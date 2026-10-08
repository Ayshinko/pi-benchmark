import { StrataMetricsPoller } from "../src/native-metrics.ts";
const base="http://127.0.0.1:8080";
const models=await (await fetch(base+"/v1/models")).json() as any;
const model=models.data?.[0]?.id;
if(!model)throw new Error("Strata /v1/models returned no models");
const poller=new StrataMetricsPoller(base+"/metrics",300,500,(s)=>{if(s)console.log(`native live=${s.liveTps} mean=${s.meanTps} pp=${s.ppTps} output=${s.outputTokens}`)});
await poller.start();
const before=await (await fetch(base+"/metrics")).json() as any;
const baseline=Math.max(0,...(before.requests??[]).map((r:any)=>Number(r.time)||0));
const started=Date.now();
try {
 const response=await fetch(base+"/v1/chat/completions",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer local"},body:JSON.stringify({model,messages:[{role:"user",content:"Reply with exactly OK."}],max_tokens:8,stream:false})});
 if(!response.ok)throw new Error(`completion HTTP ${response.status}: ${await response.text()}`);
 const result:any=await response.json();
 console.log("provider response:",JSON.stringify({model,usage:result.usage,content:result.choices?.[0]?.message?.content}));
 const native=await poller.finalizeRequest();
 const after=await (await fetch(base+"/metrics")).json() as any;
 const rows=(after.requests??[]).filter((r:any)=>Number(r.time)>baseline);
 console.log("native completion:",JSON.stringify(native));
 console.log("matching /metrics record:",JSON.stringify(rows.slice(0,2).map((r:any)=>({time:r.time,output_tokens:r.output_tokens,decode_ms:r.decode_ms,decode_tok_s:r.decode_tok_s}))));
 console.log("elapsedMs:",Date.now()-started);
 if(!native?.completed||rows.length!==1)process.exitCode=2;
} finally {poller.stop();}
