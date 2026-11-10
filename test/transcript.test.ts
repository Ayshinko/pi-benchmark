import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { setCapabilities, setCellDimensions } from "@earendil-works/pi-tui";
import { BENCHMARK_ENTRY, isReadablePng, renderBenchmarkEntry, summarizeToolResult } from "../src/transcript.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-benchmark-transcript-"));
const png = path.join(dir, "pagoda.png");
// Real, decodable 1x1 PNG fixture.
fs.writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
assert.equal(isReadablePng(png), true, "valid PNG is accepted");
assert.equal(isReadablePng(path.join(dir, "missing.png")), false, "missing PNG uses fallback");

setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
setCellDimensions({ widthPx: 8, heightPx: 16 });
const theme = { fg: (_name: string, value: string) => value, bg: (_name: string, value: string) => value };
const component = renderBenchmarkEntry({ kind: "image", run: 1, sequence: 2, atMs: 1, title: "Pagoda screenshot", imagePath: png, status: "ok" }, false, theme);
const rendered = component.render(100).join("\n");
assert.match(rendered, /\x1b_G/, "real PNG renders through native Kitty image protocol");

const sessionDir = path.join(dir, "sessions");
const manager = SessionManager.create(dir, sessionDir);
manager.appendMessage({ role: "user", content: "ordinary prompt", timestamp: Date.now() } as any);
manager.appendCustomEntry(BENCHMARK_ENTRY, { kind: "result", title: "PASS" });
const file = manager.getSessionFile();
assert(file, "session file created");
const reopened = SessionManager.open(file!, sessionDir);
assert(reopened.getEntries().some((entry: any) => entry.type === "custom" && entry.customType === BENCHMARK_ENTRY), "entry survives session reload");
assert(!reopened.buildSessionContext().messages.some((message: any) => JSON.stringify(message).includes("PASS")), "benchmark entry is excluded from model context");

const summary = summarizeToolResult({ content: [{ type: "text", text: "line one\nline two" }] });
assert.equal(summary.short, "line one line two", "tool output is concise by default");
console.log("TRANSCRIPT TESTS PASSED");
