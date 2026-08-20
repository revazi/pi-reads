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

## Kindle configuration

Run `/reads-config` and choose **Kindle delivery**. The wizard asks only for non-secret preferences and names of environment variables—it never asks for an address, username, or password value.

The safe configuration in `pi-reads.json` has this shape:

```json
{
  "kindle": {
    "deviceLabel": "My Kindle",
    "defaultFormat": "epub",
    "recipientEnv": "PI_READS_KINDLE_ADDRESS",
    "smtp": {
      "host": "smtp.example.com",
      "port": 587,
      "secure": false,
      "userEnv": "PI_READS_SMTP_USER",
      "passwordEnv": "PI_READS_SMTP_PASSWORD",
      "fromEnv": "PI_READS_SMTP_FROM"
    }
  }
}
```

The SMTP host, port, TLS mode, device label, default format, and environment-variable names are non-secret. The host may be omitted to keep using `PI_READS_SMTP_HOST`. Environment-variable names must use uppercase letters, digits, and underscores.

For a quick non-interactive setup, `/reads-config kindle <smtp-host>` writes the host with safe default environment-variable names. Interactive `/reads-config` is recommended.

## Kindle environment

Kindle delivery uses SMTP. Keep all addresses and credentials in environment variables, never `pi-reads.json`, command arguments, manifests, or repository files:

| Variable | Meaning |
|---|---|
| `PI_READS_KINDLE_ADDRESS` | The device's Send to Kindle address |
| `PI_READS_KINDLE_DEVICE_LABEL` | Optional override for the configured non-secret device label |
| `PI_READS_SMTP_HOST` | Optional override when an SMTP host is stored in safe configuration |
| `PI_READS_SMTP_PORT` | SMTP port; defaults to `587` |
| `PI_READS_SMTP_SECURE` | `true` for implicit TLS, otherwise `false` |
| `PI_READS_SMTP_USER` | SMTP username |
| `PI_READS_SMTP_PASSWORD` | SMTP password or application password |
| `PI_READS_SMTP_FROM` | Sender address approved in Amazon's personal document settings |

When custom `recipientEnv`, `userEnv`, `passwordEnv`, or `fromEnv` names are configured, set those variables instead of the defaults above. The Kindle recipient must use the `kindle.com` domain. Configure the sender address in Amazon's approved personal document email list before attempting delivery.

## Dry-run and confirmation

A Kindle export is a dry-run unless `send: true` is explicitly requested. Its format may be omitted to use the configured `defaultFormat` (`epub` by default):

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
