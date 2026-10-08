/**
 * Regression tests for streaming / incremental task metrics.
 *
 * Verifies that a long-running assistant message does NOT report 0 output tokens / 0 TPS
 * merely because message_end never arrived before timeout, and that partial estimates are
 * reconciled to exact usage.output without double counting.
 *
 *   node test/metrics-incremental.test.ts
 */

import { RunMetrics } from "../src/metrics.ts";
import { formatRunDetail, formatOutput, liveLine } from "../src/format.ts";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}
function near(a: number, b: number, tol = 1e-6): boolean {
  return Math.abs(a - b) < tol;
}
function makeClock(): { now: number; clock: () => number } {
  const state = { value: 0 };
  return {
    now: 0,
    set now(v: number) {
      state.value = v;
    },
    get now(): number {
      return state.value;
    },
    clock: () => state.value,
  };
}

console.log("\n[partial message]");
{
  const c = makeClock();
  const m = new RunMetrics(c.clock, 4);
  m.start();
  c.now = 0;
  m.beginAssistantMessage(); // message_start
  c.now = 1000;
  m.contentStarted(); // first output event
  for (let i = 0; i < 40; i++) m.outputDelta("x".repeat(100)); // 4000 chars -> 1000 tokens est
  c.now = 6000;
  const s = m.snapshot();
  check("output estimated ~1000", near(s.outputTokens, 1000), `got ${s.outputTokens}`);
  check("genMs = 5000", near(s.genMs, 5000), `got ${s.genMs}`);
  check("weightedTps ~200", near(s.weightedTps, 200, 0.01), `got ${s.weightedTps}`);
  check("accuracy estimated", s.outputTokenAccuracy === "estimated", s.outputTokenAccuracy);
  check("partialOutputTokens ~1000", near(s.partialOutputTokens, 1000), `got ${s.partialOutputTokens}`);
  check("turns started 1", s.assistantTurnsStarted === 1);
  check("turns completed 0", s.assistantTurnsCompleted === 0);
  check("activeAssistantTurn 0", s.activeAssistantTurn === 0);
  check("liveTps ~200", near(s.liveTps, 200, 0.01), `got ${s.liveTps}`);
}

console.log("\n[timeout during stream]");
{
  const c = makeClock();
  const m = new RunMetrics(c.clock, 4);
  m.start();
  m.beginAssistantMessage();
  c.now = 1000;
  m.contentStarted();
  for (let i = 0; i < 40; i++) m.outputDelta("z".repeat(100));
  c.now = 6000;
  m.markAborted(); // timeout aborts the session
  const s = m.snapshot();
  check("retains output > 0", s.outputTokens > 0, `got ${s.outputTokens}`);
  check("retains genMs > 0", s.genMs > 0, `got ${s.genMs}`);
  check("retains weightedTps > 0", s.weightedTps > 0, `got ${s.weightedTps}`);
  check("aborted", s.aborted);
  check("accuracy estimated", s.outputTokenAccuracy === "estimated", s.outputTokenAccuracy);
}

console.log("\n[abort finalizes partial (terminal usage unreliable)]");
{
  const c = makeClock();
  const m = new RunMetrics(c.clock, 4);
  m.start();
  m.beginAssistantMessage();
  c.now = 1000;
  m.contentStarted();
  for (let i = 0; i < 40; i++) m.outputDelta("q".repeat(100)); // 1000 est
  c.now = 7000;
  m.markAborted();
  // The agent session emits a terminal message_end with stopReason "aborted" and an
  // unreliable/zero usage. This must NOT reset the accumulated partial to 0.
  m.endAssistantMessagePartial("aborted");
  const s = m.snapshot();
  check("partial preserved as completed turn (~1000)", near(s.outputTokens, 1000), `got ${s.outputTokens}`);
  check("turns completed 1", s.assistantTurnsCompleted === 1);
  check("no active turn remains", s.activeAssistantTurn === null);
  check("accuracy estimated (not reconciled)", s.outputTokenAccuracy === "estimated", s.outputTokenAccuracy);
  check("genMs preserved", near(s.genMs, 6000), `got ${s.genMs}`);
}

console.log("\n[normal reconciliation]");
{
  const c = makeClock();
  const m = new RunMetrics(c.clock, 4);
  m.start();
  m.beginAssistantMessage();
  c.now = 500;
  m.contentStarted();
  for (let i = 0; i < 38; i++) m.outputDelta("y".repeat(100)); // 3800 chars -> 950 tokens est
  c.now = 3000;
  m.endAssistantMessage({ output: 1000, input: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.2 } }, "stop");
  const s = m.snapshot();
  check("final output = exact 1000 (not 1950)", near(s.outputTokens, 1000), `got ${s.outputTokens}`);
  check("accuracy reconciled", s.outputTokenAccuracy === "reconciled", s.outputTokenAccuracy);
  check("no partial", s.partialOutputTokens === 0);
  check("genMs exact", near(s.genMs, 2500), `got ${s.genMs}`);
  check("exact cost", near(s.cost, 0.2), `got ${s.cost}`);
}

console.log("\n[multiple turns: complete + partial]");
{
  const c = makeClock();
  const m = new RunMetrics(c.clock, 4);
  m.start();
  // turn 0 completes exactly: 2000 chars -> 500 est, end reports 500 exact
  m.beginAssistantMessage();
  c.now = 100;
  m.contentStarted();
  for (let i = 0; i < 20; i++) m.outputDelta("a".repeat(100));
  c.now = 400;
  m.endAssistantMessage({ output: 500 }, "toolUse");
  // turn 1 still active / partial
  c.now = 900;
  m.beginAssistantMessage();
  c.now = 1000;
  m.contentStarted();
  for (let i = 0; i < 16; i++) m.outputDelta("b".repeat(100)); // 1600 chars -> 400 est
  c.now = 3000;
  const s = m.snapshot();
  check("output = completed exact 500 + active est 400", near(s.outputTokens, 900), `got ${s.outputTokens}`);
  check("genMs = (400-100) + (3000-1000)", near(s.genMs, 2300), `got ${s.genMs}`);
  check("turns started 2", s.assistantTurnsStarted === 2);
  check("turns completed 1", s.assistantTurnsCompleted === 1);
  check("activeAssistantTurn 1", s.activeAssistantTurn === 1);
  check("accuracy estimated", s.outputTokenAccuracy === "estimated", s.outputTokenAccuracy);
}

console.log("\n[partial survives tool-call transition]");
{
  const c = makeClock();
  const m = new RunMetrics(c.clock, 4);
  m.start();
  m.beginAssistantMessage();
  c.now = 100;
  m.contentStarted();
  for (let i = 0; i < 20; i++) m.outputDelta("c".repeat(100)); // 500 est
  m.toolCall(false); // tool execution in the SAME turn must not reset streaming state
  for (let i = 0; i < 20; i++) m.outputDelta("d".repeat(100)); // +500 est
  c.now = 4000;
  const s = m.snapshot();
  check("output accumulates across tool call (~1000)", near(s.outputTokens, 1000), `got ${s.outputTokens}`);
  check("still one active turn", s.activeAssistantTurn === 0 && s.assistantTurnsStarted === 1);
  check("tool counted", s.toolCalls === 1);
  check("genMs not reset (3900)", near(s.genMs, 3900), `got ${s.genMs}`);
}

console.log("\n[prefill timeout]");
{
  const c = makeClock();
  const m = new RunMetrics(c.clock, 4);
  m.start();
  m.beginAssistantMessage();
  c.now = 5000;
  m.markAborted(); // timed out before any output event
  const s = m.snapshot();
  check("output 0", s.outputTokens === 0, `got ${s.outputTokens}`);
  check("genMs 0", s.genMs === 0, `got ${s.genMs}`);
  check("activeGenerationMs 0", s.activeGenerationMs === 0);
  check("accuracy exact on empty prefill", s.outputTokenAccuracy === "exact", s.outputTokenAccuracy);
}

console.log("\n[format helpers]");
{
  check("formatOutput 420 -> 420", formatOutput(420) === "420");
  check("formatOutput 5800 -> 5.8k", formatOutput(5800) === "5.8k");
  check("formatOutput 2000 -> 2k", formatOutput(2000) === "2k");
  check("formatOutput 11600 -> 11.6k", formatOutput(11600) === "11.6k");
}

console.log("\n[backward compatibility: old results without new fields still render]");
{
  const oldMetrics: any = {
    wallMs: 60000, genMs: 20000, outputTokens: 5000, inputTokens: 1000,
    cacheRead: 0, cacheWrite: 0, cost: 0.5, weightedTps: 250, wallTps: 83.3,
    generations: 2, toolCalls: 3, toolErrors: 0, stopReasons: ["toolUse", "stop"], aborted: false,
  };
  const oldRun: any = {
    id: "old-1", benchmark: "pagoda", promptVersion: "v1", runIndex: 1, timestamp: "2026-01-01",
    model: { provider: "strata-auto", id: "swift-1.5-iq3_xxs", name: "x" },
    thinkingLevel: "low", workspace: "ws", runDir: "rd", sessionFile: null, outcome: "PASS",
    reasons: [], metrics: oldMetrics,
    artifact: { found: false, path: null, name: null, sizeBytes: 0, candidates: [], checks: {}, staticOk: false },
    browser: { attempted: false, skipped: true, ok: false, consoleErrors: [], errors: [] },
    visual: null,
    timings: { agentMs: 1, validationMs: 0 },
  };
  let threw = false;
  try {
    const detail = formatRunDetail(oldRun as any);
    check("formatRunDetail renders old results", detail.includes("PASS"), detail.slice(0, 80));
    const line = liveLine(oldMetrics);
    check("liveLine renders old results", line.length > 0);
  } catch (e) {
    threw = true;
    console.error(e);
  }
  check("old result did not throw", !threw);
}

async function main(): Promise<void> {
  console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main();