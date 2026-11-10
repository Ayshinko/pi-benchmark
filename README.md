# Pi Benchmark

A benchmark harness for **complete coding-agent tasks**: the agent gets one prompt, works in an
empty isolated workspace, must produce a runnable artifact, and the harness verifies that
artifact in a real browser and scores the run.

The original production benchmark is **Pagoda v1** (`pagoda-v1`): build a
Japanese voxel pagoda garden in Three.js using instancing, interactive controls, particles and
HUD readouts.

The second production suite is **Agent Endurance V3** (`agent-endurance-v3`), a long-running,
standard-library-only Python warehouse-system task with hidden deterministic verification.

**Agent Endurance V4** (`agent-endurance-v4`) is the contract-clarified successor. It preserves
the same workload and scoring weights, but explicitly requires `inventory()` to return available
stock as an integer and every `lines`/`quantities` payload to be a `{sku: qty}` mapping. V3 remains
available unchanged for historical comparisons; V3 and V4 results must not be mixed.

## Agent Endurance V3

**Purpose.** Evaluate long-running coding-agent reliability, software-engineering
capability, tool-call stability, error recovery and autonomous task completion. It works with
any currently selected Pi model/provider (local Strata models or cloud models). Nothing in the
suite hardcodes a model name, and the current model, provider, thinking level and inference
settings are preserved unless advanced flags explicitly override them.

### Select and run

```text
/benchmark                       → choose "Agent Endurance V3" in the wizard
/benchmark agent-endurance-v3    → fast path with the current model/thinking
/benchmark agent-endurance-v3 3  → three runs
/artifact-bench agent-endurance-v3 [--runs N] [--model provider/id] [--thinking level]
                                 [--timeout seconds] [--resume <runId>]
node src/cli.ts agent-endurance-v3 --model provider/id [--runs N]   # headless CLI
node src/cli.ts agent-endurance-v4 --model provider/id [--runs N]   # clarified contract
```

Default wall-clock budget for this suite is **3 hours** (`timeoutSeconds: 10800` in the suite
definition) because a 12-phase build needs far more time than a single-file artifact task; keep
it identical for every model you compare.

### The standardized workload

The prompt in `src/assets/agent-endurance-v3.prompt.txt` is immutable inside a benchmark
version; every model receives the same bytes (`promptHash` proves it). The agent must build a
Python **Mini Warehouse Management System** using only the standard library, in 12 phases:
architecture plan, multi-warehouse inventory, atomic reservations, transfers + partial
receiving, purchase orders + supplier receiving, returns/refunds/duplicate prevention, atomic
JSON persistence with integrity checksum, reporting + sales analytics, complete argparse CLI,
≥ 120 unit tests, refactoring + regression run, ≥ 10 end-to-end scenarios. Objective phase
evidence comes from `PHASES.md` in the workspace (a bare phase header with no evidence counts as
missing).

### Independent evaluation (the agent's own tests are never sufficient)

`src/evaluators/agent-endurance-v3.py` (evaluator version `ae3-hidden-2`) lives **outside** every
evaluated workspace and is never copied into one; the evaluated agent never sees it. It spawns
`python` with a minimal environment (**PATH only** — no credentials or other secret env values)
and prints one deterministic JSON object. It verifies 20 behaviours, including: the public
contract, multi-warehouse stock, atomic reservation/transfer rollback, "invalid lines rejected
without mutation", transfer and purchase-order receiving bounds, shipping that consumes reserved
stock exactly once, returns bounded by shipped quantities, duplicate-refund prevention, refunds
restocking once, persistence round-trips that preserve reservations, two tamper vectors
(wrong checksum, changed data with the original checksum), atomic replacement with no leftover
temporary files, cross-process CLI JSON output, non-zero CLI failure exits, and CLI state that
survives separate processes. Line payload shapes — `{sku: qty}` maps versus `[{sku, qty}]` lists —
are both accepted and remembered, so an equivalent-but-differently-shaped payload is never scored
as a failure.
`test/fixtures/warehouse-ref` (a reference implementation) must pass 20/20, and
`test/fixtures/warehouse-broken` must fail — proving the evaluator detects incorrect software.

### Scoring (three axes, never merged into one number)

| Axis | Formula / rule |
|---|---|
| **Engineering** | `round(100 * (0.8 * hiddenTestRatio + 0.2 * phaseCompletion/12))` — weights unchanged from the first V3 release so history stays comparable. Breakdown ratios: `hiddenTests`, `featureCoverage`, `integration` (cli/integration/reports categories), `integrity` (transactions/persistence/orders/transfers/purchasing/returns). |
| **Reliability** | `max(0, 100 − 25·prematureStops − 20·manualContinuations − 3·toolFailures − 4·unrecoveredFailures − 5·boundaryViolations − 25·resumed)`. `UNKNOWN` when manual continuations cannot be observed. |
| **Autonomous** | `PASS` only when the hidden evaluator says complete **and** premature stops = 0 **and** manual continuations = 0 **and** no harness interruption **and** no boundary violations **and** not resumed. Otherwise `FAIL`, or `UNKNOWN` when continuations are unobservable. |
| **Efficiency** | Raw, deliberately unscored: wall time, cumulative output/input tokens, active context peak, tool calls, assistant turns. More tool calls or more self-written tests earn nothing. |

A run that needed a manual continuation cannot score a perfect autonomous reliability result, and a
resumed run is always flagged `resumed: true` and can never be an autonomous `PASS` (the result
card prints `DIAGNOSTIC (continues <runId>)` and the history table shows `resumed yes`). Result
records carry `evaluatorVersion` and `evaluatorSha256`, so runs scored by different hidden-test
sets are visibly distinguishable.

### Workspace isolation

Every run gets a uniquely named directory: `<benchRoot>/<benchmark>/<timestamp>/<model-slug>/run-NN/`
with its own `workspace/`, `session/` and `prompt.txt`. Runs never reuse, overwrite or delete another
run (a resumed run additionally gets a `run-NN-resumed-<id>` directory and a copy of the source
workspace). `PI_BENCHMARK_WORKSPACE_ROOT` moves agent workspaces out of the results tree, e.g.
`C:\AI\Scratch\pi-agent-benchmarks` (the workspace path is always recorded in `run.json`). The
benchmark session loads no extensions, skills, prompt templates, themes or context files, so Pi
config, Strata config and installed extensions are never loaded inside the run. The transcript is
scanned for tool calls that referenced paths outside the workspace or protected locations
(`.pi/`, `auth.json`, `models.json`, `AppData`, `Program Files`, other benchmark runs); the count
is reported as `Workspace boundary hits`, with samples — it is an objective audit, not a sandbox.

### Resume (diagnostic only)

`--resume <runId>` (interactive `/artifact-bench` or CLI) continues an existing
agent-endurance-v3 run: the source workspace is copied and its transcript is forked into a new
session in a new run directory. A separately versioned continuation prompt
(`agent-endurance-v3.continuation-v1`) is recorded instead of the canonical prompt, the run is
flagged `resumed: true`, and it can never be an autonomous PASS. Resumed runs are never eligible
for the IQ3-vs-IQ4 leaderboard comparison.

### Reports

`/artifact-bench show <id>`, `/artifact-bench history agent-endurance-v3` and the post-run cards
print: run id, benchmark version, model/provider, thinking level, configuration snapshot
(provider, model, thinking, context window, max output, timeout, inherited provider count — never
credentials or env values), engineering score and breakdown, autonomous verdict, reliability score
and its deduction breakdown, raw efficiency metrics, per-phase evidence, independent-evaluator
results (hidden-test counts, evaluator version + hash, individual failures), the failure/recovery
timeline, boundary samples, artifact/session/run-directory paths, and the resumed marker.

### What the metrics mean (and what is UNKNOWN)

| Metric | Source | Meaning |
|---|---|---|
| tool calls, tool failures, recovered failures | live pi events + persisted transcript | counted from Pi's own records, never from the model's summary |
| invalid tool arguments | transcript `argumentsError` + validation-shaped tool errors | structurally invalid tool payloads; `UNKNOWN` when neither source is available |
| malformed tool calls | transcript text scan | tool-call markup emitted as assistant text (chat-template failures) |
| premature stops | classification over assistant `stopReason` counts | the final `stop` is the normal loop terminator; only additional earlier stops count |
| failed completion claim | final `stop` plus independent evaluation | the agent ended normally but the produced artifact did not complete the contract; distinct from interruption or malformed calls |
| manual continuations | extra user messages after the single benchmark prompt | measured when the transcript exists, otherwise `UNKNOWN` (never assumed zero) |
| retries | `auto_retry_start/end` events | harness-side automatic retries |
| compactions | `compaction_start/end` events + transcript `compaction` entries | context compactions |
| active context peak | max single-turn `input + cacheRead + cacheWrite` | the largest single-turn context; **not** a sum |
| cumulative tokens | sum of per-turn usage | cumulative usage, kept separate from active context |
| wall time | runner lifecycle | prompt start → agent loop end |
| boundary violations | transcript tool-argument audit | tool calls touching paths outside the workspace |

### Limitations

- Pi is not OS-sandboxed: the boundary audit detects out-of-workspace tool arguments after the
  fact; it cannot prevent them. Prompt-level isolation is the only preventive measure.
- Manual continuation cannot be injected into a non-interactive benchmark session by a user, so
  normally it measures 0 from the transcript; hosts that cannot produce a transcript report
  `UNKNOWN` rather than 0.
- Active context peak is derived from provider-reported usage; providers that omit usage data make
  it `UNKNOWN`. Cumulative token totals inherit the same accuracy marking as Pagoda (Strata native,
  mixed, or estimated).
- Historical runs keep their original measurements; they are compared through
  `benchmarkVersion`, `promptHash` and `evaluatorVersion`/`evaluatorSha256`. Runs recorded with the
  earlier hidden-test set (`ae3-hidden-1`) are visibly not comparable with `ae3-hidden-2` runs.
- Self-written unit-test counts are never scored (120 tests is a phase-evidence requirement, not a
  quality signal), and tool-call volume is reported raw.

## Install

The extension is registered as a pi package:

```json
{
  "packages": ["git:github.com/Ayshinko/pi-benchmark"]
}
```

Browser validation uses `puppeteer-core` and your installed Chrome/Edge (no bundled Chromium).
Set `PI_BENCH_BROWSER` or `CHROME_PATH` to point at a specific browser binary if auto-detection
fails.

## Quick start

1. Select the model you want to test in Pi.
2. Type:

```
/benchmark
```

3. Choose the number of runs (1, 3, 5, or Custom).
4. Confirm the plan and the Strata-exclusive-use warning (for native TPS).
5. Wait for the result card.

`/benchmark` runs **Pagoda v1** with your **current model and thinking level** — it never changes
them silently, and it never requires you to remember any flags.

## Fast path

```
/benchmark 3
```

Runs Pagoda v1 with the current model and thinking level for **3** runs (any integer ≥ 1).

## Advanced mode

Normal users never need these, but `--advanced` exposes every knob:

```
/benchmark --advanced
```

which can configure the benchmark suite, runs, model, thinking, timeout, browser validation and
settle time.

### Standardized timeout

The benchmark uses a **20-minute (1200 second)** wall-clock timeout by default for ALL
models, in every flow (`/benchmark`, `/benchmark N`, the advanced interface, and legacy
`/artifact-bench pagoda`). Do not vary the timeout per model. An advanced user may still
override it with an explicit `--timeout` value or by editing the advanced-mode field.

Agent Endurance V3 ships its own suite-level default of **10800 s** (three hours), applied
consistently to every model. Do not vary the endurance timeout per model.

## Legacy / advanced interface

`/artifact-bench` remains available and fully functional for compatibility:

```
/artifact-bench pagoda [--runs N] [--model provider/id] [--thinking level]
                       [--timeout seconds] [--no-browser] [--fake]
/artifact-bench agent-endurance-v3 [--runs N] [--model provider/id] [--thinking level]
                                   [--timeout seconds] [--resume <runId>]
/artifact-bench history [benchmark] [--limit N]
/artifact-bench compare <runId> <runId>
/artifact-bench show <runId>
/artifact-bench help
```

It is an advanced/legacy interface; new users should start with `/benchmark`.

## Canonical Pagoda v1

There is ONE production prompt source: the immutable, versioned asset

```
src/assets/pagoda-v1.prompt.txt
```

Both `/benchmark` and `/artifact-bench pagoda` resolve to this exact `pagoda-v1` prompt. The
expected artifact is **`index.html`**.

Every run persists, in its run directory, the exact prompt that was sent and its hash:

```
run.json          full result, incl. benchmarkVersion: "pagoda-v1", promptHash, compliance
prompt.txt        exact bytes sent to session.prompt()
```

`promptHash` is SHA-256 over the exact UTF-8 bytes sent to `session.prompt()`. The current
canonical hash is `e8441237…` (computed from the asset file).

## Result states (separated gates)

A run is split into five gates: **Agent**, **Compliance**, **Runtime**, **Visual**, and **Overall**.

**Overall PASS requires Agent PASS AND Compliance PASS AND Runtime PASS AND Visual PASS.**

| State | Meaning |
|---|---|
| `PASS` | every gate passes |
| `FAIL_AGENT` | agent errored / aborted / timed out before finishing |
| `FAIL_LENGTH` | a turn hit the output length limit |
| `FAIL_RUNTIME` | artifact exists but failed static checks or crashed in the browser |
| `FAIL_VISUAL` | artifact ran but the render is blank/black/white/flat |
| `FAIL_MISSING_ARTIFACT` | no HTML was written |
| `FAIL_TIMEOUT` | wall-clock budget exceeded |
| `FAIL_COMPLIANCE` | ran fine but the artifact does not meaningfully implement the contract |
| `REVIEW` | ran fine but compliance could not be confirmed confidently |
| `ERROR_HARNESS` | the harness itself failed (no browser, session error) |

Legacy results stored before compliance was introduced render with `Compliance: n/a (legacy result)`
and are never rewritten.

## Compliance validation

A browser-rendering WebGL page is **not** enough to pass. Compliance checks the artifact
meaningfully implements the pagoda-v1 contract: Three.js, **InstancedMesh**, a multi-level
pagoda, interactive controls, floating particles, falling petals, HUD (fps + voxel count),
atmospheric lighting, shadows, fog, and the garden asset set (torii, blossom trees, pond, bridge,
rocks, grass, flowers, shrubs, lanterns, paths).

Detection combines conservative **static source inspection** with **runtime DOM / Three.js
facts** gathered in the browser, each feature via several patterns to avoid false FAILs from
naming differences. Items are reported **PASS / FAIL / UNKNOWN** — UNKNOWN when compliance cannot
decide, never a fabricated verdict.

Policy:

- **Critical** (core structure + anti-triviality): a confident FAIL on any fails overall.
- **Non-critical** (garden assets & atmosphere): several confident FAILs together fail overall;
  a few uncertain/unknown detections trigger **REVIEW** instead of PASS.
- A tiny 6 KB toy demo cannot earn full compliance: byte size, instancing, and the number of
  detected systems feed an anti-triviality sanity check (size alone never decides).

## Live status

While a run streams, a concise status line is shown via the normal status bar and cleared when
finished (the Pi footer is never permanently modified). Strata-backed runs show native Live,
Mean and PP values alongside whole-task Task Avg. Before any real benchmark the user must confirm:
"For accurate Strata-native TPS, do not run other Pi sessions or other Strata inference clients
during this benchmark. This benchmark does not technically lock the server. Continue?"

```
Pagoda v1 · Run 1/3: elapsed 3m21s | out 8.2k | taskAvg 49.2 tok/s | live 51.1 tok/s | turns 2 | tools 2 | state generating
```

## What is measured

| Metric | Definition |
|---|---|
| wall time | prompt start → agent loop end, including tool execution |
| generation time | sum of assistant decode durations only |
| output tokens | Strata `requests[].output_tokens` when matched; otherwise provider usage or marked estimate |
| **weighted TPS** | sum of per-request output tokens / sum of those requests' decode seconds (whole-task) |
| wall TPS | output tokens / wall time |
| tool calls | tool executions, plus error count |
| TPS source / accuracy | Strata native (exclusive-use assumption), mixed, or provider/streaming fallback |
| stop reasons | every assistant turn's stop reason |
| artifact | discovered HTML, static checks (canvas, THREE, script, closed HTML, size) |
| browser | headless Chrome: canvas, WebGL, `window.THREE`, scene facts, page/console errors |
| visual | screenshot luminance stats, colour count, saturation |
| compliance | per-feature PASS/FAIL/UNKNOWN plus overall gate |

## Result card

After every run a report is sent directly into the conversation (no need to open JSON/session
files). For multiple runs a concise aggregate card follows (mean/median TPS & wall, pass rate,
per-run rows). Unavailable data shows `n/a`, never a literal `undefined`.

## Storage

`PI_BENCHMARK_DIR` overrides the write root; `PI_BENCHMARK_WORKSPACE_ROOT` moves agent workspaces
out of the results tree; `PI_BENCHMARK_HISTORY_ROOTS` adds extra read-only roots (older runs stay
discoverable after a storage-location change; entries are deduplicated by run id).

```
~/.pi/benchmarks/index.jsonl                       one full RunResult per line
~/.pi/benchmarks/<benchmark>/<timestamp>/<model>/run-NN/
    run.json          full result (incl. promptHash, endurance scores, compliance)
    prompt.txt        exact canonical prompt sent
    workspace/        the artifact the agent wrote
    session/          the isolated session transcript
    screenshot.png    browser validation screenshot (pagoda only)
```

When `PI_CODING_AGENT_DIR` is set and a `<state>/benchmarks/index.jsonl` already exists, that tree
becomes the write root; the historical `~/.pi/benchmarks` root is always read as well.

## Isolation

Each run creates a fresh `SessionManager` in an empty workspace and a `DefaultResourceLoader` with
`noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes` and `noContextFiles`. The benchmark
extension never loads itself recursively inside the nested session, and no global model or session
state is touched. Provider configs (e.g. `strata-auto`) are inherited from the parent process and
re-registered so authentication works identically inside the isolated session.

## Tests

```
node test/harness.test.ts           # metrics, PNG analysis, outcome, artifact, browser fixtures
node test/auth-regression.test.ts   # local-provider auth inheritance & fallback
node test/metrics-incremental.test.ts # streaming estimates and reconciliation
node test/metrics-incremental.test.ts # streaming estimates and reconciliation
node test/native-metrics.test.ts        # Strata parsing, baselines, native replacement, fallback
node test/benchmark-ux.test.ts          # /benchmark UX, canonical prompt & hash, compliance, reports
node test/agent-endurance-v3.test.ts      # discovery, run isolation, scoring, persistence
node test/agent-endurance-v3-integration.test.ts # transcript parsing, evaluator, history roots
```

```
npm test   # runs all of the above (no expensive model generations)
```

A fake/end-to-end fixture run is enough to test the whole pipeline without spending tokens, and
`npm test` includes the lightweight Agent Endurance V3 smoke coverage (fixture implementations and
mocked session events only — the full 12-phase endurance run is never started automatically):

```
node test/e2e-fake.ts
```
