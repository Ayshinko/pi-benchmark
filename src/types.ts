/**
 * Result states for one benchmark run.
 *
 * PASS                agent finished, artifact found, browser rendered, visual sane,
 *                     and the artifact is compliant with the benchmark contract
 * FAIL_AGENT        agent errored or was aborted before finishing
 * FAIL_LENGTH       agent hit the output length limit (truncated generation)
 * FAIL_RUNTIME      artifact exists but the browser could not run it
 * FAIL_VISUAL       artifact ran but the rendered output is blank/black/white
 * FAIL_MISSING_ARTIFACT no artifact was produced in the workspace
 * FAIL_TIMEOUT      wall-clock budget exceeded
 * FAIL_COMPLIANCE   agent/runtime/visual all fine but the artifact does not
 *                   meaningfully implement the benchmark's required features
 * REVIEW            agent/runtime/visual fine but compliance could not be
 *                   confirmed confidently (many UNKNOWN detections)
 * ERROR_HARNESS     the harness itself failed (no browser, session creation error)
 */
export type ResultState =
  | "PASS"
  | "FAIL_AGENT"
  | "FAIL_LENGTH"
  | "FAIL_RUNTIME"
  | "FAIL_VISUAL"
  | "FAIL_MISSING_ARTIFACT"
  | "FAIL_TIMEOUT"
  | "FAIL_COMPLIANCE"
  | "REVIEW"
  | "ERROR_HARNESS";

/** Per-item compliance status. UNKNOWN hides rather than fabricates a verdict. */
export type ComplianceStatus = "PASS" | "FAIL" | "UNKNOWN";

/**
 * One required pagoda-v1 feature and how confidently the artifact implements it.
 */
export interface ComplianceItem {
  /** Stable identifier, e.g. "instanced-mesh". */
  id: string;
  /** Human label, e.g. "InstancedMesh". */
  label: string;
  status: ComplianceStatus;
  /** Short evidence string, or "" when nothing was detected. */
  detail: string;
  /** Critical items FAIL the whole compliance gate when they are FAIL. */
  critical: boolean;
}

/**
 * Result of compliance validation for one run.
 */
export interface ComplianceReport {
  /** PASS | FAIL | REVIEW */
  overall: ComplianceStatus | "REVIEW";
  items: ComplianceItem[];
  /** Short human summary of why the overall verdict was reached. */
  reasons: string[];
}

/**
 * Structural facts gathered while the artifact runs in the browser (or from a
 * cooperative window.__benchMetrics global the artifact may expose). Absent
 * values mean the harness could not observe them, not that they are absent.
 */
export interface RuntimeProbe {
  threeLoaded: boolean;
  canvas: boolean;
  webgl: boolean;
  /** Body innerText, trimmed (used to read HUD text such as fps / voxels). */
  bodyText: string;
  /** Reported via window.__benchMetrics.voxels, if the artifact exposes it. */
  reportedVoxels: number | null;
  /** Reported via window.__benchMetrics.fps, if the artifact exposes it. */
  reportedFps: number | null;
  /** Reported via window.__benchMetrics.objectCount, if the artifact exposes it. */
  objectCount: number | null;
  /** Reported via window.__benchMetrics.instances, if the artifact exposes it. */
  instancedMeshes: number | null;
  /** Reported via window.__benchMetrics.features (string[]), if exposed. */
  features: string[];
}

export interface GenerationStat {
  index: number;
  /** Provider request start (message_start), includes prefill. */
  requestStartMs: number;
  /** First streamed content block: the model is actually decoding. */
  decodeStartMs: number;
  /** message_end. */
  endMs: number;
  outputTokens: number;
  inputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  stopReason: string;
}

export type OutputTokenAccuracy = "exact" | "estimated" | "reconciled";

export interface MetricsSnapshot {
  wallMs: number;
  genMs: number;
  outputTokens: number;
  inputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Whole-task weighted TPS: total output tokens / total decode seconds. */
  weightedTps: number;
  /** Secondary: output tokens over the whole wall clock. */
  wallTps: number;
  generations: number;
  toolCalls: number;
  toolErrors: number;
  stopReasons: string[];
  aborted: boolean;
  /** Streaming/incremental fields. */
  /** Estimated output tokens of a still-active assistant turn (0 if none). */
  partialOutputTokens: number;
  /** Whether the reported outputTokens are exact, estimated, or reconciled to exact. */
  outputTokenAccuracy: OutputTokenAccuracy;
  /** Current/local generation rate of the active turn (tok/s); 0 when idle. */
  liveTps: number;
  /** Generation time (ms) of the still-active assistant turn (0 if none). */
  activeGenerationMs: number;
  /** Assistant turns started (completed + active). */
  assistantTurnsStarted: number;
  /** Assistant turns that reached message_end. */
  assistantTurnsCompleted: number;
  /** Index of the active (non-finalized) assistant turn, or null. */
  activeAssistantTurn: number | null;
  /** Heuristic used to estimate partial tokens (chars per token). */
  estimatedCharsPerToken: number;
  /** Source quality across all model requests (legacy results omit these). */
  measurementAccuracy?: "native" | "mixed" | "estimated" | "unavailable";
  measurementSource?: string;
  nativeRequests?: number;
}

export interface ArtifactReport {
  found: boolean;
  path: string | null;
  name: string | null;
  sizeBytes: number;
  candidates: string[];
  checks: {
    hasCanvas: boolean;
    hasThree: boolean;
    hasScript: boolean;
    closedHtml: boolean;
    sizeOk: boolean;
  };
  staticOk: boolean;
}

export interface BrowserReport {
  attempted: boolean;
  skipped: boolean;
  ok: boolean;
  browser: string | null;
  browserName: string | null;
  durationMs: number;
  errors: string[];
  consoleErrors: string[];
  canvas: boolean;
  canvasWidth: number;
  canvasHeight: number;
  threeLoaded: boolean;
  webgl: boolean;
  bodyTextLength: number;
  /** Trimmed body innerText, used to read HUD text (fps / voxel counts). */
  bodyText: string;
  /** Runtime scene facts for compliance (see RuntimeProbe). */
  runtime: RuntimeProbe;
  screenshotPath: string | null;
  screenshotWidth: number;
  screenshotHeight: number;
  visual: VisualReport | null;
}

export interface VisualReport {
  ok: boolean;
  width: number;
  height: number;
  meanLuminance: number;
  luminanceStdDev: number;
  blackFraction: number;
  whiteFraction: number;
  uniqueColors: number;
  meanSaturation: number;
  reasons: string[];
}

export interface RunResult {
  id: string;
  benchmark: string;
  /** Canonical versioned benchmark name, e.g. "pagoda-v1". */
  benchmarkVersion: string;
  /** SHA-256 (hex) of the exact text sent to session.prompt(). */
  promptHash: string;
  promptVersion: string;
  runIndex: number;
  timestamp: string;
  model: { provider: string; id: string; name: string; contextWindow?: number; maxTokens?: number };
  thinkingLevel: string;
  workspace: string;
  runDir: string;
  sessionFile: string | null;
  outcome: ResultState;
  reasons: string[];
  metrics: MetricsSnapshot;
  artifact: ArtifactReport;
  browser: BrowserReport;
  visual: VisualReport;
  /** Compliance validation of the produced artifact (present on new runs). */
  compliance: ComplianceReport | null;
  timings: { agentMs: number; validationMs: number };
}
