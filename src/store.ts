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

export const BENCH_ROOT = path.join(os.homedir(), ".pi", "benchmarks");
const INDEX_FILE = path.join(BENCH_ROOT, "index.jsonl");

export function ensureRoot(): void {
  fs.mkdirSync(BENCH_ROOT, { recursive: true });
}

export function saveRun(result: RunResult): void {
  ensureRoot();
  fs.writeFileSync(path.join(result.runDir, "run.json"), JSON.stringify(result, null, 2), "utf8");
  fs.appendFileSync(INDEX_FILE, JSON.stringify(result) + "\n", "utf8");
}

export function loadRuns(benchmark?: string): RunResult[] {
  if (!fs.existsSync(INDEX_FILE)) return [];
  const runs: RunResult[] = [];
  for (const line of fs.readFileSync(INDEX_FILE, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const run = JSON.parse(line) as RunResult;
      if (!benchmark || run.benchmark === benchmark) runs.push(run);
    } catch {
      // skip malformed lines
    }
  }
  return runs;
}

export function findRun(id: string): RunResult | null {
  return loadRuns().find((run) => run.id === id) ?? null;
}

export function latestRuns(benchmark: string, limit: number): RunResult[] {
  return loadRuns(benchmark).slice(-limit).reverse();
}
