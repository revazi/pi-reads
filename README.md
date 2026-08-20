# Pi Reads

[![npm version](https://img.shields.io/npm/v/pi-reads.svg)](https://www.npmjs.com/package/pi-reads)
[![npm downloads](https://img.shields.io/npm/dm/pi-reads.svg)](https://www.npmjs.com/package/pi-reads)
[![CI](https://github.com/revazi/pi-reads/actions/workflows/ci.yml/badge.svg)](https://github.com/revazi/pi-reads/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Pi Reads is a [Pi](https://github.com/badlogic/pi-mono) package for turning web pages, pasted text, Markdown, and local files into a trustworthy reading library. It keeps faithful archives separate from AI-authored digests and syntheses, then exports them to Markdown, print HTML, PDF, EPUB, Obsidian, or Kindle.

The original deterministic printing workflow remains a first-class feature: source prose is preserved word-for-word, rendered with Astro and Shiki, verified by visible-text hash, and printed to PDF with Playwright.

## Motivation and origin

Pi Reads grew out of [`IrakliJani/irakli-reads`](https://github.com/IrakliJani/irakli-reads), the article-to-print workflow created by my friend [Irakli Janiashvili](https://github.com/IrakliJani). I told Irakli I would turn the idea into a Pi package; this project is that extension of his original work.

The goal is not merely to save links. It is to keep a faithful, locally owned source archive while making it easy to create clearly labeled, cited reading material and send it to the tools and devices where reading actually happens.

## Core guarantees

- **Faithful archives:** deterministic cleanup only; no model rewriting.
- **Separated authorship:** `archive`, `digest`, and `synthesis` records use separate immutable paths.
- **Provenance:** generated articles retain source IDs, citations, model, and generation time.
- **Local ownership:** the default library is `~/Documents/pi-reads`, outside the package checkout.
- **Safe delivery:** Obsidian conflicts and Kindle email require explicit interactive confirmation.
- **No stored secrets:** SMTP credentials and Kindle/sender addresses remain environment values.
- **Verified print output:** archive exports must pass visible-text fidelity checks.

## Install the Pi package

Requirements:

- Node.js 24+
- Pi
- pnpm for local development and the compatibility print CLI

Install the published npm package:

```sh
pi install npm:pi-reads
```

A version-pinned Git install is also available:

```sh
pi install git:github.com/revazi/pi-reads@v1.0.1
```

Or load a local checkout:

```sh
pi -e .
```

Install Chromium before the first PDF export:

```text
/reads-install-browser
```

## Use Pi Reads

Pi Reads provides four tools and four commands:

| Surface | Purpose |
|---|---|
| `/reads` | Capture or generate an article and choose an output |
| `/reads-config` | Configure the library, Obsidian, and safe Kindle preferences |
| `/reads-list` | Browse recent stored articles |
| `/reads-install-browser` | Install Chromium for PDF rendering |
| `reads_ingest` | Capture URL, text, Markdown, or a local file |
| `reads_save_article` | Save a cited digest or synthesis with active-model provenance |
| `reads_export` | Export locally or deliver to Obsidian/Kindle |
| `reads_library` | List and inspect source/article metadata |

A typical interactive flow starts with:

```text
/reads https://example.com/article
```

Choose one of:

- `archive` for a faithful captured copy;
- `digest` for a cited condensed version;
- `synthesis` for a cited article built from one or more sources.

Local exports support Markdown, standalone light-print HTML, PDF, and validated reflowable EPUB.

## Configure destinations

Run the interactive configuration command:

```text
/reads-config
```

Configuration is stored at `~/.config/pi-reads/pi-reads.json` by default. A complete secret-free example is available at [`examples/pi-reads.example.json`](examples/pi-reads.example.json).

### Obsidian

Set a vault interactively or use:

```text
/reads-config obsidian ~/Documents/MyVault
```

Pi Reads copies/downloads article images, rewrites relative links, preserves provenance in frontmatter, and refuses to overwrite differing notes or assets without confirmation. See [Obsidian integration](docs/obsidian.md).

### Kindle

The wizard stores only safe preferences and environment-variable names. Addresses, SMTP usernames, and passwords never belong in `pi-reads.json`. Kindle export defaults to a dry-run that retains the local EPUB/PDF and shows a redacted recipient. Sending is disabled in headless sessions and requires a full-recipient confirmation in interactive use.

See [EPUB and Kindle delivery](docs/epub-and-kindle.md) for setup and environment variables.

## Deterministic article printing

The original print pipeline remains available through the `article:*` commands.

Install dependencies and Chromium:

```sh
pnpm install --frozen-lockfile
pnpm article:install-browser
```

Fetch, verify, and print one article:

```sh
pnpm article:read '<article-url>' --slug '<slug>'
```

This pipeline:

```text
URL
  → Readability extraction
  → deterministic cleanup and clean links
  → source serif/sans-serif detection
  → faithful Markdown archive
  → Astro + Shiki github-light print HTML
  → visible-text hash verification
  → Playwright PDF
```

The output is written to:

```text
articles/<slug>.md
dist/read/<slug>/index.html
pdfs/<slug>.pdf
```

Useful deterministic presentation options:

```sh
pnpm article:read '<article-url>' --slug '<slug>' --smaller-body-font
pnpm article:read '<article-url>' --slug '<slug>' --image-scale 80
```

The options are recorded in article frontmatter and do not alter source prose. The compatibility skill wrapper remains available:

```sh
node skills/irakli-reads/scripts/print-article.ts '<article-url>' --slug '<slug>'
```

Individual print steps:

```sh
pnpm article:fetch '<article-url>' --slug '<slug>' --save-html 'sources/<slug>.html'
pnpm article:render       # Astro build + fidelity verification
pnpm article:pdf -- '<slug>'
pnpm article:verify
```

Printed links use `label {clean-url}`, body text is black on white, syntax highlighting uses Shiki `github-light`, and the source page's serif/sans-serif category is mapped to controlled local print stacks.

## Data and repository hygiene

Captured content and generated artifacts belong in the external Pi Reads library. The legacy `articles/`, `sources/`, `dist/`, and `pdfs/` paths are local compatibility outputs and are ignored by Git. Never commit copied prose, raw source captures, credentials, local configuration, PDFs, or EPUBs.

If archive verification fails, fix deterministic extraction or rendering. Do not edit source prose to make the hash pass.

## Development and release checks

```sh
pnpm article:check
pnpm test
pnpm build
pnpm release:check
```

`pnpm release:check` also runs the real fixture-based Astro/fidelity/PDF pipeline, validates EPUB structure, audits package contents, smoke-loads the Pi extension, and checks production dependencies. See [Contributing](CONTRIBUTING.md), [Security](SECURITY.md), and [Release process](docs/releasing.md).

## Documentation

- [Product and storage contract](docs/product-contract.md)
- [Architecture](docs/architecture.md)
- [Naming and compatibility](docs/naming-and-compatibility.md)
- [Obsidian integration](docs/obsidian.md)
- [EPUB and Kindle delivery](docs/epub-and-kindle.md)
- [Versioned JSON Schemas](schemas/README.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE). Copyright belongs to the contributors named in the license and Git history.
