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

Run `/reads-config` and choose **Kindle delivery**. For normal interactive use, choose **System credential store — configure once**. The wizard collects the Send-to-Kindle address, SMTP username/sender, and app-specific password once; password input is masked. It stores protected credential entries using macOS Keychain, Windows Credential Manager, or Linux Secret Service. Pi Reads retrieves those entries automatically when preparing or sending a Kindle export—no launcher script, shell exports, or Pi restart is required.

`pi-reads.json` still contains only non-secret preferences and a credential profile name:

```json
{
  "kindle": {
    "deviceLabel": "My Kindle",
    "defaultFormat": "epub",
    "credentialStore": "system",
    "credentialProfile": "default",
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

The SMTP host, port, TLS mode, device label, default format, credential backend/profile, and environment-variable names are non-secret. Addresses and credentials are never copied into JSON configuration, manifests, logs, tool results, or Git.

For iCloud Mail, create an app-specific password at `account.apple.com`, approve the iCloud sender in Amazon's Personal Document Settings, and use:

- SMTP host: `smtp.mail.me.com`
- port: `587`
- implicit TLS: `no` (the connection upgrades with STARTTLS)
- SMTP username/from: the approved full iCloud address
- password: the Apple app-specific password

The wizard masks the password and writes it only to the system credential store. For a quick non-interactive or CI setup, `/reads-config kindle <smtp-host>` writes the host with safe default environment-variable names. Interactive `/reads-config` is recommended for one-time desktop setup.

## Environment overrides

Environment variables remain available for CI, headless systems without a credential service, and temporary per-field overrides. Select **Environment variables — advanced/CI** in the wizard when they should be the primary source:

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

When custom `recipientEnv`, `userEnv`, `passwordEnv`, or `fromEnv` names are configured, set those variables instead of the defaults above. Environment values take precedence over stored credentials, allowing automation without modifying desktop setup. The Kindle recipient must use the `kindle.com` domain. Configure the sender address in Amazon's approved personal document email list before attempting delivery.

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
