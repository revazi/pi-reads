# Pi Reads product contract

Status: accepted for schema version 1

Date: 2026-08-20

This document defines the Phase 0 domain and storage contract. The JSON Schemas under [`../schemas/v1/`](../schemas/v1/) are its machine-readable companion.

Normative terms such as **must**, **must not**, and **should** describe behavior that future phases need to preserve.

## Product boundary

Pi Reads captures source material, creates optional AI-authored reading documents, renders those documents, and delivers exports through adapters.

The product has four persistent domain records:

- **Source** — an immutable capture of a URL, pasted text, Markdown, or local file.
- **Article** — a reading document in `archive`, `digest`, or `synthesis` mode.
- **Citation** — a reference from generated prose to a captured source.
- **Export** — a reproducible artifact prepared for local, Obsidian, or Kindle delivery.

Source capture and AI-authored output are separate operations and separate files.

## Modes

| Mode | Meaning | Authorship | Source requirements |
|---|---|---|---|
| `archive` | Faithful readable representation after deterministic cleanup | Source author | Exactly one source; visible-text hash must match the source capture |
| `digest` | Condensed or reorganized reading version | AI-authored | One or more sources; generation metadata and citations are required |
| `synthesis` | New article combining multiple inputs | AI-authored | One or more sources; generation metadata and citations are required |

An `archive` article must never contain AI rewriting. Extraction fixes belong in deterministic extraction code and result in a new immutable source capture when source content changes.

A `digest` or `synthesis` article must never replace the source capture or an archive article. Generated prose must be labeled through the article mode and `generatedBy` metadata.

## Identifiers and immutability

Identifiers are opaque and prefixed by record type:

- `src_…` for sources
- `art_…` for articles
- `cite_…` for citations
- `exp_…` for exports

Slugs are presentation values and are not identifiers. Duplicate slugs are allowed across record IDs and must be disambiguated at export time without overwriting an existing artifact.

Completed source, article, and export records are immutable. A correction or regeneration creates a new ID. Articles may point to an earlier revision with `supersedesArticleId`.

Writers must use create-only, atomic writes:

1. prepare content in a temporary sibling path;
2. calculate and verify hashes;
3. fail if the final record path already exists;
4. atomically rename the temporary path into place.

## Hashes

Hashes use lowercase SHA-256 with a `sha256:` prefix.

- `contentHash` hashes the exact stored bytes.
- `textHash` hashes normalized visible text using the fidelity verifier's whitespace and block-boundary rules.

For an archive article:

- `article.archiveVerification.sourceId` must equal its only `sourceIds` entry;
- `article.archiveVerification.sourceTextHash` must equal the source's `content.textHash`;
- the article body's `textHash` must equal that same source text hash.

These cross-record rules are enforced by the application layer because JSON Schema cannot compare values in separate records.

## Source contract

A source records:

- input kind and original locator;
- canonical URL for URL input;
- capture time and adapter provenance;
- immutable readable Markdown;
- exact-byte and normalized-text hashes;
- optional raw capture and assets.

Raw HTML is evidence, not working prose. It must never be edited in place. Raw captures and copied article content are local library data and must not be committed to this repository.

Each source may have a deterministic `markdown-blocks-v1` structure index derived from `content.md`. The index records the source content/text hashes, UTF-8 byte length, stable content-derived heading and paragraph IDs, exact byte ranges, per-range hashes, heading ancestry, character counts, and approximate token counts. It contains no generated timestamp, so identical source bytes and manifests produce identical index bytes. The derived index may be verified or rebuilt atomically without modifying the source manifest, source prose, or archive article.

`reads_library` can expose that index as a bounded outline, read an inclusive heading/paragraph locator range, or search a single source lexically. Retrieval defaults to an 8 KiB result budget and accepts explicit 1–32 KiB budgets. Returned excerpts are exact source substrings, include the source ID and stable locators, and are enclosed in `PI_READS_SOURCE_DATA` records marked as untrusted data rather than instructions. Budget exhaustion omits whole records or clips an exact UTF-8-safe prefix and reports `nextLocator` or `nextByte` continuation cursors.

Local file paths may be retained in a local source manifest but must not be presented as public citations. URL citations use the source's canonical URL.

## Article contract

An article records:

- mode, title, slug, and source IDs;
- immutable Markdown body and hashes;
- citations;
- creation time;
- optional print presentation settings;
- either archive verification or AI generation metadata;
- verified source-coverage policy and per-source diagnostics for newly generated articles.

`archiveVerification` is mutually exclusive with `generatedBy` and `sourceCoverage`.

Generated articles record the active provider, model, generation time, and—when available—the Pi session ID and thinking level. Prompts and credentials are not persisted in the article manifest.

The existing presentation behavior maps into `article.presentation`:

- `sourceFontStyle`
- `bodyFontSizeAdjustment`
- `imageScalePercent`

## Citation contract

Generated Markdown references citation IDs using standard Markdown footnotes, for example `[^cite_example]`. Each referenced ID must have exactly one matching `Citation` in the article manifest.

Every citation must reference one of the article's `sourceIds`. A citation should include the most precise available locator and may include a short supporting quote. Bounded source reads and searches suggest compact deterministic citation IDs plus stable locator fragments; generated articles may use those suggestions instead of inventing verbose identifiers. Exporters resolve source metadata from the source manifest and render destination-appropriate footnotes or endnotes.

Generated articles choose one source-coverage policy. `complete` requires coverage evidence for every heading and paragraph locator in every source index and is required for `digest`. `targeted` records only selected sections, is limited to `synthesis`, and persists a warning that the result is not comprehensive. Coverage evidence is bound to each source content hash and index locator-set hash. Unknown, duplicate, stale, or incomplete evidence fails before article persistence. Targeted manifests retain missing-section counts and at most 20 stable missing locators plus a truncation flag. Coverage policy and warnings remain visible in generated exports; citations continue to point to original captured sources.

For `digest` and `synthesis` modes:

- at least one citation is required;
- factual claims derived from a source should have a nearby citation marker;
- invented or unresolved citations are validation failures.

Archive articles retain source provenance through their sole source record and do not need per-paragraph citations.

## Export contract

An export records:

- source article ID;
- format and local artifact;
- optional copied assets needed by the artifact;
- destination;
- preparation or delivery status;
- exact artifact hash;
- non-secret delivery evidence.

Exports are derived and may be regenerated under new export IDs. They never become the source of truth for article content. EPUB artifacts contain validated package/navigation/spine documents and embed the image bytes needed for offline reading.

Kindle delivery is an external side effect. A successful Kindle export record must contain the prepared local export ID, interactive confirmation timestamp, and delivery timestamp. Dry-runs retain an immutable local EPUB or PDF and expose its export ID and content hash with only a redacted recipient outside the confirmation dialog. A later send verifies the requested article, format, path, byte length, and hash, sends those exact prepared bytes, and records delivery evidence by reference rather than copying the attachment. SMTP credentials and full Kindle/sender addresses must come from the operating-system credential store or environment overrides and must not be written to JSON configuration, manifests, logs, article metadata, Pi tool results, or Git.

## Library location resolution

The application resolves the library root in this order:

1. an explicit API or CLI argument;
2. `PI_READS_LIBRARY_DIR`;
3. `libraryDir` in the resolved `pi-reads.json` configuration;
4. `~/Documents/pi-reads`.

Configuration is resolved in this order:

1. an explicit config path;
2. `PI_READS_CONFIG`;
3. `$XDG_CONFIG_HOME/pi-reads/pi-reads.json` when `XDG_CONFIG_HOME` is set;
4. `~/.config/pi-reads/pi-reads.json`.

Tilde expansion occurs only at the start of a configured path. Persisted record paths always use forward-slash, library-relative paths. Core services receive resolved paths and do not depend on Pi APIs or the process working directory.

Configuration contains preferences, never credentials. Obsidian configuration may contain a vault path/name, inbox and attachment folders, note naming template, tags, custom scalar or string-array frontmatter, and an open-after-export preference. Kindle configuration may contain a device label, default format, SMTP host/port/TLS mode, credential backend/profile, and environment-variable names for recipient, username, password, and approved sender. Actual addresses and credentials belong in the operating-system credential store or environment overrides. Vault files are conflict-checked by hash and require confirmation before a differing target is overwritten.

## Library layout

```text
<library-root>/
  sources/
    <source-id>/
      manifest.json
      content.md
      raw/                 # optional original bytes
      assets/              # optional captured assets
  articles/
    archive/
      <article-id>/
        manifest.json
        content.md
    digest/
      <article-id>/
        manifest.json
        content.md
    synthesis/
      <article-id>/
        manifest.json
        content.md
  exports/
    <article-id>/
      <export-id>/
        manifest.json
        <artifact>
  indexes/
    library.json           # derived and rebuildable library metadata
    sources/
      <source-id>/
        structure-v1.json  # deterministic heading/paragraph ranges
```

Physical mode directories make archive/generated path collisions impossible. The schema requires each article body path to match its mode directory.

`indexes/library.json` is a cache, not canonical data. It contains source/article metadata needed for listing, search, canonical URL/hash lookup, date/mode filtering, and unique slug allocation. It may be deleted and rebuilt solely by scanning immutable manifests. Normal reads validate constant-time source and article-mode directory stamps rather than reopening each manifest. Index replacement is atomic, and an `indexes/dirty` interruption marker forces a rebuild after an incomplete canonical-record/index update.

The application must refuse to use a Git working tree as a library root by default. An explicit unsafe override may be added for development fixtures, but production content must remain outside the package checkout.

## Schema evolution

All records currently use `schemaVersion: 1` and validate against `schemas/v1`.

- Adding an optional field may extend version 1 when old readers safely ignore it.
- Changing required meaning, hashes, path semantics, or mode invariants requires a new schema version.
- Migrations read an old record and create a validated new record or backup; they never silently mutate archived prose.
- Unknown schema versions fail closed with an actionable error.

## Legacy compatibility

After the Phase 5 rename:

- existing `pnpm article:*` commands remain available;
- `skills/irakli-reads` remains a compatibility entry point;
- current `articles/<slug>.md` output remains supported by thin legacy wrappers;
- core APIs, Pi tools, configuration, manifests, and package resources use `pi-reads` or stable `reads_*` names.

Legacy Markdown can be imported as a version 1 source plus archive article. Import must preserve the existing `source`, `sourceTextHash`, and presentation frontmatter and must not modify the original file.

## Phase 0 acceptance decisions

The following are fixed for version 1:

1. The default library is `~/Documents/pi-reads`, outside the installed package.
2. Sources, archive articles, generated articles, and exports occupy separate immutable paths.
3. The only article modes are `archive`, `digest`, and `synthesis`.
4. Stable Pi tool names use the `reads_` prefix and the primary command is `/reads`.
5. User configuration is named `pi-reads.json` and stores no credentials.
6. Existing Irakli Reads print commands and skill remain documented compatibility surfaces after the Pi Reads rename.
