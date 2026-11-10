/**
 * Persistent benchmark history.
 *
 * Layout:
 *   ~/.pi/benchmarks/index.jsonl        one full RunResult per line
 *   ~/.pi/benchmarks/<benchmark>/<ts>/<model>/run-NN/
 *       run.json        full result
 *       workspace/      the artifact the agent wrote
 *       session/        the isolated session transcript
 *       screenshot.png  browser validation screenshot
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunResult } from "./types.ts";

/** The pre-move location that still holds the original benchmark history. */
const LEGACY_BENCH_ROOT = path.join(os.homedir(), ".pi", "benchmarks");

/**
 * Write root for new results.
 *
 * PI_BENCHMARK_DIR wins when set (tests, CI). Otherwise the state directory next
 * to PI_CODING_AGENT_DIR is preferred only when that root already contains
 * results; the first Agent Endurance V3 runs live under ~/.pi/benchmarks, and the
 * write root must not switch out from under a populated history.
 */
function resolveBenchRoot(): string {
  if (process.env.PI_BENCHMARK_DIR) return path.resolve(process.env.PI_BENCHMARK_DIR);
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (agentDir) {
    const normalized = path.resolve(agentDir);
    const stateRoot = path.basename(normalized).toLowerCase() === "agent"
      ? path.dirname(normalized)
      : normalized;
    const candidate = path.join(stateRoot, "benchmarks");
    if (fs.existsSync(path.join(candidate, "index.jsonl"))) return candidate;
    if (!fs.existsSync(path.join(LEGACY_BENCH_ROOT, "index.jsonl"))) return candidate;
  }
  return LEGACY_BENCH_ROOT;
}

/**
 * Roots that are read for history (older runs live in more than one place after
 * a storage-location change). Later duplicates are deduplicated by run id.
 */
function resolveHistoryRoots(): string[] {
  const roots: string[] = [BENCH_ROOT];
  for (const entry of (process.env.PI_BENCHMARK_HISTORY_ROOTS ?? "").split(path.delimiter)) {
    if (entry.trim()) roots.push(path.resolve(entry));
  }
  if (BENCH_ROOT !== LEGACY_BENCH_ROOT) roots.push(LEGACY_BENCH_ROOT);
  const defaultRoot = path.join(os.homedir(), ".pi", "benchmarks");
  if (!roots.includes(defaultRoot)) roots.push(defaultRoot);
  return [...new Set(roots)];
}

export const BENCH_ROOT = resolveBenchRoot();
const INDEX_FILE = path.join(BENCH_ROOT, "index.jsonl");

export function historyRoots(): string[] {
  return resolveHistoryRoots();
}

export function ensureRoot(): void {
  fs.mkdirSync(BENCH_ROOT, { recursive: true });
}

export function saveRun(result: RunResult): void {
  ensureRoot();
  fs.mkdirSync(result.runDir, { recursive: true });
  fs.writeFileSync(path.join(result.runDir, "run.json"), JSON.stringify(result, null, 2), "utf8");
  fs.appendFileSync(INDEX_FILE, JSON.stringify(result) + "\n", "utf8");
}

export function loadRuns(benchmark?: string): RunResult[] {
  const runs: RunResult[] = [];
  const seen = new Set<string>();
  for (const root of resolveHistoryRoots()) {
    const indexFile = path.join(root, "index.jsonl");
    if (!fs.existsSync(indexFile)) continue;
    for (const line of fs.readFileSync(indexFile, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const run = JSON.parse(line) as RunResult;
        const key = `${run.id ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!benchmark || benchmarkMatches(run, benchmark)) runs.push(run);
      } catch {
        // skip malformed lines
      }
    }
  }
  return runs;
}

/** History filters accept both the suite key and the canonical version name. */
function benchmarkMatches(run: RunResult, reference: string): boolean {
  const wanted = reference.trim().toLowerCase();
  const runBenchmark = String(run.benchmark ?? "").toLowerCase();
  const version = String(run.benchmarkVersion ?? "").toLowerCase();
  if (runBenchmark === wanted || version === wanted) return true;
  if (wanted === "pagoda" || wanted === "pagoda-v1") return runBenchmark === "pagoda" || version === "pagoda-v1";
  if (wanted === "agent-endurance-v3" || wanted === "endurance") {
    return runBenchmark === "agent-endurance-v3" || version === "agent-endurance-v3";
  }
  if (wanted === "agent-endurance-v4" || wanted === "endurance-v4") {
    return runBenchmark === "agent-endurance-v4" || version === "agent-endurance-v4";
  }
  if (["agent-endurance-v5", "endurance-v5", "agent-endurance-3.0.0-rev2"].includes(wanted)) {
    return runBenchmark === "agent-endurance-v5" || version === "agent-endurance-3.0.0-rev2";
  }
  return false;
}

export function findRun(id: string): RunResult | null {
  return loadRuns().find((run) => run.id === id) ?? null;
}

export function latestRuns(benchmark: string, limit: number): RunResult[] {
  return loadRuns(benchmark).slice(-limit).reverse();
}

/** Locked-variable audit for fair model comparisons. Model identity may differ. */
export function fairComparisonIssues(runs: RunResult[]): string[] {
  if (runs.length < 2) return ["at least two runs are required"];
  const fields: Array<[string, (run: RunResult) => unknown]> = [
    ["benchmark version", (r) => r.benchmarkVersion],
    ["prompt hash", (r) => r.promptHash],
    ["thinking level", (r) => r.thinkingLevel],
    ["context length", (r) => r.endurance?.configuration?.contextWindow ?? "UNKNOWN"],
    ["max output", (r) => r.endurance?.configuration?.maxTokens ?? "UNKNOWN"],
    ["wall budget", (r) => r.endurance?.configuration?.timeoutMs ?? "UNKNOWN"],
    ["turn budget", (r) => r.endurance?.configuration?.maxTurns ?? "UNKNOWN"],
    ["continuation policy", (r) => r.endurance?.configuration?.continuationLimit ?? "UNKNOWN"],
  ];
  const issues: string[] = [];
  for (const [label, read] of fields) {
    const values = runs.map((run) => JSON.stringify(read(run)));
    if (new Set(values).size > 1) issues.push(`${label} differs: ${values.join(" vs ")}`);
  }
  return issues;
}
