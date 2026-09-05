# Library maintenance and portable backups

Maintenance is an **offline, local-only** workflow. Stop other Pi Reads sessions and library writers first. It never calls a model, fetches sources, opens a vault, renders documents, reads a credential store, or sends email.

From a checkout:

```sh
pnpm library:maintain verify --library "$HOME/Documents/pi-reads"
pnpm library:maintain rebuild --library "$HOME/Documents/pi-reads"
pnpm library:maintain backup --library "$HOME/Documents/pi-reads" --backup "$HOME/Backups/reads-2026-09-03"
pnpm library:maintain restore --backup "$HOME/Backups/reads-2026-09-03" --library "$HOME/Documents/pi-reads-restored"
```

The parent directories must already exist; backup and restore target directories **must not exist**, even if empty. Use distinct, non-nested paths outside Git. Paths and their ancestors must not be symbolic links; use the physical path on systems with symlinked temporary directories.

For an installed package, invoke `node /absolute/path/to/pi-reads/scripts/maintain-library.ts` with the same arguments. The script resolves schemas relative to its installation, not the working directory. These operations are CLI/API-only; there is no maintenance model tool or slash command.

`verify`, `rebuild`, and `backup` accept the normal library/config resolution rules, including `--config FILE`, `PI_READS_LIBRARY_DIR`, and `PI_READS_CONFIG`. CLI restore requires an explicit `--library NEW_DIRECTORY` and never switches the active configuration automatically.

## Verification

`verify` is read-only. It scans canonical files directly, rather than trusting or automatically repairing indexes. JSON output includes error/warning totals, record/file counts, at most **50 findings**, and a truncation flag. Finding paths are capped at 240 characters, control characters are removed, and findings contain recovery actions rather than source prose or raw parser errors.

Checks cover:

- Strict versioned source/article/export/state schemas, record identity and expected storage paths, duplicate IDs, missing manifests, and unsafe filesystem entries.
- Exact SHA-256 hashes and byte lengths for prose, raw captures, assets, and export artifacts; normalized visible-text hashes and cross-record archive fidelity.
- Source/article references and lineage cycles, inline citation/metadata agreement, exact quotes and source locators, persisted citation diagnostics, and coverage-summary consistency.
- State-to-article references and revisioned state validation.
- Local export references, including Kindle delivery manifests sharing a verified prepared artifact. Verification does not inspect the live Obsidian vault or re-send historical deliveries.
- Source structure indexes, the canonical records represented in the library catalog, and a freshly derived state-aware search index.

Canonical failures return a nonzero CLI exit status and block backup/rebuild. Missing or stale derived indexes are warnings with a rebuild action, not evidence that source prose is lost. Unreferenced files under scanned data directories are reported as excluded from backup; unrelated root files, such as `.env`, are not opened.

Historical generated articles without newer optional coverage/diagnostic metadata remain supported. Verification checks recorded evidence; it does not prove a model actually read a source, fact-check generated prose, or reconstruct omitted locator lists from truncated targeted coverage.

## Index rebuilding

`rebuild` verifies canonical records first and replaces only the derived catalog, every current source structure index, and the local full-text search index. Existing unsafe index symlinks fail closed. Article/source/export bytes and reading-state records remain unchanged. It does not modify managed Obsidian views; rebuild those explicitly through `/reads-obsidian-graph` after configuring the new machine.

Index writes use the existing atomic cache writers. An interrupted rebuild can be retried; it is not an all-index atomic transaction.

## Backup format and privacy

A backup is a self-contained directory, not an opaque compressed archive:

```text
reads-2026-09-03/
  snapshot.json
  library/
    sources/...
    articles/...
    exports/...
    state/articles/...
```

`snapshot.json` uses [`portable-snapshot.schema.json`](../schemas/v1/portable-snapshot.schema.json), format `pi-reads-portable-v1`, and an ordered inventory of library-relative paths, SHA-256 hashes, and byte lengths. Only verified canonical manifests, their referenced files, and validated persisted state enter that inventory. Raw captures and source/export assets are included by reference, not by recursively copying arbitrary adjacent files. Referenced export artifacts are included once even when multiple delivery manifests use them.

Portable config is an explicit allowlist: `schemaVersion` and default article mode/export format. **All** Kindle/SMTP configuration, credential profiles, environment-variable names/values, Obsidian configuration, machine paths, locks, derived caches, and unreferenced files are excluded. Configure destinations and credentials again on the new machine.

Backup and verification never change archived prose. Consequently, a backup still contains your private reading content and original provenance, including any local origin paths or sensitive text already captured in a source. It is **not encrypted, scrubbed, or cryptographically authenticated**. Store it privately; hashes detect corruption, not a malicious party rewriting both data and hashes. Protect it with your own encryption/access controls before moving it externally. No upload is performed here. Created directories/files use private POSIX modes (0700/0600); Windows access follows local ACLs.

The implementation rejects symbolic and hard links, traversal/absolute paths, non-portable names, case-folded path-prefix collisions, depth above 16, more than 50,000 files or 100,000 directory entries, individual files above 64 MiB, and tracked data above 256 MiB. JSON nesting is bounded and invalid UTF-8 is rejected. It is an in-memory verification workflow, not a streaming solution for arbitrarily large libraries.

Copy-time hashes, a second canonical inventory, and verification of the completed backup detect changes during backup. They do not replace the requirement to stop writers or provide an atomic live filesystem snapshot. Failed operations clean up only their newly reserved target; a process crash can leave an incomplete directory. Keep incomplete outputs out of use and retry with a new target.

## Restore and migration

Restore validates the snapshot schema, complete file inventory, hashes, canonical schemas, and cross-record invariants before reserving a new destination. Unexpected files, unresolved records, duplicate IDs, conflicting portable paths, or an existing destination fail closed. There is no merge, overwrite, renumbering, or automatic repair of canonical records.

It copies exact bytes, rechecks them, rebuilds derived indexes, and verifies the result. Original IDs, hashes, raw captures, archive/generated separation, provenance, citations, export evidence, and state revisions survive unchanged. Portable preferences are written to an **inert** `portable-config.json` in the restored library, never over the active `pi-reads.json`.

Inspect the restored library and then explicitly configure Pi Reads to use it. Retain the old library and backup until satisfied. Reconfigure Obsidian and Kindle separately; restoring historical delivery records neither authorizes nor performs new delivery.
