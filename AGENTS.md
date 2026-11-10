# pi-benchmark — project memory pointer

- Durable facts for this repo are in `C:\AI\State\Pi\agent\MEMORY.md` (Pi benchmark suite section).
- Pagoda v1 is the ONLY shipped suite. Never change the pagoda-v1 prompt text without bumping the
  benchmark version (promptHash history must stay verifiable).
- Agent Endurance V2–V5 were removed; their historical index entries are hidden by the
  `isRetiredBenchmark` filter in `src/store.ts` but never deleted from disk.
- Storage roots: `~/.pi/benchmarks` (legacy, always read) and `<state>/benchmarks` (write root when
  its `index.jsonl` exists). Overrides: `PI_BENCHMARK_DIR`, `PI_BENCHMARK_HISTORY_ROOTS`,
  `PI_BENCHMARK_WORKSPACE_ROOT`.
- `npm test` is the regression gate (no live model runs; fixture-based only).
