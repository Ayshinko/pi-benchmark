/**
 * Independent evaluation for Agent Endurance V3.
 *
 * The hidden verification suite lives in `src/evaluators/agent-endurance-v3.py`
 * inside this repository. It is executed with the evaluated workspace as its only
 * argument, and it is never copied into that workspace, so the evaluated agent
 * never sees these tests or their expectations.
 *
 * The child process gets a minimal environment (PATH only): credentials and other
 * secret environment variables are not handed to the evaluator, and the evaluator
 * output (pure JSON) is the only thing read back.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import type { EnduranceEvaluation } from "./endurance-scoring.ts";

export const EVALUATOR_SCRIPT = path.join(import.meta.dirname, "evaluators", "agent-endurance-v3.py");
export const EVALUATOR_V4_SCRIPT = path.join(import.meta.dirname, "evaluators", "agent-endurance-v4.py");
export const EVALUATOR_V5_SCRIPT = path.join(import.meta.dirname, "evaluators", "agent-endurance-v5.py");

export function evaluatorScript(benchmarkVersion = "agent-endurance-v3"): string {
  if (benchmarkVersion === "agent-endurance-3.0.0-rev2") return EVALUATOR_V5_SCRIPT;
  return benchmarkVersion === "agent-endurance-v4" ? EVALUATOR_V4_SCRIPT : EVALUATOR_SCRIPT;
}

/** 12 documented phases; used to report evidence per phase, not just a count. */
export const PHASE_LABELS: string[] = [
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

export interface PhaseEvidence {
  phase: number;
  label: string;
  evidence: string | null;
  status: "declared" | "missing";
}

export interface EnduranceEvaluationReport extends EnduranceEvaluation {
  phases: PhaseEvidence[];
  evaluatorScript: string;
  workspace: string;
  notes: string[];
}

/** SHA-256 of the hidden evaluator source, recorded with every result. */
export function evaluatorIdentity(benchmarkVersion = "agent-endurance-v3"): { version: string; sha256: string } {
  const source = fs.readFileSync(evaluatorScript(benchmarkVersion));
  const sha256 = crypto.createHash("sha256").update(source).digest("hex");
  const declared = /EVALUATOR_VERSION\s*=\s*["']([^"']+)/.exec(source.toString("utf8"));
  return { version: declared?.[1] ?? "unknown", sha256 };
}

/**
 * Run the hidden evaluator against `workspace`.
 * `pythonPath` is injectable for tests; default resolves python on Windows.
 */
export function evaluateEndurance(
  workspace: string,
  options: { pythonPath?: string; timeoutMs?: number; benchmarkVersion?: string } = {},
): EnduranceEvaluationReport {
  const python = options.pythonPath ?? (process.platform === "win32" ? "python" : "python3");
  const script = evaluatorScript(options.benchmarkVersion);
  const identity = evaluatorIdentity(options.benchmarkVersion);
  const notes: string[] = [];
  const proc = spawnSync(python, [script, workspace], {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 180000,
    // PATH only: never forward credentials or unrelated secret environment values.
    env: { PATH: process.env.PATH ?? "" },
    windowsHide: true,
  });

  let parsed: any = null;
  try {
    parsed = JSON.parse(proc.stdout || "");
  } catch {
    // handled below
  }

  const phases = phaseEvidence(workspace);
  if (!parsed) {
    notes.push(
      `hidden evaluator did not produce JSON (${proc.error?.message ?? `exit ${proc.status}`}${
        proc.stderr ? `: ${String(proc.stderr).slice(0, 200)}` : ""
      })`,
    );
    return {
      passed: 0,
      total: 1,
      categories: {},
      phaseCompletion: phases.filter((p) => p.status === "declared").length,
      completed: false,
      details: notes,
      phases,
      evaluatorScript: script,
      workspace,
      notes,
      evaluatorVersion: identity.version,
      evaluatorSha256: identity.sha256,
    };
  }

  const phasesDeclared = phases.filter((p) => p.status === "declared").length;
  const completed = parsed.passed === parsed.total && phasesDeclared === PHASE_LABELS.length;
  if (String(parsed.evaluatorVersion ?? "") !== identity.version) {
    notes.push(
      `evaluator reported version ${parsed.evaluatorVersion ?? "missing"}, expected ${identity.version}`,
    );
  }
  return {
    passed: parsed.passed,
    total: parsed.total,
    categories: parsed.categories ?? {},
    phaseCompletion: phasesDeclared,
    completed,
    details: parsed.details ?? [],
    phases,
    evaluatorScript: script,
    workspace,
    notes,
    evaluatorVersion: String(parsed.evaluatorVersion ?? identity.version),
    evaluatorSha256: String(parsed.evaluatorSha256 ?? identity.sha256),
  };
}

/**
 * Objective phase evidence: the agent must record what it did for each phase in
 * `PHASES.md`. This is deliberately not a self-reported summary: an empty or
 * narrative-free section counts as missing.
 */
export function phaseEvidence(workspace: string): PhaseEvidence[] {
  const file = path.join(workspace, "PHASES.md");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  return PHASE_LABELS.map((label, index) => {
    const phase = index + 1;
    const line = findPhaseLine(text, phase);
    return { phase, label, evidence: line, status: line ? "declared" as const : "missing" as const };
  });
}

function findPhaseLine(text: string, phase: number): string | null {
  const pattern = new RegExp(`(?:^|\\n)(#{1,6}\\s*)?(?:phase\\s*)?${phase}(?:[.:)\\s-]|$)`, "i");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!pattern.test(`${line}\n`)) continue;
    // require actual evidence: the line itself, or the line below, carries text
    const rest = text.split(/\r?\n/);
    const index = rest.findIndex((entry) => entry.trim() === line);
    const following = index >= 0 ? (rest[index + 1] ?? "").trim() : "";
    const inline = line.replace(/^[#*\s]*phase\s*\d+[.:)\s-]*/i, "").trim();
    if (inline.length >= 3) return line.slice(0, 160);
    if (following.length >= 3) return `${line} -> ${following}`.slice(0, 160);
    return null;
  }
  return null;
}
