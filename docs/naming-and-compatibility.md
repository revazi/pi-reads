# Pi Reads naming and compatibility

Status: Phase 5 rename complete

Date: 2026-08-20

The repository and Git package are now `revazi/pi-reads`. GitHub redirects the former `revazi/irakli-reads` URL, while the upstream remote remains attached to Irakli Janiashvili's original repository for provenance.

## Stable names introduced by the roadmap

| Surface | Stable name |
|---|---|
| Product and package display name | Pi Reads |
| GitHub repository after Phase 5 | `revazi/pi-reads` |
| Configuration file | `pi-reads.json` |
| Environment prefix | `PI_READS_` |
| Default library directory | `~/Documents/pi-reads` |
| Primary Pi command | `/reads` |
| Pi tools | `reads_ingest`, `reads_save_article`, `reads_export`, `reads_library` |
| Pi extension directory | `extensions/pi-reads/` |
| Distributable skill | `skills/pi-reads/` with skill name `pi-reads` |
| Persisted schema IDs | `https://github.com/revazi/pi-reads/schemas/v1/...` |

Domain types remain unbranded: `Source`, `Article`, `Citation`, and `Export`.

The `reads_*` tool prefix is intentionally independent of npm scope and GitHub owner. Tool calls saved in Pi sessions remain valid after the repository rename.

## Retained compatibility surfaces

The stable package keeps these original print-workflow entry points:

- `pnpm article:*` scripts;
- `skills/irakli-reads` and its wrapper;
- legacy `articles/`, `sources/`, and `pdfs/` working directories.

Their arguments, deterministic output, Astro/Shiki light styling, and fidelity verification remain supported. Any future removal requires a documented release boundary and migration path; warnings must never alter generated article output.

## Compatibility policy

- Existing deterministic archive behavior is backward compatible by default.
- Existing Markdown frontmatter remains readable during migration.
- New manifests use schema version 1 and final Pi Reads naming.
- Persisted IDs and tool names are never derived from the repository name.
- A repository or package rename must not move or rewrite a user's library.
- Compatibility removal requires a documented release boundary and migration path.

## Legacy import mapping

| Legacy frontmatter | Version 1 destination |
|---|---|
| `title` | `Article.title` and, when captured, `Source.title` |
| `slug` | `Article.slug` |
| `source` | `Source.origin.canonicalUrl` |
| `author` | `Source.authors` / `Article.authors` |
| `date` | `Source.publishedAt` |
| `sourceTextHash` | `Source.content.textHash` and `Article.archiveVerification.sourceTextHash` |
| `sourceFontStyle` | `Article.presentation.sourceFontStyle` |
| `bodyFontSizeAdjustment` | `Article.presentation.bodyFontSizeAdjustment` |
| `imageScalePercent` | `Article.presentation.imageScalePercent` |

Import creates new immutable source and archive records. It does not edit, move, or delete the legacy Markdown file.

## Phase 5 rename outcome

- GitHub repository: `revazi/pi-reads`
- package name: `pi-reads`
- extraction user agent: `pi-reads/1.0`
- Nix shell: `pi-reads-dev-shell`
- local `origin`: `https://github.com/revazi/pi-reads.git`
- preserved upstream provenance: `https://github.com/IrakliJani/irakli-reads.git`
- stable install target: `git:github.com/revazi/pi-reads@v1.0.0`

The compatibility print workflow remains included and covered by the real Astro, fidelity, and Playwright PDF test.
