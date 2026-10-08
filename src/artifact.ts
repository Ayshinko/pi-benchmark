/**
 * Artifact discovery and static validation.
 */

import fs from "node:fs";
import path from "node:path";
import type { ArtifactReport } from "./types.ts";

const IGNORED_DIRS = new Set(["node_modules", ".git", ".pi", "session", "__pycache__"]);

function walk(dir: string, depth: number, out: string[]): void {
  if (depth > 4) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walk(full, depth + 1, out);
    } else if (/\.(html|htm)$/i.test(entry.name)) {
      out.push(full);
    }
  }
}

export function findArtifact(workspace: string, expectedName: string): ArtifactReport {
  const candidates: string[] = [];
  walk(workspace, 0, candidates);

  const empty: ArtifactReport = {
    found: false,
    path: null,
    name: null,
    sizeBytes: 0,
    candidates,
    checks: {
      hasCanvas: false,
      hasThree: false,
      hasScript: false,
      closedHtml: false,
      sizeOk: false,
    },
    staticOk: false,
  };

  if (candidates.length === 0) return empty;

  const exact = candidates.find((c) => path.basename(c).toLowerCase() === expectedName.toLowerCase());
  const chosen =
    exact ??
    candidates.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];

  const size = fs.statSync(chosen).size;
  const html = fs.readFileSync(chosen, "utf8");
  const lower = html.toLowerCase();

  const checks = {
    hasCanvas: lower.includes("<canvas") || lower.includes("webgl"),
    hasThree: lower.includes("three"),
    hasScript: lower.includes("<script"),
    closedHtml: lower.includes("</html>"),
    sizeOk: size >= 800,
  };

  return {
    found: true,
    path: chosen,
    name: path.basename(chosen),
    sizeBytes: size,
    candidates,
    checks,
    staticOk: checks.hasCanvas && checks.hasThree && checks.hasScript && checks.closedHtml && checks.sizeOk,
  };
}
