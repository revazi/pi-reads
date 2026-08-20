# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- One-time Kindle setup backed by macOS Keychain, Windows Credential Manager, or Linux Secret Service, with masked password entry and automatic credential loading.

### Changed

- Environment variables are now optional per-field overrides for CI/headless use rather than the default desktop credential workflow.
- `/reads` mode selection now explains archive, digest, and synthesis inline.

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
- Dry-run and confirmation-gated Kindle EPUB/PDF delivery using environment-held credentials.
- Non-secret Kindle preferences and environment-variable indirection in `/reads-config`.
- Deterministic extraction, fidelity, package, destination, and fake-SMTP tests.

### Security

- Reject unsafe library paths, symlink escapes, local/private asset requests, and silent destination overwrites.
- Keep copied content, generated artifacts, addresses, and credentials outside Git and package manifests.

### Compatibility

- Retain the original `article:*` print workflow and `skills/irakli-reads` compatibility entry point while the repository transitions to Pi Reads.

[Unreleased]: https://github.com/revazi/pi-reads/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/revazi/pi-reads/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/revazi/pi-reads/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/revazi/pi-reads/releases/tag/v0.1.0
