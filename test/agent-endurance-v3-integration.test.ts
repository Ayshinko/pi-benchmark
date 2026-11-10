/**
 * Agent Endurance V3 integration tests (no model tokens, no live benchmark run).
 *
 * Covers: suite discovery, immutable prompt, run isolation + resume isolation,
 * session-event and transcript parsing, premature-stop classification, scoring
 * rules (including UNKNOWN handling), independent evaluator behaviour and
 * isolation, and result persistence with merged history roots.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  AGENT_ENDURANCE_V3,
  AGENT_ENDURANCE_V4,
  AGENT_ENDURANCE_V5,
  AGENT_ENDURANCE_V5_REGISTERED_SHA256,
  AGENT_ENDURANCE_V3_CONTINUATION_PROMPT,
  AGENT_ENDURANCE_V3_CONTINUATION_VERSION,
  PAGODA_V1,
  hashPrompt,
  productionBenchmarks,
  resolveBenchmark,
} from "../src/prompts.ts";
import { buildRunPaths } from "../src/runner.ts";
import { mergeEnduranceTelemetry, parseEnduranceEvents } from "../src/endurance-events.ts";
import {
  analyzeEnduranceSession,
  classifyPrematureStops,
  detectBoundaryViolation,
  looksLikeTextualToolCall,
} from "../src/endurance-session.ts";
import { evaluateEndurance, evaluatorIdentity, phaseEvidence } from "../src/endurance-evaluator.ts";
import { scoreEndurance } from "../src/endurance-scoring.ts";
import { enduranceSection, gates } from "../src/reporting.ts";
import { captureIntegrity, compareIntegrity } from "../src/integrity.ts";
import { fairComparisonIssues } from "../src/store.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");

const checks: string[] = [];
function check(name: string, condition: unknown, extra = ""): void {
  if (!condition) throw new Error(`FAILED: ${name} ${extra}`);
  checks.push(name);
}

// -------------------------------------------------------------------------- //
console.log("[discovery and prompt immutability]");
check("aliases resolve to agent-endurance-v3", [
  "agent-endurance-v3",
  "endurance",
  "endurance-v3",
  "agent endurance v3",
].every((ref) => resolveBenchmark(ref).version === "agent-endurance-v3"));
check("v4 aliases resolve independently", ["agent-endurance-v4", "endurance-v4", "agent endurance v4"]
  .every((ref) => resolveBenchmark(ref).version === "agent-endurance-v4"));
check("rev2 aliases resolve to the separately versioned v5 suite", ["agent-endurance-v5", "endurance-v5", "agent-endurance-3.0.0-rev2"]
  .every((ref) => resolveBenchmark(ref).version === "agent-endurance-3.0.0-rev2"));
check("all production suites are discoverable", productionBenchmarks().length === 4
  && productionBenchmarks().some((s) => s.version === "pagoda-v1")
  && productionBenchmarks().some((s) => s.version === "agent-endurance-v3")
  && productionBenchmarks().some((s) => s.version === "agent-endurance-v4")
  && productionBenchmarks().some((s) => s.version === "agent-endurance-3.0.0-rev2"));
check("pagoda default timeout is 1200s", PAGODA_V1.timeoutSeconds === 1200);
check("endurance timeout is a long build budget", AGENT_ENDURANCE_V3.timeoutSeconds >= 7200);

const promptAsset = path.join(HERE, "..", "src", "assets", "agent-endurance-v3.prompt.txt");
const assetBytes = fs.readFileSync(promptAsset);
check("promptHash matches the asset bytes", hashPrompt(AGENT_ENDURANCE_V3.prompt) === createHash("sha256").update(assetBytes).digest("hex"));
const phaseNames = [
  "Architecture and implementation plan",
  "Multi-warehouse inventory management",
  "Customer orders and atomic reservations",
  "Warehouse transfers and partial receiving",
  "Purchase orders and supplier receiving",
  "Returns, refunds and duplicate prevention",
  "JSON persistence, atomic writes and integrity checks",
  "Inventory reporting and sales analytics",
  "Complete argparse CLI",
  "At least 120 meaningful unit tests",
  "Refactoring and full regression testing",
  "At least 10 end-to-end integration scenarios",
];
check("prompt lists all 12 phases in order", phaseNames.every((name) => AGENT_ENDURANCE_V3.prompt.includes(name)));
check("prompt mandates standard library only", /only the Python standard library/.test(AGENT_ENDURANCE_V3.prompt));
check("prompt tells the agent to stay inside the workspace", /Do not access or modify anything outside the current workspace/.test(AGENT_ENDURANCE_V3.prompt));
check("v4 fixes inventory return shape", /inventory\(warehouse_id, sku\).*Python `int`/.test(AGENT_ENDURANCE_V4.prompt));
check("v4 fixes line payload shape", /mapping of SKU strings to positive integer quantities/.test(AGENT_ENDURANCE_V4.prompt));
check("v3 prompt remains byte-distinct", hashPrompt(AGENT_ENDURANCE_V3.prompt) !== hashPrompt(AGENT_ENDURANCE_V4.prompt));
check("rev2 prompt hash is frozen", hashPrompt(AGENT_ENDURANCE_V5.prompt) === AGENT_ENDURANCE_V5_REGISTERED_SHA256);
check("rev2 budget is four hours and 400 turns", AGENT_ENDURANCE_V5.timeoutSeconds === 14400 && AGENT_ENDURANCE_V5.maxTurns === 400);
check("rev2 uses the CLI-only wms contract", /package `wms\/`/.test(AGENT_ENDURANCE_V5.prompt) && AGENT_ENDURANCE_V5.expectedArtifact === "wms/__init__.py");
check("continuation prompt is separately versioned", AGENT_ENDURANCE_V3_CONTINUATION_VERSION.includes("continuation")
  && AGENT_ENDURANCE_V3_CONTINUATION_PROMPT !== AGENT_ENDURANCE_V3.prompt);

// -------------------------------------------------------------------------- //
console.log("[run isolation]");
const baseCfg: any = { benchmark: "agent-endurance-v3", model: { provider: "strata-auto", id: "iq3_s" }, runIndex: 1, benchRoot: "R" };
const first = buildRunPaths(baseCfg, "2026-07-29T00-00-00-000Z");
const second = buildRunPaths(baseCfg, "2026-07-29T00-00-01-000Z");
check("each timestamp gets its own run dir", first.runDir !== second.runDir && first.workspace !== second.workspace);
const otherModel = buildRunPaths({ ...baseCfg, model: { provider: "strata-auto", id: "iq4_xsv31" } }, "2026-07-29T00-00-00-000Z");
check("different models get different run dirs", otherModel.runDir !== first.runDir);
const resumed = buildRunPaths(baseCfg, "2026-07-29T00-00-00-000Z", "resumed-abc12345");
check("resumed run never reuses the source run dir", resumed.runDir !== first.runDir && resumed.workspace !== first.workspace);
check("resumed run dir marks itself diagnostic", /[\\/]run-01-resumed-abc12345$/.test(resumed.runDir));
const withRoot = buildRunPaths({ ...baseCfg, workspaceRoot: path.join(os.tmpdir(), "bench-workspaces") }, "2026-07-29T00-00-00-000Z");
check("workspaceRoot override moves the workspace outside the results tree",
  !withRoot.workspace.startsWith(path.resolve("R")) && withRoot.workspace.includes("bench-workspaces"));
check("default workspace lives inside the run dir", first.workspace === path.join(first.runDir, "workspace"));
const rev2Paths = buildRunPaths({ ...baseCfg, benchmark: "agent-endurance-v5" }, "2026-07-29T00-00-00-000Z");
if (process.platform === "win32") check("rev2 defaults to the specified Scratch root", rev2Paths.workspace.startsWith("C:\\AI\\Scratch\\pi-agent-benchmarks"));

const integrityRoot = fs.mkdtempSync(path.join(os.tmpdir(), "endurance-integrity-"));
fs.mkdirSync(path.join(integrityRoot, "src", "evaluators"), { recursive: true });
fs.writeFileSync(path.join(integrityRoot, "src", "evaluators", "hidden.py"), "one");
const integrityAgent = fs.mkdtempSync(path.join(os.tmpdir(), "endurance-agent-"));
const beforeIntegrity = captureIntegrity(integrityAgent, integrityRoot);
fs.writeFileSync(path.join(integrityRoot, "src", "evaluators", "hidden.py"), "two");
check("integrity hashing detects hidden evaluator changes", compareIntegrity(beforeIntegrity, captureIntegrity(integrityAgent, integrityRoot)).length === 1);

const comparable: any = { benchmarkVersion: "agent-endurance-3.0.0-rev2", promptHash: "same", thinkingLevel: "low", endurance: { configuration: { contextWindow: 1, maxTokens: 2, timeoutMs: 3, maxTurns: 400, continuationLimit: 3 } } };
check("fair comparison accepts identical locks", fairComparisonIssues([comparable, { ...comparable }]).length === 0);
check("fair comparison rejects changed budgets", fairComparisonIssues([comparable, { ...comparable, endurance: { configuration: { ...comparable.endurance.configuration, maxTurns: 399 } } }]).some((issue) => issue.includes("turn budget")));

// -------------------------------------------------------------------------- //
console.log("[session events: real pi event names]");
const live = parseEnduranceEvents([
  { type: "agent_start" },
  { type: "message_start", message: { role: "user" } },
  { type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "1", name: "write", arguments: {}, argumentsError: "bad json" }] } },
  { type: "tool_execution_end", toolName: "write", isError: true, atMs: 10 },
  { type: "tool_execution_end", toolName: "write", isError: false, atMs: 12 },
  { type: "compaction_start", reason: "threshold" },
  { type: "compaction_end", reason: "threshold" },
  { type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 100, errorMessage: "overloaded" },
  { type: "auto_retry_end", success: true, attempt: 1 },
  { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "<tool_call>\n<function write>\n<parameter path>\na.py\n</parameter>\n</function>\n</tool_call>" }] } },
  { type: "agent_end", messages: [], willRetry: false },
], false);
check("compaction_start/end pair counted once", live.compactions === 1, `got ${live.compactions}`);
check("auto_retry pair counted once", live.retries === 1, `got ${live.retries}`);
check("argumentsError counted as invalid tool arguments", live.invalidToolArguments === 1, `got ${live.invalidToolArguments}`);
check("textual tool markup counted as malformed", live.malformedToolCalls === 1, `got ${live.malformedToolCalls}`);
check("recovery counted after a failed call succeeds", live.recoveries === 1);
check("one user prompt is not counted as a continuation", live.manualContinuations === 0, `got ${live.manualContinuations}`);
check("absent user events leave continuations unobserved", parseEnduranceEvents([{ type: "tool_execution_end", isError: false, toolName: "read" }], false).manualContinuations === "UNKNOWN");
check("boundary audit starts UNKNOWN for live-only telemetry", live.boundaryViolations === "UNKNOWN");

// -------------------------------------------------------------------------- //
console.log("[premature stop classification]");
check("normal final stop is not premature", classifyPrematureStops({ stop: 1, toolUse: 9, length: 0, aborted: 0, error: 0, other: 0 }, true) === 0);
check("failed final completion claim is not a protocol premature stop", classifyPrematureStops({ stop: 1, toolUse: 9, length: 0, aborted: 0, error: 0, other: 0 }, false) === 0);
check("extra stops count when the task completed", classifyPrematureStops({ stop: 3, toolUse: 9, length: 0, aborted: 0, error: 0, other: 0 }, true) === 2);
check("failed completion claim is recorded separately", live.failedCompletionClaim === true);

// -------------------------------------------------------------------------- //
console.log("[transcript analysis]");
const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "endurance-session-"));
const transcript = path.join(tmpWorkspace, "session.jsonl");
const usage = (input: number, output: number, cacheRead: number) => ({ input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead });
fs.writeFileSync(transcript, [
  JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-07-29T00:00:00.000Z", cwd: tmpWorkspace }),
  JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "build it" }] } }),
  JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "toolUse", usage: usage(100, 5, 1000), content: [{ type: "toolCall", id: "a", name: "write", arguments: { path: "warehouse/x.py" } }] } }),
  JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "a", toolName: "write", isError: false, content: [{ type: "text", text: "ok" }] } }),
  JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "toolUse", usage: usage(40, 6, 1600), content: [{ type: "toolCall", id: "b", name: "read", arguments: { path: "C:/Users/tester/.pi/agent/auth.json" } }] } }),
  JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "b", toolName: "read", isError: true, content: [{ type: "text", text: "must have required property 'path'" }] } }),
  JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "toolUse", usage: usage(30, 2, 300), content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "python ../outside.py" }, argumentsError: "not valid JSON" }] } }),
  JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "c", toolName: "bash", isError: true, content: [{ type: "text", text: "exit 1" }] } }),
  JSON.stringify({ type: "compaction", reason: "threshold" }),
  JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "continue" }] } }),
  JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", usage: usage(50, 10, 500), content: [{ type: "text", text: "done <tool_call><function write><parameter path>a.py</parameter></function></tool_call>" }] } }),
].join("\n"), "utf8");

const analysis = analyzeEnduranceSession(transcript, tmpWorkspace);
check("transcript is readable", analysis.available);
check("manual continuation measured, not guessed", analysis.manualContinuations === 1, `got ${analysis.manualContinuations}`);
check("transcript compaction counted", analysis.compactions === 1);
check("tool calls counted", analysis.toolCalls === 3, `got ${analysis.toolCalls}`);
check("tool failures counted", analysis.toolFailures === 2, `got ${analysis.toolFailures}`);
check("invalid tool arguments counted from transcript", analysis.invalidToolArguments === 2, `got ${analysis.invalidToolArguments}`);
check("active context peak is the largest single turn, not a sum", analysis.activeContextPeak === 1640, `got ${analysis.activeContextPeak}`);
check("cumulative tokens kept separate from active context",
  analysis.cumulative.input === 220 && analysis.cumulative.cacheRead === 3400,
  JSON.stringify(analysis.cumulative));
check("boundary violations detected outside workspace", analysis.boundaryViolations >= 2, `got ${analysis.boundaryViolations}`);
check("boundary samples are recorded", analysis.boundarySamples.length > 0);
check("malformed textual call detected", analysis.malformedToolCalls === 1, `got ${analysis.malformedToolCalls}`);
check("missing transcript is UNKNOWN-safe", analyzeEnduranceSession(null, tmpWorkspace).available === false
  && analyzeEnduranceSession(null, tmpWorkspace).manualContinuations === null);

check("inside-workspace paths are not flagged", detectBoundaryViolation({ path: "warehouse/x.py" }, tmpWorkspace).violation === false);
check("protected pi config flagged", detectBoundaryViolation({ path: "C:/Users/x/.pi/agent/auth.json" }, tmpWorkspace).violation === true);
check("outside-workspace absolute path flagged", detectBoundaryViolation({ path: path.resolve(tmpWorkspace, "..", "other.py") }, tmpWorkspace).violation === true);
check("relative traversal flagged", detectBoundaryViolation({ command: "cat ../../secret" }, tmpWorkspace).violation === true);
check("signature matcher tolerant of stripped templates", looksLikeTextualToolCall("<tool_call><functionwrite><parameter path>a</parameter></function></tool_call>"));

const merged = mergeEnduranceTelemetry(parseEnduranceEvents([], false), analysis, { completed: false, resumed: false });
check("merged telemetry takes transcript measurements", merged.manualContinuations === 1 && merged.compactions === 1
  && typeof merged.activeContextPeak === "number" && typeof merged.boundaryViolations === "number",
  JSON.stringify({ mc: merged.manualContinuations, cc: merged.compactions, ctx: merged.activeContextPeak, bv: merged.boundaryViolations }));
check("merged telemetry rebuilds timeline from transcript", merged.timeline.some((entry) => entry.type === "tool_failure"));

const resumedMerged = mergeEnduranceTelemetry(parseEnduranceEvents([], false), analysis, { completed: true, resumed: true });
check("resumed run is never treated as uninterrupted", (resumedMerged.manualContinuations as number) >= 1);

// -------------------------------------------------------------------------- //
console.log("[scoring rules]");
const evaluation = {
  passed: 20, total: 20, phaseCompletion: 12, completed: true, details: [],
  categories: {
    transactions: { passed: 3, total: 3 }, persistence: { passed: 3, total: 3 },
    orders: { passed: 2, total: 2 }, transfers: { passed: 1, total: 1 }, purchasing: { passed: 1, total: 1 },
    returns: { passed: 3, total: 3 }, cli: { passed: 3, total: 3 }, reports: { passed: 1, total: 1 }, api: { passed: 1, total: 1 }, inventory: { passed: 2, total: 2 },
  },
};
const cleanTelemetry = {
  toolCalls: 40, toolFailures: 0, invalidToolArguments: 0, malformedToolCalls: 0, prematureStops: 0,
  manualContinuations: 0, retries: 0, recoveries: 0, compactions: 0, activeContextPeak: 12000,
  boundaryViolations: 0, boundarySamples: [], assistantTurns: 40, userMessages: 1, stopReasons: "toolUse=39 stop=1",
  interruptedTurns: { aborted: 0, error: 0, length: 0 }, observation: { events: true, session: true }, timeline: [],
};
const perfect = scoreEndurance(evaluation as any, cleanTelemetry as any, { wallMs: 60000, outputTokens: 5000, inputTokens: 90000 }, false);
check("clean autonomous run can PASS", perfect.autonomous === "PASS" && perfect.engineering === 100, JSON.stringify(perfect));
check("reliability perfect when nothing needed help", perfect.reliability === 100);
check("engineering breakdown separated", perfect.engineeringBreakdown.hiddenTests === 1 && perfect.engineeringBreakdown.featureCoverage === 1
  && perfect.engineeringBreakdown.integration === 1 && perfect.engineeringBreakdown.integrity === 1);
check("efficiency reports raw metrics", perfect.efficiency.wallMs === 60000 && perfect.efficiency.outputTokens === 5000 && perfect.efficiency.toolCalls === 40);

const helped = scoreEndurance(evaluation as any, { ...cleanTelemetry, manualContinuations: 1 } as any, { wallMs: 60000, outputTokens: 5000, inputTokens: 90000 }, false);
check("run that needed a continuation cannot be autonomous PASS", helped.autonomous === "FAIL");
check("run that needed a continuation loses reliability points", (helped.reliability as number) === 80, String(helped.reliability));

const unknownContinuations = scoreEndurance(evaluation as any, { ...cleanTelemetry, manualContinuations: "UNKNOWN", activeContextPeak: "UNKNOWN" } as any, { wallMs: 60000 }, false);
check("unobservable continuations are UNKNOWN, not assumed zero", unknownContinuations.autonomous === "UNKNOWN" && unknownContinuations.reliability === "UNKNOWN");

const resumedScore = scoreEndurance(evaluation as any, { ...cleanTelemetry, manualContinuations: 1 } as any, { wallMs: 60000 }, true);
check("resumed run cannot be an autonomous PASS", resumedScore.autonomous === "FAIL");
check("resumed run penalised in reliability", (resumedScore.reliability as number) === 55, String(resumedScore.reliability));

const boundaryScore = scoreEndurance(evaluation as any, { ...cleanTelemetry, boundaryViolations: 2 } as any, { wallMs: 60000 }, false);
check("boundary violations lower reliability and block autonomous PASS", boundaryScore.autonomous === "FAIL" && (boundaryScore.reliability as number) === 90, String(boundaryScore.reliability));

const busyTelemetry = { ...cleanTelemetry, toolCalls: 400, toolFailures: 40, recoveries: 40 };
const busy = scoreEndurance(evaluation as any, busyTelemetry as any, { wallMs: 60000, outputTokens: 5000 }, false);
check("more tool calls is not rewarded", busy.engineering === perfect.engineering && busy.reliability !== perfect.reliability);

const partialEngineering = scoreEndurance({ ...evaluation, passed: 5, total: 20, completed: false, phaseCompletion: 6 } as any, cleanTelemetry as any, { wallMs: 1 }, false);
check("partial credit scored by hidden tests + phases", partialEngineering.engineering === 30, String(partialEngineering.engineering));
check("partial credit is not autonomous PASS", partialEngineering.autonomous === "FAIL");

const rev2Evaluation: any = { passed: 4, total: 4, evaluatorVersion: "ae5-hidden-1", completed: true,
  phaseCompletion: 12, details: [], categories: { inventory: { passed: 1, total: 1 },
    persistence: { passed: 1, total: 1 }, transactions: { passed: 1, total: 1 },
    interface: { passed: 1, total: 1 } } };
const rev2Perfect = scoreEndurance(rev2Evaluation, cleanTelemetry as any, { wallMs: 1 }, false);
check("rev2 engineering formula reaches 100 for all groups and phases", rev2Perfect.engineering === 100, String(rev2Perfect.engineering));
const rev2Continued = scoreEndurance(rev2Evaluation, { ...cleanTelemetry, manualContinuations: 1 } as any, { wallMs: 1 }, false);
check("rev2 first continuation caps reliability at 70", rev2Continued.reliability === 70, String(rev2Continued.reliability));

// -------------------------------------------------------------------------- //
console.log("[independent evaluator: coverage, determinism and isolation]");
const identity = evaluatorIdentity();
check("evaluator version declared", identity.version === "ae3-hidden-2", identity.version);
check("evaluator sha256 recorded", /^[0-9a-f]{64}$/.test(identity.sha256));

const good = evaluateEndurance(path.join(FIXTURES, "warehouse-ref"));
check("reference implementation passes every hidden check", good.passed === good.total && good.completed,
  JSON.stringify({ passed: good.passed, total: good.total, details: good.details }));
check("reference implementation declares 12 phases", good.phaseCompletion === 12, String(good.phaseCompletion));
check("phases reported individually", good.phases.length === 12 && good.phases.every((phase) => phase.status === "declared"));
check("evaluator version travels with the result", good.evaluatorVersion === identity.version && good.evaluatorSha256 === identity.sha256);

const identityV4 = evaluatorIdentity("agent-endurance-v4");
const goodV4 = evaluateEndurance(path.join(FIXTURES, "warehouse-ref"), { benchmarkVersion: "agent-endurance-v4" });
check("v4 has an independent evaluator identity", identityV4.version === "ae4-hidden-1"
  && identityV4.sha256 !== identity.sha256);
check("v4 rejects the v3 fixture's now-disallowed inventory mapping", !goodV4.completed
  && goodV4.categories["v4-contract"]?.passed === 1
  && goodV4.details.some((detail) => detail.includes("inventory() must return")),
  JSON.stringify({ passed: goodV4.passed, total: goodV4.total, details: goodV4.details }));

const identityV5 = evaluatorIdentity("agent-endurance-3.0.0-rev2");
const goodV5 = evaluateEndurance(path.join(FIXTURES, "wms-ref"), { benchmarkVersion: "agent-endurance-3.0.0-rev2" });
check("rev2 has an independent evaluator identity", identityV5.version === "ae5-hidden-1"
  && identityV5.sha256 !== identityV4.sha256);
check("rev2 reference implementation passes every hidden group", goodV5.completed && goodV5.passed === goodV5.total,
  JSON.stringify({ passed: goodV5.passed, total: goodV5.total, details: goodV5.details }));
const goodV5Again = evaluateEndurance(path.join(FIXTURES, "wms-ref"), { benchmarkVersion: "agent-endurance-3.0.0-rev2" });
check("rev2 evaluator is deterministic", goodV5Again.passed === goodV5.passed
  && goodV5Again.total === goodV5.total && JSON.stringify(goodV5Again.categories) === JSON.stringify(goodV5.categories));

const broken = evaluateEndurance(path.join(FIXTURES, "warehouse-broken"));
check("broken implementation fails hidden checks", !broken.completed && broken.passed < broken.total,
  JSON.stringify({ passed: broken.passed, total: broken.total }));
check("evaluator detects transaction/integrity weakness", broken.categories.transactions?.passed === 0,
  JSON.stringify(broken.categories.transactions));
check("evaluator detects receiving-bound weakness", (broken.categories.purchasing?.passed ?? 1) === 0);
check("broken fixture reports missing phases", broken.phaseCompletion === 0 && broken.phases.every((phase) => phase.status === "missing"));

const workspaceCopy = fs.mkdtempSync(path.join(os.tmpdir(), "endurance-isolation-"));
fs.cpSync(path.join(FIXTURES, "warehouse-ref", "warehouse"), path.join(workspaceCopy, "warehouse"), { recursive: true });
fs.cpSync(path.join(FIXTURES, "warehouse-ref", "PHASES.md"), path.join(workspaceCopy, "PHASES.md"));
const isolatedRun = evaluateEndurance(workspaceCopy);
const leaked = fs.readdirSync(workspaceCopy, { recursive: true } as fs.MaskedFileOptionsAll).filter((entry: string | Buffer) => String(entry).includes("agent-endurance-v3"));
check("hidden evaluator is never copied into the evaluated workspace", leaked.length === 0, JSON.stringify(leaked));
check("isolated copy still evaluates deterministically", isolatedRun.total === good.total && isolatedRun.passed === good.total);

const secondPass = evaluateEndurance(path.join(FIXTURES, "warehouse-ref"));
check("evaluator output is deterministic across runs",
  JSON.stringify({ ...secondPass, phases: null, notes: null, evaluatorScript: null, workspace: null })
  === JSON.stringify({ ...good, phases: null, notes: null, evaluatorScript: null, workspace: null }));

const missing = evaluateEndurance(fs.mkdtempSync(path.join(os.tmpdir(), "endurance-empty-")));
check("empty workspace stays incomplete", missing.passed < missing.total && missing.total > 0 && !missing.completed && missing.phaseCompletion === 0);
check("missing workspace never marked complete", evaluateEndurance(path.join(FIXTURES, "does-not-exist")).completed === false);

// -------------------------------------------------------------------------- //
console.log("[result persistence and history roots]");
const historyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "endurance-history-"));
const extraRoot = fs.mkdtempSync(path.join(os.tmpdir(), "endurance-history-extra-"));
process.env.PI_BENCHMARK_DIR = historyRoot;
process.env.PI_BENCHMARK_HISTORY_ROOTS = extraRoot;
const store = await import(`../src/store.ts?itest=${Date.now()}`);
const legacyRun: any = { id: "agent-endurance-v3-legacy-1", benchmark: "agent-endurance-v3", benchmarkVersion: "agent-endurance-v3", outcome: "FAIL_COMPLIANCE", metrics: {}, workspace: "W", runDir: path.join(extraRoot, "legacy-run") };
fs.mkdirSync(legacyRun.runDir, { recursive: true });
fs.appendFileSync(path.join(extraRoot, "index.jsonl"), JSON.stringify(legacyRun) + "\n", "utf8");
const newRun: any = { id: "agent-endurance-v3-new-1", benchmark: "agent-endurance-v3", benchmarkVersion: "agent-endurance-v3", outcome: "PASS", metrics: {}, workspace: "W", runDir: path.join(historyRoot, "new-run") };
store.saveRun(newRun);
check("resumed-style fields persist", (() => {
  const stored = JSON.parse(fs.readFileSync(path.join(newRun.runDir, "run.json"), "utf8"));
  return stored.id === newRun.id;
})());
check("legacy run is still discoverable after a storage-location change", store.findRun("agent-endurance-v3-legacy-1") !== null);
check("new run is discoverable", store.findRun("agent-endurance-v3-new-1") !== null);
const enduranceFiltered = store.loadRuns("agent-endurance-v3").map((run: any) => run.id);
check("endurance-only history filter contains both synthetic runs",
  enduranceFiltered.includes("agent-endurance-v3-new-1") && enduranceFiltered.includes("agent-endurance-v3-legacy-1"),
  JSON.stringify(enduranceFiltered.slice(0, 6)));
check("history roots listed", store.historyRoots().includes(extraRoot) && store.historyRoots().includes(historyRoot));
check("pagoda filter excludes endurance runs", store.loadRuns("pagoda").every((run: any) => run.benchmark === "pagoda"));

const richRun: any = {
  id: "rich", benchmark: "agent-endurance-v3", benchmarkVersion: "agent-endurance-v3", outcome: "PASS",
  metrics: { wallMs: 1, weightedTps: 1, outputTokens: 1, inputTokens: 1, toolCalls: 1, toolErrors: 0, stopReasons: [] },
  artifact: { found: true, path: "p", name: "warehouse/__init__.py", sizeBytes: 10, candidates: [], checks: {}, staticOk: true },
  browser: { attempted: false, skipped: true, errors: [], consoleErrors: [], durationMs: 0 },
  visual: null, compliance: null, model: { id: "m", provider: "p" }, thinkingLevel: "low",
  promptHash: "x".repeat(64), runDir: "R", workspace: "W", sessionFile: "S", reasons: [], timings: { agentMs: 1, validationMs: 0 },
  endurance: {
    evaluation: { ...evaluation, phases: phaseEvidence(path.join(FIXTURES, "warehouse-ref")), evaluatorVersion: identity.version, evaluatorSha256: identity.sha256, evaluatorScript: "src/evaluators/agent-endurance-v3.py", notes: [] },
    telemetry: cleanTelemetry,
    scores: perfect,
    resumed: false,
    configuration: { provider: "p", model: "m", thinkingLevel: "low" },
  },
};
check("endurance gates map compliance to the independent evaluator", JSON.stringify(gates(richRun)) === JSON.stringify({ agent: "PASS", compliance: "PASS", runtime: "N/A", visual: "N/A" }));
richRun.endurance.resumed = true;
richRun.endurance.resumeOf = "agent-endurance-v3-legacy-1";
richRun.endurance.scores = { ...perfect, autonomous: "FAIL", reliability: 55 };
check("resumed endurance run fails the gates", gates(richRun).agent === "FAIL" && gates(richRun).compliance === "FAIL");
const section = enduranceSection(richRun).join("\n");
check("report flags a resumed run as diagnostic", /DIAGNOSTIC \(continues agent-endurance-v3-legacy-1\)/.test(section));
check("report separates cumulative tokens from active context",
  section.includes("Cumulative output") && section.includes("Active context peak") && !section.includes("context window used"));
check("report includes evaluator version and hidden-test counts",
  section.includes("ae3-hidden-2") && /Hidden tests\s+20\/20/.test(section));
check("report renders UNKNOWN values honestly", enduranceSection({
  ...richRun,
  endurance: {
    ...richRun.endurance,
    telemetry: { ...cleanTelemetry, manualContinuations: "UNKNOWN", invalidToolArguments: "UNKNOWN", activeContextPeak: "UNKNOWN", boundaryViolations: "UNKNOWN", retries: "UNKNOWN" },
    scores: { ...perfect, reliability: "UNKNOWN", autonomous: "UNKNOWN", efficiency: { ...perfect.efficiency, outputTokens: "UNKNOWN", inputTokens: "UNKNOWN" } },
  },
}).join("\n").includes("UNKNOWN (not observable)"));

// -------------------------------------------------------------------------- //
console.log("[secrets are never handed to the evaluator or stored]");
const evaluatorSource = fs.readFileSync(path.join(HERE, "..", "src", "endurance-evaluator.ts"), "utf8");
check("evaluator child process only inherits PATH", /env:\s*\{\s*PATH:/.test(evaluatorSource));
check("evaluator passes no env object to the child", !/env:\s*(?:process\.env|\{\s*\.\.\.process)/.test(evaluatorSource));
const runnerSource = fs.readFileSync(path.join(HERE, "..", "src", "runner.ts"), "utf8");
check("runner configuration snapshot excludes credentials",
  /inheritedProviderCount/.test(runnerSource) && !/configuration:\s*\{[^}]*api[Kk]ey/.test(runnerSource));

// -------------------------------------------------------------------------- //
console.log(`\nAgent Endurance V3 integration tests passed (${checks.length} checks)`);
