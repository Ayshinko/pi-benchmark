/**
 * Standalone CLI so the harness can be run outside the pi UI:
 *
 *   node src/cli.ts pagoda --runs 2 --model strata-local/qwen3.8-flash-next-q2_0 --thinking low
 *   node src/cli.ts history pagoda
 *   node src/cli.ts show <runId>
 */

import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getPrompt } from "./prompts.ts";
import { runBenchmark } from "./runner.ts";
import { BENCH_ROOT, latestRuns, findRun, saveRun } from "./store.ts";
import { formatRunDetail, formatTable } from "./format.ts";

const agentDir = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");

function parseArgs(argv: string[]): { sub: string; positional: string[]; flags: Record<string, string> } {
  const [sub = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    if (body.includes("=")) {
      const [key, value] = body.split("=", 2);
      flags[key] = value;
      continue;
    }
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags[body] = next;
      i++;
    } else {
      flags[body] = "true";
    }
  }
  return { sub, positional, flags };
}

async function main(): Promise<void> {
  const { sub, positional, flags } = parseArgs(process.argv.slice(2));

  if (sub === "history") {
    console.log(formatTable(latestRuns(positional[0] ?? "pagoda", Number(flags.limit ?? 20))));
    return;
  }

  if (sub === "show") {
    const run = findRun(positional[0] ?? "");
    if (!run) {
      console.error(`no run with id ${positional[0]}`);
      process.exit(1);
    }
    console.log(formatRunDetail(run));
    return;
  }

  if (sub === "compare") {
    const runs = positional.map((id) => findRun(id)).filter(Boolean) as any[];
    if (runs.length < 2) {
      console.error("usage: compare <runId> <runId>");
      process.exit(1);
    }
    console.log(formatTable(runs));
    console.log(`TPS delta: ${(runs[1].metrics.weightedTps - runs[0].metrics.weightedTps).toFixed(1)} tok/s`);
    return;
  }

  if (sub !== "pagoda") {
    console.log("usage: node src/cli.ts pagoda [--runs N] [--model provider/id] [--thinking level] [--timeout s] [--settle ms] [--no-browser] [--fake]");
    console.log("       node src/cli.ts history [benchmark] [--limit N]");
    console.log("       node src/cli.ts show <runId>");
    console.log("       node src/cli.ts compare <runId> <runId>");
    return;
  }

  if (flags.fake !== "true") {
    const warning = "For accurate Strata-native TPS, do not run other Pi sessions or other Strata inference clients during this benchmark. This benchmark does not technically lock the server. Continue? [y/N] ";
    if (!stdin.isTTY || !stdout.isTTY) throw new Error("A TTY confirmation is required before a real benchmark run.");
    const rl = readline.createInterface({ input: stdin, output: stdout });
    const answer = await rl.question(warning);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) { console.log("Benchmark cancelled."); return; }
  }

  const task = getPrompt("pagoda");
  const runtime = await ModelRuntime.create({
    modelsPath: path.join(agentDir, "models.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"),
    authPath: path.join(agentDir, "auth.json"),
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);

  const [provider, modelId] = (flags.model ?? "strata-local/qwen3.8-flash-next-q2_0").split("/", 2);
  const model = registry.find(provider, modelId);
  if (!model) {
    console.error(`model not found: ${flags.model}`);
    process.exit(1);
  }

  const runs = Math.max(1, Number(flags.runs ?? 1));
  const results = [];

  for (let i = 1; i <= runs; i++) {
    console.log(`pagoda run ${i}/${runs} with ${provider}/${modelId} thinking=${flags.thinking ?? "low"}`);
    const result = await runBenchmark({
      benchmark: "pagoda",
      prompt: task.prompt,
      promptVersion: task.version,
      expectedArtifact: task.expectedArtifact,
      model,
      thinkingLevel: flags.thinking ?? "low",
      timeoutMs: Math.max(30000, Number(flags.timeout ?? 1200) * 1000),
      settleMs: Math.max(500, Number(flags.settle ?? 3000)),
      viewport: { width: 1280, height: 720 },
      runIndex: i,
      agentDir,
      benchRoot: BENCH_ROOT,
      runBrowser: flags["no-browser"] !== "true",
      fake: flags.fake === "true",
      fakeArtifactPath: path.join(import.meta.dirname, "..", "test", "fixtures", "pagoda-v1-full.html"),
      onProgress: (line) => console.log(`  ${line}`),
    });
    saveRun(result);
    results.push(result);
    console.log(formatRunDetail(result));
    console.log("");
  }

  console.log(formatTable(results));
}

main();
