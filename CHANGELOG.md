# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/revazi/irakli-reads/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/revazi/irakli-reads/releases/tag/v0.1.0
