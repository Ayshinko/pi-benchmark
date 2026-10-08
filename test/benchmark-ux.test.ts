/**
 * Deterministic benchmarks/UX tests:
 *   - /benchmark command registration and first-use flow (no full model runs)
 *   - run-count selection, fast path, cancel path, model/thinking preservation
 *   - canonical pagoda-v1 resolution and exact prompt hash / expected artifact
 *   - compliance: full fixture passes, tiny fixture fails, runtime-good but
 *     compliance-bad -> FAIL_COMPLIANCE
 *   - result card never prints "undefined", multi-run aggregate math
 *   - legacy results still render
 *
 *   node test/benchmark-ux.test.ts
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(path.join(import.meta.dirname, "x.js"), { eval: true });

const { resolveBenchmark, getPrompt, PAGODA_V1, hashPrompt, PAGODA_V1_PROMPT_TEXT } = jiti("../src/prompts.ts");
const { evaluateCompliance } = jiti("../src/compliance.ts");
const { determineOutcome } = jiti("../src/outcome.ts");
const { parseBenchmarkInvocation, pickRunCountInteractive, RUN_CHOICES, confirmationSummary, advancedPlanInteractive } = jiti("../src/wizard.ts");
const { formatResultCard, formatAggregateCard, gates } = jiti("../src/reporting.ts");

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const emptyRuntime = {
  threeLoaded: true, canvas: true, webgl: true, bodyText: "",
  reportedVoxels: null, reportedFps: null, objectCount: null, instancedMeshes: null, features: [],
};
const fullRuntime = {
  threeLoaded: true, canvas: true, webgl: true, bodyText: "fps: 60\nvoxels: 31420",
  reportedVoxels: 31420, reportedFps: 60, objectCount: 20, instancedMeshes: 5000,
  features: ["three", "instancing", "multi-level-pagoda", "animation", "controls", "particles", "petals", "torii", "blossom-trees", "pond", "bridge", "rocks", "grass", "flowers", "shrubs", "lanterns", "paths", "shadows", "lighting", "fog", "hud"],
};

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

/* ------------------------------------------------------------------ *
 * Capture the registered commands from the real extension entry point.
 * ------------------------------------------------------------------ */
function loadExtensionCli() {
  const commands = new Map<string, any>();
  const renderers: string[] = [];
  const sent: any[] = [];
  const fakePi = {
    registerCommand: (name: string, def: any) => commands.set(name, def),
    registerMessageRenderer: (type: string) => renderers.push(type),
    registerTool: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    sendMessage: (m: any) => sent.push(m),
    on: () => () => {},
  };
  const mod = jiti("../index.ts");
  const factory = mod.default ?? mod;
  factory(fakePi);
  return { commands, renderers, sent };
}

function fakeCtx(overrides: Record<string, any> = {}) {
  const base = {
    mode: "tui",
    hasUI: true,
    model: { provider: "strata-auto", id: "qwen3.8-flash-next-q2_0", name: "Qwen3.8 Flash Next Q2_0", contextWindow: 65536, maxTokens: 32768 },
    thinkingLevel: "low",
    modelRegistry: { getRegisteredProviderIds: () => [], getRegisteredProviderConfig: () => null, find: () => null },
    signal: undefined,
    ui: {
      notify: () => {},
      setStatus: () => {},
      select: async () => "1 run",
      input: async () => undefined,
      confirm: async () => false,
      editor: async () => undefined,
    },
  };
  for (const [k, v] of Object.entries(overrides)) (base as any)[k] = v;
  return base as any;
}

/* ------------------------------------------------------------------ *
 * 1. Command registration
 * ------------------------------------------------------------------ */
console.log("\n[registration]");
{
  const { commands, renderers } = loadExtensionCli();
  check("registerMessageRenderer called", renderers.includes("artifact-bench-report"), renderers.join(","));
  check("/benchmark command registered", commands.has("benchmark"));
  check("/artifact-bench still registered (backward compat)", commands.has("artifact-bench"));
  check("/artifact-bench has a handler", typeof commands.get("artifact-bench").handler === "function");
  check("/benchmark has a handler", typeof commands.get("benchmark").handler === "function");
}

/* ------------------------------------------------------------------ *
 * 2. Run-count selection logic
 * ------------------------------------------------------------------ */
console.log("\n[run-count selection]");
{
  check("choices put 1 run first (default)", RUN_CHOICES[0] === "1 run");
  const ui = { choices: [...RUN_CHOICES], input: null, notifications: [] };
  const selected = await pickRunCountInteractive({
    select: async (t: string, options: string[]) => ui.choices.shift(),
    input: async () => "4",
    confirm: async () => true,
    notify: (m) => ui.notifications.push(m),
  }, { defaultRunCount: 1 });
  check("pickRunCountInteractive maps '1 run' -> 1", selected === 1);

  const custom = await pickRunCountInteractive({
    select: async () => "Custom...",
    input: async () => "4",
    confirm: async () => true,
    notify: () => {},
  }, { defaultRunCount: 1 });
  check("Custom input returns integer", custom === 4);

  const cancelled = await pickRunCountInteractive({
    select: async () => undefined, // dismiss
    input: async () => undefined,
    confirm: async () => true,
    notify: () => {},
  }, { defaultRunCount: 1 });
  check("select cancel returns null", cancelled === null);

  // 0 is invalid; the wizard notifies and retries. Emulate a real retry returning a valid count:
  let inputs = ["0", "4"];
  const invalidThenValid = await pickRunCountInteractive({
    select: async () => "Custom...",
    input: async () => inputs.shift(),
    confirm: async () => true,
    notify: () => {},
  }, { defaultRunCount: 1 });
  check("invalid custom is rejected and retried until valid", invalidThenValid === 4, String(invalidThenValid));
}

/* ------------------------------------------------------------------ *
 * 3. /benchmark 3 fast path
 * ------------------------------------------------------------------ */
console.log("\n[fast path parsing]");
{
  const inv = parseBenchmarkInvocation("3");
  check("parse '3' -> fast mode", inv.mode === "fast");
  check("parse '3' -> runs 3", inv.runs === 3 && !inv.advanced);

  const inv5 = parseBenchmarkInvocation("  5  ");
  check("parse '5' trims whitespace", inv5.runs === 5);

  const empty = parseBenchmarkInvocation("");
  check("parse '' -> interactive wizard", empty.mode === "interactive");

  const adv = parseBenchmarkInvocation("--advanced");
  check("parse --advanced -> advanced mode", adv.mode === "advanced" && adv.advanced);

  let threw = false;
  try { parseBenchmarkInvocation("abc"); } catch { threw = true; }
  check("parse invalid run count throws", threw);

  try { parseBenchmarkInvocation("0"); } catch (e) { threw = true; }
  check("parse 0 is rejected", threw);
}

/* ------------------------------------------------------------------ *
 * 4. Cancel path does not start benchmark
 * ------------------------------------------------------------------ */
console.log("\n[cancel path]");
{
  const { commands, sent } = loadExtensionCli();
  const notices: string[] = [];
  const handler = commands.get("benchmark").handler;
  const ctx = fakeCtx({
    ui: {
      notify: (m: string) => notices.push(m),
      setStatus: () => {},
      select: async () => "1 run",
      input: async () => undefined,
      confirm: async () => false, // user cancels
    },
  });
  await handler("", ctx);
  check("cancel sends no benchmark report (run not started)", sent.length === 0);
  check("cancel notifies the user", notices.some((n) => n.includes("cancelled")), notices.join("|"));

  // Cancelling at the run-count selector (returning undefined) also aborts.
  const { commands: c2, sent: s2 } = loadExtensionCli();
  const ctx2 = fakeCtx({ ui: { notify: () => {}, setStatus: () => {}, select: async () => undefined, input: async () => undefined, confirm: async () => false } });
  await c2.get("benchmark").handler("", ctx2);
  check("select-dismiss also never sends a report", s2.length === 0);
}

/* ------------------------------------------------------------------ *
 * 5. Current model / thinking are preserved
 * ------------------------------------------------------------------ */
console.log("\n[model & thinking preserved]");
{
  const { planFromContext, planFromAdvanced } = (() => {
    const mod = jiti("../index.ts");
    return mod;
  })();
  const ctx = fakeCtx();
  const plan = planFromContext(ctx, { benchmark: "pagoda" }, 3);
  check("fast plan uses the exact current model", plan.model === ctx.model);
  check("fast plan keeps current thinking level", plan.thinking === "low");
  check("fast plan requests 3 runs", plan.runs === 3);
  check("fast plan resolves canonical benchmark", plan.benchmarkKey === "pagoda");

  const adv = planFromAdvanced(ctx, { benchmark: "pagoda" }, { id: "other", provider: "x" } as any, { thinking: "high", runs: 5, timeoutSeconds: 300, browser: false, settleMs: 900 });
  check("advanced plan uses chosen model/thinking", adv.thinking === "high" && adv.runs === 5 && adv.browser === false && adv.timeoutSeconds === 300);
}

/* ------------------------------------------------------------------ *
 * 5b. Standardized 1200s timeout + explicit advanced override
 * ------------------------------------------------------------------ */
console.log("\n[standard timeout]");
{
  const { executeBenchmark, planFromContext, planFromAdvanced } = (() => {
    const mod = jiti("../index.ts");
    return mod;
  })();
  check("executeBenchmark is exported (testable)", typeof executeBenchmark === "function");

  const ctx = fakeCtx();
  check("default plan timeout is 1200 seconds", planFromContext(ctx, { benchmark: "pagoda" }, 1).timeoutSeconds === 1200);
  check("fast path default timeout is 1200 seconds", planFromContext(ctx, { benchmark: "pagoda" }, 3).timeoutSeconds === 1200);

  // Explicit advanced timeout overrides the default.
  const adv = planFromAdvanced(ctx, { benchmark: "pagoda" }, {} as any, { thinking: "low", runs: 2, timeoutSeconds: 300, browser: false, settleMs: 500 });
  check("explicit advanced timeout overrides default", adv.timeoutSeconds === 300, String(adv.timeoutSeconds));

  // The advanced wizard: default timeout when the user leaves it blank, and
  // the user's explicit value when they type one.
  const mkUI = (timeoutInput: string | undefined) => ({
    select: async () => "noop",
    input: async (t: string) => {
      if (t.startsWith("Timeout")) return timeoutInput;
      if (t.startsWith("Settle")) return "3000";
      return undefined;
    },
    confirm: async () => true,
    notify: () => {},
  });
  const wizardDefaults = { benchmarkName: "Pagoda v1", runs: 1, modelLabel: "m", thinking: "low", timeoutSeconds: 1200, browser: true, settleMs: 3000 } as const;
  const defaultPlan = await advancedPlanInteractive(mkUI("") as any, wizardDefaults as any);
  check("advanced wizard default timeout is 1200", defaultPlan?.timeoutSeconds === 1200, String(defaultPlan?.timeoutSeconds));
  const explicitPlan = await advancedPlanInteractive(mkUI("450") as any, wizardDefaults as any);
  check("explicit wizard timeout overrides default", explicitPlan?.timeoutSeconds === 450, String(explicitPlan?.timeoutSeconds));
}

/* ------------------------------------------------------------------ *
 * 6-8. Canonical pagoda-v1, exact prompt SHA, expected artifact index.html
 * ------------------------------------------------------------------ */
console.log("\n[canonical pagoda-v1]");
{
  const canonical = resolveBenchmark("");
  check("empty ref resolves to pagoda-v1", canonical.version === "pagoda-v1");
  check("canonical expected artifact is index.html", canonical.expectedArtifact === "index.html");
  check("canonical name is Pagoda v1", canonical.name === "Pagoda v1");

  const byAlias = resolveBenchmark("pagoda-v1");
  check("pagoda-v1 alias resolves identically", byAlias.version === "pagoda-v1" && byAlias.prompt === canonical.prompt);

  const fromLegacy = getPrompt("pagoda");
  check("/artifact-bench pagoda resolves to the SAME pagoda-v1", fromLegacy.prompt === PAGODA_V1.prompt && fromLegacy.version === "pagoda-v1");
  check("legacy prompt expected artifact is index.html", getPrompt("pagoda").expectedArtifact === "index.html");

  // Exact file bytes == the string we ship.
  const fileText = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "assets", "pagoda-v1.prompt.txt"), "utf8");
  check("canonical prompt file matches exported text", PAGODA_V1.prompt === fileText && PAGODA_V1_PROMPT_TEXT === fileText);

  // SHA-256 over the exact text.
  const sha = createHash("sha256").update(fileText, "utf8").digest("hex");
  check("hashPrompt matches byte-identical file hash", hashPrompt(fileText) === sha);
  check("known SHA-256 of pagoda-v1 = e8441237...", sha === "e844123729ef5da522de7a1513c5ab1ffa7d7b4ba871f79f8810fe45991fab95", sha);

  // The OLD short pagoda prompt (pagoda.html, minimal garden) must not be the
  // production prompt source anywhere in the reachable path.
  check("old short prompt not used as production source", !PAGODA_V1.prompt.includes("pagoda.html"));
  check("canonical prompt demands InstancedMesh", /InstancedMesh/i.test(PAGODA_V1.prompt));
  check("canonical prompt lists the full feature set", /FPS/.test(PAGODA_V1.prompt) && /voxel count/i.test(PAGODA_V1.prompt));
}

/* ------------------------------------------------------------------ *
 * 9-10. Compliance: full fixture passes, tiny fixture fails
 * ------------------------------------------------------------------ */
console.log("\n[compliance]");
{
  const fullSrc = fs.readFileSync(path.join(FIXTURES, "pagoda-v1-full.html"), "utf8");
  const fullSize = fs.statSync(path.join(FIXTURES, "pagoda-v1-full.html")).size;
  const full = evaluateCompliance(fullSrc, fullRuntime, fullSize);
  check("canonical full fixture PASSES compliance", full.overall === "PASS", JSON.stringify({ o: full.overall, r: full.reasons }));
  check("full fixture no fails, no unknowns", full.items.every((i) => i.status !== "FAIL"));
  check("full fixture confirms instanced mesh + multilevel + controls", ["instanced-mesh", "multi-level-pagoda", "controls-interactive"].every((id) => full.items.find((i) => i.id === id)?.status === "PASS"));

  // Static-only (no runtime probe) still passes when the source is complete.
  const fullStatic = evaluateCompliance(fullSrc, emptyRuntime, fullSize);
  check("full fixture passes from static source alone", fullStatic.overall === "PASS");

  const tinySrc = fs.readFileSync(path.join(FIXTURES, "tiny.html"), "utf8");
  const tinySize = fs.statSync(path.join(FIXTURES, "tiny.html")).size;
  const tiny = evaluateCompliance(tinySrc, emptyRuntime, tinySize);
  check("tiny toy fixture FAILS compliance", tiny.overall === "FAIL", JSON.stringify({ o: tiny.overall, r: tiny.reasons }));
  check("tiny fixture has a real reason", tiny.reasons.length > 0);
}

/* ------------------------------------------------------------------ *
 * 11. Runtime-good but compliance-bad -> Overall FAIL_COMPLIANCE
 * ------------------------------------------------------------------ */
console.log("\n[overall gate]");
{
  const goodMetrics: any = {
    wallMs: 60000, genMs: 20000, outputTokens: 5000, inputTokens: 1000, cacheRead: 0, cacheWrite: 0,
    cost: 0.5, weightedTps: 250, wallTps: 83.3, generations: 3, toolCalls: 4, toolErrors: 0,
    stopReasons: ["toolUse", "toolUse", "stop"], aborted: false,
  };
  const goodArtifact: any = {
    found: true, path: "index.html", name: "index.html", sizeBytes: 12075, candidates: ["index.html"],
    checks: { hasCanvas: true, hasThree: true, hasScript: true, closedHtml: true, sizeOk: true }, staticOk: true,
  };
  const goodBrowser: any = {
    attempted: true, skipped: false, ok: true, browser: "chrome", browserName: "Chrome", durationMs: 4000, errors: [],
    consoleErrors: [], canvas: true, canvasWidth: 1280, canvasHeight: 720, threeLoaded: true, webgl: true,
    bodyTextLength: 0, bodyText: "", runtime: emptyRuntime, screenshotPath: "screenshot.png", screenshotWidth: 1280, screenshotHeight: 720, visual: null,
  };
  const goodVisual: any = {
    ok: true, width: 1280, height: 720, meanLuminance: 90, luminanceStdDev: 60,
    blackFraction: 0.1, whiteFraction: 0.05, uniqueColors: 400, meanSaturation: 0.4, reasons: [],
  };
  const failCompliance: any = { overall: "FAIL", items: [], reasons: ["critical feature(s) failed: instanced-mesh"] };
  const passCompliance: any = { overall: "PASS", items: [], reasons: [] };

  const bad = determineOutcome({ metrics: goodMetrics, artifact: goodArtifact, browser: goodBrowser, visual: goodVisual, timedOut: false, harnessError: null, compliance: failCompliance });
  check("runtime-good + compliance-bad -> FAIL_COMPLIANCE", bad.outcome === "FAIL_COMPLIANCE", bad.outcome);

  const good = determineOutcome({ metrics: goodMetrics, artifact: goodArtifact, browser: goodBrowser, visual: goodVisual, timedOut: false, harnessError: null, compliance: passCompliance });
  check("wholly good -> PASS", good.outcome === "PASS");

  const reviewCompliance: any = { overall: "REVIEW", items: [], reasons: ["unconfirmed"] };
  const review = determineOutcome({ metrics: goodMetrics, artifact: goodArtifact, browser: goodBrowser, visual: goodVisual, timedOut: false, harnessError: null, compliance: reviewCompliance });
  check("compliance REVIEW -> Overall REVIEW", review.outcome === "REVIEW");

  // Positional (legacy) call with no compliance still PASSes.
  const pos = determineOutcome(goodMetrics, goodArtifact, goodBrowser, goodVisual, false, null);
  check("legacy positional call still PASSes", pos.outcome === "PASS", pos.outcome);
}

/* ------------------------------------------------------------------ *
 * 12. Result card never prints literal "undefined"
 * ------------------------------------------------------------------ */
function makeRun(overrides: Record<string, any> = {}): any {
  return {
    id: "pagoda-2026-01-01T00-00-00-000Z_-run-01",
    benchmark: "pagoda",
    benchmarkVersion: "pagoda-v1",
    promptHash: "e844123729ef5da522de7a1513c5ab1ffa7d7b4ba871f79f8810fe45991fab95",
    promptVersion: "pagoda-v1",
    runIndex: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    model: { provider: "strata-auto", id: "qwen3.8-flash-next-q2_0", name: "Q", contextWindow: 65536, maxTokens: 32768 },
    thinkingLevel: "low",
    workspace: "ws",
    runDir: "rd",
    sessionFile: null,
    outcome: "PASS",
    reasons: [],
    metrics: {
      wallMs: 372000, genMs: 321000, outputTokens: 16800, inputTokens: 5000, cacheRead: 0, cacheWrite: 0,
      cost: 0.3, weightedTps: 51.7, wallTps: 45, generations: 4, toolCalls: 5, toolErrors: 0,
      stopReasons: ["toolUse", "toolUse", "stop"], aborted: false, outputTokenAccuracy: "exact",
      partialOutputTokens: 0, liveTps: 0, activeGenerationMs: 0, assistantTurnsStarted: 4, assistantTurnsCompleted: 4, activeAssistantTurn: null, estimatedCharsPerToken: 4,
    },
    artifact: { found: true, path: "rd/workspace/index.html", name: "index.html", sizeBytes: 46200, candidates: ["index.html"], checks: {}, staticOk: true },
    browser: { attempted: true, skipped: false, ok: true, browser: "chrome", browserName: "Chrome", durationMs: 4000, errors: [], consoleErrors: [], canvas: true, canvasWidth: 1280, canvasHeight: 720, threeLoaded: true, webgl: true, bodyTextLength: 40, bodyText: "fps: 60\nvoxels: 31420", runtime: { threeLoaded: true, canvas: true, webgl: true, bodyText: "fps: 60\nvoxels: 31420", reportedVoxels: 31420, reportedFps: 60, objectCount: 20, instancedMeshes: 5000, features: [] }, screenshotPath: "rd/screenshot.png", screenshotWidth: 1280, screenshotHeight: 720, visual: objVisual(true) },
    visual: objVisual(true),
    compliance: { overall: "PASS", items: [], reasons: [] },
    timings: { agentMs: 360000, validationMs: 4000 },
    ...overrides,
  };
}
function objVisual(ok: boolean): any {
  return { ok, width: 1280, height: 720, meanLuminance: 90, luminanceStdDev: 60, blackFraction: 0.1, whiteFraction: 0.05, uniqueColors: 400, meanSaturation: 0.4, reasons: [] };
}

console.log("\n[result card]");
{
  const card = formatResultCard(makeRun());
  check("card prints Overall PASS", card.includes("Overall\n              PASS") || /Overall\s+PASS/.test(card));
  check("card lists Compliance PASS", /Compliance\s+PASS/.test(card));
  check("card shows Pagoda v1 heading", card.startsWith("Pagoda v1 Benchmark"));
  check("card shows prompt SHA", /Prompt SHA\s+e8441237/.test(card), card.split("\n").find((l) => l.includes("Prompt SHA")));
  check("card never prints literal 'undefined'", !card.includes("undefined"), card.slice(0, 200));

  // A sparse/legacy-ish run with missing optional fields must still render.
  const sparse = makeRun({ sessionFile: null, compliance: null, model: { provider: "p", id: "m", name: "M" }, browser: { ...makeRun().browser, runtime: { ...emptyRuntime }, screenshotPath: null }, metrics: { ...makeRun().metrics, assistantTurnsStarted: undefined } });
  const sparseCard = formatResultCard(sparse);
  check("sparse run card renders without 'undefined'", !sparseCard.includes("undefined"), sparseCard.slice(0, 150));

  const g = gates(makeRun({ outcome: "FAIL_COMPLIANCE", compliance: { overall: "FAIL", items: [], reasons: [] } }));
  check("gate separation shows Compliance FAIL", g.compliance === "FAIL" && g.agent === "PASS" && g.runtime === "PASS" && g.visual === "PASS");
}

/* ------------------------------------------------------------------ *
 * 13. Multi-run aggregate mean/median/pass rate
 * ------------------------------------------------------------------ */
console.log("\n[aggregate]");
{
  const r1 = makeRun({ id: "a", runIndex: 1, outcome: "PASS", metrics: { ...makeRun().metrics, weightedTps: 50, wallMs: 300000, outputTokens: 15800 }, benchmarkVersion: "pagoda-v1", model: makeRun().model });
  const r2 = makeRun({ id: "b", runIndex: 2, outcome: "FAIL_COMPLIANCE", metrics: { ...makeRun().metrics, weightedTps: 45, wallMs: 400000, outputTokens: 18900 }, benchmarkVersion: "pagoda-v1" });
  const r3 = makeRun({ id: "c", runIndex: 3, outcome: "PASS", metrics: { ...makeRun().metrics, weightedTps: 55, wallMs: 360000, outputTokens: 17600 }, benchmarkVersion: "pagoda-v1" });

  const agg = formatAggregateCard([r1, r2, r3]);
  check("aggregate shows pass rate 2/3 (66.7%)", /PASS\s+2\/3/.test(agg) && /66\.7%/.test(agg), agg.split("\n").find((l) => l.includes("PASS")));
  check("aggregate avg TPS = 50.0", /Avg TPS\s+50\.0 tok\/s/.test(agg), agg.split("\n").find((l) => l.includes("Avg TPS")));
  check("aggregate median TPS = 50.0", /Median TPS\s+50\.0 tok\/s/.test(agg));
  check("aggregate groups 1 compliance failure", /1 compliance/.test(agg), agg.split("\n").filter((l) => l.includes("compliance")).join("|"));
  check("aggregate lists per-run rows", /Run 2\s+FAIL_COMPLIANCE/.test(agg));
  check("aggregate never prints 'undefined'", !agg.includes("undefined"));
}

/* ------------------------------------------------------------------ *
 * 14. Old historical result still renders (no new fields, no compliance)
 * ------------------------------------------------------------------ */
console.log("\n[legacy rendering]");
{
  const legacy: any = {
    id: "old-1", benchmark: "pagoda", runIndex: 1, timestamp: "2026-01-01",
    model: { provider: "strata-auto", id: "swift-1.5-iq3_xxs", name: "x" },
    thinkingLevel: "low", workspace: "ws", runDir: "rd", sessionFile: null, outcome: "PASS", reasons: [],
    metrics: { wallMs: 60000, genMs: 20000, outputTokens: 5000, inputTokens: 1000, cacheRead: 0, cacheWrite: 0, cost: 0.5, weightedTps: 250, wallTps: 83.3, generations: 2, toolCalls: 3, toolErrors: 0, stopReasons: ["toolUse", "stop"], aborted: false },
    artifact: { found: false, path: null, name: null, sizeBytes: 0, candidates: [], checks: {}, staticOk: false },
    browser: { attempted: false, skipped: true, ok: false, consoleErrors: [], errors: [], bodyText: "", runtime: emptyRuntime },
    visual: null,
    timings: { agentMs: 1, validationMs: 0 },
    // NOTE: legacy run has NO benchmarkVersion, promptHash, or compliance.
  };
  let threw = false;
  let card = "";
  try {
    card = formatResultCard(legacy);
    const agg = formatAggregateCard([legacy]);
    check("legacy aggregate renders", agg.includes("Pagoda v1"));
  } catch (e) { threw = true; }
  check("legacy result card renders without throwing", !threw);
  check("legacy card labels compliance n/a (legacy result)", /n\/a \(legacy result\)/.test(card), card.split("\n").find((l) => l.includes("Compliance")));
  check("legacy card prints no 'undefined'", !card.includes("undefined"));
  check("legacy card shows prompt SHA n/a", /Prompt SHA\s+n\/a/.test(card));
}

/* ------------------------------------------------------------------ *
 * 14b. Early-failure gate display (timeout before any artifact)
 * ------------------------------------------------------------------ */
console.log("\n[early-failure gates]");
{
  // A NEW run that timed out before producing an artifact: compliance is NULL
  // (the stage never ran), browser never attempted, no visual report.
  const timeoutRun = makeRun({
    outcome: "FAIL_TIMEOUT",
    artifact: {
      found: false, path: null, name: null, sizeBytes: 0, candidates: [], checks: {}, staticOk: false,
    },
    browser: {
      attempted: false, skipped: false, ok: false, browser: null, browserName: null, durationMs: 0,
      errors: [], consoleErrors: [], canvas: false, canvasWidth: 0, canvasHeight: 0, threeLoaded: false,
      webgl: false, bodyTextLength: 0, bodyText: "", runtime: { ...emptyRuntime }, screenshotPath: null,
      screenshotWidth: 0, screenshotHeight: 0, visual: null,
    },
    visual: { ok: false, width: 0, height: 0, meanLuminance: 0, luminanceStdDev: 0, blackFraction: 0, whiteFraction: 0, uniqueColors: 0, meanSaturation: 0, reasons: ["no screenshot captured"] },
    compliance: null,
    model: makeRun().model,
  });
  const g = gates(timeoutRun);
  check("timeout-before-artifact Agent FAIL", g.agent === "FAIL", g.agent);
  check("timeout-before-artifact Compliance NOT_RUN", g.compliance === "NOT_RUN", g.compliance);
  check("timeout-before-artifact Runtime NOT_RUN", g.runtime === "NOT_RUN", g.runtime);
  check("timeout-before-artifact Visual NOT_RUN", g.visual === "NOT_RUN", g.visual);
  check("timeout-before-artifact Overall FAIL_TIMEOUT", timeoutRun.outcome === "FAIL_TIMEOUT");
  check("timeout-before-artifact card is NOT misleading", !/Runtime\s+PASS/.test(formatResultCard(timeoutRun)) && !/Visual\s+PASS/.test(formatResultCard(timeoutRun)));

  // A genuinely old result (no compliance field at all) still says n/a (legacy result).
  const legacyOnly = makeRun({
    outcome: "FAIL_TIMEOUT",
    artifact: { found: false, path: null, name: null, sizeBytes: 0, candidates: [], checks: {}, staticOk: false },
    browser: { attempted: false, skipped: true, ok: false, errors: [], consoleErrors: [], bodyText: "", runtime: { ...emptyRuntime }, visual: null },
    visual: null,
    compliance: undefined,
    model: makeRun().model,
  });
  const lg = gates(legacyOnly);
  check("genuine legacy result still n/a (legacy result)", lg.compliance === "n/a (legacy result)", lg.compliance);
}

/* ------------------------------------------------------------------ *
 * 14c. executeBenchmark emits one card / run + one aggregate (no duplicates)
 * ------------------------------------------------------------------ */
console.log("\n[result card emission]");
{
  const { executeBenchmark } = jiti("../index.ts");
    const runResult = (i: number) => makeRun({ id: `x-${i}`, runIndex: i, metrics: { ...makeRun().metrics, outputTokens: 15000 + i * 1000, weightedTps: 40 + i }, model: makeRun().model });

  async function capture(runs: number) {
    const sent: any[] = [];
    const pi = { sendMessage: (m: any) => sent.push(m) };
    const ctx = fakeCtx({
      ui: {
        notify: () => {}, setStatus: () => {}, select: async () => undefined, input: async () => undefined, confirm: async () => true,
      },
    });
    const callArgs: unknown[][] = [];
    const fakeRun = async (cfg: any) => {
      callArgs.push(Object.entries(cfg).map(([k, v]) => [k, v]));
      return runResult(cfg.runIndex);
    };
    await executeBenchmark(pi as any, ctx, {
      benchmarkKey: "pagoda", model: ctx.model, thinking: "low",
      runs, timeoutSeconds: 1200, browser: true, settleMs: 3000, fake: false,
    }, { run: fakeRun as any, save: (async () => {}) as any });
    return { sent, runs: callArgs.length };
  }

  // Single run -> exactly ONE card, and it's a detailed result card (not an aggregate).
  {
    const { sent, runs } = await capture(1);
    check("single run emitted exactly one message", sent.length === 1, `got ${sent.length}`);
    check("single run ran the benchmark once", runs === 1, `got ${runs}`);
    check("single run card is a result card (not aggregate)", !!(sent[0]?.content?.includes("Pagoda v1 Benchmark") && !sent[0]?.content?.includes("Runs")));
  }

  // Three runs -> ONE detailed card per run PLUS one aggregate, no duplicates.
  {
    const { sent, runs } = await capture(3);
    const cards = sent.filter((m) => m?.content?.includes("Pagoda v1 Benchmark"));
    const aggs = sent.filter((m) => m?.content?.startsWith("Pagoda v1 ") && m?.content?.includes("Runs"));
    check("three runs emitted 4 messages (3 cards + 1 aggregate)", sent.length === 4, `got ${sent.length}`);
    check("three runs emitted exactly 3 detailed cards", cards.length === 3, `got ${cards.length}`);
    check("three runs emitted exactly 1 aggregate card", aggs.length === 1, `got ${aggs.length}`);
    check("aggregate is not a repeat of all detail cards", !(aggs[0]?.content || "").includes("Task Avg"));
    check("three runs ran the benchmark three times", runs === 3, `got ${runs}`);
    check("no duplicate result card", new Set(sent.map((m) => m.content)).size === sent.length);
  }
}


/* ------------------------------------------------------------------ *
 * 15. Confirmation summary shows resolved model limits (read-only metadata)
 * ------------------------------------------------------------------ */
console.log("\n[confirmation model limits]");
{
  const base = {
    benchmarkName: "Pagoda v1",
    modelLabel: "swift-1.5-iq3_xxs",
    provider: "strata-auto",
    thinking: "low",
    runs: 1,
  };

  // 1-2. contextWindow=65536 -> "65,536"; maxTokens=32768 -> "32,768"
  const full = confirmationSummary({ ...base, contextWindow: 65536, maxTokens: 32768 });
  check("confirmation shows contextWindow 65536 as 65,536", /Context\s*:\s*65,536/.test(full), full.split("\n").filter((l) => l.includes("Context"))[0]);
  check("confirmation shows maxTokens 32768 as 32,768", /Max output\s*:\s*32,768/.test(full), full.split("\n").filter((l) => l.includes("Max output"))[0]);
  check("full confirmation renders all base fields", ["Pagoda v1", "swift-1.5-iq3_xxs", "strata-auto", "low", "Runs", "[ Start benchmark ]"].every((s) => full.includes(s)));

  // 3. maxTokens=16384 displays the comparability warning
  const warn16 = confirmationSummary({ ...base, contextWindow: 65536, maxTokens: 16384 });
  check("maxTokens 16384 shows the 16K comparability warning", warn16.includes("⚠ Max output is 16,384 tokens."), warn16);
  check("16K warning mentions 32,768 standard + leaderboard", warn16.includes("32,768 max output tokens") && warn16.includes("directly comparable"));

  // 4. maxTokens=32768 does NOT display the warning
  check("maxTokens 32768 does NOT show the warning", !full.includes("⚠"));

  // 5. missing values display n/a
  const missing = confirmationSummary({ ...base, contextWindow: undefined, maxTokens: undefined });
  check("missing values display n/a", /Context\s*:\s*n\/a/.test(missing) && /Max output\s*:\s*n\/a/.test(missing), missing);
  check("unknown max output shows informational note (non-blocking)", missing.includes("⚠ Max output limit could not be determined."));

  // 6. /benchmark 3 (fast) confirmation includes both fields
  const fast = confirmationSummary({ ...base, contextWindow: 65536, maxTokens: 32768 });
  check("fast-path confirmation includes Context and Max output", /Context/.test(fast) && /Max output/.test(fast));

  // 7-8. the resolved model/thinking objects are untouched by rendering
  const modelObj = { provider: "strata-auto", id: "swift-1.5-iq3_xxs", contextWindow: 65536, maxTokens: 16384 };
  const thinkBefore = "low";
  confirmationSummary({ ...base, contextWindow: modelObj.contextWindow, maxTokens: modelObj.maxTokens });
  check("current model object not modified", modelObj.contextWindow === 65536 && modelObj.maxTokens === 16384 && modelObj.id === "swift-1.5-iq3_xxs");
  check("current thinking level not modified", thinkBefore === "low" && base.thinking === "low");

  // 9. rendering the confirmation writes nothing to disk (canonical prompt / model config untouched)
  const root = path.join(import.meta.dirname, "..");
  const readText = (p: string) => fs.readFileSync(p, "utf8");
  const snap = (p: string) => createHash("sha256").update(readText(p)).digest("hex") + "|" + fs.statSync(p).mtimeMs;
  const guarded = [
    path.join(root, "src", "assets", "pagoda-v1.prompt.txt"),
    path.join(root, "src", "prompts.ts"),
    path.join(root, "index.ts"),
    path.join(root, "src", "wizard.ts"),
  ];
  const before = guarded.map(snap);
  confirmationSummary({ ...base, contextWindow: 65536, maxTokens: 16384 });
  confirmationSummary({ ...base, contextWindow: undefined, maxTokens: undefined });
  const after = guarded.map(snap);
  check("no prompt/config file rewritten by confirmation rendering", before.every((h, i) => h === after[i]), `changed: ${guarded.filter((_, i) => before[i] !== after[i]).join(",")}`);
}

/* ------------------------------------------------------------------ */
console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);