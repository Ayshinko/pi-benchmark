/**
 * Formatting helpers for the live status line, the report, and history tables.
 */

import type { MetricsSnapshot, RunResult } from "./types.ts";

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatTps(tps: number): string {
  return `${tps.toFixed(1)} tok/s`;
}

/** Compact human output: 5800 -> 5.8k, 11600 -> 11.6k, 420 -> 420. */
export function formatOutput(value: number): string {
  if (value < 1000) return String(Math.round(value));
  const k = value / 1000;
  return `${k.toFixed(1).replace(/\.0$/, "")}k`;
}

/** Current assistant-turn state name used in the live status line. */
export function liveState(snapshot: MetricsSnapshot): string {
  if (snapshot.activeAssistantTurn !== null) {
    if (snapshot.outputTokens > 0 && snapshot.partialOutputTokens > 0) return "generating";
    if (snapshot.activeGenerationMs > 0 && snapshot.partialOutputTokens === 0 && snapshot.outputTokens === 0) return "reasoning";
    return "generating";
  }
  return "idle";
}

export interface LiveLineOptions {
  /** True while a turn is actively streaming (uses partial/live metrics). */
  live?: boolean;
}

export function liveLine(snapshot: MetricsSnapshot, options: LiveLineOptions = {}): string {
  const parts = [
    `elapsed ${formatDuration(snapshot.wallMs)}`,
    `out ${formatOutput(snapshot.outputTokens)}`,
    `taskAvg ${slashed(snapshot.weightedTps)}`,
    `gen ${formatDuration(snapshot.genMs)}`,
  ];
  if (options.live && snapshot.activeAssistantTurn !== null) {
    parts.push(`live ${formatTps(snapshot.liveTps)}`, `turns ${snapshot.assistantTurnsStarted}`);
  }
  parts.push(`tools ${snapshot.toolCalls}`, `state ${liveState(snapshot)}`);
  if (snapshot.outputTokenAccuracy !== "exact") parts.push(`acc ${snapshot.outputTokenAccuracy}`);
  return parts.join(" | ");
}

function slashed(v: number): string {
  return `${v.toFixed(1)} tok/s`;
}

export function summaryLine(run: RunResult): string {
  return `${run.outcome.padEnd(20)} ${run.model.provider}/${run.model.id} ${run.thinkingLevel} ${formatTps(run.metrics.weightedTps)} wall ${formatDuration(run.metrics.wallMs)}`;
}

export function formatTable(runs: RunResult[]): string {
  const headers = ["outcome", "model", "think", "TPS", "wall", "gen", "out tok", "tools", "artifact", "visual"];
  const rows = runs.map((run) => [
    run.outcome,
    `${run.model.provider}/${run.model.id}`,
    run.thinkingLevel,
    formatTps(run.metrics.weightedTps),
    formatDuration(run.metrics.wallMs),
    formatDuration(run.metrics.genMs),
    formatNumber(run.metrics.outputTokens),
    String(run.metrics.toolCalls),
    run.artifact.found ? `${run.artifact.name} (${formatNumber(run.artifact.sizeBytes)} B)` : "missing",
    run.visual ? (run.visual.ok ? `${run.visual.uniqueColors} colors, lum ${run.visual.meanLuminance.toFixed(0)}` : "failed") : "n/a",
  ]);

  const widths = headers.map((header, i) => {
    let width = header.length;
    for (const row of rows) width = Math.max(width, row[i].length);
    return width;
  });

  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  const lines = [
    headers.map((header, i) => header.padEnd(widths[i])).join("  "),
    separator,
    ...rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join("  ")),
  ];
  return lines.join("\n");
}

export function formatRunDetail(run: RunResult): string {
  // New streaming fields may be absent from older stored results; default them.
  const accuracy = run.metrics.outputTokenAccuracy ?? "exact";
  const acc = accuracy !== "exact" ? ` (${accuracy})` : "";
  const partial = run.metrics.partialOutputTokens ? ` (${formatNumber(run.metrics.partialOutputTokens)} partial est)` : "";
  const turnsStarted = run.metrics.assistantTurnsStarted ?? run.metrics.generations;
  const activeGen = run.metrics.activeGenerationMs ? ` (+active ${formatDuration(run.metrics.activeGenerationMs)})` : "";
  const live = run.metrics.liveTps ? ` live ${formatTps(run.metrics.liveTps)}` : "";
  const benchVersion = run.benchmarkVersion ?? "n/a";
  const promptHash = run.promptHash ?? "n/a";

  const lines = [
    `Run ${run.id}`,
    `  benchmark      ${run.benchmark} (${benchVersion})`,
    `  prompt hash    ${promptHash}`,
    `  model          ${run.model.provider}/${run.model.id} thinking=${run.thinkingLevel}`,
    `  outcome        ${run.outcome}${run.reasons.length ? ` - ${run.reasons.join("; ")}` : ""}`,
    `  wall           ${formatDuration(run.metrics.wallMs)}`,
    `  generation     ${formatDuration(run.metrics.genMs)}${activeGen}`,
    `  weighted TPS   ${formatTps(run.metrics.weightedTps)}`,
    `  TPS source     ${run.metrics.measurementSource ?? "legacy / provider usage"} (${run.metrics.measurementAccuracy ?? accuracy})`,
    `  wall TPS       ${formatTps(run.metrics.wallTps)}`,
    `  output tokens  ${formatNumber(run.metrics.outputTokens)}${acc}${partial}`,
    `  input tokens   ${formatNumber(run.metrics.inputTokens)} (cache read ${formatNumber(run.metrics.cacheRead)})`,
    `  cost           $${run.metrics.cost.toFixed(4)}`,
    `  assistant msgs ${turnsStarted} (${run.metrics.generations} completed)  stop: ${run.metrics.stopReasons.join(", ") || "none"}`,
    `  tool calls     ${run.metrics.toolCalls} (${run.metrics.toolErrors} errors)`,
    `  artifact       ${run.artifact.found ? `${run.artifact.path} (${formatNumber(run.artifact.sizeBytes)} B)` : "none"}`,
    `  metrics        output accuracy ${accuracy}${live}`,
    `  browser        ${run.browser.skipped ? "skipped (--no-browser)" : run.browser.attempted ? `${run.browser.browserName} ok=${run.browser.ok} canvas=${run.browser.canvas} webgl=${run.browser.webgl} three=${run.browser.threeLoaded}` : "not attempted"}`,
    `  visual         ${run.visual ? `lum ${run.visual.meanLuminance.toFixed(1)} std ${run.visual.luminanceStdDev.toFixed(1)} black ${(run.visual.blackFraction * 100).toFixed(1)}% white ${(run.visual.whiteFraction * 100).toFixed(1)}% colors ${run.visual.uniqueColors}` : "not captured"}`,
    `  compliance     ${run.compliance ? formatComplianceOverall(run.compliance) : "n/a (legacy result)"}`,
    `  run dir        ${run.runDir}`,
  ];
  if (run.browser.consoleErrors.length > 0) {
    lines.push(`  console errors ${run.browser.consoleErrors.slice(0, 5).join(" | ")}`);
  }
  if (run.compliance) {
    const fails = run.compliance.items.filter((i) => i.status === "FAIL");
    const unknowns = run.compliance.items.filter((i) => i.status === "UNKNOWN");
    if (fails.length) lines.push(`  compliance fails ${fails.map((f) => `${f.id}:${f.detail || "absent"}`).join(" | ")}`);
    if (unknowns.length) lines.push(`  compliance unknown ${unknowns.length} item(s): ${unknowns.map((u) => u.id).join(", ")}`);
  }
  return lines.join("\n");
}

function formatComplianceOverall(c: { overall: string }): string {
  return c.overall;
}
