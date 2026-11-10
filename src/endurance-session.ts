/**
 * Objective measurements from the isolated benchmark session transcript.
 *
 * Pi persists every session as a JSONL transcript (see pi docs `session-format.md`).
 * The transcript is written by Pi itself, not by the model, so it is a trustworthy
 * source for agent-reliability metrics: how many tool calls actually ran, how many
 * failed, whether tool arguments were structurally invalid, how large the ACTIVE
 * context grew, and whether any extra user message (a manual continuation) entered
 * the session after the single benchmark prompt.
 *
 * Nothing here is inferred from the model's own final summary. Values that cannot be
 * observed are reported as `null` / "UNKNOWN", never guessed.
 *
 * IMPORTANT: cumulative token usage (sum of `usage` across turns) and the ACTIVE
 * context size of one turn are different measurements. `activeContextPeak` is the
 * largest single-turn context (input + cacheRead + cacheWrite), never a sum.
 */

import fs from "node:fs";
import path from "node:path";

export type Maybe<T> = T | null;

export interface SessionStopCounts {
  /** assistant messages whose stopReason was exactly "stop" (agent loop ended). */
  stop: number;
  toolUse: number;
  length: number;
  aborted: number;
  error: number;
  other: number;
}

export interface SessionAnalysis {
  /** false when the transcript was missing/unreadable: every measurement is then UNKNOWN. */
  available: boolean;
  file: string | null;
  assistantMessages: number;
  userMessages: number;
  toolResultMessages: number;
  toolCalls: number;
  toolFailures: number;
  /** Tool calls whose argument JSON was structurally invalid (pi `argumentsError`). */
  invalidToolArguments: number;
  /** Tool results whose text looks like an argument/schema validation failure. */
  validationToolFailures: number;
  /** Tool-call markup the model emitted as plain assistant text instead of a tool call. */
  malformedToolCalls: number;
  /** Failures followed by a later successful tool call (same adjacent-recovery rule as live events). */
  recoveries: number;
  /** First 10 recorded failure texts, for the failure/recovery timeline. */
  failureSamples: string[];
  compactions: number;
  stopReasons: SessionStopCounts;
  /** Largest single-turn active context (input + cacheRead + cacheWrite). Never a sum. */
  activeContextPeak: Maybe<number>;
  /** Cumulative token usage across the whole session. Separate from active context. */
  cumulative: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Extra user messages after the first one => manual continuations in an automated run. */
  manualContinuations: Maybe<number>;
  /** Tool calls that referenced paths outside the benchmark workspace. */
  boundaryViolations: number;
  boundarySamples: string[];
  firstTimestampMs: number | null;
  lastTimestampMs: number | null;
}

export function emptySessionAnalysis(file: string | null): SessionAnalysis {
  return {
    available: false,
    file,
    assistantMessages: 0,
    userMessages: 0,
    toolResultMessages: 0,
    toolCalls: 0,
    toolFailures: 0,
    invalidToolArguments: 0,
    validationToolFailures: 0,
    malformedToolCalls: 0,
    recoveries: 0,
    failureSamples: [],
    compactions: 0,
    stopReasons: { stop: 0, toolUse: 0, length: 0, aborted: 0, error: 0, other: 0 },
    activeContextPeak: null,
    cumulative: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    manualContinuations: null,
    boundaryViolations: 0,
    boundarySamples: [],
    firstTimestampMs: null,
    lastTimestampMs: null,
  };
}

/**
 * Tool results that mean "the model sent bad arguments" rather than "the operation
 * failed". Pi emits these as ordinary tool errors; we classify them with conservative
 * signatures instead of counting every failure as an argument error.
 */
const ARGUMENT_ERROR_SIGNATURES: RegExp[] = [
  /not valid JSON/i,
  /invalid json/i,
  /must have required property/i,
  /must be equal to/i,
  /is not allowed to/i,
  /additional properties/i,
  /must be (?:string|number|integer|array|boolean|object)/i,
  /arguments? (?:must|should) be/i,
  /no such tool|unknown tool|tool .+ not found/i,
  /missing required (?:argument|parameter|option)/i,
];

/**
 * Conservative signature for tool-call markup leaking into assistant text. Some
 * local/quantised models (IQ3/IQ4 style chat templates) emit the markup as text when
 * their tool-call format is misapplied; that is an observable malformed call.
 */
export function looksLikeTextualToolCall(text: string): boolean {
  return /<tool_call>/i.test(text) && /<\/tool_call>/i.test(text) && /<function/i.test(text) && /<parameter/i.test(text);
}

function errorTextForSamples(message: any): string {
  const text = Array.isArray(message?.content)
    ? message.content
        .filter((part: any) => part?.type === "text")
        .map((part: any) => String(part.text ?? ""))
        .join(" ")
    : "";
  return text.replace(/\s+/g, " ").slice(0, 160);
}

/** Locations a benchmark agent must never touch (Pi config, other runs, OS trees). */
const PROTECTED_SIGNATURES: RegExp[] = [
  /[\\/]\.pi[\\/]/i, // Pi configuration and agent state
  /[\\/](?:auth|models-store|models)\.json/i, // Pi credentials and model configuration
  /[\\/]pi-benchmark[\\/]/i, // the benchmark harness itself
  /[\\/]pi-agent-benchmarks[\\/]/i, // other benchmark runs
  /[\\/]AppData[\\/]/i,
  /[\\/]Program ?Files/i,
  /%USERPROFILE%|%APPDATA%/i,
  /[${]?USERPROFILE[}?]?[\\/]/i,
  /[${]HOME[}?]?[\\/]/i,
  /~[\\/]\.pi/i,
];

function normalizePath(value: string): string {
  return value.replace(/[\\/]+/g, "/").toLowerCase();
}

/**
 * Best-effort, non-blocking boundary audit: did a tool call reference a path outside
 * the isolated workspace, or a protected Pi location? This is an objective signal
 * taken from recorded tool arguments; it is NOT a security sandbox (Pi runs with the
 * permissions of its user account), see the README limitations section.
 */
export function detectBoundaryViolation(
  args: any,
  workspace: string,
): { violation: boolean; sample: string } {
  const workspaceNorm = normalizePath(path.resolve(workspace));
  const samples: string[] = [];
  let violation = false;

  const examine = (raw: unknown, key: string): void => {
    const text = String(raw ?? "");
    if (!text) return;
    const protectedHit = PROTECTED_SIGNATURES.some((re) => re.test(text));
    const traversal = /\.\.[\\/]/.test(text);
    const absolute = /^[a-zA-Z]:[\\/]/.test(text) || text.startsWith("/") || text.startsWith("\\\\");
    if (!protectedHit && !traversal && !absolute) return;
    if (protectedHit || traversal) {
      violation = true;
      samples.push(`${key}=${text.slice(0, 140)}`);
      return;
    }
    const candidate = normalizePath(path.resolve(text.replace(/[\\/]+$/, "")));
    if (candidate !== workspaceNorm && !candidate.startsWith(`${workspaceNorm}/`)) {
      violation = true;
      samples.push(`${key}=${text.slice(0, 140)}`);
    }
  };

  const walk = (value: any, key = ""): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key);
      return;
    }
    if (typeof value === "object") {
      for (const [entryKey, entryValue] of Object.entries(value)) walk(entryValue, entryKey);
      return;
    }
    if (key === "path" || key === "file" || key === "filePath" || key === "dir" || key === "cwd" || key === "command") {
      examine(value, key);
    }
  };
  walk(args);
  return { violation, sample: samples.join(" | ").slice(0, 400) };
}

/** Parse one Pi session transcript into objective measurements. */
export function analyzeEnduranceSession(
  sessionFile: string | null,
  workspace: string,
  options: { resumePromptText?: string } = {},
): SessionAnalysis {
  const analysis = emptySessionAnalysis(sessionFile);
  if (!sessionFile || !fs.existsSync(sessionFile)) return analysis;
  let text: string;
  try {
    text = fs.readFileSync(sessionFile, "utf8");
  } catch {
    return analysis;
  }

  const toolCallById = new Map<string, { name: string; invalid: boolean }>();
  let previousFailure: boolean | null = null;
  let userMessages = 0;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const type = entry?.type;
    if (typeof entry?.timestamp === "string" || typeof entry?.timestamp === "number") {
      const ms = typeof entry.timestamp === "number" ? entry.timestamp : Date.parse(entry.timestamp);
      if (Number.isFinite(ms)) {
        analysis.firstTimestampMs ??= ms;
        analysis.lastTimestampMs = ms;
      }
    }
    if (type === "compaction" || type === "branch_summary") analysis.compactions++;
    if (type !== "message" || !entry.message) continue;
    const message = entry.message;
    const role = String(message.role ?? "");

    if (role === "user") {
      userMessages++;
    } else if (role === "toolResult") {
      analysis.toolResultMessages++;
      const isError = Boolean(message.isError);
      const errorText = Array.isArray(message.content)
        ? message.content
            .filter((part: any) => part?.type === "text")
            .map((part: any) => String(part.text ?? ""))
            .join("\n")
        : "";
      if (isError) {
        analysis.toolFailures++;
        if (analysis.failureSamples.length < 10) {
          const sample = errorTextForSamples(message);
          if (sample) analysis.failureSamples.push(sample);
        }
        const call = toolCallById.get(String(message.toolCallId ?? ""));
        // A call whose own argumentsError was already counted is not counted twice.
        if (call?.invalid) {
          void call;
        } else if (ARGUMENT_ERROR_SIGNATURES.some((re) => re.test(errorText))) {
          analysis.invalidToolArguments++;
          analysis.validationToolFailures++;
        }
        previousFailure = true;
      } else {
        if (previousFailure) analysis.recoveries++;
        previousFailure = false;
      }
    } else if (role === "assistant") {
      analysis.assistantMessages++;
      const reason = String(message.stopReason ?? "other");
      const counts = analysis.stopReasons;
      if (reason === "stop") counts.stop++;
      else if (reason === "toolUse") counts.toolUse++;
      else if (reason === "length") counts.length++;
      else if (reason === "aborted") counts.aborted++;
      else if (reason === "error") counts.error++;
      else counts.other++;

      const usage = message.usage;
      if (usage) {
        const active =
          (Number(usage.input) || 0) + (Number(usage.cacheRead) || 0) + (Number(usage.cacheWrite) || 0);
        if (active > 0) analysis.activeContextPeak = Math.max(analysis.activeContextPeak ?? 0, active);
        analysis.cumulative.input += Number(usage.input) || 0;
        analysis.cumulative.output += Number(usage.output) || 0;
        analysis.cumulative.cacheRead += Number(usage.cacheRead) || 0;
        analysis.cumulative.cacheWrite += Number(usage.cacheWrite) || 0;
      }

      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === "toolCall") {
          analysis.toolCalls++;
          const invalid = Boolean(part.argumentsError);
          if (invalid) analysis.invalidToolArguments++;
          toolCallById.set(String(part.id ?? ""), { name: String(part.name ?? ""), invalid });
          const probe = detectBoundaryViolation(part.arguments, workspace);
          if (probe.violation) {
            analysis.boundaryViolations++;
            if (analysis.boundarySamples.length < 8) {
              analysis.boundarySamples.push(`${part.name}: ${probe.sample}`);
            }
          }
        } else if (part?.type === "text" && looksLikeTextualToolCall(String(part.text ?? ""))) {
          analysis.malformedToolCalls++;
        }
      }
    }
  }

  analysis.available = true;
  // One user message is the benchmark prompt itself. In an automated, isolated run
  // any additional user message is a manual continuation.
  analysis.manualContinuations = Math.max(0, userMessages - 1);
  analysis.userMessages = userMessages;
  return analysis;
}

/**
 * Premature-stop classification.
 *
 * Pi ends the agent loop when an assistant turn stops with reason "stop" (no tool
 * calls). The final stop is always the normal loop terminator. Independent
 * evaluation failure is a failed completion claim, not a protocol interruption;
 * only additional stops before the final one are classified as premature.
 */
export function classifyPrematureStops(stopReasons: SessionStopCounts, completed: boolean): number {
  void completed;
  // The final `stop` is the normal way Pi ends an agent loop, regardless of
  // whether the independent evaluator later accepts the artifact. Extra stops
  // before that final turn are protocol-level premature terminations.
  return Math.max(0, stopReasons.stop - 1);
}
