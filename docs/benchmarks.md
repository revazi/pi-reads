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

The initial cold-registration budget is 500 ms on the benchmark environment. Registration includes importing the extension and registering its four tools and four commands, but excludes Node.js process startup. The report also records Node, operating-system, CPU, CI, package, commit, and browser-mode metadata. Its storage summary reports duplicate artifact bytes by comparing immutable export hashes; this makes repeated Kindle preparation or delivery visible.

## Optional performance gates

Benchmarks report measurements without failing on performance by default. A budget can fail the command only when `--gate` is explicitly supplied:

```sh
pnpm --silent benchmark --gate examples/benchmark-budgets.example.json
```

A gate file can set maximum values for `wallTimeMs`, `toolCalls`, `sourceCharactersExposedToModel`, `artifactBytesWritten`, and `totalBytesWritten`. Avoid committing machine-specific wall-time limits unless CI hardware and variance are understood.

CI explicitly runs `pnpm --silent benchmark --gate examples/benchmark-budgets.example.json` without `--browser` or credentials. Functional test failures still fail normally; performance metrics fail only because CI explicitly supplies that gate.
