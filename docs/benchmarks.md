# Performance and token-efficiency benchmarks

Pi Reads includes a deterministic benchmark suite for comparing runtime, model-context volume, tool orchestration, and storage changes. It uses synthetic local fixtures and a fake Kindle mail transport. It never fetches live content or sends email.

## Run the suite

Run the CI-safe, non-browser baseline:

```sh
pnpm --silent benchmark
```

The silent command writes one JSON report to standard output without pnpm lifecycle banners. To save a report outside Git:

```sh
pnpm --silent benchmark --output /tmp/pi-reads-benchmark.json
```

The baseline covers:

- extension cold import and registration in an isolated Node.js process;
- direct archive-only `/reads` capture with no model handoff or model tool calls;
- a long-source digest workflow;
- a five-source synthesis workflow;
- library listing;
- EPUB export;
- Kindle EPUB preview and confirmed delivery through a fake transport.

PDF is represented as a skipped measurement in the default report. Install Playwright Chromium and opt into the browser benchmark with:

```sh
pnpm article:install-browser
pnpm --silent benchmark --browser
```

## Metrics

Every workflow records:

- wall time;
- the number of public `reads_*` tool operations represented by the workflow;
- source characters that would be exposed to the active model;
- artifact bytes and total library bytes written;
- Pi token usage when externally captured metrics are supplied.

Digest and synthesis prose is a deterministic fixture, not a model call, so token usage is `null` by default. Source characters remain a stable context-volume proxy. To attach token metrics from a separate model-driven run, provide a JSON object keyed by benchmark name:

```json
{
  "digest-long": {
    "inputTokens": 1200,
    "outputTokens": 240,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0,
    "totalTokens": 1440
  }
}
```

```sh
pnpm --silent benchmark --token-usage /tmp/pi-token-usage.json
```

The initial cold-registration budget is 500 ms on the benchmark environment. Registration includes importing the extension and registering its four tools and four commands, but excludes Node.js process startup. The report also records Node, operating-system, CPU, CI, package, commit, and browser-mode metadata. Its storage summary counts physical artifact paths and reports duplicate bytes by comparing their immutable hashes; delivery manifests that reference an existing prepared artifact do not count as another stored copy, while repeated rendering remains visible.

The deterministic test suite also creates 10,000 immutable article manifests, rebuilds `indexes/library.json`, and gates both indexed listing and metadata search at 500 ms each. Rebuilding is intentionally outside that latency budget because it is a recovery/migration path; normal listing, search, and slug allocation read the single derived index and constant-time catalog stamps instead of scanning manifests.

## Context-overhead baseline

Issue #16 measured the extension at baseline commit `4b7004b` and after the compact-contract changes using the same deterministic Markdown fixture. Estimates use `ceil(Unicode code points / 4)`; they are provider-neutral comparisons, not billed-token claims. Tool contracts serialize each tool's name, description, TypeBox parameters, prompt snippet, and prompt guidelines. Result measurements count model-visible text only; full paths and manifests remain available in structured `details`.

| Surface | Before | After | Change |
|---|---:|---:|---:|
| Four tool contracts | 1,697 | 1,021 | -39.8% |
| Persistent tool snippets/guidelines | 390 | 170 | -56.4% |
| Pi Reads skill | 1,565 | 924 | -41.0% |
| Generated `/reads` digest prompt | 194 | 109 | -43.8% |
| Successful `reads_ingest` text | 166 | 35 | -78.9% |
| Successful `reads_save_article` text | 96 | 16 | -83.3% |
| Successful local `reads_export` text | 105 | 56 | -46.7% |
| Bounded source outline | 235 | 235 | unchanged |

The outline intentionally remains unchanged because source identity/hash, stable locators, continuation state, byte accounting, and untrusted-data boundaries are operational or safety-critical. Contract tests cap schema, guidance, skill, workflow-prompt, and common-result sizes while asserting that archive immutability, source-as-data handling, citation grounding, Obsidian overwrite approval, Kindle send confirmation, and exact prepared-artifact reuse remain explicit.

## Optional performance gates

Benchmarks report measurements without failing on performance by default. A budget can fail the command only when `--gate` is explicitly supplied:

```sh
pnpm --silent benchmark --gate examples/benchmark-budgets.example.json
```

A gate file can set maximum values for `wallTimeMs`, `toolCalls`, `sourceCharactersExposedToModel`, `artifactBytesWritten`, and `totalBytesWritten`. Avoid committing machine-specific wall-time limits unless CI hardware and variance are understood.

CI explicitly runs `pnpm --silent benchmark --gate examples/benchmark-budgets.example.json` without `--browser` or credentials. Functional test failures still fail normally; performance metrics fail only because CI explicitly supplies that gate.
