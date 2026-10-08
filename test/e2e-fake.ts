import path from "node:path";
import { runBenchmark } from "../src/runner.ts";
import { getPrompt } from "../src/prompts.ts";
import { saveRun, latestRuns } from "../src/store.ts";
import { formatRunDetail, formatTable } from "../src/format.ts";

const task = getPrompt("pagoda");

const result = await runBenchmark({
  benchmark: "pagoda",
  prompt: task.prompt,
  promptVersion: task.version,
  expectedArtifact: task.expectedArtifact,
  model: { id: "fake-model", name: "Fake Model", provider: "fake" } as any,
  thinkingLevel: "low",
  timeoutMs: 60000,
  settleMs: 2500,
  viewport: { width: 1280, height: 720 },
  runIndex: 1,
  agentDir: path.join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent"),
  benchRoot: path.join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "benchmarks"),
  runBrowser: true,
  fake: true,
  fakeArtifactPath: path.join(import.meta.dirname, "fixtures", "pagoda-v1-full.html"),
  onProgress: (line) => console.log("progress:", line),
});

saveRun(result);
console.log(formatRunDetail(result));
console.log("\n" + formatTable([result]));
console.log("\nhistory entries:", latestRuns("pagoda", 5).length);
