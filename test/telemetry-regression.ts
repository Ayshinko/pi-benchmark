import assert from 'node:assert/strict';
import { RunMetrics } from '../src/metrics.ts';
import { renderTelemetry } from '../src/telemetry.ts';
let now=1000;
const m=new RunMetrics(()=>now);
m.start(); m.beginAssistantMessage(); now+=1000; m.contentStarted(); now+=1000; m.outputDelta('one two three four '.repeat(20));
const live=renderTelemetry(m.snapshot(),'low'); console.log(live); assert.match(live,/Live [\d.]+ tok\/s/); assert.match(live,/Avg [\d.]+ tok\/s/); assert(!live.includes('↓0'));
m.endAssistantMessage({output:100,input:20,cacheRead:0,cacheWrite:0,cost:{total:0}},'stop'); m.finish(); const final=renderTelemetry(m.snapshot(),'low'); console.log(final); assert.match(final,/Live —/); assert.match(final,/Avg [\d.]+ tok\/s/); assert.match(final,/↓100/);
console.log('PASS');
