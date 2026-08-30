# Contributing

Thanks for helping improve Pi Reads.

## Development

Use Node.js 24+ and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm article:install-browser
pnpm release:check
pnpm benchmark
```

Keep CLI scripts thin, reusable behavior importable, and TypeScript strict. Tests should use local deterministic fixtures rather than live network requests. See [docs/benchmarks.md](docs/benchmarks.md) before changing performance or model-context behavior; metric gates must remain explicitly opt-in.

## Product boundaries

- Archive prose is source evidence: never rewrite or overwrite it.
- Digests and syntheses are generated content and must retain provenance and citations.
- Do not commit article bodies, source HTML, PDFs, EPUBs, credentials, Kindle addresses, or local configuration.
- Do not silently overwrite immutable records or conflicting destination files.
- External delivery must require explicit confirmation.
- Preserve the Astro/Shiki light print design and visible-text fidelity verification.

## Pull requests

Keep changes focused and explain the user-visible behavior. Include relevant tests and list the checks you ran. For security issues, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
