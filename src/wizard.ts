/**
 * Interactive first-use flow for `/benchmark`.
 *
 * A new user runs `/benchmark` and answers a few `ctx.ui` dialogs — no flags
 * required. All decision helpers are pure/testable; only the actual dialog calls
 * touch the Pi UI.
 *
 * Flow:
 *   1. Only one production suite (pagoda-v1) exists -> auto-selected, no chooser.
 *   2. Current model + thinking shown (never changed silently).
 *   3. Ask "How many runs?" with fast choices (default/highlight 1 run first).
 *   4. Confirm the full plan, then run.
 *
 * Fast path: `/benchmark 3` -> 3 runs, current model, current thinking, a single
 * concise confirmation. `/benchmark --advanced` exposes every knob.
 */

/** Minimal slice of ctx.ui the wizard needs (kept small for deterministic tests). */
export interface WizardUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export const RUN_CHOICES = ["1 run", "3 runs", "5 runs", "Custom..."] as const;

export type BenchmarkMode = "interactive" | "fast" | "advanced";

export interface BenchmarkInvocation {
  mode: BenchmarkMode;
  /** Fast-path run count (mode === "fast"). */
  runs?: number;
  /** "--advanced" was present. */
  advanced: boolean;
}

/**
 * Parse the raw `/benchmark ...` argument string.
 *   ""          -> interactive wizard
 *   "3"         -> fast path, 3 runs
 *   "--advanced"-> advanced wizard
 */
export function parseBenchmarkInvocation(args: string): BenchmarkInvocation {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const advanced = tokens.includes("--advanced");
  const nonFlag = tokens.filter((t) => !t.startsWith("--"));
  if (advanced) {
    return { mode: "advanced", advanced: true };
  }
  if (nonFlag.length > 0) {
    const n = Number(nonFlag[0]);
    if (Number.isInteger(n) && n >= 1) {
      return { mode: "fast", runs: n, advanced: false };
    }
    throw new Error(`Invalid run count "${nonFlag[0]}". Run /benchmark with no argument for the wizard, or /benchmark N for N runs (>= 1).`);
  }
  return { mode: "interactive", advanced: false };
}

/**
 * Interactive run-count selection. Returns the chosen count or null on cancel.
 */
export async function pickRunCountInteractive(
  ui: WizardUI,
  _context: { defaultRunCount: number },
): Promise<number | null> {
  const choice = await ui.select(
    "How many runs?",
    [...RUN_CHOICES],
  );
  if (!choice) return null; // user dismissed the dialog
  if (choice === "Custom...") {
    const raw = await ui.input("Number of runs", "3");
    if (raw === undefined || raw === null) return null;
    const n = Number(raw.trim());
    if (!Number.isInteger(n) || n < 1) {
      ui.notify("Run count must be a whole number >= 1.", "error");
      return pickRunCountInteractive(ui, _context);
    }
    return n;
  }
  const n = Number(choice.replace(/[^0-9]/g, ""));
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/**
 * Advanced-mode field picker. Returns a plan or null on cancel. `defaults` are
 * current values so the user is never pushed off one of them accidentally.
 */
export async function advancedPlanInteractive(
  ui: WizardUI,
  defaults: {
    benchmarkName: string;
    runs: number;
    modelLabel: string;
    thinking: string;
    timeoutSeconds: number;
    browser: boolean;
    settleMs: number;
  },
): Promise<AdvancedPlan | null> {
  const suite = await ui.select("Benchmark suite", [`${defaults.benchmarkName} (pagoda-v1)`]);
  if (!suite) return null;
  const runs = await pickRunCountInteractive(ui, { defaultRunCount: defaults.runs });
  if (runs === null) return null;

  const modelChoice = await ui.select("Model", [`${defaults.modelLabel} (current)`, "Other..."]);
  if (modelChoice === undefined) return null;
  let model: string | null = null;
  if (modelChoice === "Other...") {
    const m = await ui.input("Model (provider/model-id)", "");
    if (m === undefined || m.trim() === "") return null;
    model = m.trim();
  }

  const thinkingChoice = await ui.select("Thinking", ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  if (!thinkingChoice) return null;

  const timeoutRaw = await ui.input("Timeout (seconds)", String(defaults.timeoutSeconds));
  if (timeoutRaw === undefined) return null;
  const timeoutSeconds = Math.max(30, Number(timeoutRaw.trim()) || defaults.timeoutSeconds);

  const browserChoice = await ui.select("Browser validation", ["on (validate in Chrome/Edge)", "off (--no-browser)"]);
  if (!browserChoice) return null;
  const browser = browserChoice.startsWith("on");

  const settleRaw = await ui.input("Settle time (ms)", String(defaults.settleMs));
  if (settleRaw === undefined) return null;
  const settleMs = Math.max(500, Number(settleRaw.trim()) || defaults.settleMs);

  return { runs, model, thinking: thinkingChoice, timeoutSeconds, browser, settleMs };
}

export interface AdvancedPlan {
  runs: number;
  model: string | null;
  thinking: string;
  timeoutSeconds: number;
  browser: boolean;
  settleMs: number;
}

/** The benchmark was standardized at this max output. Used only for the
 *  informational comparability warning — it is NOT written into any model or
 *  config, and it is NOT used to verify/hardcode a model limit. */
const STANDARD_MAX_OUTPUT = 32_768;

function resolveLimit(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatLimit(value: number | null): string {
  return value === null ? "n/a" : value.toLocaleString("en-US");
}

/**
 * Build the confirmation summary block shown before a run starts.
 * The resolved model limits (context window / max output) come READ-ONLY from
 * the currently resolved Pi model object and are shown as informational
 * metadata only. If a limit is missing it renders as "n/a"; if maxTokens is
 * known but below the standardized 32,768, an informational comparability
 * warning is appended without blocking the run or mutating anything.
 */
export function confirmationSummary(plan: {
  benchmarkName: string;
  modelLabel: string;
  provider: string;
  thinking: string;
  runs: number;
  contextWindow?: number | null;
  maxTokens?: number | null;
  timeoutSeconds?: number;
  browser?: boolean;
  settleMs?: number;
}): string {
  const context = resolveLimit(plan.contextWindow);
  const maxOut = resolveLimit(plan.maxTokens);

  const label = (key: string): string => `${key.padEnd(11)}: `;
  const lines = [
    "Ready to benchmark",
    "",
    label("Benchmark") + plan.benchmarkName,
    label("Model") + plan.modelLabel,
    label("Provider") + plan.provider,
    label("Thinking") + plan.thinking,
    label("Context") + formatLimit(context),
    label("Max output") + formatLimit(maxOut),
    label("Runs") + String(plan.runs),
  ];
  if (plan.timeoutSeconds !== undefined) lines.push(label("Timeout") + `${plan.timeoutSeconds}s`);
  if (plan.browser !== undefined) lines.push(label("Browser") + (plan.browser ? "on" : "off"));
  if (plan.settleMs !== undefined) lines.push(label("Settle") + `${plan.settleMs}ms`);
  if (maxOut !== null && maxOut < STANDARD_MAX_OUTPUT) {
    lines.push(
      "",
      `⚠ Max output is ${formatLimit(maxOut)} tokens.`,
      `This benchmark was standardized with ${STANDARD_MAX_OUTPUT.toLocaleString("en-US")} max output tokens.`,
      `Results may not be directly comparable with the standard leaderboard.`,
    );
  } else if (maxOut === null) {
    lines.push("", `⚠ Max output limit could not be determined.`);
  }
  lines.push("", "[ Start benchmark ]   [ Cancel ]");
  return lines.join("\n");
}