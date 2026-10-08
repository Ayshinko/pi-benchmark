// Real-session smoke test: verifies createAgentSession + event wiring works
// in an isolated workspace, using the local strata model and a trivial prompt.
import path from "node:path";
import os from "node:os";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runBenchmark } from "../src/runner.ts";
import { formatRunDetail } from "../src/format.ts";

const agentDir = path.join(os.homedir(), ".pi", "agent");
const runtime = await ModelRuntime.create({
  modelsPath: path.join(agentDir, "models.json"),
  modelsStorePath: path.join(agentDir, "models-store.json"),
  authPath: path.join(agentDir, "auth.json"),
  refreshOnCreate: false,
});
const registry = new ModelRegistry(runtime);

const model = registry.find("strata-local", "qwen3.8-flash-next-q2_0");
if (!model) {
  console.error("model not found");
  process.exit(1);
}

const result = await runBenchmark({
  benchmark: "smoke",
  prompt: "Write a file named pagoda.html containing a minimal HTML page with a <canvas> and a script that loads three.js from unpkg and renders a red cube. Keep it short.",
  promptVersion: "smoke-v1",
  expectedArtifact: "pagoda.html",
  model,
  thinkingLevel: "low",
  timeoutMs: 120000,
  settleMs: 2000,
  viewport: { width: 800, height: 600 },
  runIndex: 1,
  agentDir,
  benchRoot: path.join(os.homedir(), ".pi", "benchmarks"),
  runBrowser: true,
  onProgress: (line) => console.log("progress:", line),
});

console.log(formatRunDetail(result));
console.log("generations:", JSON.stringify(result.metrics.generations, null, 2).slice(0, 800));
