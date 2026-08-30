# Pi Reads architecture

Status: accepted for Phase 0

Date: 2026-08-20

This document defines the dependency boundaries for the roadmap. It does not claim that every component exists yet.

## Design goals

1. Preserve faithful source capture independently from AI generation.
2. Keep core behavior usable from CLI scripts, Pi, tests, and future applications.
3. Keep package installation files separate from user library data.
4. Make every external destination an explicit adapter with testable side effects.
5. Preserve deterministic Astro/Shiki print output and text-hash verification.

## Layers

```text
┌──────────────────────────────────────────────────────────────┐
│ Interfaces                                                   │
│ scripts/*       extensions/pi-reads/*       skills/pi-reads │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│ Application services                                         │
│ ingest source · create article · verify archive · export     │
└───────────────┬──────────────────────────────┬───────────────┘
                │                              │
┌───────────────▼────────────────┐  ┌──────────▼──────────────┐
│ Core domain                    │  │ Ports                   │
│ records · validation · hashes │  │ storage · render · send │
└────────────────────────────────┘  └──────────┬──────────────┘
                                               │
                                  ┌────────────▼──────────────┐
                                  │ Adapters                  │
                                  │ web · file · Astro/PDF    │
                                  │ Obsidian · EPUB · Kindle  │
                                  └───────────────────────────┘
```

Dependencies point downward. Core domain modules must not import Pi, Astro, Playwright, Obsidian, SMTP, or process-global configuration.

## Planned source layout

The roadmap may refine file names, but it must retain these boundaries:

```text
src/
  core/
    domain/             # schema-backed records and invariants
    hashing/            # exact-byte and normalized-text hashes
    validation/         # record and cross-record validation
  application/
    ingest/             # use cases over source adapters
    articles/           # archive/digest/synthesis persistence
    exports/            # render and delivery orchestration
  adapters/
    sources/            # URL, text, Markdown, and file input
    storage/            # filesystem library implementation
    render/             # Markdown, Astro HTML, PDF, and EPUB
    destinations/       # local, Obsidian, and Kindle
  layouts/              # existing Astro presentation
  pages/                # existing Astro routes
extensions/
  pi-reads/             # Pi tools and slash commands
skills/
  pi-reads/             # distributable end-user workflow
scripts/                # thin compatibility and CLI entry points
schemas/                # versioned persisted-record contracts
tests/
  fixtures/             # deterministic local inputs
```

## Core domain

The core owns:

- `Source`, `Article`, `Citation`, and `Export` semantics;
- mode and identifier rules;
- path-independent record validation;
- content and visible-text hashing;
- archive/generated separation;
- cross-record provenance checks.

The core receives clocks, ID generators, paths, and I/O through function arguments or ports. It does not read environment variables or infer the package root.

## Application services

Application services coordinate domain rules and ports. Expected use cases are:

- `ingestSource(input, options)`
- `createArchive(sourceId, options)`
- `saveGeneratedArticle(draft, generationContext)`
- `prepareExport(articleId, format)`
- `deliverExport(exportId, destination, confirmation)`
- `listLibrary(query)`

Names here describe responsibilities, not a frozen TypeScript API. Pi-facing tool names are frozen separately in the naming contract.

Application services must be abort-aware where adapters perform network, browser, filesystem, or delivery work.

## Ports and adapters

### Source adapters

A source adapter turns one external input into a capture candidate. It may fetch or read bytes, but it cannot persist a canonical record directly. The ingestion service validates, hashes, and writes the source. URL extraction performs one HTML fetch; optional serif/sans-serif presentation is inferred deterministically from inline or embedded CSS in those captured bytes and safely defaults to serif, without browser probing or a second navigation.

Phase ordering:

- Phase 1: URL, text, Markdown, file
- Phase 6: RSS, social threads, transcripts, and other sources

### Storage adapter

The filesystem adapter implements the layout in the product contract. It must:

- resolve all record paths beneath a configured library root;
- reject traversal and absolute record paths;
- write atomically and create-only;
- treat manifests as canonical and indexes as rebuildable;
- reject a Git working tree as a production library root by default.

### Render adapters

Renderers consume a validated article and resolved source/assets. They do not mutate source or article records.

- Markdown is the canonical readable body format.
- Astro HTML and PDF retain the existing light print behavior.
- EPUB is a separate reflowable renderer with validated ZIP/container/package/spine structure and embedded assets.

Archive rendering must run visible-text fidelity verification before an export is reported as prepared.

### Destination adapters

Destinations receive a prepared export; they do not generate article prose.

- Local destination retains the artifact in the library.
- Obsidian renders destination frontmatter, copies/downloads assets, rewrites relative links, and writes only conflict-approved targets in a configured vault.
- Kindle dry-runs retain a local EPUB/PDF; SMTP delivery sends that exact artifact only after explicit interactive confirmation.

Every external side effect returns delivery evidence suitable for a non-secret export manifest.

## Pi integration boundary

The Pi extension is an interface adapter over application services.

It owns:

- TypeBox tool argument schemas;
- `reads_*` tool registration;
- `/reads` and configuration commands;
- active Pi model/session provenance;
- TUI prompts and explicit delivery confirmation;
- compact, truncated tool results.

It must not own extraction, storage, rendering, or destination business logic. Headless Pi modes must be able to use tools without TUI-only APIs; interactive commands must guard UI calls with the documented Pi context capabilities.

The distributable skill explains when and how the agent should use these tools. It does not duplicate implementation in skill-local scripts.

## Main workflows

### Archive

```text
input
  → source adapter
  → deterministic extraction/cleanup
  → immutable Source
  → archive Article with matching text hash
  → render
  → fidelity verification
  → Export
```

No model-authored prose enters this path.

### Digest or synthesis

```text
one or more immutable Sources
  → Pi reads source content
  → model authors a cited draft
  → application validates source IDs and citation IDs
  → immutable generated Article
  → render
  → Export
```

The active Pi model is the generator. The extension does not silently invoke a second model.

### Delivery

```text
validated Article
  → prepared local Export
  → destination-specific preview
  → explicit confirmation when required
  → destination adapter
  → delivery status/evidence
```

A failed delivery never deletes the prepared local artifact.

## Configuration and secrets

Path resolution is defined in the product contract. Core services receive a resolved configuration object.

`pi-reads.json` may hold non-secret preferences, including SMTP host/port/TLS mode, a credential backend/profile, and the names of environment-variable overrides used for Kindle delivery. Interactive desktop setup writes protected credential entries to macOS Keychain, Windows Credential Manager, or Linux Secret Service. SMTP usernames/passwords, tokens, full Kindle/sender addresses, and other credentials are never copied into JSON configuration.

Logs, persisted records, and tool results must redact credential material and recipient addresses. The interactive Kindle confirmation may display the full recipient transiently, but it is not persisted.

## Error behavior

- Invalid or unsupported records fail closed with an actionable message.
- Existing immutable record paths produce a collision error, never overwrite.
- Partial writes are cleaned up or left only under a documented temporary name.
- Cancellation propagates to fetch, browser, rendering, and delivery adapters.
- Export or delivery failure does not mutate source/article records.
- A fidelity mismatch blocks archive export.

## Testing strategy

- Core: unit tests for invariants, hashing, validation, and path handling.
- Extraction: local HTML fixtures; no required live network.
- Storage: temporary-directory integration tests, including collisions and atomicity.
- Rendering: existing fidelity verifier plus fixture snapshots where stable.
- Pi extension: extension-load and tool-contract smoke tests.
- Obsidian: temporary fake vault with local/remote image fixtures, conflict handling, unrelated-file checks, and symlink escape rejection.
- Kindle: fake SMTP transport and mandatory confirmation tests.

Each phase adds only the tests needed for its layer. The baseline eventually remains:

```sh
pnpm article:check
pnpm test
pnpm build
```

## Explicitly deferred

Phase 0 does not implement:

- core modules or migrations;
- the Pi package manifest or extension;
- Obsidian writes;
- EPUB rendering;
- SMTP/Kindle delivery;
- RSS, social, or transcript adapters.

Those remain owned by their roadmap phases.
