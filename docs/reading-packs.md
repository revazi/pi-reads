# Multi-article reading packs and scheduled Kindle preparation

Pi Reads can combine 2–50 saved articles into one validated EPUB while preserving the selected order and each article's immutable provenance.

## Interactive preparation

Run `/reads`, choose **Reading pack — ordered multi-article EPUB**, select articles in chapter order, choose **Done**, and enter a title. Pi Reads creates:

- an immutable `collections/col_…/manifest.json` record;
- one ordered snapshot per article with its mode, content hash, source IDs, citations, and generation provenance;
- a validated local EPUB under `exports/col_…/exp_…/collection.epub`.

The EPUB has a navigation table of contents and exactly one spine item/XHTML chapter per selected article. Chapter headers retain the article mode and source attribution; citation markers, source lists, exact quote metadata, and offline image assets remain with their article.

Interactive preparation is local only. It does not read Kindle credentials or send email. Keep the reported collection ID, prepared export ID, content hash, and artifact path for review.

## Scheduled local preparation

The scheduler-safe command has no mail transport and accepts no send option:

```sh
pnpm kindle:digest:prepare -- \
  --title "Weekend reading" \
  --article art_first_id \
  --article art_second_id
```

Use `--library /absolute/path/to/pi-reads` when the scheduled process cannot resolve the normal Pi Reads configuration. Article flags are repeatable and their order becomes chapter order.

A cron, launchd, or Task Scheduler job may invoke this command at any cadence. Each run creates a new immutable collection and local EPUB, prints bounded IDs/hash/path metadata, and exits. The job cannot send email unattended: unknown options, including `--send`, fail closed, and the preparation service exposes no delivery operation.

Example cron entry (paths and IDs are illustrative):

```cron
0 7 * * 6 cd /path/to/pi-reads && /path/to/pnpm kindle:digest:prepare -- --title "Weekend reading" --article art_first_id --article art_second_id
```

Do not put SMTP credentials or Kindle addresses in scheduler arguments, logs, or configuration files.

## Sending the exact prepared pack

A later `reads_export` call can dry-run the prepared collection:

```json
{
  "collectionId": "col_…",
  "format": "epub",
  "destination": "kindle",
  "preparedExportId": "exp_…"
}
```

After reviewing the returned redacted recipient, subject, size, path, prepared ID, and content hash, the user may explicitly request `send: true` with the same collection and prepared export IDs. Pi Reads re-reads and verifies the immutable manifest and artifact, displays the full recipient in the interactive confirmation, and sends only after approval. Headless sends are rejected. The delivered record references the exact prepared export and hash; the attachment is not rendered again.

Cancelling or failing delivery leaves the local EPUB available for manual Send to Kindle upload.
