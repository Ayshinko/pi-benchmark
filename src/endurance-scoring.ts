/**
 * Agent Endurance V3 scoring.
 *
 * Three separate axes are reported; they are never merged into one number:
 *
 *  ENGINEERING (correctness of the produced software)
 *    headline:  engineering = round(100 * (0.8 * hiddenTestRatio + 0.2 * phaseRatio))
 *      - hiddenTestRatio  = evaluator.passed / evaluator.total (hidden tests live
 *        in src/evaluators, never copied into the evaluated workspace)
 *      - phaseRatio       = phaseCompletion / 12 (objective evidence in PHASES.md)
 *    breakdown (0..1 ratios, informational):
 *      - hiddenTests      : hiddenTestRatio
 *      - featureCoverage  : phaseRatio (12 documented phases)
 *      - integration      : ratio over the evaluator categories that describe
 *                           cross-process behaviour (cli, integration, reports)
 *      - integrity        : ratio over the categories that describe transactional
 *                           and persistence behaviour (transactions, persistence,
 *                           orders, transfers, purchasing, returns)
 *    The headline weights are unchanged from the first Agent Endurance V3 release,
 *    so historical results remain comparable.
 *
 *  RELIABILITY (does the agent finish on its own, without the harness helping?)
 *      reliability = max(0, 100
 *                    - 25 * prematureStops
 *                    - 20 * manualContinuations
 *                    -  3 * toolFailures
 *                    -  4 * max(0, toolFailures - recoveries)     (unrecovered)
 *                    -  5 * boundaryViolations
 *                    - 25 if the run was resumed)
 *      `reliability` is "UNKNOWN" when manual continuations cannot be observed.
 *      A run that needed a manual continuation, a premature stop, or a resume is
 *      never a perfect autonomous score and never an autonomous PASS.
 *
 *  EFFICIENCY (raw metrics only; deliberately not scored)
 *      wallMs, cumulative output/input tokens, active context peak, tool calls.
 *      More tool calls or more self-written tests are NOT rewarded: self-written
 *      tests are not part of any score, and tool-call counts are reported raw.
 *
 * Resumed runs are diagnostic: `resumed: true` forces autonomous = FAIL, and the
 * result card marks the run as diagnostic.
 */

import type { EnduranceTelemetry } from "./endurance-events.ts";

export interface EnduranceEvaluation {
  passed: number;
  total: number;
  categories: Record<string, { passed: number; total: number }>;
  phaseCompletion: number;
  completed: boolean;
  details: string[];
  /** Identifies the hidden test set so results stay comparable across releases. */
  evaluatorVersion?: string;
  evaluatorSha256?: string;
}

export interface EngineeringBreakdown {
  hiddenTests: number;
  featureCoverage: number;
  integration: number;
  integrity: number;
}

export interface ReliabilityBreakdown {
  prematureStops: number;
  manualContinuations: number | "UNKNOWN";
  toolFailures: number;
  unrecoveredFailures: number;
  boundaryViolations: number | "UNKNOWN";
  resumed: boolean;
}

export interface EnduranceScores {
  /** Headline engineering score, 0..100 (unchanged weighting: 80% hidden, 20% phases). */
  engineering: number;
  engineeringBreakdown: EngineeringBreakdown;
  reliability: number | "UNKNOWN";
  reliabilityBreakdown: ReliabilityBreakdown;
  autonomous: "PASS" | "FAIL" | "UNKNOWN";
  efficiency: {
    wallMs: number;
    outputTokens: number | "UNKNOWN";
    inputTokens: number | "UNKNOWN";
    activeContextPeak: number | "UNKNOWN";
    toolCalls: number;
    assistantTurns: number;
  };
}

export interface ScoreOptions {
  resumed?: boolean;
  /** Harness interruption: the timeout/abort clock fired or the session aborted. */
  interrupted?: boolean;
}

const INTEGRITY_CATEGORIES = ["transactions", "persistence", "orders", "transfers", "purchasing", "returns"];
const INTEGRATION_CATEGORIES = ["cli", "integration", "reports"];

function categoryRatio(categories: Record<string, { passed: number; total: number }>, names: string[]): number {
  let passed = 0;
  let total = 0;
  for (const name of names) {
    const entry = categories?.[name];
    if (!entry) continue;
    passed += entry.passed;
    total += entry.total;
  }
  return total === 0 ? 0 : passed / total;
}

function num(value: unknown): number | "UNKNOWN" {
  return typeof value === "number" && Number.isFinite(value) ? value : "UNKNOWN";
}

export function scoreEndurance(
  e: EnduranceEvaluation,
  t: EnduranceTelemetry,
  metrics: any,
  resumedOrOptions: boolean | ScoreOptions = false,
): EnduranceScores {
  const options: ScoreOptions = typeof resumedOrOptions === "boolean" ? { resumed: resumedOrOptions } : resumedOrOptions;
  const resumed = Boolean(options.resumed);

  const hiddenRatio = e.total > 0 ? e.passed / e.total : 0;
  const phaseRatio = Math.max(0, Math.min(1, (e.phaseCompletion || 0) / 12));
  const engineering = Math.round(100 * (0.8 * hiddenRatio + 0.2 * phaseRatio));

  const manual = t.manualContinuations;
  const boundary = t.boundaryViolations ?? "UNKNOWN";
  const unrecovered = Math.max(0, t.toolFailures - t.recoveries);

  let reliability: number | "UNKNOWN" = "UNKNOWN";
  if (manual !== "UNKNOWN") {
    reliability = Math.max(
      0,
      100 -
        t.prematureStops * 25 -
        manual * 20 -
        t.toolFailures * 3 -
        unrecovered * 4 -
        (boundary === "UNKNOWN" ? 0 : boundary * 5) -
        (resumed ? 25 : 0),
    );
  }

  let autonomous: "PASS" | "FAIL" | "UNKNOWN";
  if (resumed || t.prematureStops > 0 || options.interrupted || (boundary !== "UNKNOWN" && boundary > 0)) {
    autonomous = "FAIL";
  } else if (manual === "UNKNOWN") {
    autonomous = "UNKNOWN";
  } else {
    autonomous = manual === 0 && e.completed ? "PASS" : "FAIL";
  }

  return {
    engineering,
    engineeringBreakdown: {
      hiddenTests: Number(hiddenRatio.toFixed(3)),
      featureCoverage: Number(phaseRatio.toFixed(3)),
      integration: Number(categoryRatio(e.categories, INTEGRATION_CATEGORIES).toFixed(3)),
      integrity: Number(categoryRatio(e.categories, INTEGRITY_CATEGORIES).toFixed(3)),
    },
    reliability,
    reliabilityBreakdown: {
      prematureStops: t.prematureStops,
      manualContinuations: manual,
      toolFailures: t.toolFailures,
      unrecoveredFailures: unrecovered,
      boundaryViolations: boundary,
      resumed,
    },
    autonomous,
    efficiency: {
      wallMs: num(metrics?.wallMs),
      outputTokens: num(metrics?.outputTokens),
      inputTokens: num(metrics?.inputTokens),
      activeContextPeak: t.activeContextPeak,
      toolCalls: t.toolCalls,
      assistantTurns: t.assistantTurns ?? 0,
    },
  };
}
