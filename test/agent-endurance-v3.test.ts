import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { AGENT_ENDURANCE_V3, hashPrompt, productionBenchmarks, resolveBenchmark } from "../src/prompts.ts";
import { buildRunPaths } from "../src/runner.ts";
import { parseEnduranceEvents } from "../src/endurance-events.ts";
import { scoreEndurance } from "../src/endurance-scoring.ts";

assert.equal(resolveBenchmark("endurance").version, "agent-endurance-v3");
assert(productionBenchmarks().some((x) => x.benchmark === "agent-endurance-v3"));
assert.equal(hashPrompt(AGENT_ENDURANCE_V3.prompt).length, 64);
assert.match(AGENT_ENDURANCE_V3.prompt, /120 meaningful unit tests/);
const cfg:any={benchmark:"agent-endurance-v3",model:{provider:"p",id:"m"},runIndex:1,benchRoot:"X"};
assert.notEqual(buildRunPaths(cfg,"a").runDir, buildRunPaths(cfg,"b").runDir);
const tel=parseEnduranceEvents([
  {type:"tool_execution_end",isError:true,toolName:"write",atMs:1},
  {type:"tool_execution_end",isError:false,toolName:"write",atMs:2},
  {type:"context_compaction",atMs:3},{type:"message_end",stopReason:"stop",atMs:4},
],false);
assert.equal(tel.toolFailures,1); assert.equal(tel.recoveries,1); assert.equal(tel.compactions,1); assert.equal(tel.prematureStops,1);
const scores=scoreEndurance({passed:9,total:9,categories:{},phaseCompletion:12,completed:true,details:[]},{...tel,manualContinuations:1},{wallMs:10,outputTokens:20},false);
assert.notEqual(scores.reliability,100); assert.equal(scores.autonomous,"FAIL");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"endurance-store-"));
process.env.PI_BENCHMARK_DIR=root;
const runDir=path.join(root,"r"); fs.mkdirSync(runDir,{recursive:true});
// Persistence accepts additive V3 fields without changing legacy schema.
const { saveRun } = await import(`../src/store.ts?endurance=${Date.now()}`);
saveRun({runDir,id:"x",benchmark:"agent-endurance-v3",endurance:{evaluation:{},telemetry:{},scores:{}},metrics:{}} as any);
assert.equal(JSON.parse(fs.readFileSync(path.join(runDir,"run.json"),"utf8")).endurance.scores instanceof Object,true);
console.log("Agent Endurance V3 tests passed");
