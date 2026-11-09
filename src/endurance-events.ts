export type TriState = true | false | "UNKNOWN";

export interface EnduranceTelemetry {
  toolCalls: number;
  toolFailures: number;
  invalidToolArguments: number | "UNKNOWN";
  malformedToolCalls: number | "UNKNOWN";
  prematureStops: number;
  manualContinuations: number | "UNKNOWN";
  retries: number;
  recoveries: number;
  compactions: number;
  activeContextPeak: number | "UNKNOWN";
  timeline: Array<{ atMs: number; type: string; detail: string }>;
}

export function emptyEnduranceTelemetry(): EnduranceTelemetry {
  return { toolCalls: 0, toolFailures: 0, invalidToolArguments: 0, malformedToolCalls: 0,
    prematureStops: 0, manualContinuations: "UNKNOWN", retries: 0, recoveries: 0,
    compactions: 0, activeContextPeak: "UNKNOWN", timeline: [] };
}

/** Pure event parser: unknown host fields remain UNKNOWN instead of being invented. */
export function parseEnduranceEvents(events: any[], completed: boolean): EnduranceTelemetry {
  const out = emptyEnduranceTelemetry();
  let lastFailure = false;
  for (const e of events) {
    const type = String(e?.type ?? "unknown");
    const atMs = Number(e?.atMs ?? 0);
    if (type === "tool_execution_end") {
      out.toolCalls++;
      if (e.isError) { out.toolFailures++; lastFailure = true; out.timeline.push({ atMs, type: "tool_failure", detail: String(e.error ?? e.toolName ?? "tool failed") }); }
      else if (lastFailure) { out.recoveries++; lastFailure = false; out.timeline.push({ atMs, type: "recovery", detail: String(e.toolName ?? "successful tool call") }); }
    } else if (type === "tool_invalid_arguments") out.invalidToolArguments = Number(out.invalidToolArguments) + 1;
    else if (type === "malformed_tool_call") out.malformedToolCalls = Number(out.malformedToolCalls) + 1;
    else if (type === "context_compaction") out.compactions++;
    else if (type === "retry") out.retries++;
    else if (type === "manual_continuation") out.manualContinuations = out.manualContinuations === "UNKNOWN" ? 1 : out.manualContinuations + 1;
    if (typeof e?.activeContextTokens === "number") out.activeContextPeak = Math.max(out.activeContextPeak === "UNKNOWN" ? 0 : out.activeContextPeak, e.activeContextTokens);
  }
  const stops = events.filter((e) => e?.type === "message_end" && (e?.stopReason ?? e?.message?.stopReason) === "stop");
  out.prematureStops = completed ? Math.max(0, stops.length - 1) : stops.length;
  return out;
}
