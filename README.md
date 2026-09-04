# Pi Reads

[![Pi package](https://img.shields.io/badge/Pi-package-111.svg)](https://pi.dev/packages/pi-reads)
[![npm version](https://img.shields.io/npm/v/pi-reads.svg)](https://www.npmjs.com/package/pi-reads)
[![npm downloads](https://img.shields.io/npm/dm/pi-reads.svg)](https://www.npmjs.com/package/pi-reads)
[![CI](https://github.com/revazi/pi-reads/actions/workflows/ci.yml/badge.svg)](https://github.com/revazi/pi-reads/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Pi Reads turns web pages, pasted text, Markdown, and local files into a private reading library inside [Pi](https://github.com/earendil-works/pi). Keep a faithful copy, create a cited digest or synthesis, and export it to Markdown, HTML, PDF, EPUB, Obsidian, or Kindle.

## What it does

- **Faithful archive** — captures the source without AI rewriting, reuses exact duplicates, and links explicitly recaptured versions.
- **Digest** — creates a shorter, cited version.
- **Synthesis** — creates a new, cited article from source ideas.
- **Local library** — stores sources, articles, provenance, exports, and separate reading state under `~/Documents/pi-reads`, with offline search and deterministic queues.
- **Reading destinations** — exports to local files, Obsidian, and Kindle.
- **Safe delivery** — asks before overwriting Obsidian files or sending Kindle email.

Archive content and AI-authored content are always stored separately.

## Quick start

Requirements: Node.js 24+ and Pi.

```sh
pi install npm:pi-reads
```

In Pi, capture an article:

```text
/reads https://example.com/article
```

Choose a mode:

| Mode | Use it when you want… |
|---|---|
| `archive` | the source captured faithfully |
| `digest` | a shorter cited reading version |
| `synthesis` | a newly written cited article |

Digests use verified complete-source coverage. Focused syntheses may use targeted coverage, which records omitted sections and carries a non-comprehensive warning. Long sources are traversed through bounded continuation cursors rather than one unbounded model-context load. Before saving generated work, Pi Reads resolves citation locators, verifies quoted text against immutable sources, and reports bounded uncited-section diagnostics.

Then choose an output such as Markdown, PDF, EPUB, Obsidian, or Kindle.

For the first PDF export, install Chromium once:

```text
/reads-install-browser
```

Browse or privately search saved articles with:

```text
/reads-list
/reads-search <query>
```

Search uses a rebuildable local BM25-style lexical index—no model, embeddings, or remote search service. Run `/reads-rebuild-search` for an explicit rebuild; missing or corrupt indexes recover automatically.

Track progress without changing immutable articles:

```text
/reads-state <article-id> reading
/reads-queue
```

States are unread, reading, completed, or archived. Tool workflows can also set tags, rating, priority, and due/read-later dates with revision-conflict protection.

## Obsidian

Run `/reads-config`, choose **Obsidian destination**, and select your vault and inbox folders. Pi Reads writes a Markdown note, copies its images, preserves provenance, and asks before replacing a conflicting file. After exporting notes, `/reads-obsidian-graph` builds managed library/topic/status/queue views and adds source-note links to exported syntheses; source/archive note bytes stay unchanged.

You can also set the vault directly:

```text
/reads-config obsidian ~/Documents/MyVault
```

See [Obsidian integration](docs/obsidian.md).

## Kindle

Run `/reads-config`, choose **Kindle delivery**, then choose **System credential store — configure once**. The wizard saves your Kindle and SMTP credentials in macOS Keychain, Windows Credential Manager, or Linux Secret Service. The password is masked and credentials are not written to `pi-reads.json`.

A Kindle export starts as a dry run, showing the recipient and retaining an immutable EPUB or PDF without sending it. Ask Pi to send that prepared export when ready; Pi verifies and reuses the exact previewed bytes, displays the full recipient, and requires confirmation before email delivery.

For iCloud Mail settings and CI environment overrides, see [EPUB and Kindle delivery](docs/epub-and-kindle.md).

## Commands

| Command | Purpose |
|---|---|
| `/reads` | Capture an article and choose a mode and destination |
| `/reads-config` | Configure the library, Obsidian, or Kindle |
| `/reads-list` | Browse saved articles |
| `/reads-search <query>` | Search local metadata and archive/generated prose |
| `/reads-state <article-id> [status]` | Show or update reading status |
| `/reads-queue [status]` | List/filter the deterministic reading queue |
| `/reads-obsidian-graph [overwrite]` | Build managed Obsidian views and synthesis backlinks |
| `/reads-rebuild-search` | Rebuild the derived local search index |
| `/reads-install-browser` | Install Chromium for PDF export |

Pi Reads also provides the `reads_ingest`, `reads_save_article`, `reads_export`, and `reads_library` tools for agent-driven workflows. `reads_ingest` reports canonical-URL changes without writing; `recapture: true` requires explicit approval and creates linked immutable versions. `reads_library` supports byte-bounded source outlines, exact heading/paragraph range reads, and lexical excerpts so the model can retrieve only the evidence it needs.

## Library maintenance

Verify records, rebuild derived indexes, and create portable local backups with `pnpm library:maintain` from a checkout (or the installed `scripts/maintain-library.ts`). Restore only creates a **new** library directory and never merges or overwrites an existing one. Stop library writers first; credentials and destination settings are excluded.

See [verification, backup, and restore](docs/library-maintenance.md) for commands, limits, and migration steps.

## Privacy and safety

- Your library stays outside the installed package and is not uploaded by Pi Reads.
- Archived source prose is immutable and separate from generated prose.
- Generated articles retain source IDs, citations, model information, and timestamps.
- Mutable reading state is revisioned separately and never changes source or article manifests.
- Kindle credentials stay in the operating-system credential store; environment overrides are available for CI.
- Kindle sending and conflicting Obsidian overwrites require interactive confirmation.

See the [product contract](docs/product-contract.md) and [security policy](SECURITY.md) for details.

## Updating or removing

```sh
pi update npm:pi-reads
pi remove npm:pi-reads
```

Removing the package does not delete the external reading library.

## Development

```sh
pnpm install --frozen-lockfile
pnpm article:install-browser
pnpm release:check
pnpm benchmark
```

The original deterministic `article:*` print workflow remains supported. Contributor guidance is in [CONTRIBUTING.md](CONTRIBUTING.md), benchmark usage is in [docs/benchmarks.md](docs/benchmarks.md), and release instructions are in [docs/releasing.md](docs/releasing.md).

## Documentation

- [Library verification, backup, and restore](docs/library-maintenance.md)
- [Performance and token-efficiency benchmarks](docs/benchmarks.md)
- [EPUB and Kindle delivery](docs/epub-and-kindle.md)
- [Obsidian integration](docs/obsidian.md)
- [Product and storage contract](docs/product-contract.md)
- [Architecture](docs/architecture.md)
- [Versioned JSON schemas](schemas/README.md)
- [Changelog](CHANGELOG.md)

## Author and license

Created and maintained by [Revaz Zakalashvili](https://github.com/revazi).

Pi Reads grew out of [`IrakliJani/irakli-reads`](https://github.com/IrakliJani/irakli-reads), the article-to-print workflow created by my friend [Irakli Janiashvili](https://github.com/IrakliJani). I told Irakli I would turn the idea into a Pi package; this project is that extension of his original work.

Licensed under the [MIT License](LICENSE).
