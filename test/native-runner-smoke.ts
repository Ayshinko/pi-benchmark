import os from "node:os";import path from "node:path";
import {runBenchmark} from "../src/runner.ts";
const agentDir=process.env.PI_AGENT_DIR??path.join(os.homedir(),".pi","agent");
const provider="strata-auto", id=process.env.STRATA_MODEL??"qwen3.8-flash-next-q2_0";
const model:any={provider,id,name:id,api:"openai-completions",baseUrl:"http://127.0.0.1:8080/v1",input:["text"],reasoning:true,contextWindow:65536,maxTokens:128,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{supportsReasoningEffort:true}};
const config:any={name:"Strata Auto",baseUrl:"http://127.0.0.1:8080/v1",apiKey:"local",api:"openai-completions",models:[model]};
const result=await runBenchmark({benchmark:"native-smoke",prompt:"Create index.html containing a minimal complete HTML page with the title Smoke and a visible paragraph saying OK. Do not use tools unless needed.",promptVersion:"smoke",expectedArtifact:"index.html",model,thinkingLevel:"off",timeoutMs:90000,settleMs:500,viewport:{width:640,height:480},runIndex:1,agentDir,benchRoot:path.join(os.tmpdir(),"pi-benchmark-native-smoke"),runBrowser:false,inheritedProviders:[{provider,config}],onProgress:(line)=>{if(line.includes("| native Live"))console.log(line)}});
console.log(JSON.stringify({outcome:result.outcome,generations:result.metrics.generations,outputTokens:result.metrics.outputTokens,genMs:result.metrics.genMs,weightedTps:result.metrics.weightedTps,measurementAccuracy:result.metrics.measurementAccuracy,measurementSource:result.metrics.measurementSource,nativeRequests:result.metrics.nativeRequests,tools:result.metrics.toolCalls,reasons:result.reasons},null,2));
if(result.metrics.generations<1||result.metrics.outputTokens<=0)process.exitCode=1;
