const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/** Terminal cell width (ANSI escapes, combining marks, CJK and emoji aware). */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text.replace(ANSI, "")) {
    const cp = char.codePointAt(0)!;
    if (/\p{Mark}/u.test(char) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    width += cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0x1f300 && cp <= 0x1faff)) ? 2 : 1;
  }
  return width;
}

export interface BenchmarkStatus {
  run: number; runs: number; elapsedMs: number;
  phase: "prefill" | "generating" | "validating" | "other";
  liveTps?: number; averageTps?: number; ppTps?: number; fallback?: boolean;
}

export function renderBenchmarkStatus(s: BenchmarkStatus, columns = Infinity): string {
  const clock = `${Math.floor(s.elapsedMs / 60000)}m${String(Math.floor(s.elapsedMs / 1000) % 60).padStart(2, "0")}s`;
  const base = `🏯 ${s.run}/${s.runs}`;
  const phase = s.phase === "validating" ? "Validating…" : s.phase === "prefill" ? "Reading" : s.phase === "generating" ? "" : "Working…";
  const suffix = s.phase === "prefill" ? (s.ppTps ? `PP ${Math.round(s.ppTps)} tok/s` : "Reading") : s.phase === "generating" ? `Live ${Math.round(s.liveTps ?? 0)} · Avg ${Math.round(s.averageTps ?? 0)}${s.fallback ? "*" : ""}` : phase;
  const fields = [base, clock, suffix].filter(Boolean);
  const joins = (parts: string[]) => parts.join(" · ");
  let text = joins(fields);
  if (displayWidth(text) <= columns) return text;
  if (s.phase === "generating") {
    text = joins([base, clock, `L${Math.round(s.liveTps ?? 0)} A${Math.round(s.averageTps ?? 0)}${s.fallback ? "*" : ""}`]);
    if (displayWidth(text) <= columns) return text;
    text = joins([base, clock, `L${Math.round(s.liveTps ?? 0)}`]);
  }
  if (displayWidth(text) <= columns) return text;
  text = joins([base, s.phase === "validating" ? "Validating…" : s.phase === "prefill" ? "Reading" : clock]);
  if (displayWidth(text) <= columns) return text;
  const compact = `${s.run}/${s.runs}`;
  return displayWidth(compact) <= columns ? compact : "";
}

/** Shared status sink: ~400ms throttle and no writes for identical content. */
export class ThrottledStatus {
  private last = "";
  private at = 0;
  private pending: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private write: (text: string | undefined) => void;
  private interval: number;
  private width: () => number;
  constructor(write: (text: string | undefined) => void, interval = 400, width = () => process.stdout.columns ?? 80) {
    this.write = write; this.interval = interval; this.width = width;
  }
  update(status: BenchmarkStatus, now = Date.now()): void {
    this.pending = renderBenchmarkStatus(status, this.width());
    if (this.pending === this.last) return;
    const delay = this.interval - (now - this.at);
    if (delay <= 0) this.flush(now);
    else if (!this.timer) this.timer = setTimeout(() => this.flush(Date.now()), delay);
  }
  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined; this.pending = undefined; this.last = "";
    this.write(undefined);
  }
  private flush(now: number): void {
    this.timer = undefined;
    if (this.pending === undefined || this.pending === this.last) return;
    this.last = this.pending; this.pending = undefined; this.at = now;
    this.write(this.last);
  }
}
