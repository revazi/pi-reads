# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Archive-only `/reads` workflows now capture and export directly without invoking an active model; Obsidian overwrites and Kindle sends retain their interactive confirmation gates.
- URL capture now infers optional serif/sans-serif presentation from already captured inline or embedded CSS, defaulting safely to serif without launching Chromium or navigating twice.
- Pi Reads now lazy-loads library, renderer, EPUB, Obsidian, Kindle, SMTP, browser, syntax-highlighting, and credential-store modules only when the selected workflow needs them.
- Kindle dry runs now return an immutable prepared export ID and content hash; later confirmed sends can verify and reuse those exact bytes, while delivery manifests reference the prepared artifact instead of storing a duplicate.
- Library listing, metadata search, and slug allocation now use an atomic derived index that detects interrupted or stale updates and can rebuild solely from immutable source/article manifests.
- Pi export routing now delegates to focused local, Obsidian, and Kindle handlers, while destination configuration uses focused validators and separate TUI collection, normalization, and persistence steps.
- Captured sources now receive deterministic, versioned heading and paragraph indexes with stable IDs, exact UTF-8 byte ranges, hashes, hierarchy, and bounded character/token estimates; existing sources can rebuild indexes without rewriting archive prose.
- `reads_library` now supports byte-bounded source outlines, inclusive heading/paragraph locator reads, and exact lexical excerpts enclosed in explicit untrusted-source-data delimiters.
- Generated articles now persist verified `complete` or `targeted` source-coverage metadata. Complete digests require every indexed locator; targeted synthesis carries bounded missing-section diagnostics and a visible non-comprehensive warning. Outline and read continuation cursors support long sources without unbounded results.
- Persistent tool contracts, skill guidance, generated workflow prompts, and common success results now avoid duplicated prose while retaining archive, source-data, citation, overwrite, and Kindle confirmation rules; source retrieval suggests compact deterministic citation IDs.
- Generated saves now verify quoted text against immutable source ranges, resolve paragraph/heading/fragment locators through source indexes, fail closed on fabricated evidence, and persist bounded per-source/per-section citation grounding diagnostics including uncited article sections.
- Capture now reuses exact canonical/content duplicates, reports changed canonical content without persistence, and creates linked immutable source/archive records only for explicitly approved recapture.

### Security

- Article and image downloads now share a public-network URL policy that rejects credentials and private/non-routable IPv4 and IPv6 targets; article redirects are validated individually and HTML fetches enforce redirect, timeout, and 10 MiB response limits.

## [1.1.1] - 2026-08-20

### Changed

- Restored the npm downloads badge and simplified the public Kindle delivery wording.

## [1.1.0] - 2026-08-20

### Added

- One-time Kindle setup backed by macOS Keychain, Windows Credential Manager, or Linux Secret Service, with masked password entry and automatic credential loading.

### Changed

- Environment variables are now optional per-field overrides for CI/headless use rather than the default desktop credential workflow.
- `/reads` mode selection now explains archive, digest, and synthesis inline.
- The README now focuses on installation and common user workflows, with detailed behavior linked from the documentation.

## [1.0.1] - 2026-08-20

### Added

- Public npm distribution as [`pi-reads`](https://www.npmjs.com/package/pi-reads).
- Provenance-enabled GitHub Actions release workflow for future tagged npm releases.
- npm version/download badges and npm-first Pi installation instructions.

## [1.0.0] - 2026-08-20

### Changed

- Renamed the repository and Git package from `irakli-reads` to `pi-reads`.
- Updated package metadata, extraction user agent, Nix shell naming, documentation, and install instructions to the stable Pi Reads identity.
- Retained `article:*` commands and `skills/irakli-reads` as documented print-workflow compatibility surfaces.

## [0.1.0] - 2026-08-20

### Added

- Installable Pi package with `/reads`, `/reads-config`, `/reads-list`, and `/reads-install-browser` commands.
- Immutable URL, text, Markdown, and file capture with archive/digest/synthesis separation.
- Markdown, standalone HTML, print-fidelity PDF, and validated reflowable EPUB exports.
- Conflict-safe Obsidian notes and assets.
- Kindle EPUB/PDF delivery with dry runs, explicit confirmation, and environment-held credentials.
- Non-secret Kindle preferences and environment-variable indirection in `/reads-config`.
- Deterministic extraction, fidelity, package, destination, and fake-SMTP tests.

### Security

- Reject unsafe library paths, symlink escapes, local/private asset requests, and silent destination overwrites.
- Keep copied content, generated artifacts, addresses, and credentials outside Git and package manifests.

### Compatibility

- Retain the original `article:*` print workflow and `skills/irakli-reads` compatibility entry point while the repository transitions to Pi Reads.

[Unreleased]: https://github.com/revazi/pi-reads/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/revazi/pi-reads/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/revazi/pi-reads/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/revazi/pi-reads/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/revazi/pi-reads/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/revazi/pi-reads/releases/tag/v0.1.0
