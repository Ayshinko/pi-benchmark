import type { EnduranceTelemetry } from "./endurance-events.ts";

export interface EnduranceEvaluation { passed: number; total: number; categories: Record<string, { passed: number; total: number }>; phaseCompletion: number; completed: boolean; details: string[]; }
export interface EnduranceScores { engineering: number; reliability: number | "UNKNOWN"; efficiency: { wallMs: number; tokens: number | "UNKNOWN"; toolCalls: number }; autonomous: "PASS" | "FAIL" | "UNKNOWN"; }

export function scoreEndurance(e: EnduranceEvaluation, t: EnduranceTelemetry, metrics: any, resumed = false): EnduranceScores {
  const hidden = e.total ? e.passed / e.total : 0;
  const engineering = Math.round(100 * (0.8 * hidden + 0.2 * Math.max(0, Math.min(1, e.phaseCompletion / 12))));
  const manual = t.manualContinuations;
  let reliability: number | "UNKNOWN" = "UNKNOWN";
  if (manual !== "UNKNOWN") reliability = Math.max(0, 100 - t.prematureStops * 25 - manual * 20 - t.toolFailures * 3 - Math.max(0, t.toolFailures - t.recoveries) * 4 - (resumed ? 25 : 0));
  const autonomous = resumed || t.prematureStops > 0 || manual === "UNKNOWN" ? (manual === "UNKNOWN" && !resumed ? "UNKNOWN" : "FAIL") : (e.completed ? "PASS" : "FAIL");
  return { engineering, reliability, autonomous, efficiency: { wallMs: metrics.wallMs, tokens: typeof metrics.outputTokens === "number" ? metrics.outputTokens : "UNKNOWN", toolCalls: t.toolCalls } };
}
