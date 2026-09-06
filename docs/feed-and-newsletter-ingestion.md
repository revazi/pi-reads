# RSS, Atom, and local newsletter ingestion

Pi Reads can preview RSS/Atom entries and exported newsletter `.eml` files before creating immutable records. The feature is deliberately two-step: preview first, then capture only indexes the user explicitly selected.

## Tool workflow

Preview a feed:

```json
{ "kind": "feed", "value": "https://example.com/feed.xml" }
```

Preview a local exported newsletter:

```json
{ "kind": "newsletter", "value": "@newsletter.eml" }
```

The result contains bounded entry metadata, duplicate status, and a `previewToken`; it never contains entry bodies or raw email. Preview creates no source or article records. Repeat the same request with both fields only after the user chooses indexes:

```json
{
  "kind": "feed",
  "value": "https://example.com/feed.xml",
  "selection": [0, 3],
  "previewToken": "sha256:..."
}
```

The token binds the collection bytes, ordered entry content hashes, canonical URLs, and locators. If a remote feed or local file changes, capture fails before writing and requires a new preview. Empty, repeated, unavailable, or more than 50 selected indexes fail closed. Collection capture never performs recapture; canonical changes remain non-writing `changed-content` outcomes.

Interactive `/reads` exposes **RSS/Atom feed** and **Newsletter .eml** source types. It reports the preview before presenting entry choices and does not capture until **Done — capture selected entries** is chosen.

## Duplicate statuses

| Preview status | Meaning |
|---|---|
| `new` | No canonical-URL or content-hash match was found. |
| `exact-duplicate` | The library already contains the same canonical content or content hash. |
| `changed-content` | The canonical URL exists with different content. |
| `duplicate-in-preview` | An earlier entry in this preview has the same canonical content or content hash. |
| `changed-in-preview` | An earlier entry has the same canonical URL but different content. |

After selection, the normal batch outcomes (`captured`, `exact-duplicate`, `changed-content`, `failed`, or `cancelled`) apply; each outcome's `index` remains the original preview index. Per-item publication, compensation, cancellation, and immutable duplicate behavior are the same as [transactional batch ingestion](batch-ingestion.md).

## Feed adapter

- Accepts RSS 2.x/RSS namespace variants and Atom feeds.
- Reads up to 2 MiB and previews the first 50 entries while reporting the total and truncation.
- Converts embedded HTML/text into deterministically cleaned Markdown, retains the entry payload as raw evidence, and records the canonical entry URL, author, publication time, adapter, and content hashes.
- Removes tracking parameters from canonical HTTP(S) entry URLs.
- Rejects XML declarations that can define document types/entities.
- Remote requests use the shared public-network policy, validate every redirect, accept feed/XML media types only, enforce streamed byte and timeout limits, and reject credential-bearing/private destinations.

## Newsletter adapter

Only local regular UTF-8 `.eml` files up to 10 MiB are supported. MIME parsing is bounded, prefers the HTML alternative when available, falls back to plain text, strips active/furniture markup through the existing deterministic cleanup pipeline, and stores the original `.eml` as `message/rfc822` evidence. Subject, sender display name, date, and an HTTP(S) `Archived-At`, `List-Archive`, `Content-Location`, or HTML canonical URL become source metadata when available. Attachments are not ingested.

Mailbox login, IMAP/POP, OAuth, message synchronization, remote attachments, scheduled polling, and credentials are out of scope. Pi Reads does not ask for or store mailbox credentials.

## Architecture and tests

`parseFeed` and `ingestNewsletterFile` produce canonical `IngestedSourceDraft` values. `CollectionIngestionService` owns stateless preview/token/selection logic and passes selected drafts through `BatchIngestionService` to `LibraryService.captureDraft`. Core/application services do not import Pi APIs; the extension remains a bounded adapter.

Tests use synthetic local RSS, Atom, and `.eml` fixtures plus fake network responses. They perform no live ingestion, mailbox access, or external delivery.
