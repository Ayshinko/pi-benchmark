/**
 * Browser validation with puppeteer-core against an already installed
 * Chrome or Edge. No bundled Chromium, no --disable-gpu.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import type { BrowserReport } from "./types.ts";
import { decodePng, visualSanity } from "./png.ts";

export interface BrowserValidationOptions {
  htmlPath: string;
  screenshotPath: string;
  timeoutMs: number;
  settleMs: number;
  viewport: { width: number; height: number };
}

/** Build a default (empty) RuntimeProbe so every path has stable fields. */
function emptyRuntime(): import("./types.ts").RuntimeProbe {
  return {
    threeLoaded: false,
    canvas: false,
    webgl: false,
    bodyText: "",
    reportedVoxels: null,
    reportedFps: null,
    objectCount: null,
    instancedMeshes: null,
    features: [],
  };
}

export function findBrowser(): { path: string; name: string } | null {
  const candidates: string[] = [];

  if (process.env.PI_BENCH_BROWSER) candidates.push(process.env.PI_BENCH_BROWSER);
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);

  if (process.platform === "win32") {
    candidates.push(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
    );
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return {
        path: candidate,
        name: candidate.toLowerCase().includes("edge") ? "Edge" : "Chrome",
      };
    }
  }

  // Last resort: ask the shell where the binaries live.
  const probe = process.platform === "win32" ? "where" : "which";
  for (const binary of ["chrome", "msedge", "google-chrome", "chromium"]) {
    try {
      const result = spawnSync(probe, [binary], { timeout: 5000 });
      const out = (result.stdout || "").toString().trim().split(/\r?\n/)[0];
      if (result.status === 0 && out && fs.existsSync(out)) {
        return { path: out, name: binary.includes("edge") ? "Edge" : "Chrome" };
      }
    } catch {
      // ignore
    }
  }

  return null;
}

export async function validateArtifact(options: BrowserValidationOptions): Promise<BrowserReport> {
  const browserPath = findBrowser();
  const started = Date.now();

  const report: BrowserReport = {
    attempted: false,
    skipped: false,
    ok: false,
    browser: browserPath?.path ?? null,
    browserName: browserPath?.name ?? null,
    durationMs: 0,
    errors: [],
    consoleErrors: [],
    canvas: false,
    canvasWidth: 0,
    canvasHeight: 0,
    threeLoaded: false,
    webgl: false,
    bodyTextLength: 0,
    bodyText: "",
    runtime: emptyRuntime(),
    screenshotPath: null,
    screenshotWidth: 0,
    screenshotHeight: 0,
  };

  if (!browserPath) {
    report.errors.push("No Chrome or Edge executable found. Set PI_BENCH_BROWSER to the browser path.");
    report.durationMs = Date.now() - started;
    return report;
  }

  let browser: any = null;

  try {
    report.attempted = true;
    browser = await puppeteer.launch({
      executablePath: browserPath.path,
      headless: "new",
      args: [
        "--no-sandbox",
        "--hide-scrollbars",
        `--window-size=${options.viewport.width},${options.viewport.height}`,
      ],
    });

    const page = await browser.newPage();
    page.on("error", (err: Error) => report.errors.push(`page error: ${err.message}`));
    page.on("console", (msg: any) => {
      if (msg.type() === "error") report.consoleErrors.push(msg.text());
    });

    await page.setViewport(options.viewport);
    await page.goto(`file:///${options.htmlPath.replace(/\\/g, "/")}`, {
      waitUntil: "load",
      timeout: options.timeoutMs,
    });

    // Give the scene time to build and render at least one frame.
    await new Promise((resolve) => setTimeout(resolve, options.settleMs));

    const probe = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      let webgl = false;
      if (canvas) {
        try {
          webgl = Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
        } catch {
          webgl = false;
        }
      }
      // Optional cooperative metrics the artifact may expose; treated as strong
      // evidence only, never required. Absence means UNKNOWN, not FAIL.
      const M = (window as any).__benchMetrics;
      return {
        canvas: Boolean(canvas),
        canvasWidth: canvas ? canvas.width : 0,
        canvasHeight: canvas ? canvas.height : 0,
        threeLoaded: typeof (window as any).THREE !== "undefined",
        webgl,
        bodyText: (document.body?.innerText || "").trim(),
        readyState: document.readyState,
        reportedVoxels: M && typeof M.voxels === "number" ? M.voxels : null,
        reportedFps: M && typeof M.fps === "number" ? M.fps : null,
        objectCount: M && typeof M.objectCount === "number" ? M.objectCount : null,
        instancedMeshes: M && typeof M.instances === "number" ? M.instances : null,
        features: M && Array.isArray(M.features) ? M.features.map(String) : [],
      };
    });

    report.canvas = probe.canvas;
    report.canvasWidth = probe.canvasWidth;
    report.canvasHeight = probe.canvasHeight;
    report.threeLoaded = probe.threeLoaded;
    report.webgl = probe.webgl;
    report.bodyText = probe.bodyText;
    report.bodyTextLength = probe.bodyText.length;
    report.runtime = {
      threeLoaded: probe.threeLoaded,
      canvas: probe.canvas,
      webgl: probe.webgl,
      bodyText: probe.bodyText,
      reportedVoxels: probe.reportedVoxels,
      reportedFps: probe.reportedFps,
      objectCount: probe.objectCount,
      instancedMeshes: probe.instancedMeshes,
      features: probe.features,
    };

    if (!probe.canvas) report.errors.push("no <canvas> element in the page");
    // Three.js can be loaded as a classic script (window.THREE) or as an ES module
    // (import * as THREE from "..."), which never touches window. A WebGL context on
    // the canvas is the real signal that a renderer was created.
    if (!probe.webgl) {
      report.errors.push("no WebGL context on the canvas - no Three.js renderer was created");
    }
    if (report.errors.length > 0 || report.consoleErrors.length > 0) {
      report.ok = false;
    } else {
      report.ok = true;
    }

    const base64 = await page.screenshot({ encoding: "base64" });
    const buffer = Buffer.from(base64, "base64");
    fs.writeFileSync(options.screenshotPath, buffer);
    report.screenshotPath = options.screenshotPath;

    const image = decodePng(buffer);
    report.screenshotWidth = image.width;
    report.screenshotHeight = image.height;
    report.visual = visualSanity(image);
  } catch (error) {
    report.errors.push(`browser validation failed: ${(error as Error).message}`);
    report.ok = false;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore close failures
      }
    }
  }

  report.durationMs = Date.now() - started;
  return report;
}
