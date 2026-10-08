// Re-validate an existing artifact directory without running a model.
import path from "node:path";
import { validateArtifact } from "../src/browser.ts";
import { findArtifact } from "../src/artifact.ts";
import { determineOutcome } from "../src/outcome.ts";

const workspace = process.argv[2];
if (!workspace) {
  console.error("usage: node test/revalidate.ts <workspace-dir>");
  process.exit(1);
}

const artifact = findArtifact(workspace, "pagoda.html");
console.log("artifact:", artifact.name, artifact.sizeBytes, "staticOk:", artifact.staticOk);

const browser = await validateArtifact({
  htmlPath: artifact.path!,
  screenshotPath: path.join(workspace, "screenshot.png"),
  timeoutMs: 30000,
  settleMs: 3000,
  viewport: { width: 1280, height: 720 },
});

console.log("browser ok:", browser.ok, "canvas:", browser.canvas, "webgl:", browser.webgl, "three:", browser.threeLoaded);
console.log("errors:", browser.errors);
console.log("console errors:", browser.consoleErrors.slice(0, 5));
console.log("visual:", JSON.stringify(browser.visual, null, 2));

const outcome = determineOutcome(
  { wallMs: 0, genMs: 0, outputTokens: 1000, inputTokens: 0, cacheRead: 0, cacheWrite: 0, cost: 0, weightedTps: 0, wallTps: 0, generations: 1, toolCalls: 0, toolErrors: 0, stopReasons: ["stop"], aborted: false },
  artifact,
  browser,
  browser.visual,
  false,
  null,
);
console.log("outcome:", outcome.outcome, outcome.reasons);
