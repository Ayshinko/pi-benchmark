import type { MetricsSnapshot } from "./types.ts";

/** Publish isolated benchmark telemetry to the existing task footer slot. */
export function renderTelemetry(s: MetricsSnapshot, thinking: string): string {
  const rate = (n: number) => Number.isFinite(n) && n > 0 ? `${n.toFixed(1)} tok/s` : "-- tok/s";
  const live = s.activeAssistantTurn !== null && s.liveTps > 0 ? rate(s.liveTps) : "—";
  const seconds = Math.floor(s.wallMs / 1000);
  const time = seconds >= 60 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
  const estimate = s.outputTokenAccuracy === "exact" ? "" : "*";
  return `⚡ Live ${live} · Avg ${rate(s.weightedTps)} · ↓${Math.round(s.outputTokens)}${estimate} · ${time} · ${thinking}`;
}
