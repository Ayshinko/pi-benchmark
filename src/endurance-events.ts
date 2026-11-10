/**
 * Agent-reliability telemetry for Agent Endurance V3.
 *
 * Two independent sources are combined:
 *   1. live Pi session events recorded by the runner while the agent works
 *      (real pi event names: tool_execution_*, compaction_start/end,
 *      auto_retry_start/end, message_end, agent_end)
 *   2. the persisted session transcript, analysed after the run
 *      (see `endurance-session.ts`)
 *
 * Rules:
 * - Never invent a metric. If neither source can observe it, report "UNKNOWN".
 * - Cumulative token usage (metrics) is never presented as active context.
 * - The final `stop` is a normal loop terminator. If evaluation is incomplete it
 *   is recorded separately as a failed completion claim; only extra stops count
 *   as premature.
 */

import type { SessionAnalysis } from "./endurance-session.ts";
import { classifyPrematureStops, looksLikeTextualToolCall } from "./endurance-session.ts";

export type TriState = true | false | "UNKNOWN";

export interface EnduranceTelemetry {
  toolCalls: number;
  toolFailures: number;
  invalidToolArguments: number | "UNKNOWN";
  malformedToolCalls: number | "UNKNOWN";
  prematureStops: number;
  /** Final normal stop followed by an incomplete independent evaluation. */
  failedCompletionClaim: boolean;
  manualContinuations: number | "UNKNOWN";
  retries: number | "UNKNOWN";
  recoveries: number;
  compactions: number;
  activeContextPeak: number | "UNKNOWN";
  /** Tool calls referencing paths outside the isolated workspace (best-effort audit). */
  boundaryViolations: number | "UNKNOWN";
  boundarySamples: string[];
  assistantTurns: number;
  userMessages: number | "UNKNOWN";
  /** stopReason counts observed on assistant turns, e.g. "stop=2 toolUse=85". */
  stopReasons: string;
  /** Turns that ended in aborted/error/length: harness interruptions, not agent choices. */
  interruptedTurns: { aborted: number; error: number; length: number };
  /** Which sources actually contributed. */
  observation: { events: boolean; session: boolean };
  timeline: Array<{ atMs: number; type: string; detail: string }>;
}
export function emptyEnduranceTelemetry(): EnduranceTelemetry {
  return {
    toolCalls: 0,
    toolFailures: 0,
    invalidToolArguments: 0,
    malformedToolCalls: 0,
    prematureStops: 0,
    failedCompletionClaim: false,
    manualContinuations: "UNKNOWN",
    retries: 0,
    recoveries: 0,
    compactions: 0,
    activeContextPeak: "UNKNOWN",
    boundaryViolations: "UNKNOWN",
    boundarySamples: [],
    assistantTurns: 0,
    userMessages: "UNKNOWN",
    stopReasons: "",
    interruptedTurns: { aborted: 0, error: 0, length: 0 },
    observation: { events: false, session: false },
    timeline: [],
  };
}

/** True when the host saw a real pi event of a given kind (used for UNKNOWN rules). */
function hasLiveEvidence(events: any[]): boolean {
  return events.some((e) => e?.type && String(e.type) !== "unknown" && String(e.type) !== "other");
}

/**
 * Parse live pi session events.
 *
 * `completed` is the independent evaluator verdict, used for the premature-stop
 * classification; the model's own summary is never used.
 */
export function parseEnduranceEvents(events: any[], completed: boolean): EnduranceTelemetry {
  const out = emptyEnduranceTelemetry();
  let lastFailure = false;
  let explicitMalformed = 0;
  let textualMalformed = 0;
  let invalidArguments = 0;
  let sawInvalidArgumentEvent = false;
  let compactions = 0;
  let retries = 0;
  let manualContinuations = 0;
  let sawManualContinuation = false;
  let activeContextPeak = 0;
  const stopCounts = { stop: 0, toolUse: 0, length: 0, aborted: 0, error: 0, other: 0 };

  for (const e of events) {
    const type = String(e?.type ?? "unknown");
    const atMs = Number(e?.atMs ?? 0);

    if (type === "tool_execution_end") {
      out.toolCalls++;
      const argsInvalid = Boolean(e?.argumentsError ?? e?.result?.argumentsError);
      if (argsInvalid) {
        invalidArguments++;
        sawInvalidArgumentEvent = true;
      }
      if (e.isError) {
        out.toolFailures++;
        lastFailure = true;
        out.timeline.push({ atMs, type: "tool_failure", detail: String(e.error ?? e.toolName ?? e.result?.error ?? "tool failed").slice(0, 160) });
      } else {
        if (lastFailure) {
          out.recoveries++;
          lastFailure = false;
          out.timeline.push({ atMs, type: "recovery", detail: String(e.toolName ?? "successful tool call") });
        }
      }
    } else if (type === "message_end" && (e?.message?.role ?? "assistant") === "assistant") {
      const reason = String(e?.stopReason ?? e?.message?.stopReason ?? "other");
      if (reason === "stop") stopCounts.stop++;
      else if (reason === "toolUse") stopCounts.toolUse++;
      else if (reason === "length") stopCounts.length++;
      else if (reason === "aborted") stopCounts.aborted++;
      else if (reason === "error") stopCounts.error++;
      else stopCounts.other++;
      out.assistantTurns++;
      const text = Array.isArray(e.message?.content)
        ? e.message.content
            .filter((part: any) => part?.type === "text")
            .map((part: any) => String(part.text ?? ""))
            .join("\n")
        : "";
      if (looksLikeTextualToolCall(text)) {
        textualMalformed++;
        out.timeline.push({ atMs, type: "malformed_tool_call", detail: "tool-call markup returned as assistant text" });
      }
      for (const part of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (part?.type === "toolCall" && part.argumentsError) {
          invalidArguments++;
          sawInvalidArgumentEvent = true;
        }
      }
    } else if (type === "message_start" && e?.message?.role === "user") {
      manualContinuations++;
      sawManualContinuation = true;
    } else if (type === "tool_invalid_arguments") {
      invalidArguments++;
      sawInvalidArgumentEvent = true;
    } else if (type === "malformed_tool_call") {
      explicitMalformed++;
    } else if (type === "compaction_start" || type === "compaction_end" || type === "context_compaction") {
      // compaction_start and compaction_end describe the same compaction.
      if (type !== "compaction_end" || !events.some((o) => o?.type === "compaction_start")) compactions++;
    } else if (type === "auto_retry_start" || type === "auto_retry_end" || type === "retry") {
      if (type !== "auto_retry_end" || !events.some((o) => o?.type === "auto_retry_start")) retries++;
    } else if (type === "manual_continuation" || type === "follow_up_message" || type === "steering_message") {
      manualContinuations++;
      sawManualContinuation = true;
    }

    const usage = e?.message?.usage;
    const observedActive =
      typeof e?.activeContextTokens === "number"
        ? e.activeContextTokens
        : usage
          ? (Number(usage.input) || 0) + (Number(usage.cacheRead) || 0) + (Number(usage.cacheWrite) || 0)
          : 0;
    if (observedActive > 0) activeContextPeak = Math.max(activeContextPeak, observedActive);
  }

  // A single run sends exactly one prompt (the benchmark prompt). Extra user
  // message_start events therefore indicate manual continuations.
  out.userMessages = sawManualContinuation || manualContinuations > 1 ? manualContinuations : events.some((e) => e?.type === "message_start" && e?.message?.role === "user") ? 1 : "UNKNOWN";
  out.manualContinuations = sawManualContinuation
    ? Math.max(0, manualContinuations - (events.some((e) => e?.type === "message_start" && e?.message?.role === "user") ? 1 : 0))
    : "UNKNOWN";
  out.retries = hasLiveEvidence(events) ? retries : "UNKNOWN";
  out.invalidToolArguments = sawInvalidArgumentEvent ? invalidArguments : hasLiveEvidence(events) ? 0 : "UNKNOWN";
  out.malformedToolCalls = Math.max(explicitMalformed, textualMalformed);
  out.compactions = compactions;
  out.activeContextPeak = activeContextPeak > 0 ? activeContextPeak : "UNKNOWN";
  out.stopReasons = Object.entries(stopCounts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");
  out.interruptedTurns = { aborted: stopCounts.aborted, error: stopCounts.error, length: stopCounts.length };
  out.prematureStops = classifyPrematureStops(stopCounts, completed);
  out.failedCompletionClaim = !completed && stopCounts.stop > 0;
  out.observation.events = hasLiveEvidence(events);
  return out;
}
export interface MergeOptions {
  completed: boolean;
  resumed: boolean;
  /** The continuation prompt a resumed run sends; excluded from manual continuations. */
  resumePromptText?: string;
}

/**
 * Combine live-event telemetry with the post-run transcript analysis.
 * The transcript is the authoritative source for counts Pi records per turn
 * (invalid tool arguments, boundary violations, active context, continuations);
 * live events keep the failure/recovery timeline with wall-clock offsets.
 */
export function mergeEnduranceTelemetry(
  fromEvents: EnduranceTelemetry,
  session: SessionAnalysis,
  options: MergeOptions,
): EnduranceTelemetry {
  const out: EnduranceTelemetry = { ...fromEvents, timeline: [...fromEvents.timeline] };
  out.observation = { events: fromEvents.observation.events, session: session.available };

  if (session.available) {
    out.toolCalls = Math.max(out.toolCalls, session.toolCalls);
    out.toolFailures = Math.max(out.toolFailures, session.toolFailures);
    out.recoveries = Math.max(out.recoveries, session.recoveries);
    out.compactions = Math.max(out.compactions, session.compactions);
    out.assistantTurns = Math.max(out.assistantTurns, session.assistantMessages);
    out.manualContinuations = session.manualContinuations ?? out.manualContinuations;
    out.userMessages = session.userMessages;
    out.invalidToolArguments = Math.max(Number(out.invalidToolArguments === "UNKNOWN" ? 0 : out.invalidToolArguments), session.invalidToolArguments);
    out.malformedToolCalls = Math.max(Number(out.malformedToolCalls === "UNKNOWN" ? 0 : out.malformedToolCalls), session.malformedToolCalls);
    out.activeContextPeak = session.activeContextPeak ?? out.activeContextPeak;
    out.boundaryViolations = session.boundaryViolations;
    out.boundarySamples = session.boundarySamples;
    out.stopReasons = Object.entries(session.stopReasons)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`)
      .join(" ") || out.stopReasons;
    out.interruptedTurns = {
      aborted: session.stopReasons.aborted,
      error: session.stopReasons.error,
      length: session.stopReasons.length,
    };
    out.prematureStops = classifyPrematureStops(session.stopReasons, options.completed);
    out.failedCompletionClaim = !options.completed && session.stopReasons.stop > 0;
    if (!fromEvents.observation.events) {
      // Transcript-only view (e.g. re-analysis or a resumed run): rebuild the
      // failure/recovery timeline from recorded tool results.
      const start = session.firstTimestampMs ?? 0;
      out.timeline = session.failureSamples.map((detail, index) => ({ atMs: start, type: "tool_failure", detail }));
      void out.timeline.length;
    }
  } else if (out.invalidToolArguments === 0 && !fromEvents.observation.events) {
    out.invalidToolArguments = "UNKNOWN";
  }

  if (options.resumed) {
    // A resumed run is by definition not an uninterrupted autonomous run.
    out.manualContinuations = Math.max(Number(out.manualContinuations === "UNKNOWN" ? 0 : out.manualContinuations), 1);
  }
  return out;
}

