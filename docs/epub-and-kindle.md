# EPUB and Kindle delivery

Pi Reads can create validated, reflowable EPUB files and can optionally email EPUB or print-fidelity PDF attachments through the practical Send to Kindle workflow.

## EPUB

Local EPUB exports contain:

- the article title, authors, language, description, canonical source URL, and modification timestamp;
- reflowable XHTML article and navigation documents;
- generated-article citation markers and bibliography;
- locally copied or safely downloaded article images;
- reader-oriented CSS;
- the required uncompressed first `mimetype` ZIP entry, container document, package manifest, and spine.

Before an EPUB is reported as prepared, Pi Reads validates its ZIP ordering, required files, XML documents, manifest targets, spine references, and embedded assets. The resulting artifact and export manifest are stored immutably in the Pi Reads library.

Use `reads_export` with `format: "epub"` and `destination: "local"`, or select `epub` in `/reads`.

## Kindle environment

Kindle delivery uses SMTP. Keep all addresses and credentials in environment variables, never `pi-reads.json`, command arguments, manifests, or repository files:

| Variable | Meaning |
|---|---|
| `PI_READS_KINDLE_ADDRESS` | The device's Send to Kindle address |
| `PI_READS_KINDLE_DEVICE_LABEL` | Optional non-secret label stored in delivery evidence |
| `PI_READS_SMTP_HOST` | SMTP server hostname |
| `PI_READS_SMTP_PORT` | SMTP port; defaults to `587` |
| `PI_READS_SMTP_SECURE` | `true` for implicit TLS, otherwise `false` |
| `PI_READS_SMTP_USER` | SMTP username |
| `PI_READS_SMTP_PASSWORD` | SMTP password or application password |
| `PI_READS_SMTP_FROM` | Sender address approved in Amazon's personal document settings |

The Kindle recipient must use the `kindle.com` domain. Configure the sender address in Amazon's approved personal document email list before attempting delivery.

## Dry-run and confirmation

A Kindle export is a dry-run unless `send: true` is explicitly requested:

```json
{
  "articleId": "art_…",
  "format": "epub",
  "destination": "kindle"
}
```

Persisted dry-run output includes only a redacted recipient, subject, filename, size, and retained local artifact path. In interactive mode, a transient notification also shows the full recipient for verification. A dry-run does not require SMTP credentials and does not send email.

To request delivery, use `send: true`. Pi Reads then:

1. creates and retains the local EPUB or PDF;
2. refuses to send when no interactive UI is available;
3. displays the full recipient, subject, filename, and size in a confirmation dialog;
4. sends only after the user confirms;
5. stores a delivered export record with confirmation and delivery timestamps, but without recipient/sender addresses or SMTP details.

Cancelling or failing SMTP delivery leaves the prepared local artifact available for manual upload. Delivery errors are sanitized so recipient addresses and credentials are not copied into the Pi session.

## Formats

- **EPUB** is recommended for reflowable Kindle reading.
- **PDF** preserves the existing light print layout and is useful when page fidelity matters more than adjustable typography.

Amazon does not provide a general public Send to Kindle API; approved-sender email remains the supported automation path used here.
