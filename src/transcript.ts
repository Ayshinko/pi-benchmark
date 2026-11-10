/** Durable, model-invisible benchmark transcript entries. */
import fs from "node:fs";
import path from "node:path";
import { Box, Image, Text, type Component } from "@earendil-works/pi-tui";

export const BENCHMARK_ENTRY = "pi-benchmark-transcript";

export type BenchmarkActivityKind =
  | "start" | "phase" | "assistant" | "tool" | "metrics" | "error" | "result" | "image";

export interface BenchmarkTranscriptEntry {
  kind: BenchmarkActivityKind;
  run: number;
  sequence: number;
  atMs: number;
  title: string;
  text?: string;
  expandedText?: string;
  status?: "running" | "ok" | "error";
  imagePath?: string;
}

export interface BenchmarkForwardEvent {
  kind: "phase" | "assistant" | "tool_start" | "tool_end" | "error" | "recovery";
  atMs: number;
  title: string;
  text?: string;
  expandedText?: string;
  isError?: boolean;
}

export function isReadablePng(file: string | null | undefined): file is string {
  if (!file) return false;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const signature = Buffer.alloc(8);
      return fs.readSync(fd, signature, 0, 8, 0) === 8 && signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function renderBenchmarkEntry(entry: BenchmarkTranscriptEntry, expanded: boolean, theme: any): Component {
  const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
  const marker = entry.status === "error" ? "✗" : entry.status === "ok" ? "✓" : entry.kind === "metrics" ? "·" : "◆";
  const color = entry.status === "error" ? "error" : entry.status === "ok" ? "success" : "accent";
  box.addChild(new Text(`${theme.fg(color, marker)} ${theme.fg("accent", entry.title)}${entry.text ? `\n${entry.text}` : ""}`, 0, 0));
  if (expanded && entry.expandedText) box.addChild(new Text(`\n${theme.fg("dim", entry.expandedText)}`, 0, 0));

  if (entry.kind === "image" && entry.imagePath) {
    if (isReadablePng(entry.imagePath)) {
      const data = fs.readFileSync(entry.imagePath).toString("base64");
      box.addChild(new Image(data, "image/png", { fallbackColor: (value) => theme.fg("dim", value) }, {
        filename: entry.imagePath,
        maxWidthCells: 80,
        maxHeightCells: 32,
      }));
    } else {
      box.addChild(new Text(theme.fg("warning", `\nScreenshot unavailable or invalid: ${entry.imagePath}`), 0, 0));
    }
  }
  return box;
}

export function compactJson(value: unknown, limit = 220): string {
  let text: string;
  try { text = JSON.stringify(value); } catch { text = String(value); }
  text = text.replace(/\s+/g, " ");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function summarizeToolResult(result: any): { short: string; full?: string } {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const full = parts.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n").trim();
  if (!full) return { short: result?.isError ? "tool failed" : "completed" };
  const oneLine = full.replace(/\s+/g, " ");
  return { short: oneLine.length > 240 ? `${oneLine.slice(0, 240)}…` : oneLine, full: full.length > 240 ? full : undefined };
}

export function imageTitle(file: string): string {
  return `Pagoda final browser screenshot · ${path.basename(file)}`;
}
