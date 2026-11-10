/**
 * Pi Benchmark (pi-benchmark)
 *
 * Benchmark harness for complete coding-agent tasks.
 *
 * Primary, first-time-user entry point:
 *
 *   /benchmark                 interactive wizard -> Pagoda v1, current model
 *   /benchmark 3               fast path: Pagoda v1, current model, 3 runs
 *   /benchmark --advanced      expose every knob (suite, runs, model, thinking,
 *                              timeout, browser validation, settle time)
 *
 * Backward-compatible advanced/legacy interface:
 *
 *   /artifact-bench pagoda [--runs N] [--model provider/id] [--thinking level]
 *   /artifact-bench history [benchmark] [--limit N]
 *   /artifact-bench compare <id> <id>
 *   /artifact-bench show <id>
 *   /artifact-bench help
 *
 * Every run is a fresh, isolated agent session in an empty workspace with no
 * extensions, skills, prompt templates or context files loaded.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { Box, Text } from "@earendil-works/pi-tui";
import { productionBenchmarks, resolveBenchmark, getPrompt } from "./src/prompts.ts";
import { runBenchmark, configuredWorkspaceRoot } from "./src/runner.ts";
import { liveLine, formatTable, formatRunDetail, formatTps } from "./src/format.ts";
import { formatResultCard, formatAggregateCard } from "./src/reporting.ts";
import { ThrottledStatus } from "./src/status.ts";
import { BENCH_ROOT, loadRuns, latestRuns, findRun, saveRun, fairComparisonIssues } from "./src/store.ts";
import { BENCHMARK_ENTRY, imageTitle, isReadablePng, renderBenchmarkEntry, type BenchmarkTranscriptEntry } from "./src/transcript.ts";
import {
  parseBenchmarkInvocation,
  pickRunCountInteractive,
  advancedPlanInteractive,
  confirmationSummary,
  type WizardUI,
} from "./src/wizard.ts";

interface RunOptions {
  runs: number;
  model: string | null;
  thinking: string | null;
  timeoutSeconds: number;
  browser: boolean;
  settleMs: number;
  fake: boolean;
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    if (body.includes("=")) {
      const [key, value] = body.split("=", 2);
      flags[key] = value;
      continue;
    }
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[body] = next;
      i++;
    } else {
      flags[body] = "true";
    }
  }
  return { positional, flags };
}

function readRunOptions(flags: Record<string, string>): RunOptions {
  return {
    runs: Math.max(1, parseInt(flags.runs ?? "1", 10) || 1),
    model: flags.model ?? null,
    thinking: flags.thinking ?? null,
    timeoutSeconds: Math.max(30, parseInt(flags.timeout ?? "0", 10) || 0),
    browser: flags["no-browser"] !== "true",
    settleMs: Math.max(500, parseInt(flags.settle ?? "3000", 10) || 3000),
    fake: flags.fake === "true",
  };
}

function resolveModel(ctx: ExtensionContext, spec: string | null): any {
  if (!spec) return ctx.model;
  const [provider, modelId] = spec.includes("/") ? spec.split("/", 2) : [ctx.model?.provider, spec];
  const found = ctx.modelRegistry.find(provider, modelId);
  if (!found) {
    throw new Error(`Model not found: ${spec}. Use provider/modelId, e.g. anthropic/claude-opus-4-5`);
  }
  return found;
}

/**
 * Capture the provider configuration currently resolved by this Pi process so the
 * isolated benchmark session can inherit it. Without this, the child session does a
 * fresh authentication lookup and loses extension-registered providers such as the
 * local `strata-auto` provider, failing with "No API key found for <provider>".
 */
function collectInheritedProviders(ctx: ExtensionContext, model: any): Array<{ provider: string; config: any }> {
  const inherited: Array<{ provider: string; config: any }> = [];
  const seen = new Set<string>();
  for (const id of ctx.modelRegistry.getRegisteredProviderIds()) {
    const config = ctx.modelRegistry.getRegisteredProviderConfig(id);
    if (config) {
      inherited.push({ provider: id, config });
      seen.add(id);
    }
  }
  if (model?.provider && !seen.has(model.provider)) {
    const config = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
    if (config) inherited.push({ provider: model.provider, config });
  }
  return inherited;
}

function modelLabel(ctx: ExtensionContext, model: any): string {
  if (!model) return "unknown";
  return `${model.provider}/${model.id}`;
}

function currentThinking(ctx: ExtensionContext): string {
  return ctx.thinkingLevel ?? "medium";
}

/** Fake-artifact source used by --fake self-tests (a compliant pagoda-v1 fixture). */
const FAKE_ARTIFACT = path.join(import.meta.dirname, "test", "fixtures", "pagoda-v1-full.html");

export interface ExecPlan {
  benchmarkKey: string;
  model: any;
  thinking: string;
  runs: number;
  timeoutSeconds: number;
  browser: boolean;
  settleMs: number;
  fake: boolean;
}

/**
 * Build the plan for `/benchmark` (interactive) or `/benchmark N` (fast path).
 * The current model and thinking level are carried through UNCHANGED — the
 * wizard never silently swaps them.
 */
export function planFromContext(
  ctx: ExtensionContext,
  task: { benchmark: string; timeoutSeconds?: number },
  runs: number,
): ExecPlan {
  return {
    benchmarkKey: task.benchmark,
    model: ctx.model,
    thinking: currentThinking(ctx),
    runs,
    timeoutSeconds: task.timeoutSeconds && task.timeoutSeconds > 0 ? task.timeoutSeconds : 1200,
    browser: true,
    settleMs: 3000,
    fake: false,
  };
}

/** Build the plan for `/benchmark --advanced` from an advanced wizard result. */
export function planFromAdvanced(
  ctx: ExtensionContext,
  task: { benchmark: string },
  model: any,
  opts: { thinking: string; runs: number; timeoutSeconds: number; browser: boolean; settleMs: number },
): ExecPlan {
  return {
    benchmarkKey: task.benchmark,
    model,
    thinking: opts.thinking,
    runs: opts.runs,
    timeoutSeconds: opts.timeoutSeconds,
    browser: opts.browser,
    settleMs: opts.settleMs,
    fake: false,
  };
}

/** Injectable dependencies for executeBenchmark (used by deterministic tests). */
export interface BenchRunnerDeps {
  /** The run implementation; default is the real isolated-session runner. */
  run?: typeof runBenchmark;
  /** Persistence; default writes to the benchmark history store. */
  save?: typeof saveRun;
}

/**
 * Run one or more isolated benchmark sessions, stream live status, persist each
 * run (including prompt.txt + promptHash + compliance), then send a result card
 * per run plus a single aggregate card when there were multiple runs.
 */
export async function executeBenchmark(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  plan: ExecPlan,
  deps: BenchRunnerDeps = {},
): Promise<void> {
  const run = deps.run ?? runBenchmark;
  const save = deps.save ?? saveRun;
  const task = getPrompt(plan.benchmarkKey);
  const prompt = task.prompt;
  const promptVersion = task.version;
  const results: any[] = [];
  let sequence = 0;
  const emit = (entry: Omit<BenchmarkTranscriptEntry, "sequence">) =>
    pi.appendEntry<BenchmarkTranscriptEntry>(BENCHMARK_ENTRY, { ...entry, sequence: ++sequence });
  const status = new ThrottledStatus((text) => ctx.ui.setStatus("pi-benchmark", text));
  const startedAt = Date.now();
  let currentRun = 1;
  const elapsedTimer = setInterval(() => status.update({ run: currentRun, runs: plan.runs, elapsedMs: Date.now() - startedAt, phase: "other" }), 1000);

  for (let index = 1; index <= plan.runs; index++) {
    currentRun = index;
    status.update({ run: index, runs: plan.runs, elapsedMs: Date.now() - startedAt, phase: "other" });
    emit({ kind: "start", run: index, atMs: Date.now() - startedAt, title: `${task.name} · run ${index}/${plan.runs}`, text: `${modelLabel(ctx, plan.model)} · thinking ${plan.thinking}`, status: "running" });
    let lastMetricsEntryAt = 0;

    const result = await run({
      benchmark: task.benchmark,
      prompt,
      promptVersion,
      expectedArtifact: task.expectedArtifact,
      model: plan.model,
      thinkingLevel: plan.thinking,
      timeoutMs: plan.timeoutSeconds * 1000,
      settleMs: plan.settleMs,
      viewport: { width: 1280, height: 720 },
      runIndex: index,
      agentDir: getAgentDir(),
      benchRoot: BENCH_ROOT,
      runBrowser: plan.browser,
      inheritedProviders: collectInheritedProviders(ctx, plan.model),
      fake: plan.fake,
      fakeArtifactPath: plan.fake ? FAKE_ARTIFACT : undefined,
      workspaceRoot: configuredWorkspaceRoot(),
      signal: ctx.signal,
      onProgress: (line) => {
        const phase = /Validating/i.test(line) ? "validating" : /native Live|live\s+[\d.]+\s+tok\/s/i.test(line) ? "generating" : /Reading|prefill/i.test(line) ? "prefill" : "other";
        const live = line.match(/native Live ([\d.]+)/i) ?? line.match(/live\s+([\d.]+)\s+tok\/s/i);
        const avg = line.match(/taskAvg\s+([\d.]+)/i);
        const pp = line.match(/PP\s+([\d.]+)/i);
        status.update({ run: index, runs: plan.runs, elapsedMs: Date.now() - startedAt, phase, liveTps: live ? Number(live[1]) : undefined, averageTps: avg ? Number(avg[1]) : undefined, ppTps: pp ? Number(pp[1]) : undefined, fallback: /estimated|mixed/i.test(line) });
        const now = Date.now();
        if (now - lastMetricsEntryAt >= 15000) {
          lastMetricsEntryAt = now;
          emit({ kind: "metrics", run: index, atMs: now - startedAt, title: "Live benchmark metrics", text: line, status: "running" });
        }
      },
      onTranscriptEvent: (event) => emit({
        kind: event.kind === "tool_start" || event.kind === "tool_end" ? "tool" : event.kind === "recovery" ? "phase" : event.kind,
        run: index,
        atMs: event.atMs,
        title: event.title,
        text: event.text,
        expandedText: event.expandedText,
        status: event.isError ? "error" : event.kind === "tool_end" || event.kind === "recovery" ? "ok" : "running",
      }),
    });

    save(result);
    results.push(result);
    ctx.ui.notify(
      `${task.name} run ${index}: ${result.outcome} - ${formatTps(result.metrics.weightedTps)}`,
      result.outcome === "PASS" ? "success" : "warning",
    );
    // Durable and excluded from model context. It also re-renders after session reload.
    emit({ kind: "result", run: index, atMs: Date.now() - startedAt, title: `${task.name} final result · ${result.outcome}`, text: formatResultCard(result), status: result.outcome === "PASS" ? "ok" : "error" });
    const screenshot = result.browser?.screenshotPath;
    if (task.benchmark === "pagoda") {
      const valid = isReadablePng(screenshot);
      emit({ kind: "image", run: index, atMs: Date.now() - startedAt, title: screenshot ? imageTitle(screenshot) : "Pagoda final browser screenshot", text: valid ? screenshot : `Screenshot unavailable or invalid: ${screenshot ?? "no screenshot was captured"}`, imagePath: screenshot ?? undefined, status: valid ? "ok" : "error" });
    }
  }

  clearInterval(elapsedTimer);
  status.clear();
  // For multiple runs, follow the per-run cards with a single aggregate summary.
  // A single run already got its one detailed card above, so repeating it here
  // would duplicate the card.
  if (results.length > 1) {
    emit({ kind: "result", run: plan.runs, atMs: Date.now() - startedAt, title: `${task.name} aggregate result`, text: formatAggregateCard(results), status: results.every((result) => result.outcome === "PASS") ? "ok" : "error" });
  }
}

/** Turn a WizardUI into a ctx.ui-backed implementation. */
function toWizardUI(ctx: ExtensionContext): WizardUI {
  return {
    select: (title, options) => ctx.ui.select(title, options),
    input: (title, placeholder) => ctx.ui.input(title, placeholder),
    confirm: (title, message) => ctx.ui.confirm(title, message),
    notify: (message, type) => ctx.ui.notify(message, type),
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerEntryRenderer<BenchmarkTranscriptEntry>(BENCHMARK_ENTRY, (entry, options, theme) =>
    renderBenchmarkEntry(entry.data ?? { kind: "error", run: 0, sequence: 0, atMs: 0, title: "Invalid benchmark entry", status: "error" }, options.expanded, theme));

  // Backward compatibility for result messages written by older releases.
  pi.registerMessageRenderer("artifact-bench-report", (message, options, theme) => {
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(message.content ?? "", 0, 0));
    return box;
  });

  // ------------------------------------------------------------------ //
  // Primary entry point: /benchmark
  // ------------------------------------------------------------------ //
  pi.registerCommand("benchmark", {
    description: "Run Pagoda v1 with the current model and thinking level.",
    getArgumentCompletions: (prefix) => {
      const opts = ["pagoda-v1", "--advanced", "1", "3", "5"];
      const matches = opts.filter((o) => o.startsWith(prefix));
      return matches.length ? matches.map((o) => ({ value: o, label: o })) : null;
    },
    handler: async (args, ctx) => {
      const rawTokens = args.trim().split(/\s+/).filter(Boolean);
      const suiteToken = rawTokens[0] && !rawTokens[0].startsWith("--") && !/^\d+$/.test(rawTokens[0]) ? rawTokens.shift()! : null;
      let invocation;
      try {
        invocation = parseBenchmarkInvocation(rawTokens.join(" "));
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
        return;
      }

      const suites = productionBenchmarks();
      const task = suiteToken ? resolveBenchmark(suiteToken) : suites[0];
      const model = ctx.model;
      const thinking = currentThinking(ctx);
      const ui = toWizardUI(ctx);

      // STEP 2: show current selection (never change it silently).
      ctx.ui.notify(
        [
          "Benchmark",
          task.name,
          "",
          "Current model",
          modelLabel(ctx, model),
          "",
          "Thinking",
          thinking,
        ].join("\n"),
        "info",
      );

      if (invocation.mode === "fast") {
        const runs = invocation.runs!;
        const ok = await ui.confirm(
          "Strata benchmark exclusivity",
          `For accurate Strata-native TPS, do not run other Pi sessions or other Strata inference clients during this benchmark. This benchmark does not technically lock the server. Continue?\n\n${confirmationSummary({ benchmarkName: task.name, modelLabel: modelLabel(ctx, model), provider: model?.provider ?? "n/a", thinking, runs, contextWindow: model?.contextWindow, maxTokens: model?.maxTokens })}`,
        );
        if (!ok) {
          ctx.ui.notify("Benchmark cancelled.", "info");
          return;
        }
        await executeBenchmark(pi, ctx, planFromContext(ctx, task, runs));
        return;
      }

      if (invocation.mode === "advanced") {
        const plan = await advancedPlanInteractive(ui, {
          benchmarkName: task.name,
          runs: 3,
          modelLabel: modelLabel(ctx, model),
          thinking,
          timeoutSeconds: 1200,
          browser: true,
          settleMs: 3000,
        });
        if (!plan) {
          ctx.ui.notify("Benchmark cancelled.", "info");
          return;
        }
        let advancedModel: any = model;
        try {
          advancedModel = resolveModel(ctx, plan.model);
        } catch (error) {
          ctx.ui.notify((error as Error).message, "error");
          return;
        }
        const ok = await ui.confirm(
          "Strata benchmark exclusivity",
          `For accurate Strata-native TPS, do not run other Pi sessions or other Strata inference clients during this benchmark. This benchmark does not technically lock the server. Continue?\n\n${confirmationSummary({
            benchmarkName: task.name,
            modelLabel: modelLabel(ctx, advancedModel),
            provider: advancedModel?.provider ?? "n/a",
            thinking: plan.thinking,
            runs: plan.runs,
            contextWindow: advancedModel?.contextWindow,
            maxTokens: advancedModel?.maxTokens,
            timeoutSeconds: plan.timeoutSeconds,
            browser: plan.browser,
            settleMs: plan.settleMs,
          })}`,
        );
        if (!ok) {
          ctx.ui.notify("Benchmark cancelled.", "info");
          return;
        }
        await executeBenchmark(pi, ctx, planFromAdvanced(ctx, task, advancedModel, plan));
        return;
      }

      // STEP 3: choose run count.
      const runs = await pickRunCountInteractive(ui, { defaultRunCount: 1 });
      if (runs === null) {
        ctx.ui.notify("Benchmark cancelled.", "info");
        return;
      }

      // STEP 4: confirm, then run.
      const sure = await ui.confirm(
        "Strata benchmark exclusivity",
        `For accurate Strata-native TPS, do not run other Pi sessions or other Strata inference clients during this benchmark. This benchmark does not technically lock the server. Continue?\n\n${confirmationSummary({ benchmarkName: task.name, modelLabel: modelLabel(ctx, model), provider: model?.provider ?? "n/a", thinking, runs, contextWindow: model?.contextWindow, maxTokens: model?.maxTokens })}`,
      );
      if (!sure) {
        ctx.ui.notify("Benchmark cancelled.", "info");
        return;
      }
      await executeBenchmark(pi, ctx, planFromContext(ctx, task, runs));
    },
  });

  // ------------------------------------------------------------------ //
  // Backward-compatible legacy interface: /artifact-bench
  // ------------------------------------------------------------------ //
  pi.registerCommand("artifact-bench", {
    description: "Advanced/legacy benchmark interface. Run pagoda-v1, list history, compare, or show runs.",
    getArgumentCompletions: (prefix) => {
      const commands = ["pagoda", "history", "compare", "show", "help"];
      const matches = commands.filter((command) => command.startsWith(prefix));
      return matches.length ? matches.map((command) => ({ value: command, label: command })) : null;
    },
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const subcommand = tokens[0] ?? "help";
      const { positional, flags } = parseFlags(tokens.slice(1));

      if (subcommand === "help") {
        ctx.ui.notify(
          [
            "Use /benchmark for the simple first-time flow (Pagoda v1, current model).",
            "/artifact-bench pagoda [--runs N] [--model provider/id] [--thinking level] [--timeout seconds] [--no-browser]",
            "/artifact-bench history [--limit N]",
            "/artifact-bench compare <runId> <runId>",
            "/artifact-bench show <runId>",
            `history root: ${BENCH_ROOT}`,
          ].join("\n"),
          "info",
        );
        return;
      }

      if (subcommand === "history") {
        const limit = Math.max(1, parseInt(flags.limit ?? "20", 10) || 20);
        const runs = latestRuns(positional[0] ?? "pagoda", limit);
        if (runs.length === 0) {
          ctx.ui.notify("No benchmark runs recorded yet.", "info");
          return;
        }
        pi.sendMessage({
          customType: "artifact-bench-report",
          content: `${positional[0] ?? "pagoda"} history (${runs.length} runs)\n${formatTable(runs)}`,
          display: true,
        });
        return;
      }

      if (subcommand === "show") {
        const run = findRun(positional[0] ?? "");
        if (!run) {
          ctx.ui.notify(`No run with id "${positional[0] ?? ""}"`, "error");
          return;
        }
        pi.sendMessage({ customType: "artifact-bench-report", content: formatRunDetail(run), display: true });
        return;
      }

      if (subcommand === "compare") {
        const runs = positional.length >= 2
          ? positional.map((id) => findRun(id)).filter(Boolean) as any[]
          : loadRuns(positional[0] ?? "pagoda").slice(-2);
        if (runs.length < 2) {
          ctx.ui.notify("Need two runs to compare. Provide two run ids, or run the benchmark twice first.", "error");
          return;
        }
        const issues = fairComparisonIssues(runs);
        if (issues.length) {
          ctx.ui.notify(`Comparison refused: ${issues.join("; ")}`, "error");
          return;
        }
        const table = formatTable(runs);
        const delta = runs[1].metrics.weightedTps - runs[0].metrics.weightedTps;
        pi.sendMessage({
          customType: "artifact-bench-report",
          content: `Comparison\n${table}\n\nTPS delta (run2 - run1): ${delta.toFixed(1)} tok/s`,
          display: true,
        });
        return;
      }

      if (subcommand === "pagoda") {
        const options = readRunOptions(flags);
        const task = getPrompt(subcommand);
        const timeoutSeconds = options.timeoutSeconds > 0 ? options.timeoutSeconds : task.timeoutSeconds;

        let model: any;
        try {
          model = resolveModel(ctx, options.model);
        } catch (error) {
          ctx.ui.notify((error as Error).message, "error");
          return;
        }

        const thinking = options.thinking ?? currentThinking(ctx);
        const confirmed = await ctx.ui.confirm(
          "Strata benchmark exclusivity",
          "For accurate Strata-native TPS, do not run other Pi sessions or other Strata inference clients during this benchmark. This benchmark does not technically lock the server. Continue?",
        );
        if (!confirmed) {
          ctx.ui.notify("Benchmark cancelled.", "info");
          return;
        }
        await executeBenchmark(pi, ctx, {
          benchmarkKey: task.benchmark,
          model,
          thinking,
          runs: options.runs,
          timeoutSeconds,
          browser: options.browser,
          settleMs: options.settleMs,
          fake: options.fake,
        });
        return;
      }

      ctx.ui.notify(`Unknown subcommand "${subcommand}". Use /artifact-bench help`, "error");
    },
  });
}
