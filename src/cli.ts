/**
 * Standalone CLI so the harness can be run outside the pi UI:
 *
 *   node src/cli.ts pagoda --runs 2 --model strata-local/qwen3.8-flash-next-q2_0 --thinking low
 *   node src/cli.ts agent-endurance-v3 --model strata-auto/qwen3.8-flash-next-iq3_s --thinking low
 *   node src/cli.ts agent-endurance-v3 --resume <runId> --model strata-auto/qwen3.8-flash-next-iq3_s
 *   node src/cli.ts history pagoda
 *   node src/cli.ts show <runId>
 *
 * `--model provider/id` is required for real runs: the model is never hardcoded.
 */

import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getPrompt, AGENT_ENDURANCE_V3_CONTINUATION_PROMPT, AGENT_ENDURANCE_V3_CONTINUATION_VERSION } from "./prompts.ts";
import { runBenchmark, configuredWorkspaceRoot } from "./runner.ts";
import { BENCH_ROOT, latestRuns, findRun, saveRun, fairComparisonIssues } from "./store.ts";
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
    const issues = fairComparisonIssues(runs);
    if (issues.length) {
      console.error(`comparison refused: ${issues.join("; ")}`);
      process.exit(1);
    }
    console.log(formatTable(runs));
    console.log(`TPS delta: ${(runs[1].metrics.weightedTps - runs[0].metrics.weightedTps).toFixed(1)} tok/s`);
    return;
  }

  if (!["pagoda", "agent-endurance-v3", "agent-endurance-v4", "agent-endurance-v5"].includes(sub)) {
    console.log("usage: node src/cli.ts <pagoda|agent-endurance-v3|agent-endurance-v4|agent-endurance-v5> --model provider/id [--runs N] [--thinking level] [--timeout s] [--settle ms] [--no-browser] [--fake] [--resume <runId>]");
    console.log("       node src/cli.ts history [benchmark] [--limit N]");
    console.log("       node src/cli.ts show <runId>");
    console.log("       node src/cli.ts compare <runId> <runId>");
    return;
  }

  const task = getPrompt(sub);
  const resumeId = flags.resume && flags.resume !== "true" ? flags.resume : null;
  let resumeFrom: { runId: string; workspace: string; sessionFile: string | null } | undefined;
  if (resumeId) {
    if (sub !== "agent-endurance-v3") {
      console.error("--resume is currently only supported for agent-endurance-v3");
      process.exit(1);
    }
    const source = findRun(resumeId);
    if (!source?.sessionFile || !source.workspace) {
      console.error(`no resumable agent-endurance-v3 run with id ${resumeId}`);
      process.exit(1);
    }
    resumeFrom = { runId: source.id, workspace: source.workspace, sessionFile: source.sessionFile };
  }

  if (flags.fake !== "true") {
    const warning = resumeFrom
      ? `Resuming run ${resumeFrom.runId} as a DIAGNOSTIC run (cannot be an autonomous PASS). The source run is copied, never modified.\n\nFor accurate Strata-native TPS, do not run other Pi sessions or other Strata inference clients during this benchmark. This benchmark does not technically lock the server. Continue? [y/N] `
      : "For accurate Strata-native TPS, do not run other Pi sessions or other Strata inference clients during this benchmark. This benchmark does not technically lock the server. Continue? [y/N] ";
    if (!stdin.isTTY || !stdout.isTTY) throw new Error("A TTY confirmation is required before a real benchmark run.");
    const rl = readline.createInterface({ input: stdin, output: stdout });
    const answer = await rl.question(warning);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) { console.log("Benchmark cancelled."); return; }
  }

  const runtime = await ModelRuntime.create({
    modelsPath: path.join(agentDir, "models.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"),
    authPath: path.join(agentDir, "auth.json"),
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);

  if (!flags.model) {
    console.error("--model provider/id is required (no model is hardcoded).");
    console.error("List models in pi with /model, then pass the exact provider/id string.");
    process.exit(1);
  }
  const [provider, modelId] = (flags.model as string).split("/", 2);
  const model = registry.find(provider, modelId);
  if (!model) {
    console.error(`model not found: ${flags.model}`);
    process.exit(1);
  }

  const runs = Math.max(1, Number(flags.runs ?? 1));
  const results = [];

  for (let i = 1; i <= runs; i++) {
    console.log(`${sub} run ${i}/${runs} with ${provider}/${modelId} thinking=${flags.thinking ?? "low"}${resumeFrom ? ` (resuming ${resumeFrom.runId})` : ""}`);
    const result = await runBenchmark({
      benchmark: sub,
      prompt: resumeFrom ? AGENT_ENDURANCE_V3_CONTINUATION_PROMPT : task.prompt,
      promptVersion: resumeFrom ? AGENT_ENDURANCE_V3_CONTINUATION_VERSION : task.version,
      expectedArtifact: task.expectedArtifact,
      model,
      thinkingLevel: flags.thinking ?? "low",
      timeoutMs: Math.max(30000, Number(flags.timeout ?? Math.round((task.timeoutSeconds ?? 1200))) * 1000),
      maxTurns: task.maxTurns,
      continuationLimit: task.benchmark === "agent-endurance-v5" && flags["no-continuations"] !== "true" ? 3 : 0,
      settleMs: Math.max(500, Number(flags.settle ?? 3000)),
      viewport: { width: 1280, height: 720 },
      runIndex: i,
      agentDir,
      benchRoot: BENCH_ROOT,
      runBrowser: flags["no-browser"] !== "true",
      workspaceRoot: configuredWorkspaceRoot(),
      fake: flags.fake === "true",
      fakeArtifactPath: path.join(import.meta.dirname, "..", "test", "fixtures", "pagoda-v1-full.html"),
      ...(resumeFrom ? { resumeFrom } : {}),
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
