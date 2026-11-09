/**
 * Versioned benchmark prompts.
 *
 * Every prompt is pinned to a version string so a run can be compared against
 * an identical task later. Changing the text means bumping the version.
 *
 * The canonical production prompt for pagoda-v1 is stored as a dedicated,
 * immutable asset (`assets/pagoda-v1.prompt.txt`), NOT duplicated as an inline
 * string. `getPrompt("pagoda")` and the `/benchmark` entry point both resolve
 * to this exact canonical prompt, so there is a single source of truth.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// Load the canonical prompt text at module initialisation. readFileSync keeps
// this deterministic and independent of any session. The file must not be
// edited in place after a release: change the version instead.
const PAGODA_V1_TEXT = fs.readFileSync(
  path.join(import.meta.dirname, "assets", "pagoda-v1.prompt.txt"),
  "utf8",
);
const AGENT_ENDURANCE_V3_TEXT = fs.readFileSync(
  path.join(import.meta.dirname, "assets", "agent-endurance-v3.prompt.txt"), "utf8",
);

/**
 * SHA-256 over the exact bytes (UTF-8) of the given prompt text. This is the
 * value persisted as `promptHash` on every run, matching exactly what is sent
 * to `session.prompt()`.
 */
export function hashPrompt(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface BenchmarkPrompt {
  /** Registry key used internally and in the on-disk history path. */
  benchmark: string;
  /** Canonical versioned benchmark name, e.g. "pagoda-v1". */
  version: string;
  /** Human-friendly name, e.g. "Pagoda v1". */
  name: string;
  prompt: string;
  expectedArtifact: string;
}

export const PAGODA_V1_PROMPT_TEXT = PAGODA_V1_TEXT;

export const PAGODA_V1: BenchmarkPrompt = {
  benchmark: "pagoda",
  version: "pagoda-v1",
  name: "Pagoda v1",
  prompt: PAGODA_V1_TEXT,
  expectedArtifact: "index.html",
};
export const AGENT_ENDURANCE_V3: BenchmarkPrompt = {
  benchmark: "agent-endurance-v3", version: "agent-endurance-v3", name: "Agent Endurance V3",
  prompt: AGENT_ENDURANCE_V3_TEXT, expectedArtifact: "warehouse/__init__.py",
};

export const PROMPTS: Record<string, BenchmarkPrompt> = {
  pagoda: PAGODA_V1,
  "agent-endurance-v3": AGENT_ENDURANCE_V3,
};

/** The single production benchmark suite currently shipped (pagoda-v1). */
export function productionBenchmarks(): BenchmarkPrompt[] {
  return [PAGODA_V1, AGENT_ENDURANCE_V3];
}

/**
 * Resolve a user-facing benchmark reference (e.g. "pagoda", "pagoda-v1", "v1",
 * "Pagoda v1") to its canonical BenchmarkPrompt. The canonical version is
 * always `pagoda-v1`.
 */
export function resolveBenchmark(ref: string): BenchmarkPrompt {
  const key = String(ref ?? "").trim().toLowerCase();
  if (key === "" || key === "pagoda" || key === "pagoda-v1" || key === "v1" || key === "pagoda v1") {
    return PAGODA_V1;
  }
  if (["agent-endurance-v3", "endurance", "endurance-v3", "agent endurance v3"].includes(key)) return AGENT_ENDURANCE_V3;
  throw new Error(`Unknown benchmark "${ref}". Available: pagoda-v1, agent-endurance-v3`);
}

export function getPrompt(benchmark: string): BenchmarkPrompt {
  const entry = PROMPTS[benchmark];
  if (!entry) {
    throw new Error(`Unknown benchmark "${benchmark}". Available: ${Object.keys(PROMPTS).join(", ")}`);
  }
  return entry;
}
