# Clipboard and timestamped transcript ingestion

## Explicit clipboard capture

Interactive `/reads` includes **Clipboard — read once after confirmation**. Selecting it does not read anything: Pi Reads displays a separate **Read clipboard now?** confirmation explaining that the clipboard will be read once and is never monitored. Declining performs no clipboard command and creates no records.

After approval, Pi Reads invokes the platform clipboard utility (`pbpaste`, PowerShell `Get-Clipboard`, or an available `wl-paste`/`xclip`/`xsel`) once, rejects empty content and values above 256 KiB, and asks whether the bytes are plain text or Markdown. The normal archive/generated mode and export choices then apply. Archive capture stays deterministic; generated workflows persist the clipboard source first and give the model only its ID/hash plus bounded retrieval instructions rather than embedding the full clipboard in a new prompt.

Core `ingestClipboard` accepts only content already supplied by its caller. It has no operating-system, Pi, timer, listener, or background access. Agent tools do not expose an operation that reads the system clipboard; callers can still submit consciously pasted text through the existing text/Markdown inputs.

## Local transcripts

`reads_ingest` and `/reads` accept local `.srt` and `.vtt` files through the `transcript` source kind:

```json
{ "kind": "transcript", "value": "@recording.vtt" }
```

Files must be stable regular UTF-8 files no larger than 10 MiB. Parsing supports SRT comma timestamps and WebVTT dot timestamps, cue identifiers/settings, multiline cues, voice/formatting markup, and deterministic skipping of WebVTT `NOTE`, `STYLE`, and `REGION` blocks. Active markup is removed. Empty cues are omitted; invalid/reversed timestamps and files without readable timestamped segments fail closed. At most 20,000 segments are accepted.

The immutable canonical Markdown has one deterministic heading per segment:

```markdown
## 00:01:02.000 --> 00:01:05.000 · segment 3

Exact segment prose.
```

This heading is the stable timestamp locator. `reads_library outline` exposes it with the existing content-derived `h_…` locator and its following exact paragraph. A citation can use the timestamp heading (or returned stable fragment) plus an exact quote; citation grounding resolves the heading section and verifies the quote against immutable source bytes. Repeated timestamps remain unambiguous because the deterministic segment ordinal is part of the heading.

The source manifest records kind `transcript`, the local origin, content/text hashes, and `srt-transcript` or `vtt-transcript` adapter provenance. Original subtitle bytes are retained as `application/x-subrip` or `text/vtt`; the archive is a separate faithful deterministic representation and is never rewritten.

## Scope

This issue intentionally has no YouTube/media-provider adapter, transcript download, API key, OAuth flow, audio transcription, or live media request. A future provider adapter requires documented provider behavior and the same explicit acquisition and provenance rules.

Tests use synthetic local SRT/WebVTT fixtures and mocked clipboard execution. They use no live media service and never read the developer's clipboard.
