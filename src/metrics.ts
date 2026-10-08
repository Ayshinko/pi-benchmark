/**
 * Whole-task metric accumulator.
 *
 * Pure logic, no Pi imports, no I/O: it can be driven by fixture events in a
 * test and by a real AgentSession in the runner.
 *
 * Three independent measurements:
 * - wallMs  real end-to-end run time, prefill + tools included
 * - genMs   model decode time only: first streamed content block of each
 *           assistant message until that message is finalized
 * - weightedTps total output tokens / total decode seconds
 *
 * The weighted TPS is a true token/second ratio over the whole task. It is NOT
 * an average of per-message TPS values.
 *
 * Streaming / incremental accounting:
 * Pi does not expose exact incremental token counts during streaming. It exposes
 * character deltas (`text_delta` / `thinking_delta` / `toolcall_delta`) and a live
 * `partial` assistant message. So during an active assistant turn we ESTIMATE output
 * tokens from accumulated streamed characters, keep that partial count in the live
 * snapshot, and RECONCILE it with the exact `usage.output` reported at `message_end`.
 * Reconciliation replaces the estimate; it never adds the two together, so partial
 * and final counts are never double counted.
 */

import type { MetricsSnapshot } from "./types.ts";

export interface AssistantUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

export type OutputTokenAccuracy = "exact" | "estimated" | "reconciled";

export interface GenerationStat {
  index: number;
  requestStartMs: number;
  decodeStartMs: number;
  endMs: number;
  outputTokens: number;
  inputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  stopReason: string;
  /**
   * Whether this turn's final outputTokens is exact (message_end usage) or an
   * estimated partial (stream interrupted, usage unreliable).
   */
  outputAccuracy: "exact" | "estimated";
}

/** Default heuristic for estimating tokens from streamed characters. */
const DEFAULT_CHARS_PER_TOKEN = 4;

export class RunMetrics {
  private readonly clock: () => number;
  private readonly charsPerToken: number;
  private wallStart = 0;
  private wallEnd = 0;
  private generations: GenerationStat[] = [];
  private toolCalls = 0;
  private toolErrors = 0;
  private aborted = false;
  private current: GenerationStat | null = null;
  private activeChars = 0;
  private activeNativeOutput: number | null = null;
  private activeNativeLiveTps: number | null = null;
  private usedEstimation = false;
  private finishedAt = 0;

  constructor(clock: () => number = () => Date.now(), charsPerToken: number = DEFAULT_CHARS_PER_TOKEN) {
    this.clock = clock;
    this.charsPerToken = charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN;
  }

  start(): void {
    this.wallStart = this.clock();
  }

  elapsedMs(): number {
    return this.wallStart ? this.clock() - this.wallStart : 0;
  }

  finish(): void {
    this.finishedAt = this.clock();
    this.wallEnd = this.finishedAt;
    // The active (never-finalized) turn stays live; snapshot() accounts for it and its
    // estimated tokens / elapsed generation time up to now. Nothing is dropped here.
  }

  /** An assistant message began (provider request issued, prefill included). */
  beginAssistantMessage(): void {
    this.current = {
      index: this.generations.length,
      requestStartMs: this.clock(),
      decodeStartMs: 0,
      endMs: 0,
      outputTokens: 0,
      inputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      stopReason: "pending",
      outputAccuracy: "exact",
    };
    this.activeChars = 0;
    this.activeNativeOutput = null;
    this.activeNativeLiveTps = null;
  }

  /**
   * The model started emitting content: decoding has begun. The generation timer for
   * this turn starts on the first streamed content block.
   */
  contentStarted(): void {
    if (this.current && this.current.decodeStartMs === 0) {
      this.current.decodeStartMs = this.clock();
    }
  }

  /**
   * Accumulate streamed output characters for the active turn (text/thinking/tool-call
   * argument deltas). Estimate tokens from characters using the configured heuristic.
   * Only counts once decoding has begun, matching how generation time is measured.
   */
  outputDelta(text: string): void {
    if (!this.current || this.current.decodeStartMs === 0) return;
    if (!text) return;
    this.activeChars += text.length;
    this.usedEstimation = true;
  }

  /** Live server token count and speed override the estimate for the active request. */
  setActiveNative(outputTokens: number, liveTps: number): void {
    if (!this.current) return;
    if (Number.isFinite(outputTokens) && outputTokens >= 0) this.activeNativeOutput = outputTokens;
    if (Number.isFinite(liveTps) && liveTps >= 0) this.activeNativeLiveTps = liveTps;
  }

  /** An assistant message was finalized with exact usage. Reconciles the estimate. */
  endAssistantMessage(usage: AssistantUsage | undefined, stopReason: string): void {
    const now = this.clock();
    const gen = this.current ?? {
      index: this.generations.length,
      requestStartMs: now,
      decodeStartMs: now,
      endMs: now,
      outputTokens: 0,
      inputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      stopReason: stopReason,
    };
    gen.endMs = now;
    gen.stopReason = stopReason;
    // Exact message-end usage is authoritative and REPLACES the streaming estimate.
    gen.outputTokens = numberOr(usage?.output, 0);
    gen.inputTokens = numberOr(usage?.input, 0);
    gen.cacheRead = numberOr(usage?.cacheRead, 0);
    gen.cacheWrite = numberOr(usage?.cacheWrite, 0);
    gen.cost = numberOr(usage?.cost?.total, 0);
    gen.outputAccuracy = "exact";
    if (gen.decodeStartMs === 0) gen.decodeStartMs = gen.requestStartMs;
    this.generations.push(gen);
    this.current = null;
    this.activeChars = 0;
    this.activeNativeOutput = null;
    this.activeNativeLiveTps = null;
  }

  /**
   * Finalize the active turn WITHOUT trustworthy exact usage (e.g. the stream was
   * interrupted by a timeout/abort/error and the terminal usage is unreliable or zero).
   * The accumulated partial estimate becomes the final count. This preserves output that
   * was already generated instead of resetting it to 0 on abort.
   */
  endAssistantMessagePartial(stopReason: string): void {
    const now = this.clock();
    const gen = this.current ?? {
      index: this.generations.length,
      requestStartMs: now,
      decodeStartMs: now,
      endMs: now,
      outputTokens: 0,
      inputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      stopReason: stopReason,
      outputAccuracy: "exact",
    };
    gen.endMs = now;
    gen.stopReason = stopReason;
    const estimated = this.activeChars / this.charsPerToken;
    gen.outputTokens = estimated;
    gen.outputAccuracy = estimated > 0 ? "estimated" : "exact";
    if (gen.decodeStartMs === 0) gen.decodeStartMs = gen.requestStartMs;
    this.generations.push(gen);
    this.current = null;
    this.activeChars = 0;
    this.activeNativeOutput = null;
    this.activeNativeLiveTps = null;
  }

  toolCall(isError: boolean): void {
    this.toolCalls += 1;
    if (isError) this.toolErrors += 1;
  }

  markAborted(): void {
    this.aborted = true;
    // Freeze the active turn's decode time so it is not recomputed past the abort.
    if (this.current && this.current.decodeStartMs > 0 && this.current.endMs === 0) {
      this.current.endMs = this.clock();
    }
  }

  private now(): number {
    return this.clock();
  }

  /** Estimated tokens so far for the active turn, if any. */
  private activePartialTokens(): number {
    return this.activeNativeOutput ?? this.activeChars / this.charsPerToken;
  }

  /** Generation time currently attributable to the active turn (ms), if any. */
  private activeGenMs(): number {
    if (!this.current || this.current.decodeStartMs === 0) return 0;
    const end = this.current.endMs || this.now();
    return Math.max(0, end - this.current.decodeStartMs);
  }

  private activeTurnEndMs(): number {
    return this.current ? this.current.endMs || this.now() : 0;
  }

  snapshot(): MetricsSnapshot {
    const now = this.now();
    const wallMs = Math.max(0, (this.wallEnd || now) - this.wallStart);
    let outputTokens = 0;
    let inputTokens = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;
    let genMs = 0;
    const stopReasons: string[] = [];

    for (const g of this.generations) {
      outputTokens += g.outputTokens;
      inputTokens += g.inputTokens;
      cacheRead += g.cacheRead;
      cacheWrite += g.cacheWrite;
      cost += g.cost;
      genMs += Math.max(0, g.endMs - g.decodeStartMs);
      stopReasons.push(g.stopReason);
    }

    // Active (not-yet-finalized) assistant turn contributes its ESTIMATED partial
    // output and its elapsed generation time.
    const hasActive = this.current !== null;
    const activePartialTokens = hasActive ? this.activePartialTokens() : 0;
    const activeGen = hasActive ? this.activeGenMs() : 0;
    const activeDecoding = hasActive && this.current!.decodeStartMs > 0 && activeGen > 0;
    if (hasActive) {
      outputTokens += activePartialTokens;
      genMs += activeGen;
      stopReasons.push(this.current!.stopReason);
    }

    const liveTps = activeDecoding ? (this.activeNativeLiveTps ?? activePartialTokens / (activeGen / 1000)) : 0;
    const completedTurns = this.generations.length;
    const startedTurns = completedTurns + (hasActive ? 1 : 0);
    const anyEstimatedGeneration = this.generations.some((g) => g.outputAccuracy === "estimated");

    // Accuracy of the reported output token count.
    let outputTokenAccuracy: OutputTokenAccuracy;
    if (hasActive) {
      outputTokenAccuracy = activePartialTokens > 0 ? "estimated" : this.usedEstimation ? "reconciled" : "exact";
      if (anyEstimatedGeneration) outputTokenAccuracy = "estimated";
    } else if (anyEstimatedGeneration) {
      outputTokenAccuracy = "estimated";
    } else if (this.usedEstimation) {
      outputTokenAccuracy = "reconciled";
    } else {
      outputTokenAccuracy = "exact";
    }

    return {
      wallMs,
      genMs,
      outputTokens,
      inputTokens,
      cacheRead,
      cacheWrite,
      cost,
      weightedTps: genMs > 0 ? outputTokens / (genMs / 1000) : 0,
      wallTps: wallMs > 0 ? outputTokens / (wallMs / 1000) : 0,
      generations: completedTurns,
      toolCalls: this.toolCalls,
      toolErrors: this.toolErrors,
      stopReasons,
      aborted: this.aborted,
      // Streaming / incremental fields.
      partialOutputTokens: activePartialTokens,
      outputTokenAccuracy,
      liveTps,
      activeGenerationMs: activeGen,
      assistantTurnsStarted: startedTurns,
      assistantTurnsCompleted: completedTurns,
      activeAssistantTurn: hasActive ? this.current!.index : null,
      estimatedCharsPerToken: this.charsPerToken,
    };
  }

  /** Replace one finalized request's fallback accounting with Strata decode-only values. */
  reconcileLastWithNative(outputTokens: number, decodeSeconds: number): boolean {
    const gen = this.generations[this.generations.length - 1];
    if (!gen || !(outputTokens > 0) || !(decodeSeconds > 0)) return false;
    gen.outputTokens = outputTokens;
    gen.decodeStartMs = gen.endMs - decodeSeconds * 1000;
    (gen as GenerationStat & { native?: boolean }).native = true;
    return true;
  }

  generationDetails(): GenerationStat[] {
    return this.generations;
  }
}

function numberOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}