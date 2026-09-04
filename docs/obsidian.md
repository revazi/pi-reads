# Obsidian integration

Pi Reads can deliver any stored archive, digest, or synthesis as a Markdown note in an existing Obsidian vault. This is a destination adapter: source and article records remain immutable in the Pi Reads library.

## Configure

Run `/reads-config` and choose **Obsidian destination**, or set a vault path non-interactively:

```text
/reads-config obsidian ~/Documents/MyVault
```

The full non-secret configuration lives in `pi-reads.json`:

```json
{
  "schemaVersion": 1,
  "obsidian": {
    "vaultPath": "~/Documents/MyVault",
    "vaultName": "MyVault",
    "inboxFolder": "Reading Inbox",
    "attachmentFolder": "Attachments/pi-reads",
    "noteNameTemplate": "{{title}}",
    "tags": ["pi-reads", "reading"],
    "frontmatter": {
      "status": "unread"
    },
    "openAfterExport": false
  }
}
```

Relative vault paths are resolved from the configuration file. Inbox and attachment folders must be vault-relative and cannot contain traversal segments.

Supported note-name variables are:

- `{{title}}`
- `{{slug}}`
- `{{id}}`
- `{{mode}}`
- `{{date}}`

The rendered name is sanitized as one filename under the configured inbox folder.

Custom frontmatter values may be strings, numbers, booleans, or string arrays. Pi Reads reserves provenance properties such as `piReadsArticleId`, `mode`, `sourceIds`, `sourceUrls`, `authors`, `createdAt`, and `generatedBy`; custom frontmatter cannot replace them.

## Export

In `/reads`, choose `obsidian` as the output. Agents can call:

```json
{
  "articleId": "art_…",
  "format": "markdown",
  "destination": "obsidian"
}
```

Set `open: true` to open the delivered note through an `obsidian://open` URI. The `openAfterExport` configuration makes that the default.

## Assets

Pi Reads scans normal Markdown images and HTML `<img src="…">` elements outside fenced code blocks. It:

1. downloads HTTP(S) images or reads images relative to a captured local Markdown file;
2. stores reproducible copies with the immutable export record;
3. writes copies under `<attachmentFolder>/<article-slug>/` in the vault;
4. rewrites note links relative to the note folder.

Supported image types are AVIF, BMP, GIF, JPEG, PNG, SVG, and WebP. Each asset is limited to 20 MiB. Relative image paths require exactly one captured local-file source so their base directory is unambiguous.

## Reading graph

After exporting source and synthesis notes, rebuild the vault's Pi Reads navigation:

```text
/reads-obsidian-graph
```

This deterministically maintains four files under `Pi Reads/`: `Library.md`, `Topics.md`, `Reading Status.md`, and `Reading Queue.md`. They link only notes whose immutable delivered-export manifest matches the configured vault and whose current frontmatter still identifies the Pi Reads article. Topic, status, rating, priority, and queue data come from separate current reading-state records.

For each exported synthesis whose captured source also has an exported archive note, the rebuild appends a managed source-note link section to the synthesis export. Obsidian consequently shows the synthesis as a backlink on that source note. Archive/source notes are never rewritten by graph generation, and immutable library artifacts remain unchanged.

A repeated rebuild with unchanged exports and state writes no bytes. Differing managed targets are listed for approval; in headless use, rerun `/reads-obsidian-graph overwrite` only after reviewing those exact paths. A colliding file without the expected Pi Reads frontmatter marker is treated as unrelated vault content and is never overwritten, even with the overwrite argument. Target hashes are compared again while writing so an edit after preview fails closed.

## Conflict behavior

Before writing, Pi Reads hashes every target note and asset:

- missing files are created;
- identical files are left unchanged;
- differing files are reported as conflicts.

Interactive export displays the exact conflicting vault paths and asks before replacing them. Headless callers must provide `overwrite: true` only after explicit approval. Writes are limited to the configured note and asset targets; unrelated vault files are not scanned, modified, or deleted. Graph generation reads only note paths recorded by Pi Reads export manifests plus its four fixed managed view paths.

Vault-relative paths and existing parent symlinks are checked so a configured folder cannot escape the vault. A successful delivery creates an immutable export manifest containing the note hash, copied asset hashes, destination vault name, and note path.
