import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { EnduranceEvaluation } from "./endurance-scoring.ts";

export function evaluateEndurance(workspace: string): EnduranceEvaluation {
  const script = path.join(import.meta.dirname, "evaluators", "agent-endurance-v3.py");
  const proc = spawnSync(process.platform === "win32" ? "python" : "python3", [script, workspace], { encoding: "utf8", timeout: 120000, env: { PATH: process.env.PATH ?? "" } });
  let parsed: any = null;
  try { parsed = JSON.parse(proc.stdout || ""); } catch {}
  if (!parsed) return { passed: 0, total: 1, categories: {}, phaseCompletion: phaseCount(workspace), completed: false, details: [`evaluator failed: ${proc.error?.message ?? proc.stderr ?? `exit ${proc.status}`}`] };
  return { ...parsed, phaseCompletion: phaseCount(workspace), completed: parsed.passed === parsed.total && phaseCount(workspace) === 12 };
}

function phaseCount(workspace: string): number {
  const file = path.join(workspace, "PHASES.md");
  if (!fs.existsSync(file)) return 0;
  const text = fs.readFileSync(file, "utf8");
  let n = 0; for (let i = 1; i <= 12; i++) if (new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:phase\\s*)?${i}[. :)-]`, "i").test(text)) n++;
  return n;
}
