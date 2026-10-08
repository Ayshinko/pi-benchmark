/** Strata-native metrics adapter based on pi-token-speed's proven poller. */
export interface StrataSnapshot { liveTps:number; meanTps:number; ppTps:number; outputTokens:number; decodeSeconds:number; completed:boolean }
export const STRATA_POLL_INTERVAL_MS=300;
export const STRATA_FETCH_TIMEOUT_MS=500;
const num=(v:any)=>typeof v==="number"&&Number.isFinite(v)?v:0;
export function parseStrataLive(payload:any):StrataSnapshot|null {
  const l=payload?.live;
  if(!l||!["reading","generating"].includes(l.state))return null;
  return {liveTps:num(l.tok_s),meanTps:num(l.tok_s_mean),ppTps:num(l.prefill_tok_s_mean),outputTokens:num(l.generated),decodeSeconds:num(l.elapsed_s),completed:false};
}
export function parseCompletedRequest(payload:any,after=0):StrataSnapshot|null {
  if(!Array.isArray(payload?.requests))return null;
  for(const r of payload.requests){
    if(!r||typeof r.time!=="number"||r.time<=after)continue;
    const outputTokens=num(r.output_tokens),decodeTokS=num(r.decode_tok_s),decodeMs=num(r.decode_ms);
    // duration_s includes prefill: never present it as exact decode duration.
    if(outputTokens<=0||decodeTokS<=0||decodeMs<=0)continue;
    return {liveTps:decodeTokS,meanTps:decodeTokS,ppTps:0,outputTokens,decodeSeconds:decodeMs/1000,completed:true};
  }
  return null;
}
function newestTime(p:any):number {return Array.isArray(p?.requests)?p.requests.reduce((m:number,r:any)=>Math.max(m,num(r?.time)),0):0;}
export class StrataMetricsPoller {
  private timer:ReturnType<typeof setTimeout>|null=null;
  private controller:AbortController|null=null;
  private running=false; private baseline=0; private latestSeenTime=0; private prefill=0; private sawLive=false;
  current:StrataSnapshot|null=null;
  readonly url:string; private interval:number; private timeout:number; private update?:(s:StrataSnapshot|null)=>void;
  constructor(url:string,interval=STRATA_POLL_INTERVAL_MS,timeout=STRATA_FETCH_TIMEOUT_MS,update?:(s:StrataSnapshot|null)=>void){this.url=url;this.interval=interval;this.timeout=timeout;this.update=update;}
  async start(){this.stop();this.current=null;this.baseline=0;this.latestSeenTime=0;this.prefill=0;this.sawLive=false;const p=await this.fetch();if(p!==undefined){this.baseline=newestTime(p);this.latestSeenTime=this.baseline;}this.running=true;this.timer=setTimeout(()=>void this.tick(),this.interval);}
  /** Reset per-request identity at the actual ModelRuntime.streamSimple boundary. */
  beginNativeRequest(){const had=this.current!==null;this.current=null;this.baseline=this.latestSeenTime;this.prefill=0;this.sawLive=false;if(had)this.update?.(null);}
  async finalizeRequest(){const p=await this.fetch();if(p!==undefined){this.latestSeenTime=Math.max(this.latestSeenTime,newestTime(p));const done=parseCompletedRequest(p,this.baseline);if(done){this.current=done;this.update?.(done);return done;}}return null;}
  stop(){this.running=false;if(this.timer)clearTimeout(this.timer);this.timer=null;this.controller?.abort();this.controller=null;}
  private async fetch():Promise<any|undefined>{const c=new AbortController();this.controller=c;const t=setTimeout(()=>c.abort(),this.timeout);try{const r=await fetch(this.url,{signal:c.signal,headers:{Accept:"application/json"}});return r.ok?await r.json():undefined;}catch{return undefined;}finally{clearTimeout(t);if(this.controller===c)this.controller=null;}}
  private async tick(){if(!this.running)return;const p=await this.fetch();if(!this.running)return;if(p!==undefined){this.latestSeenTime=Math.max(this.latestSeenTime,newestTime(p));if(!this.baseline)this.baseline=newestTime(p);const l=parseStrataLive(p);if(l){this.sawLive=true;if(l.ppTps>0)this.prefill=l.ppTps;const done=parseCompletedRequest(p,this.baseline);this.current=done??{...l,ppTps:this.prefill};this.update?.(this.current);}}this.timer=setTimeout(()=>void this.tick(),this.interval);}
  async finalize(){const p=await this.fetch();let done=parseCompletedRequest(p,this.baseline);if(!done&&this.baseline>0&&!this.sawLive&&newestTime(p)===this.baseline)done=parseCompletedRequest(p,0);if(done){this.current=done;this.update?.(done);}this.stop();return this.current;}
}
/** Resolve metrics endpoint exclusively from the selected local Strata provider config. */
export function strataMetricsUrl(provider:string,providers:Array<{provider:string;config:any}>):string|null {
  if(!/^strata(?:-|$)/i.test(provider))return null;
  const c=providers.find(x=>x.provider===provider)?.config;if(typeof c?.baseUrl!=="string")return null;
  try{const u=new URL(c.baseUrl);if(!["localhost","127.0.0.1","::1","[::1]"].includes(u.hostname.toLowerCase()))return null;u.pathname=u.pathname.replace(/\/v1\/?$/i,"").replace(/\/$/,"")+"/metrics";u.search="";u.hash="";return u.toString();}catch{return null;}
}
