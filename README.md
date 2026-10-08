# Pi Benchmark

A benchmark harness for **complete coding-agent tasks**: the agent gets one prompt, works in an
empty isolated workspace, must produce a runnable artifact, and the harness verifies that
artifact in a real browser and scores the run.

The first — and currently only — production benchmark is **Pagoda v1** (`pagoda-v1`): build a
Japanese voxel pagoda garden in Three.js using instancing, interactive controls, particles and
HUD readouts.

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

## Legacy / advanced interface

`/artifact-bench` remains available and fully functional for compatibility:

```
/artifact-bench pagoda [--runs N] [--model provider/id] [--thinking level]
                       [--timeout seconds] [--no-browser] [--fake]
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

```
~/.pi/benchmarks/index.jsonl                       one full RunResult per line
~/.pi/benchmarks/<benchmark>/<timestamp>/<model>/run-NN/
    run.json          full result (incl. promptHash, intelligence, compliance)
    prompt.txt        exact canonical prompt sent
    workspace/        the artifact the agent wrote
    session/          the isolated session transcript
    screenshot.png    browser validation screenshot
```

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
node test/native-metrics.test.ts     # Strata parsing, baselines, native replacement, fallback
node test/benchmark-ux.test.ts      # /benchmark UX, canonical prompt & hash, compliance, reports
```

```
npm test   # runs all of the above (no expensive model generations)
```

A fake/end-to-end fixture run is enough to test the whole pipeline without spending tokens:

```
node test/e2e-fake.ts
```