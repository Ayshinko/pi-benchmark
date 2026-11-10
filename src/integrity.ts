import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type IntegritySnapshot = Record<string, string>;

function addFile(out: IntegritySnapshot, file: string): void {
  try {
    if (!fs.statSync(file).isFile()) return;
    out[path.resolve(file)] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch { /* missing or unreadable is represented by absence */ }
}

function addTree(out: IntegritySnapshot, root: string): void {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if ([".git", "node_modules", "__pycache__", ".venv"].includes(entry.name)) continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) addTree(out, target);
    else if (entry.isFile()) addFile(out, target);
  }
}

/** Hash protected benchmark/config surfaces without ever storing file contents. */
export function captureIntegrity(agentDir: string, benchmarkRoot: string): IntegritySnapshot {
  const out: IntegritySnapshot = {};
  for (const name of ["settings.json", "models.json", "models-store.json", "auth.json"]) addFile(out, path.join(agentDir, name));
  addTree(out, path.join(agentDir, "extensions"));
  addTree(out, path.join(benchmarkRoot, "src", "evaluators"));
  for (const name of ["package.json", "index.ts"]) addFile(out, path.join(benchmarkRoot, name));
  const strata = process.platform === "win32" ? "C:\\AI\\State\\strata" : "";
  if (strata && fs.existsSync(strata)) {
    for (const name of ["config.json", "settings.json", "strata.json"]) addFile(out, path.join(strata, name));
  }
  return out;
}

export function compareIntegrity(before: IntegritySnapshot, after: IntegritySnapshot): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => before[key] !== after[key]).sort();
}
