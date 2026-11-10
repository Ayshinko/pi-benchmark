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
const AGENT_ENDURANCE_V4_TEXT = fs.readFileSync(
  path.join(import.meta.dirname, "assets", "agent-endurance-v4.prompt.txt"), "utf8",
);
const AGENT_ENDURANCE_V5_TEXT = fs.readFileSync(
  path.join(import.meta.dirname, "assets", "agent-endurance-v5.prompt.txt"), "utf8",
);
export const AGENT_ENDURANCE_V5_REGISTERED_SHA256 = "d0327cff7fe4f7d54590fa8691818da6eb1f85962132af1b86c4ad01022c02a9";

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
  /** Default wall-clock budget for one run, in seconds (per-suite, not per-model). */
  timeoutSeconds: number;
  /** Hard assistant-turn budget when the runner can enforce it. */
  maxTurns?: number;
  /** Frozen hash; a mismatch prevents suite resolution. */
  registeredPromptHash?: string;
}

export const PAGODA_V1_PROMPT_TEXT = PAGODA_V1_TEXT;

export const PAGODA_V1: BenchmarkPrompt = {
  benchmark: "pagoda",
  version: "pagoda-v1",
  name: "Pagoda v1",
  prompt: PAGODA_V1_TEXT,
  expectedArtifact: "index.html",
  timeoutSeconds: 1200,
};
export const AGENT_ENDURANCE_V3: BenchmarkPrompt = {
  benchmark: "agent-endurance-v3", version: "agent-endurance-v3", name: "Agent Endurance V3",
  prompt: AGENT_ENDURANCE_V3_TEXT, expectedArtifact: "warehouse/__init__.py",
  // A 12-phase build needs far more wall time than a single-file artifact task.
  timeoutSeconds: 10800,
};
export const AGENT_ENDURANCE_V4: BenchmarkPrompt = {
  benchmark: "agent-endurance-v4", version: "agent-endurance-v4", name: "Agent Endurance V4",
  prompt: AGENT_ENDURANCE_V4_TEXT, expectedArtifact: "warehouse/__init__.py",
  timeoutSeconds: 10800,
};
export const AGENT_ENDURANCE_V5: BenchmarkPrompt = {
  benchmark: "agent-endurance-v5", version: "agent-endurance-3.0.0-rev2", name: "Agent Endurance V5",
  prompt: AGENT_ENDURANCE_V5_TEXT, expectedArtifact: "wms/__init__.py",
  timeoutSeconds: 14400,
  maxTurns: 400,
  registeredPromptHash: AGENT_ENDURANCE_V5_REGISTERED_SHA256,
};

/**
 * Diagnostic continuation prompt for Agent Endurance V3 resume runs only.
 *
 * It is separately versioned so a resumed run never pretends it used the canonical
 * benchmark prompt: the recorded `promptHash` is the hash of this text, and the run
 * is flagged `resumed: true` (a resumed run cannot be an autonomous PASS).
 */
export const AGENT_ENDURANCE_V3_CONTINUATION_VERSION = "agent-endurance-v3.continuation-v1";
export const AGENT_ENDURANCE_V3_CONTINUATION_PROMPT = `You are continuing the Agent Endurance V3 benchmark in the current workspace. This is a diagnostic continuation of an earlier run, not a fresh run.

The canonical benchmark contract still applies (package "warehouse", WarehouseSystem, atomic multi-line operations, checksum persistence, argparse CLI, PHASES.md evidence, standard library only).

Do not start over and do not delete existing work. Inspect the current artifacts, run the full test suite (python -m unittest discover -v), repair failing behaviour, and finish every phase that is still missing. Update PHASES.md with objective evidence for each completed phase and report what changed.`;

export const PROMPTS: Record<string, BenchmarkPrompt> = {
  pagoda: PAGODA_V1,
  "agent-endurance-v3": AGENT_ENDURANCE_V3,
  "agent-endurance-v4": AGENT_ENDURANCE_V4,
  "agent-endurance-v5": AGENT_ENDURANCE_V5,
};

/** The production benchmark suites currently shipped (pagoda-v1 and agent-endurance-v3). */
export function productionBenchmarks(): BenchmarkPrompt[] {
  return [PAGODA_V1, AGENT_ENDURANCE_V3, AGENT_ENDURANCE_V4, AGENT_ENDURANCE_V5];
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
  if (["agent-endurance-v4", "endurance-v4", "agent endurance v4"].includes(key)) return AGENT_ENDURANCE_V4;
  if (["agent-endurance-v5", "endurance-v5", "agent endurance v5", "agent-endurance-3.0.0-rev2"].includes(key)) {
    if (hashPrompt(AGENT_ENDURANCE_V5.prompt) !== AGENT_ENDURANCE_V5_REGISTERED_SHA256) {
      throw new Error("Agent Endurance V5 prompt hash mismatch; refusing to start a mutated benchmark");
    }
    return AGENT_ENDURANCE_V5;
  }
  throw new Error(`Unknown benchmark "${ref}". Available: pagoda-v1, agent-endurance-v3, agent-endurance-v4, agent-endurance-v5`);
}

export function getPrompt(benchmark: string): BenchmarkPrompt {
  const entry = PROMPTS[benchmark];
  if (!entry) {
    throw new Error(`Unknown benchmark "${benchmark}". Available: ${Object.keys(PROMPTS).join(", ")}`);
  }
  if (entry.registeredPromptHash && hashPrompt(entry.prompt) !== entry.registeredPromptHash) {
    throw new Error(`${entry.name} prompt hash mismatch; refusing to start a mutated benchmark`);
  }
  return entry;
}
