# Irakli Reads

Deterministic article-to-print pipeline:

```txt
URL
  -> Readability extracts article DOM
  -> deterministic cleanup cleans links/code/metadata
  -> Chromium detects whether the source body is serif or sans-serif
  -> Markdown is written without LLM rewriting
  -> Astro renders with the matching local font stack and Shiki GitHub Light
  -> fidelity verifier checks rendered text hash
  -> Playwright exports PDFs from the print HTML
```

Design goals:

- preserve article prose word-for-word; do not rewrite with an LLM
- black-on-white article body
- preserve the source article's serif/sans-serif body category using controlled print font stacks
- light syntax highlighting with Shiki `github-light`
- links print as `label {clean-url}`
- descriptions prefer page metadata and are omitted when they repeat the opening prose or contain only a byline
- redundant linked bylines and internal-link table-of-contents blocks are removed from the article body
- referral/tracking params are stripped before rendering
- TypeScript-only scripts, run directly on Node 24's native type stripping; TypeScript 7 is used for checking

## Project direction

This repository is evolving into **Pi Reads**: a Pi package for faithful source capture, cited AI-authored reading articles, Obsidian export, and Kindle delivery. Archive content remains separate from generated digest and synthesis content.

- [Product and storage contract](docs/product-contract.md)
- [Architecture](docs/architecture.md)
- [Naming and compatibility](docs/naming-and-compatibility.md)
- [Versioned JSON Schemas](schemas/README.md)

The existing `article:*` commands remain the supported archive-to-print workflow while the roadmap is implemented incrementally.

## Pi package MVP

Install the current Git package:

```sh
pi install git:github.com/revazi/irakli-reads
```

For local development, load this checkout directly:

```sh
pi -e .
```

Pi Reads adds:

- `/reads` — capture a URL/file or paste text, choose archive/digest/synthesis, and export
- `/reads-config` — configure the library directory (default `~/Documents/pi-reads`)
- `/reads-list` — browse stored articles
- `/reads-install-browser` — install Chromium for PDF exports
- `reads_ingest`, `reads_save_article`, `reads_export`, and `reads_library` tools

Captured sources and faithful archives are immutable. Digests and syntheses are stored separately with source IDs, citations, and active Pi model provenance. Local exports support Markdown, standalone light-print HTML, and PDF.

## Install

Requires Node.js 24+ and pnpm.

```sh
pnpm install
pnpm article:install-browser
```

## One-command article PDF

```sh
pnpm article:read '<article-url>' --slug '<slug>'
```

The skill-local wrapper does the same thing:

```sh
node skills/irakli-reads/scripts/print-article.ts '<article-url>' --slug '<slug>'
```

Both fetch the article, build Astro, verify fidelity, and write `pdfs/<slug>.pdf`. To reduce only the article prose from 11pt to 10pt, add the deterministic `--smaller-body-font` option:

```sh
pnpm article:read '<article-url>' --slug '<slug>' --smaller-body-font
```

The option records `bodyFontSizeAdjustment: -1` in article frontmatter; it is not enabled by default.

To cap images at a percentage of the article width without enlarging smaller images, use `--image-scale` with an integer from 1 to 100. For example:

```sh
pnpm article:read '<article-url>' --slug '<slug>' --image-scale 80
```

This records `imageScalePercent: 80` in article frontmatter. Font and image options can be combined.

## Fetch an article

```sh
pnpm article:fetch '<article-url>' \
  --slug '<slug>' \
  --save-html 'sources/<slug>.html'
```

This writes `articles/<slug>.md`.

## Build printable pages

```sh
pnpm article:render
```

That runs Astro build and the fidelity verifier. Open the printable page:

```sh
open 'dist/read/<slug>/index.html'
```

## Build PDFs

Generate PDFs for every fetched article:

```sh
pnpm article:pdf
```

PDFs are written to `pdfs/<slug>.pdf`. To generate selected articles only:

```sh
pnpm article:pdf -- '<slug-a>' '<slug-b>'
```

## Check TypeScript scripts

```sh
pnpm article:check
```

## Verify fidelity only

```sh
pnpm article:verify
```

The fetcher stores `sourceTextHash` in Markdown frontmatter. The verifier compares that hash with the rendered `.article-body` text from `dist/`. CSS-generated printed link URLs do not affect the hash.

## Local dev

```sh
pnpm dev
```

Then open `http://localhost:4321/read/<slug>/`.

## Generated files

Fetched article Markdown, raw HTML, rendered HTML, and PDFs are generated locally under `articles/`, `sources/`, `dist/`, and `pdfs/`. Article Markdown and PDFs are intentionally ignored so the repository does not publish copied article bodies or generated artifacts.

## Notes

- Markdown is an archive/editing format, not an excuse to paraphrase.
- If verification fails, fix extraction/rendering. Do not manually rewrite article prose unless the source page itself requires a deterministic correction.
- Font detection records `sourceFontStyle` in article frontmatter. It uses rendered source paragraphs when Chromium is available and falls back to the serif stack when detection is unavailable or inconclusive.
- PDF export uses Playwright/Chromium from the already-rendered print HTML.
