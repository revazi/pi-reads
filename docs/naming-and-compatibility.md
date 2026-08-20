# Pi Reads naming and compatibility

Status: accepted for Phase 0

Date: 2026-08-20

The repository is currently `revazi/irakli-reads` and is expected to become `revazi/pi-reads` in Phase 5. New public surfaces use their final names now so the repository rename does not force another API migration.

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

## Temporary legacy surfaces

The following stay available until the Phase 5 migration is complete:

- package name `irakli-reads`;
- README title “Irakli Reads”;
- `pnpm article:*` scripts;
- `skills/irakli-reads` and its wrapper;
- legacy `articles/`, `sources/`, and `pdfs/` working directories;
- current extraction user-agent string.

Phase 1 may turn legacy scripts into thin wrappers, but it must preserve their arguments and outputs. Phase 2 adds final Pi Reads package resources without removing the old skill. Deprecation warnings should be concise and must not alter generated article output.

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

## Phase 5 rename procedure

1. Ensure all new code and documentation already use stable names from this document.
2. Rename the GitHub repository from `irakli-reads` to `pi-reads`.
3. Change the package name and display metadata.
4. Remove or formally deprecate the old end-user skill after its compatibility window.
5. Update the extraction user-agent and Nix shell display name.
6. Update local `origin` to `https://github.com/revazi/pi-reads.git`.
7. Verify GitHub's old URL redirect and a fresh Pi Git-package installation.
8. Tag the first release intended for installation from the renamed repository.

The `upstream` remote may remain pointed at `IrakliJani/irakli-reads` to preserve fork provenance.

## Out of scope before Phase 5

Do not rename the GitHub repository, remove legacy commands, or rewrite historical commits during earlier phases. The compatibility layer allows feature development and migration to proceed incrementally.
