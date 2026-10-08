/**
 * Outcome classification. Kept separate from the runner so it can be tested
 * without importing the Pi SDK.
 *
 * A run is separated into gates, and Overall PASS requires ALL of:
 *   - Agent PASS       (finished, no abort/error/length, produced output)
 *   - Runtime PASS     (artifact found, static checks ok, browser ran it)
 *   - Visual PASS      (screen not blank/black/white/flat)
 *   - Compliance PASS  (artifact meaningfully implements the contract when a
 *                       compliance report is available; legacy runs without one
 *                       are treated as passing compliance)
 */

import type {
  ArtifactReport,
  BrowserReport,
  ComplianceReport,
  MetricsSnapshot,
  ResultState,
  VisualReport,
} from "./types.ts";

export interface OutcomeArgs {
  metrics: MetricsSnapshot;
  artifact: ArtifactReport;
  browser: BrowserReport;
  visual: VisualReport | null;
  timedOut: boolean;
  harnessError: string | null;
  /** New runs supply a compliance report; legacy/test callers may omit it. */
  compliance?: ComplianceReport | null;
}

export function determineOutcome(
  metrics: MetricsSnapshot,
  artifact: ArtifactReport,
  browser: BrowserReport,
  visual: VisualReport | null,
  timedOut: boolean,
  harnessError: string | null,
): { outcome: ResultState; reasons: string[] };
export function determineOutcome(args: OutcomeArgs): { outcome: ResultState; reasons: string[] };
export function determineOutcome(
  a: MetricsSnapshot | OutcomeArgs,
  artifact?: ArtifactReport,
  browser?: BrowserReport,
  visual?: VisualReport | null,
  timedOut?: boolean,
  harnessError?: string | null,
): { outcome: ResultState; reasons: string[] } {
  let metrics: MetricsSnapshot;
  let compliance: ComplianceReport | null | undefined;

  if (isArgs(a)) {
    metrics = a.metrics;
    artifact = a.artifact;
    browser = a.browser;
    visual = a.visual;
    timedOut = a.timedOut;
    harnessError = a.harnessError;
    compliance = a.compliance;
  } else {
    metrics = a as MetricsSnapshot;
    compliance = undefined;
  }

  if (harnessError) {
    return { outcome: "ERROR_HARNESS", reasons: [harnessError] };
  }
  if (timedOut) {
    return { outcome: "FAIL_TIMEOUT", reasons: [`wall clock exceeded ${metrics.wallMs} ms`] };
  }
  if (metrics.aborted) {
    return { outcome: "FAIL_AGENT", reasons: ["agent aborted before finishing"] };
  }
  if (metrics.stopReasons.includes("error")) {
    return { outcome: "FAIL_AGENT", reasons: ["assistant request errored"] };
  }
  if (metrics.stopReasons.includes("length")) {
    return { outcome: "FAIL_LENGTH", reasons: ["assistant generation hit the output length limit"] };
  }
  if (metrics.outputTokens === 0) {
    return { outcome: "FAIL_AGENT", reasons: ["agent produced no output tokens"] };
  }
  if (!artifact.found) {
    return { outcome: "FAIL_MISSING_ARTIFACT", reasons: ["no HTML artifact written to the workspace"] };
  }
  if (!artifact.staticOk) {
    const failed = Object.entries(artifact.checks)
      .filter(([, ok]) => !ok)
      .map(([key]) => key);
    return { outcome: "FAIL_RUNTIME", reasons: [`artifact failed static checks: ${failed.join(", ")}`] };
  }
  if (browser.skipped) {
    // With browser validation disabled we cannot confirm visual or compliance; run
    // compliance on static source only, else REVIEW.
    if (compliance && compliance.overall !== "PASS" && compliance.overall !== "REVIEW") {
      return { outcome: "FAIL_COMPLIANCE", reasons: compliance.reasons };
    }
    return { outcome: "PASS", reasons: ["browser validation skipped (--no-browser)"] };
  }
  if (!browser.attempted) {
    return {
      outcome: "ERROR_HARNESS",
      reasons: browser.errors.length ? browser.errors.join("; ") : "browser validation did not run",
    };
  }
  if (!browser.ok) {
    return { outcome: "FAIL_RUNTIME", reasons: browser.errors.length ? browser.errors : ["artifact did not run in the browser"] };
  }
  if (visual && !visual.ok) {
    return { outcome: "FAIL_VISUAL", reasons: visual.reasons };
  }
  if (compliance) {
    if (compliance.overall === "FAIL") {
      return { outcome: "FAIL_COMPLIANCE", reasons: compliance.reasons };
    }
    if (compliance.overall === "REVIEW") {
      return { outcome: "REVIEW", reasons: compliance.reasons };
    }
    // PASS -> fall through to PASS
  }
  return { outcome: "PASS", reasons: [] };
}

function isArgs(a: MetricsSnapshot | OutcomeArgs): a is OutcomeArgs {
  // A MetricsSnapshot has no `.metrics` property; an OutcomeArgs object does.
  return (
    typeof (a as OutcomeArgs).metrics === "object" &&
    (a as OutcomeArgs).metrics !== null &&
    !Array.isArray((a as OutcomeArgs).metrics)
  );
}