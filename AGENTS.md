# pi-benchmark — project memory pointer

- Durable facts for this repo are in `C:\AI\State\Pi\agent\MEMORY.md` (Pi benchmark suite section).
- Never change the endurance scoring weights or the 12-phase prompt text without bumping the
  benchmark version and the hidden evaluator version, or IQ3_S-vs-IQ4_XS-v31 history breaks.
- Storage roots: `~/.pi/benchmarks` (legacy, always read) and `<state>/benchmarks` (write root when
  its `index.jsonl` exists). Overrides: `PI_BENCHMARK_DIR`, `PI_BENCHMARK_HISTORY_ROOTS`,
  `PI_BENCHMARK_WORKSPACE_ROOT`.
- Hidden evaluator version `ae3-hidden-2` (`src/evaluators/agent-endurance-v3.py`); reference
  fixture `test/fixtures/warehouse-ref` must score 20/20; `warehouse-broken` must fail.
- `npm test` is the regression gate (no live model runs; fixture-based only).
