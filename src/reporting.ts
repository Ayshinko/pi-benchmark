/**
 * Human-readable benchmark reports sent into the Pi conversation after a run
 * or a multi-run batch. No caller should need to open JSON / session files for
 * normal use. Every value defaults to "n/a" — never a literal "undefined".
 */

import type { RunResult } from "./types.ts";
import { formatDuration, formatNumber, formatTps } from "./format.ts";

const SEP = "─".repeat(48);

function na(v: unknown, fallback = "n/a"): string {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "number" && !Number.isFinite(v)) return fallback;
  return String(v);
}

/** Renders an efficiency value that may legitimately be "UNKNOWN". */
function naFormat(value: unknown, format: (value: number) => string): string {
  if (typeof value === "number" && Number.isFinite(value)) return format(value);
  return value === "UNKNOWN" ? "UNKNOWN (not observable)" : "n/a";
}

function vuln(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? "n/a" : formatNumber(v);
}

/** Gate statuses used in the result card. */
export interface Gates {
  agent: string;
  compliance: string;
  runtime: string;
  visual: string;
}

/**
 * True only for genuinely old stored results created before the compliance
 * fields existed (their stored JSON simply has no `compliance` property). New
 * runs always carry one — either a report object or `null` when the compliance
 * stage never executed (e.g. a run that timed out before producing an artifact).
 */
function isLegacyResult(result: RunResult): boolean {
  return result.compliance === undefined;
}

function runtimeFromOutcome(o: string): string {
  return o === "FAIL_MISSING_ARTIFACT" || o === "FAIL_RUNTIME" || o === "ERROR_HARNESS" ? "FAIL" : "PASS";
}

function visualFromOutcome(o: string, visual: VisualReport | null | undefined): string {
  return o === "FAIL_VISUAL" ? "FAIL" : visual?.ok === false ? "FAIL" : "PASS";
}

/**
 * Build the per-gate statuses for a result card.
 *
 * Later validation stages that were never executed on a NEW run are shown as
 * NOT_RUN rather than a fabricated PASS/FAIL. The only exception is a genuinely
 * legacy stored result (no `compliance` property), which keeps its old
 * PASS/FAIL rendering and reserves `n/a (legacy result)` for the compliance row.
 */
export function gates(result: RunResult): Gates {
  const o = result.outcome;
  const legacy = isLegacyResult(result);

  if (result.endurance) {
    const interrupted = o === "FAIL_AGENT" || o === "FAIL_LENGTH" || o === "FAIL_TIMEOUT";
    const premature = result.endurance.telemetry.prematureStops > 0;
    const resumed = Boolean(result.endurance.resumed);
    return {
      agent: interrupted || premature || resumed ? "FAIL" : "PASS",
      compliance: result.endurance.evaluation.completed && result.endurance.scores?.autonomous !== "FAIL" ? "PASS" : "FAIL",
      runtime: "N/A",
      visual: "N/A",
    };
  }

  const agent = o === "FAIL_AGENT" || o === "FAIL_LENGTH" || o === "FAIL_TIMEOUT" ? "FAIL" : "PASS";

  const compliance = legacy ? "n/a (legacy result)" : result.compliance ? result.compliance.overall : "NOT_RUN";

  const runtime = legacy
    ? runtimeFromOutcome(o)
    : result.browser?.attempted === true
      ? runtimeFromOutcome(o)
      : "NOT_RUN";

  const visual = legacy
    ? visualFromOutcome(o, result.visual)
    : result.browser?.visual != null
      ? visualFromOutcome(o, result.visual)
      : "NOT_RUN";

  return { agent, compliance, runtime, visual };
}

/**
 * Full single-run result card.
 */
export function formatResultCard(run: RunResult): string {
  const g = gates(run);
  const m = run.metrics;
  const artifact = run.artifact;
  const browser = run.browser;
  const benchName = run.benchmarkVersion && run.benchmarkVersion !== "pagoda-v1"
    ? run.benchmarkVersion
    : "Pagoda v1";

  const padding = Math.max("Provider".length, "Browser validation".length, "Max output".length) + 2;
  const row = (key: string, value: string): string => `${key.padEnd(padding)}${value}`;

  const lines: string[] = [
    `${benchName} Benchmark`,
    SEP,
    row("Overall", run.outcome),
    "",
    row("Model", run.model.id),
    row("Provider", run.model.provider),
    row("Thinking", run.thinkingLevel),
    "",
    row("Agent", g.agent),
    row("Compliance", g.compliance),
    row("Runtime", g.runtime),
    row("Visual", g.visual),
    "",
    "Performance",
    row("Task Avg", formatTps(m.weightedTps)),
    row("TPS source", `${m.measurementSource ?? "legacy / provider usage"} (${m.measurementAccuracy ?? "n/a"})`),
    row("Output", `${formatK(m.outputTokens)} tokens`),
    row("Generation", formatDuration(m.genMs)),
    row("Wall", formatDuration(m.wallMs)),
    "",
    "Agent behavior",
    row("Turns", na(m.assistantTurnsStarted ?? m.generations)),
    row("Tool calls", na(m.toolCalls)),
    row("Tool errors", na(m.toolErrors)),
    row("Stop reasons", m.stopReasons.length ? m.stopReasons.join(" → ") : "n/a"),
    "",
    "Artifact",
    row("File", artifact.found ? artifact.name ?? "unknown" : "none"),
    row("Size", artifact.found ? formatBytes(artifact.sizeBytes) : "n/a"),
    row("Voxel count", vuln(browser.runtime?.reportedVoxels ?? null)),
    row("Canvas", browser.canvas ? "PASS" : browser.attempted ? "FAIL" : "n/a"),
    row("WebGL", browser.webgl ? "PASS" : browser.attempted ? "FAIL" : "n/a"),
    row("Console", browser.consoleErrors.length ? `${browser.consoleErrors.length} errors` : "0 errors"),
    "",
    "Reproducibility",
    row("Benchmark", run.benchmarkVersion ?? run.promptVersion ?? "n/a"),
    row("Prompt SHA", shortSha(run.promptHash)),
    row("Context", vuln(run.model.contextWindow)),
    row("Max output", vuln(run.model.maxTokens)),
    "",
    "Files",
    row("Artifact", artifact.found ? artifact.path ?? "n/a" : "n/a"),
    row("Screenshot", browser.screenshotPath ?? "n/a"),
    row("Session", run.sessionFile ?? "n/a"),
    row("Run directory", run.runDir ?? "n/a"),
  ];

  if (run.endurance) {
    lines.splice(8, 0, ...enduranceSection(run));
  }

  return lines.join("\n");
}

/**
 * Agent Endurance V3 report block: engineering, autonomous reliability, raw
 * efficiency, phase evidence, independent evaluator results and the failure /
 * recovery timeline. Secrets and environment values are never included.
 */
export function enduranceSection(run: RunResult): string[] {
  const e = run.endurance!;
  const t = e.telemetry;
  const breakdown = e.scores.engineeringBreakdown ?? { hiddenTests: 0, featureCoverage: 0, integration: 0, integrity: 0 };
  const lines: string[] = [
    "Engineering and reliability",
    row2("Overall", run.outcome === "PASS" ? "PASS" : run.outcome),
    ...(e.resumed ? [row2("Resumed run", `DIAGNOSTIC (continues ${e.resumeOf ?? "unknown run"})`)] : []),
    row2("Engineering score", `${e.scores.engineering}/100`),
    row2("  hidden tests", `${(breakdown.hiddenTests * 100).toFixed(0)}%`),
    row2("  feature coverage", `${(breakdown.featureCoverage * 100).toFixed(0)}%`),
    row2("  integration", `${(breakdown.integration * 100).toFixed(0)}%`),
    row2("  persistence/integrity", `${(breakdown.integrity * 100).toFixed(0)}%`),
    row2("Reliability score", String(e.scores.reliability)),
    row2("Autonomous", e.scores.autonomous),
    "",
    "Agent reliability (objective, from session events)",
    row2("Premature stops", String(t.prematureStops)),
    row2("Failed completion claim", String(t.failedCompletionClaim ?? false)),
    row2("Manual continuations", String(t.manualContinuations)),
    row2("Tool calls", String(t.toolCalls)),
    row2("Tool failures", String(t.toolFailures)),
    row2("Recovered failures", String(t.recoveries)),
    row2("Invalid tool args", String(t.invalidToolArguments)),
    row2("Malformed calls", String(t.malformedToolCalls)),
    row2("Retries", String(t.retries)),
    row2("Compactions", String(t.compactions)),
    row2("Stop reasons", t.stopReasons || "n/a"),
    row2("Workspace boundary hits", String(t.boundaryViolations)),
    row2("Observed from", `${t.observation?.events ? "live events" : ""}${t.observation?.events && t.observation?.session ? " + " : ""}${t.observation?.session ? "session transcript" : ""}${!t.observation?.events && !t.observation?.session ? "no source available" : ""}`),
    "",
    "Efficiency (raw, not scored)",
    row2("Wall", formatDuration(e.scores.efficiency.wallMs)),
    row2("Cumulative output", naFormat(e.scores.efficiency.outputTokens, formatNumber)),
    row2("Cumulative input", naFormat(e.scores.efficiency.inputTokens, formatNumber)),
    row2("Active context peak", String(t.activeContextPeak)),
    row2("Assistant turns", String(t.assistantTurns)),
    row2("Tool calls", String(t.toolCalls)),
    "",
    "Independent evaluator",
    row2("Hidden tests", `${e.evaluation.passed}/${e.evaluation.total}`),
    row2("Evaluator version", `${e.evaluation.evaluatorVersion ?? "unknown"} (${shortSha(e.evaluation.evaluatorSha256)})`),
    row2("Evaluator script", e.evaluation.evaluatorScript ?? "n/a"),
    row2("Phases", `${e.evaluation.phaseCompletion}/12`),
  ];
  for (const phase of e.evaluation.phases ?? []) {
    lines.push(row2(`  phase ${phase.phase}`, `${phase.status === "declared" ? "declared" : "MISSING"}  ${phase.label}`));
  }
  const failures = e.evaluation.details ?? [];
  if (failures.length) {
    lines.push("", "Hidden-test failures");
    for (const failure of failures.slice(0, 8)) lines.push(`  ${failure}`);
    if (failures.length > 8) lines.push(`  … ${failures.length - 8} more`);
  }
  if (t.boundarySamples?.length) {
    lines.push("", "Boundary samples");
    for (const sample of t.boundarySamples.slice(0, 4)) lines.push(`  ${sample}`);
  }
  const timeline = t.timeline ?? [];
  if (timeline.length) {
    lines.push("", "Failure and recovery timeline");
    for (const entry of timeline.slice(-12)) {
      lines.push(`  ${formatDuration(entry.atMs)}  ${entry.type}  ${entry.detail}`);
    }
  }
  return lines;
}

function row2(key: string, value: string): string {
  return `${key.padEnd(26)}${value}`;
}

/** Compact human output: 16800 -> 16.8k, 420 -> 420. */
function formatK(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  if (value < 1000) return String(Math.round(value));
  const k = value / 1000;
  return `${k.toFixed(1).replace(/\.0$/, "")}k`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "n/a";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function shortSha(hash?: string): string {
  if (!hash) return "n/a";
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

/**
 * Concise aggregate card for a multi-run batch.
 */
export function formatAggregateCard(runs: RunResult[]): string {
  if (runs.length === 0) return "No runs to summarise.";
  const modelId = runs[0].model.id;
  const thinking = runs[0].thinkingLevel;
  const bench = shortUpperName(runs[0]);

  const passCount = runs.filter((r) => r.outcome === "PASS").length;
  const passRate = (100 * passCount) / runs.length;

  const tps = runs.map((r) => r.metrics.weightedTps).filter(Number.isFinite);
  const walls = runs.map((r) => r.metrics.wallMs).filter(Number.isFinite);
  const outs = runs.map((r) => r.metrics.outputTokens).filter(Number.isFinite);

  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const median = (xs: number[]) => {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  const failures = groupFailures(runs);

  const lines: string[] = [
    `${bench} · ${modelId} · ${thinking}`,
    SEP,
    `Runs           ${runs.length}`,
    `PASS           ${passCount}/${runs.length} (${passRate.toFixed(1)}%)`,
    `Avg TPS        ${fmtTps(avg(tps))}`,
    `Median TPS     ${fmtTps(median(tps))}`,
    `Avg Wall       ${fmtDur(avg(walls))}`,
    `Median Wall    ${fmtDur(median(walls))}`,
    `Avg Output     ${fmtK(avg(outs))}`,
  ];

  const enduranceRuns = runs.filter((run) => run.endurance);
  if (enduranceRuns.length) {
    const engineering = enduranceRuns.map((run) => run.endurance!.scores.engineering);
    const autonomous = enduranceRuns.map((run) => run.endurance!.scores.autonomous);
    const hidden = enduranceRuns.map((run) => `${run.endurance!.evaluation.passed}/${run.endurance!.evaluation.total}`);
    lines.push(
      "",
      `Engineering    ${engineering.map((value) => `${value}/100`).join(", ")}`,
      `Autonomous     ${autonomous.join(", ")}`,
      `Hidden tests   ${hidden.join(", ")}`,
      `Resumed        ${enduranceRuns.filter((run) => run.endurance!.resumed).length} diagnostic run(s)`,
    );
  }

  if (failures.length) {
    lines.push("", "Failures");
    for (const f of failures) lines.push(`${f.count} ${f.label}`);
  }

  lines.push("", ...runs.map((r, i) => rowLine(i + 1, r)));
  return lines.join("\n");
}

function shortUpperName(run: RunResult): string {
  const v = run.benchmarkVersion ?? run.promptVersion ?? run.benchmark;
  return v === "pagoda-v1" || v === "pagoda" ? "Pagoda v1" : v;
}

function groupFailures(runs: RunResult[]): Array<{ label: string; count: number }> {
  const map = new Map<string, number>();
  for (const r of runs) {
    if (r.outcome === "PASS") continue;
    let label = r.outcome.replace(/^FAIL_/, "");
    if (label === "COMPLIANCE") label = "compliance";
    else label = label.toLowerCase();
    map.set(label, (map.get(label) ?? 0) + 1);
  }
  return [...map.entries()].map(([label, count]) => ({ label, count }));
}

function rowLine(index: number, r: RunResult): string {
  const outcome = r.outcome.padEnd(15);
  const tps = formatTps(r.metrics.weightedTps).padEnd(11);
  const wall = formatDuration(r.metrics.wallMs).padEnd(8);
  const out = formatK(r.metrics.outputTokens).padEnd(6);
  return `Run ${index}   ${outcome}  ${tps}${wall}${out}`;
}

function fmtTps(v: number): string {
  return Number.isFinite(v) ? formatTps(v) : "n/a";
}
function fmtDur(v: number): string {
  return Number.isFinite(v) ? formatDuration(v) : "n/a";
}
function fmtK(v: number): string {
  return Number.isFinite(v) ? `${formatK(v)} tok` : "n/a";
}

export { formatNumber };
