/**
 * Benchmark runner.
 *
 * Each run is an isolated, fresh Pi agent session:
 * - new session file in the run directory
 * - empty workspace directory as cwd
 * - no extensions, skills, prompt templates, themes or context files loaded,
 *   so the benchmark extension never re-enters itself
 * - the model and thinking level are pinned per run
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { RunMetrics } from "./metrics.ts";
import { StrataMetricsPoller, strataMetricsUrl, type StrataSnapshot } from "./native-metrics.ts";
import { liveLine } from "./format.ts";
import { hashPrompt } from "./prompts.ts";
import { evaluateCompliance } from "./compliance.ts";
import { findArtifact } from "./artifact.ts";
import { validateArtifact } from "./browser.ts";
import { determineOutcome } from "./outcome.ts";
import type { ArtifactReport, BrowserReport, ComplianceReport, RunResult } from "./types.ts";
import { parseEnduranceEvents, mergeEnduranceTelemetry } from "./endurance-events.ts";
import { analyzeEnduranceSession } from "./endurance-session.ts";
import { evaluateEndurance } from "./endurance-evaluator.ts";
import { scoreEndurance } from "./endurance-scoring.ts";
import { captureIntegrity, compareIntegrity } from "./integrity.ts";

export interface RunConfig {
  benchmark: string;
  prompt: string;
  promptVersion: string;
  expectedArtifact: string;
  model: any;
  thinkingLevel: string;
  timeoutMs: number;
  settleMs: number;
  viewport: { width: number; height: number };
  runIndex: number;
  agentDir: string;
  benchRoot: string;
  runBrowser: boolean;
  fake?: boolean;
  fakeArtifactPath?: string;
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
  /**
   * Provider configurations already resolved by the parent Pi process (from
   * ctx.modelRegistry). These are re-registered on the isolated child session's
   * ModelRuntime so custom/local providers such as `strata-auto` keep working
   * even though extensions are disabled inside the benchmark session.
   */
  inheritedProviders?: Array<{ provider: string; config: any }>;
  /**
   * Diagnostic continuation of an earlier run. The source run is never modified:
   * its workspace is copied into a fresh, uniquely named run and its transcript is
   * forked into a new session. Resumed runs can never be an autonomous PASS.
   */
  resumeFrom?: { runId: string; workspace: string; sessionFile: string | null };
  /**
   * Optional base directory for agent workspaces (default: inside the run dir).
   * Set PI_BENCHMARK_WORKSPACE_ROOT to keep workspaces out of the results tree.
   */
  workspaceRoot?: string;
  /** Hard cap on completed assistant turns. */
  maxTurns?: number;
  /** Fixed rev2 continuation budget; zero is diagnostic no-continuation mode. */
  continuationLimit?: number;
}

/**
 * Hostnames that are local loopback addresses. Used for the harmless local API key
 * fallback below. `localhost`, `127.0.0.1` and `::1` never require /login or OAuth
 * and never need a real credential.
 */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLocalUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl || !baseUrl.trim()) return false;
  try {
    return LOCAL_HOSTS.has(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Prepare an inherited provider config for the child session.
 *
 * If a provider points at a local-loopback OpenAI-compatible endpoint and no API key
 * is configured, inject the harmless placeholder `local` so the Pi SDK does not demand
 * real authentication for a keyless local server. Remote providers are returned
 * untouched, preserving normal OpenRouter/Anthropic/OpenAI/OAuth behaviour.
 */
export function applyLocalApiKeyFallback(provider: string, config: any): any {
  if (!config || typeof config !== "object") return config;
  if (!isLocalUrl(config.baseUrl)) return config;
  if (config.apiKey || config.oauth || config.authHeader === false) return config;
  return { ...config, apiKey: "local" };
}

/**
 * Build a child ModelRuntime for an isolated benchmark session.
 *
 * It starts from the ordinary agent configuration (so remote providers such as
 * OpenRouter read their normal credentials from auth.json / models.json) and then
 * re-registers the provider configurations inherited from the parent Pi process
 * (e.g. the extension-registered `strata-auto` provider). This loses the fresh
 * authentication lookup that dropped the local provider config.
 */
export async function buildChildModelRuntime(
  agentDir: string,
  inheritedProviders?: Array<{ provider: string; config: any }>,
): Promise<ModelRuntime> {
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"),
    refreshOnCreate: false,
  });
  for (const entry of inheritedProviders ?? []) {
    if (entry?.provider && entry?.config) {
      try {
        modelRuntime.registerProvider(entry.provider, applyLocalApiKeyFallback(entry.provider, entry.config));
      } catch (error) {
        // A broken inherited provider must not take the whole benchmark down.
        console.error(`Ignoring inherited provider ${entry.provider}: ${(error as Error).message}`);
      }
    }
  }
  return modelRuntime;
}

export interface RunPaths {
  runDir: string;
  workspace: string;
  sessionDir: string;
  screenshotPath: string;
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").toLowerCase();
}

export function buildRunPaths(cfg: RunConfig, timestamp: string, resumeMarker?: string): RunPaths {
  const modelSlug = slug(`${cfg.model.provider}/${cfg.model.id}`);
  // A resumed run gets its own directory name so it can never collide with, or
  // overwrite, the run it was continued from.
  const runName = `run-${String(cfg.runIndex).padStart(2, "0")}${resumeMarker ? `-${resumeMarker}` : ""}`;
  const runDir = path.join(
    cfg.benchRoot,
    cfg.benchmark,
    timestamp,
    modelSlug,
    runName,
  );
  const rev2Root = cfg.benchmark === "agent-endurance-v5" && process.platform === "win32"
    ? "C:\\AI\\Scratch\\pi-agent-benchmarks"
    : undefined;
  const workspaceRoot = cfg.workspaceRoot ?? rev2Root;
  const workspace = workspaceRoot
    ? cfg.benchmark === "agent-endurance-v5"
      ? path.join(workspaceRoot, modelSlug, `${timestamp}-${randomBytes(4).toString("hex")}`)
      : path.join(workspaceRoot, `${modelSlug}-${timestamp}-${runName}`)
    : path.join(runDir, "workspace");
  return {
    runDir,
    workspace,
    sessionDir: path.join(runDir, "session"),
    screenshotPath: path.join(runDir, "screenshot.png"),
  };
}

function shortId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").slice(-8) || "unknown";
}

/** Workspace placement honouring PI_BENCHMARK_WORKSPACE_ROOT when configured. */
export function configuredWorkspaceRoot(): string | undefined {
  const value = process.env.PI_BENCHMARK_WORKSPACE_ROOT;
  return value && value.trim() ? path.resolve(value) : undefined;
}

const PHASE_COUNT = 12;
const REV2_CONTINUATION = "Continue working on the remaining phases. Do not restart completed work.";

function rev2CompletionGate(workspace: string): boolean {
  if (!fs.existsSync(path.join(workspace, "DONE.md"))) return false;
  const env = { PATH: process.env.PATH ?? "", PYTHONHASHSEED: "0", WMS_NOW: "2026-01-02T03:04:05+00:00" };
  const help = spawnSync(process.platform === "win32" ? "python" : "python3", ["-m", "wms", "--help"], {
    cwd: workspace, env, timeout: 30000, windowsHide: true,
  });
  if (help.status !== 0) return false;
  const tests = spawnSync(process.platform === "win32" ? "python" : "python3", ["-m", "unittest", "discover", "-s", "tests"], {
    cwd: workspace, env, timeout: 180000, windowsHide: true,
  });
  return tests.status === 0;
}

export async function runBenchmark(cfg: RunConfig): Promise<RunResult> {
  const startedAt = new Date();
  const timestamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const resumed = Boolean(cfg.resumeFrom);
  const resumeMarker = resumed ? `resumed-${shortId(cfg.resumeFrom!.runId)}` : undefined;
  const paths = buildRunPaths(cfg, timestamp, resumeMarker);
  const integrityBefore = cfg.benchmark === "agent-endurance-v5"
    ? captureIntegrity(cfg.agentDir, path.resolve(import.meta.dirname, ".."))
    : null;
  fs.mkdirSync(paths.workspace, { recursive: true });
  fs.mkdirSync(paths.sessionDir, { recursive: true });

  if (resumed) {
    // Copy the source workspace so the original run stays untouched. Byte-for-byte
    // copies keep the diagnostic run independent of the run it continues.
    const skip = /[\\/](?:__pycache__|node_modules|[.]git)(?:[\\/]|$)/;
    fs.cpSync(cfg.resumeFrom!.workspace, paths.workspace, { recursive: true, filter: (source) => !skip.test(source) });
  }

  const metrics = new RunMetrics();
  let timedOut = false;
  let turnBudgetExceeded = false;
  let continuationsSent = 0;
  let harnessError: string | null = null;
  let agentMs = 0;
  let sessionFile: string | null = null;
  const nativeFinalizers: Promise<void>[] = [];
  const structuredEvents: any[] = [];
  let nativeCompleted = 0;

  metrics.start();

  if (cfg.fake) {
    // Harness self-test: pretend an agent wrote the artifact, so the whole
    // pipeline (discovery, browser validation, visual gate, storage, report)
    // runs without spending model tokens.
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    fs.copyFileSync(cfg.fakeArtifactPath!, path.join(paths.workspace, cfg.expectedArtifact));
    metrics.beginAssistantMessage();
    await sleep(1200); // prefill
    metrics.contentStarted();
    await sleep(3000); // generation
    metrics.endAssistantMessage({ output: 1200, input: 500, cacheRead: 0, cacheWrite: 0, cost: { total: 0.05 } }, "toolUse");
    await sleep(1500); // tool execution
    metrics.toolCall(false);
    metrics.beginAssistantMessage();
    await sleep(800);
    metrics.contentStarted();
    await sleep(2500);
    metrics.endAssistantMessage({ output: 800, input: 900, cacheRead: 0, cacheWrite: 0, cost: { total: 0.04 } }, "stop");
  } else {
    try {
    const settingsManager = SettingsManager.create(paths.workspace, cfg.agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: paths.workspace,
      agentDir: cfg.agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const sessionManager = resumed
      ? SessionManager.forkFrom(cfg.resumeFrom!.sessionFile ?? "", paths.workspace, paths.sessionDir)
      : SessionManager.create(paths.workspace, paths.sessionDir);
    sessionFile = sessionManager.getSessionFile() ?? null;

    // Reuse the already-resolved Pi provider configuration on the child session so
    // custom/local providers (strata-auto) and remote providers (OpenRouter, ...)
    // authenticate identically to the parent session instead of via a fresh lookup
    // that loses extension-registered providers.
    const modelRuntime = await buildChildModelRuntime(cfg.agentDir, cfg.inheritedProviders);
    const metricsUrl = strataMetricsUrl(cfg.model.provider, cfg.inheritedProviders ?? []);
    let nativePoller: StrataMetricsPoller | null = null;
    let nativeSnapshot: StrataSnapshot | null = null;
    let nativeRequests = 0;
    if (metricsUrl) {
      nativePoller = new StrataMetricsPoller(metricsUrl, 300, 500, (snapshot) => {
        nativeSnapshot = snapshot;
        if (snapshot && !snapshot.completed) metrics.setActiveNative(snapshot.outputTokens, snapshot.liveTps);
        if (snapshot) cfg.onProgress?.(`${snapshot.ppTps > 0 && snapshot.liveTps === 0 ? `Reading PP ${snapshot.ppTps.toFixed(0)} tok/s` : `Generating native Live ${snapshot.liveTps.toFixed(1)}`} taskAvg ${metrics.snapshot().weightedTps.toFixed(1)}`);
      });
      await nativePoller.start();
      // ModelRuntime.streamSimple is the actual child provider-request boundary,
      // before the provider sends the HTTP request (message_start is too late).
      const originalStreamSimple = modelRuntime.streamSimple.bind(modelRuntime);
      modelRuntime.streamSimple = ((...args: any[]) => {
        nativePoller!.beginNativeRequest();
        nativeRequests++;
        return originalStreamSimple(...args);
      }) as typeof modelRuntime.streamSimple;
    }

    const { session } = await createAgentSession({
      cwd: paths.workspace,
      agentDir: cfg.agentDir,
      model: cfg.model,
      thinkingLevel: cfg.thinkingLevel as any,
      modelRuntime,
      sessionManager,
      resourceLoader,
      settingsManager,
    });

    const unsubscribe = session.subscribe((event: any) => {
      structuredEvents.push({ ...event, atMs: metrics.elapsedMs() });
      if (event.type === "message_start" && event.message?.role === "assistant") {
        metrics.beginAssistantMessage();
      } else if (event.type === "message_update") {
        const assistantEvent = event.assistantMessageEvent;
        if (
          assistantEvent?.type === "text_start" ||
          assistantEvent?.type === "thinking_start" ||
          assistantEvent?.type === "toolcall_start"
        ) {
          metrics.contentStarted();
          cfg.onProgress?.(liveLine(metrics.snapshot(), { live: true }));
        } else if (
          assistantEvent?.type === "text_delta" ||
          assistantEvent?.type === "thinking_delta" ||
          assistantEvent?.type === "toolcall_delta"
        ) {
          // Streaming character deltas -> estimated partial token count. Reconciled to
          // exact usage.output at message_end.
          metrics.outputDelta(assistantEvent.delta ?? "");
          cfg.onProgress?.(liveLine(metrics.snapshot(), { live: true }));
        }
      } else if (event.type === "message_end" && event.message?.role === "assistant") {
        const reason = event.message.stopReason ?? "stop";
        // On an interrupted turn (timeout/abort/error) the terminal usage is unreliable
        // (often 0), so preserve the accumulated partial estimate instead of resetting it.
        if (reason === "aborted" || reason === "error") {
          metrics.endAssistantMessagePartial(reason);
        } else {
          metrics.endAssistantMessage(event.message.usage, reason);
        }
        if (nativePoller) {
          nativeFinalizers.push(nativePoller.finalizeRequest().then((native) => {
            if (native?.completed && metrics.reconcileLastWithNative(native.outputTokens, native.decodeSeconds)) nativeCompleted++;
          }).catch(() => undefined));
        }
        cfg.onProgress?.(liveLine(metrics.snapshot()));
        if (cfg.maxTurns && metrics.snapshot().assistantTurnsCompleted >= cfg.maxTurns) {
          turnBudgetExceeded = true;
          metrics.markAborted();
          session.abort().catch(() => undefined);
        }
      } else if (event.type === "tool_execution_start") {
        cfg.onProgress?.(`Validating… taskAvg ${metrics.snapshot().weightedTps.toFixed(1)}`);
      } else if (event.type === "tool_execution_end") {
        metrics.toolCall(Boolean(event.isError));
        cfg.onProgress?.(`Validating… taskAvg ${metrics.snapshot().weightedTps.toFixed(1)}`);
      }
    });

    const onOuterAbort = () => {
      timedOut = true;
      metrics.markAborted();
      session.abort().catch(() => undefined);
    };
    if (cfg.signal) cfg.signal.addEventListener("abort", onOuterAbort);

    const timer = setTimeout(() => {
      timedOut = true;
      metrics.markAborted();
      session.abort().catch(() => undefined);
    }, cfg.timeoutMs);

    try {
      await session.prompt(cfg.prompt);
      if (cfg.benchmark === "agent-endurance-v5") {
        const limit = Math.max(0, Math.min(3, cfg.continuationLimit ?? 3));
        while (!turnBudgetExceeded && !timedOut && continuationsSent < limit && !rev2CompletionGate(paths.workspace)) {
          continuationsSent++;
          structuredEvents.push({ type: "manual_continuation", atMs: metrics.elapsedMs(), reason: "completion gate failed", index: continuationsSent });
          await session.prompt(REV2_CONTINUATION);
        }
      }
    } finally {
      clearTimeout(timer);
      if (cfg.signal) cfg.signal.removeEventListener("abort", onOuterAbort);
      unsubscribe();
      await Promise.all(nativeFinalizers);
      nativePoller?.stop();
      session.dispose();
    }

    agentMs = metrics.elapsedMs();
  } catch (error) {
    harnessError = `session failed: ${(error as Error).message}`;
  }
  }

  metrics.finish();
  const baseSnapshot = metrics.snapshot();
  const requestCount = baseSnapshot.generations;
  const accuracy = nativeCompleted === 0 ? "estimated" : nativeCompleted === requestCount ? "native" : "mixed";
  const snapshot = {
    ...baseSnapshot,
    measurementAccuracy: accuracy as "native" | "mixed" | "estimated",
    measurementSource: nativeCompleted > 0 ? "Strata native (exclusive-use assumption)" : "provider usage / streamed estimate",
    nativeRequests: nativeCompleted,
  };

  const artifact = findArtifact(paths.workspace, cfg.expectedArtifact);

  const browser: BrowserReport = {
    attempted: false,
    skipped: false,
    ok: false,
    browser: null,
    browserName: null,
    durationMs: 0,
    errors: [],
    consoleErrors: [],
    canvas: false,
    canvasWidth: 0,
    canvasHeight: 0,
    threeLoaded: false,
    webgl: false,
    bodyTextLength: 0,
    screenshotPath: null,
    screenshotWidth: 0,
    screenshotHeight: 0,
    visual: null,
  };

  const isEndurance = ["agent-endurance-v3", "agent-endurance-v4", "agent-endurance-v5"].includes(cfg.benchmark);
  if (isEndurance) {
    browser.skipped = true;
    browser.errors.push("browser validation not applicable to Python benchmark");
  } else if (!cfg.runBrowser) {
    browser.skipped = true;
    browser.errors.push("browser validation disabled by --no-browser");
  } else if (artifact.found) {
    cfg.onProgress?.(`Validating… taskAvg ${metrics.snapshot().weightedTps.toFixed(1)}`);
    const report = await validateArtifact({
      htmlPath: artifact.path!,
      screenshotPath: paths.screenshotPath,
      timeoutMs: 30000,
      settleMs: cfg.settleMs,
      viewport: cfg.viewport,
    });
    Object.assign(browser, report);
  }

  const visual = browser.visual ?? null;

  // Compliance validation against the produced artifact source + runtime facts.
  let compliance: ComplianceReport | null = null;
  if (!isEndurance && artifact.found && artifact.path) {
    try {
      const source = fs.readFileSync(artifact.path, "utf8");
      compliance = evaluateCompliance(source, browser.runtime, artifact.sizeBytes);
    } catch {
      compliance = null;
    }
  }

  let { outcome, reasons } = determineOutcome({
    metrics: snapshot,
    artifact,
    browser,
    visual,
    timedOut,
    harnessError,
    compliance,
  });

  let endurance: RunResult["endurance"];
  if (isEndurance) {
    const evaluation = evaluateEndurance(paths.workspace, { benchmarkVersion: cfg.promptVersion });
    const session = analyzeEnduranceSession(sessionFile, paths.workspace, {
      resumePromptText: resumed ? cfg.prompt : undefined,
    });
    const telemetry = mergeEnduranceTelemetry(
      parseEnduranceEvents(structuredEvents, evaluation.completed),
      session,
      { completed: evaluation.completed, resumed, resumePromptText: resumed ? cfg.prompt : undefined },
    );
    const rev2GatePassed = cfg.benchmark === "agent-endurance-v5" ? rev2CompletionGate(paths.workspace) : evaluation.completed;
    if (cfg.benchmark === "agent-endurance-v5") {
      const stopCount = session.available ? session.stopReasons.stop : Number(/stop=(\d+)/.exec(telemetry.stopReasons)?.[1] ?? 0);
      telemetry.prematureStops = rev2GatePassed ? Math.max(0, stopCount - 1) : stopCount;
      telemetry.failedCompletionClaim = !rev2GatePassed && stopCount > 0;
    }
    const scores = scoreEndurance(evaluation, telemetry, snapshot, {
      resumed,
      interrupted: timedOut || snapshot.aborted,
    });
    const interrupted = timedOut || snapshot.aborted;
    outcome = turnBudgetExceeded
      ? "BUDGET_EXCEEDED"
      : timedOut
      ? "FAIL_TIMEOUT"
      : harnessError
        ? "ERROR_HARNESS"
        : interrupted
          ? "FAIL_AGENT"
          : evaluation.completed && scores.autonomous === "PASS"
            ? "PASS"
            : "FAIL_COMPLIANCE";
    reasons = [];
    if (!evaluation.completed) {
      reasons.push(
        evaluation.details.length
          ? evaluation.details.slice(0, 6).join("; ")
          : `independent evaluator ${evaluation.passed}/${evaluation.total}; phases ${evaluation.phaseCompletion}/${PHASE_COUNT}`,
      );
    }
    if (scores.autonomous === "FAIL") {
      reasons.push(
        `autonomous reliability FAIL (premature stops=${telemetry.prematureStops}, continuations=${telemetry.manualContinuations}, boundary violations=${telemetry.boundaryViolations})`,
      );
    }
    if (resumed) reasons.push("resumed run is diagnostic: not eligible for an autonomous PASS");
    const integrityChanged = integrityBefore
      ? compareIntegrity(integrityBefore, captureIntegrity(cfg.agentDir, path.resolve(import.meta.dirname, "..")))
      : [];
    if (cfg.benchmark === "agent-endurance-v5" && telemetry.boundarySamples.some((sample) => /evaluators|hidden/i.test(sample))) {
      integrityChanged.push("hidden evaluator access recorded in tool-call log");
    }
    if (integrityChanged.length) {
      outcome = "FAIL_AGENT";
      reasons.unshift(`integrity violation: ${integrityChanged.join(", ")}`);
    }
    endurance = {
      status: integrityChanged.length
        ? "INTEGRITY_VIOLATION"
        : resumed
        ? "RESUMED"
        : turnBudgetExceeded || timedOut
          ? "BUDGET_EXCEEDED"
          : harnessError
            ? "CRASHED"
            : evaluation.completed && continuationsSent === 0
              ? "AUTONOMOUS_PASS"
              : evaluation.completed
                ? "PASS_WITH_CONTINUATION"
                : evaluation.passed > 0
                  ? "PARTIAL"
                  : "FAILED",
      evaluation,
      telemetry,
      scores,
      resumed,
      ...(resumed ? { resumeOf: cfg.resumeFrom!.runId } : {}),
      sessionFile,
      integrity: { ok: integrityChanged.length === 0, changedPaths: integrityChanged },
      configuration: {
        provider: cfg.model.provider,
        model: cfg.model.id,
        thinkingLevel: cfg.thinkingLevel,
        contextWindow: cfg.model.contextWindow ?? "UNKNOWN",
        maxTokens: cfg.model.maxTokens ?? "UNKNOWN",
        timeoutMs: cfg.timeoutMs,
        maxTurns: cfg.maxTurns ?? "UNKNOWN",
        continuationLimit: cfg.continuationLimit ?? (cfg.benchmark === "agent-endurance-v5" ? 3 : 0),
        continuationsSent,
        // Configuration snapshot deliberately contains no credentials or env values.
        inheritedProviderCount: (cfg.inheritedProviders ?? []).length,
      },
    };
  }

  const modelSlug = slug(`${cfg.model.provider}/${cfg.model.id}`);

  const idParts = [cfg.benchmark, timestamp, modelSlug, `run-${String(cfg.runIndex).padStart(2, "0")}`];
  if (resumed) idParts.push(`resumed-${shortId(cfg.resumeFrom!.runId)}`);

  // Persist the exact prompt that was sent so every run is reproducible and the
  // hash can be re-verified byte-for-byte against the canonical asset.
  const promptHash = hashPrompt(cfg.prompt);
  fs.writeFileSync(path.join(paths.runDir, "prompt.txt"), cfg.prompt, "utf8");

  return {
    id: idParts.join("-"),
    benchmark: cfg.benchmark,
    benchmarkVersion: cfg.promptVersion,
    promptHash,
    promptVersion: cfg.promptVersion,
    runIndex: cfg.runIndex,
    timestamp: startedAt.toISOString(),
    model: {
      provider: cfg.model.provider,
      id: cfg.model.id,
      name: cfg.model.name ?? cfg.model.id,
      contextWindow: typeof cfg.model.contextWindow === "number" ? cfg.model.contextWindow : undefined,
      maxTokens: typeof cfg.model.maxTokens === "number" ? cfg.model.maxTokens : undefined,
    },
    thinkingLevel: cfg.thinkingLevel,
    workspace: paths.workspace,
    runDir: paths.runDir,
    sessionFile,
    outcome,
    reasons,
    metrics: snapshot,
    artifact,
    browser,
    visual: visual ?? {
      ok: false,
      width: 0,
      height: 0,
      meanLuminance: 0,
      luminanceStdDev: 0,
      blackFraction: 0,
      whiteFraction: 0,
      uniqueColors: 0,
      meanSaturation: 0,
      reasons: ["no screenshot captured"],
    },
    compliance,
    timings: { agentMs, validationMs: browser.durationMs },
    ...(endurance ? { endurance } : {}),
  };
}
