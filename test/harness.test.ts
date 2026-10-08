/**
 * Harness tests. No model calls: the runner logic, metric math, PNG analysis,
 * outcome classification and browser validation are exercised with fixtures.
 *
 *   node test/harness.test.ts
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { RunMetrics } from "../src/metrics.ts";
import { decodePng, visualSanity } from "../src/png.ts";
import { determineOutcome } from "../src/outcome.ts";
import { findArtifact } from "../src/artifact.ts";
import { validateArtifact, findBrowser } from "../src/browser.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures");

let failures = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

/** Minimal PNG encoder so the tests can synthesise screenshots. */
function makePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const offset = y * (1 + width * 3) + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }

  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeBuffer = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuffer, data])) >>> 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function testMetrics(): void {
  console.log("\n[metrics]");
  let now = 0;
  const metrics = new RunMetrics(() => now);
  metrics.start();

  // assistant 1: request at 0, first token at 1000, ends at 3000, 600 output tokens
  now = 0;
  metrics.beginAssistantMessage();
  now = 1000;
  metrics.contentStarted();
  now = 3000;
  metrics.endAssistantMessage({ output: 600, input: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } }, "toolUse");

  // tool execution: 2000 ms of wall time, no generation
  now = 5000;
  metrics.toolCall(false);

  // assistant 2: request at 5000, first token at 5500, ends at 7500, 400 output tokens
  now = 5000;
  metrics.beginAssistantMessage();
  now = 5500;
  metrics.contentStarted();
  now = 7500;
  metrics.endAssistantMessage({ output: 400, input: 200, cacheRead: 50, cacheWrite: 0, cost: { total: 0.2 } }, "stop");

  now = 8000;
  metrics.finish();
  const snapshot = metrics.snapshot();

  check("wall time is 8000 ms", snapshot.wallMs === 8000, `got ${snapshot.wallMs}`);
  check("generation time excludes prefill and tools", snapshot.genMs === 4000, `got ${snapshot.genMs}`);
  check("total output tokens", snapshot.outputTokens === 1000, `got ${snapshot.outputTokens}`);
  check("weighted TPS is 250 tok/s", Math.abs(snapshot.weightedTps - 250) < 0.001, `got ${snapshot.weightedTps}`);
  check("wall TPS is 125 tok/s", Math.abs(snapshot.wallTps - 125) < 0.001, `got ${snapshot.wallTps}`);
  check("tool calls counted", snapshot.toolCalls === 1);
  check("stop reasons recorded", snapshot.stopReasons.join(",") === "toolUse,stop");
}

function testVisual(): void {
  console.log("\n[visual]");

  const black = decodePng(makePng(200, 200, () => [0, 0, 0]));
  const blackReport = visualSanity(black);
  check("all-black screenshot fails visual sanity", !blackReport.ok, blackReport.reasons.join("; "));
  check("all-black reports 100% black", blackReport.blackFraction === 1);

  const white = decodePng(makePng(200, 200, () => [255, 255, 255]));
  const whiteReport = visualSanity(white);
  check("all-white screenshot fails visual sanity", !whiteReport.ok, whiteReport.reasons.join("; "));
  check("all-white reports 100% white", whiteReport.whiteFraction === 1);

  const scene = decodePng(
    makePng(300, 200, (x, y) => {
      if (y < 60) return [40 + (x % 40), 90, 160];
      if (x > 120 && x < 180) return [200, 60 + (y % 50), 40];
      return [30, 120 + (x % 60), 60 + (y % 30)];
    }),
  );
  const sceneReport = visualSanity(scene);
  check("colourful scene passes visual sanity", sceneReport.ok, sceneReport.reasons.join("; "));
  check("colourful scene has >= 3 colours", sceneReport.uniqueColors >= 3, `got ${sceneReport.uniqueColors}`);
}

function testOutcome(): void {
  console.log("\n[outcome]");
  const goodMetrics = {
    wallMs: 60000, genMs: 20000, outputTokens: 5000, inputTokens: 1000, cacheRead: 0, cacheWrite: 0,
    cost: 0.5, weightedTps: 250, wallTps: 83.3, generations: 3, toolCalls: 4, toolErrors: 0,
    stopReasons: ["toolUse", "toolUse", "stop"], aborted: false,
  };
  const goodArtifact = {
    found: true, path: "pagoda.html", name: "pagoda.html", sizeBytes: 9000, candidates: ["pagoda.html"],
    checks: { hasCanvas: true, hasThree: true, hasScript: true, closedHtml: true, sizeOk: true }, staticOk: true,
  };
  const goodBrowser = {
    attempted: true, skipped: false, ok: true, browser: "chrome", browserName: "Chrome", durationMs: 4000, errors: [],
    consoleErrors: [], canvas: true, canvasWidth: 1280, canvasHeight: 720, threeLoaded: true, webgl: true,
    bodyTextLength: 0, screenshotPath: "screenshot.png", screenshotWidth: 1280, screenshotHeight: 720, visual: null,
  };
  const goodVisual = {
    ok: true, width: 1280, height: 720, meanLuminance: 90, luminanceStdDev: 60,
    blackFraction: 0.1, whiteFraction: 0.05, uniqueColors: 400, meanSaturation: 0.4, reasons: [],
  };

  check("PASS when everything is good", determineOutcome(goodMetrics, goodArtifact, goodBrowser, goodVisual, false, null).outcome === "PASS");
  check("FAIL_TIMEOUT on wall clock overrun", determineOutcome(goodMetrics, goodArtifact, goodBrowser, goodVisual, true, null).outcome === "FAIL_TIMEOUT");
  check("FAIL_AGENT on abort", determineOutcome({ ...goodMetrics, aborted: true }, goodArtifact, goodBrowser, goodVisual, false, null).outcome === "FAIL_AGENT");
  check("FAIL_LENGTH on length stop reason", determineOutcome({ ...goodMetrics, stopReasons: ["length"] }, goodArtifact, goodBrowser, goodVisual, false, null).outcome === "FAIL_LENGTH");
  check("FAIL_MISSING_ARTIFACT when no html written", determineOutcome(goodMetrics, { ...goodArtifact, found: false, path: null, name: null, sizeBytes: 0, candidates: [], staticOk: false }, goodBrowser, goodVisual, false, null).outcome === "FAIL_MISSING_ARTIFACT");
  check("FAIL_RUNTIME when browser cannot run it", determineOutcome(goodMetrics, goodArtifact, { ...goodBrowser, ok: false, errors: ["THREE is not defined"] }, goodVisual, false, null).outcome === "FAIL_RUNTIME");
  check("FAIL_VISUAL when render is black", determineOutcome(goodMetrics, goodArtifact, goodBrowser, { ...goodVisual, ok: false, reasons: ["all black"] }, false, null).outcome === "FAIL_VISUAL");
  check("ERROR_HARNESS when no browser available", determineOutcome(goodMetrics, goodArtifact, { ...goodBrowser, attempted: false, ok: false }, null, false, null).outcome === "ERROR_HARNESS");
  check("PASS when browser validation is skipped", determineOutcome(goodMetrics, goodArtifact, { ...goodBrowser, attempted: false, skipped: true }, null, false, null).outcome === "PASS");
  check("ERROR_HARNESS when the harness throws", determineOutcome(goodMetrics, goodArtifact, goodBrowser, goodVisual, false, "session failed: boom").outcome === "ERROR_HARNESS");
}

function testArtifactDiscovery(): void {
  console.log("\n[artifact]");
  const dir = path.join(FIXTURES, "discovery");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pagoda.html"), "<!doctype html><html><body><canvas></canvas><script src=\"three.js\"></script></body></html><!-- padding so the fixture is a realistic artifact size: " + "x".repeat(900) + " -->");
  fs.writeFileSync(path.join(dir, "notes.txt"), "not an artifact");
  const report = findArtifact(dir, "pagoda.html");
  check("artifact found", report.found && report.name === "pagoda.html");
  check("artifact passes static checks", report.staticOk);
  check("non-html files are ignored", report.candidates.length === 1);
}

async function testBrowser(): Promise<void> {
  console.log("\n[browser]");
  const browser = findBrowser();
  if (!browser) {
    console.log("  skip  no Chrome/Edge found on this machine");
    return;
  }
  console.log(`  using ${browser.name} at ${browser.path}`);

  const outDir = path.join(FIXTURES, "out");
  fs.mkdirSync(outDir, { recursive: true });

  const blank = await validateArtifact({
    htmlPath: path.join(FIXTURES, "blank.html"),
    screenshotPath: path.join(outDir, "blank.png"),
    timeoutMs: 20000,
    settleMs: 1000,
    viewport: { width: 800, height: 600 },
  });
  check("blank page is rejected", !blank.ok && !blank.canvas, blank.errors.join("; "));

  const black = await validateArtifact({
    htmlPath: path.join(FIXTURES, "webgl-black.html"),
    screenshotPath: path.join(outDir, "black.png"),
    timeoutMs: 20000,
    settleMs: 1500,
    viewport: { width: 800, height: 600 },
  });
  check("black WebGL page runs but fails visual", black.ok && black.webgl && black.visual && !black.visual.ok,
    black.visual ? black.visual.reasons.join("; ") : "no visual report");

  const colour = await validateArtifact({
    htmlPath: path.join(FIXTURES, "webgl-colour.html"),
    screenshotPath: path.join(outDir, "colour.png"),
    timeoutMs: 20000,
    settleMs: 1500,
    viewport: { width: 800, height: 600 },
  });
  check("colour WebGL page passes", colour.ok && colour.webgl && colour.visual?.ok,
    colour.errors.join("; ") || (colour.visual ? colour.visual.reasons.join("; ") : ""));

  const pagoda = await validateArtifact({
    htmlPath: path.join(FIXTURES, "pagoda-good.html"),
    screenshotPath: path.join(outDir, "pagoda.png"),
    timeoutMs: 30000,
    settleMs: 3000,
    viewport: { width: 1280, height: 720 },
  });
  check("reference pagoda renders", pagoda.ok && pagoda.threeLoaded && pagoda.visual?.ok,
    pagoda.errors.join("; ") || (pagoda.visual ? pagoda.visual.reasons.join("; ") : ""));
  console.log(`  screenshot: ${path.join(outDir, "pagoda.png")}`);
}

async function main(): Promise<void> {
  testMetrics();
  testVisual();
  testOutcome();
  testArtifactDiscovery();
  await testBrowser();
  console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
