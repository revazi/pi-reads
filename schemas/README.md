# Pi Reads schemas

The JSON Schemas in `v1/` are the machine-readable form of the Pi Reads product contract. They use JSON Schema draft 2020-12.

Canonical records:

- `source.schema.json` — immutable captured input and provenance
- `source-content-index.schema.json` — deterministic heading/paragraph locators derived from source Markdown
- `citation.schema.json` — a generated article's reference to a source
- `citation-diagnostics.schema.json` — bounded source-grounding and article-section citation diagnostics
- `article.schema.json` — an archive, digest, or synthesis reading document with optional backward-compatible coverage/diagnostic metadata
- `export.schema.json` — a rendered artifact and destination attempt
- `config.schema.json` — non-secret user configuration

`common.schema.json` contains shared hashes, timestamps, paths, and stored-file definitions.

All persisted records carry `schemaVersion: 1`. Implementations must validate data at read and write boundaries. A future incompatible format gets a new versioned schema directory and an explicit migration; existing records are never silently rewritten.

See [`../docs/product-contract.md`](../docs/product-contract.md) for semantic rules that cannot be expressed completely in JSON Schema.
