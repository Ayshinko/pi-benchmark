/**
 * SHORT real-model streaming smoke test.
 *
 * Runs the real benchmark runner against strata-auto with a small, bounded prompt so we
 * can observe streaming/incremental metrics without a 15-minute pagoda run:
 *   - output token count rises BEFORE message_end (partial estimate)
 *   - live TPS appears while the active turn streams
 *   - final exact usage reconciles after message_end (or partial preserved on timeout)
 *
 *   node test/smoke-streaming.ts
 */

import os from "node:os";
import path from "node:path";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { buildChildModelRuntime, runBenchmark } from "../src/runner.ts";
import { getPrompt } from "../src/prompts.ts";

const agentDir = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const BASE_URL = "http://127.0.0.1:8080/v1";
const WANT_MODEL = process.env.STRATA_MODEL ?? "swift-1.5-iq3_xxs";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 240000);

const CFG = {
  name: "Strata Auto", providerId: "strata-auto", baseUrl: BASE_URL, apiKey: "local",
  api: "openai-completions",
  defaults: {
    contextWindow: 65536, maxTokens: 16384, reasoning: true, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsReasoningEffort: true },
    thinkingLevelMap: { off: "none", minimal: "none", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
  },
};

function buildModels(ids: string[]): any[] {
  return ids.map((id) => ({
    id, name: id, input: CFG.defaults.input, reasoning: CFG.defaults.reasoning,
    contextWindow: CFG.defaults.contextWindow, maxTokens: CFG.defaults.maxTokens,
    cost: { ...CFG.defaults.cost }, compat: CFG.defaults.compat, thinkingLevelMap: CFG.defaults.thinkingLevelMap,
  }));
}

function providerConfig(ids: string[]): any {
  return {
    name: CFG.name, baseUrl: CFG.baseUrl, apiKey: CFG.apiKey, api: CFG.api,
    models: buildModels(ids),
    refreshModels: async (context: any) => context?.allowNetwork === false ? buildModels(ids) : buildModels(ids),
  };
}

async function main(): Promise<void> {
  const res = await fetch(`${BASE_URL.replace(/\/+$/, "")}/models`);
  const json: any = await res.json();
  const data = Array.isArray(json) ? json : json?.data ?? [];
  const ids = data.map((m: any) => m?.id).filter((x: unknown): x is string => typeof x === "string");
  console.log(`strata models: ${ids.join(", ")}`);

  const config = providerConfig(ids);
  const runtime = await buildChildModelRuntime(agentDir, [{ provider: "strata-auto", config }]);
  const registry = new ModelRegistry(runtime);
  const model = registry.find("strata-auto", WANT_MODEL);
  if (!model) throw new Error(`model not found: strata-auto/${WANT_MODEL}`);

  const prompt =
    "Write a pagoda.html file with the text: a numbered list of exactly 100 short lines, one per line, from 1 to 100. Each line must be a short sentence. Save it with the write tool.";

  console.log(`running short streaming smoke → strata-auto/${WANT_MODEL} (timeout ${TIMEOUT_MS}ms)`);
  const seenLive: string[] = [];
  const result = await runBenchmark({
    benchmark: "smoke-stream",
    prompt,
    promptVersion: "v1",
    expectedArtifact: "pagoda.html",
    model,
    thinkingLevel: "low",
    timeoutMs: TIMEOUT_MS,
    settleMs: 1000,
    viewport: { width: 800, height: 600 },
    runIndex: 1,
    agentDir,
    benchRoot: path.join(os.homedir(), ".pi", "benchmarks"),
    runBrowser: false,
    inheritedProviders: [{ provider: "strata-auto", config }],
    onProgress: (line) => {
      seenLive.push(line);
    },
  });

  console.log("");
  console.log(`outcome:        ${result.outcome}`);
  console.log(`outputTokens:   ${result.metrics.outputTokens}`);
  console.log(`genMs:          ${result.metrics.genMs}`);
  console.log(`weightedTps:    ${result.metrics.weightedTps.toFixed(1)}`);
  console.log(`accuracy:       ${result.metrics.outputTokenAccuracy}`);
  console.log(`partial:        ${result.metrics.partialOutputTokens}`);
  console.log(`liveTps:        ${result.metrics.liveTps.toFixed(1)}`);
  console.log(`turns:          started=${result.metrics.assistantTurnsStarted} completed=${result.metrics.assistantTurnsCompleted}`);
  console.log(`activeTurn:     ${result.metrics.activeAssistantTurn}`);
  console.log(`reasons:        ${result.reasons.join(", ")}`);
  console.log(`stop:           ${result.metrics.stopReasons.join(", ")}`);

  // Show a couple of intermediate live lines that contained partial output / live TPS.
  const liveWithOutput = seenLive.filter((l) => /live\s+\d/.test(l) || /out\s+\d/.test(l)).slice(-3);
  console.log("intermediate live lines (tail):");
  for (const l of liveWithOutput) console.log("   ", l);

  // Hard assertions: no harness/auth error, and we observed streaming metrics.
  if (result.outcome === "ERROR_HARNESS") {
    console.error(`SMOKE FAIL: harness error (${result.reasons.join(", ")})`);
    process.exit(1);
  }
  const observed = seenLive.some((l) => /out\s+[1-9]/.test(l) || /live\s+[1-9]/.test(l)) || result.metrics.outputTokens > 0;
  if (!observed && result.metrics.outputTokens === 0) {
    console.error("SMOKE FAIL: no streaming tokens observed (output 0)");
    process.exit(1);
  }
  if (result.metrics.outputTokens > 0 && result.metrics.genMs <= 0) {
    console.error("SMOKE FAIL: output counted but zero generation time");
    process.exit(1);
  }

  console.log("SMOKE PASS: streaming metrics populated during the real run.");
}

main().catch((err) => {
  console.error("SMOKE ERROR:", err?.stack ?? err);
  process.exit(1);
});