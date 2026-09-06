# Transactional batch ingestion

`reads_ingest` supports mixed batches without a separate model call/tool call for every source:

```json
{
  "kind": "batch",
  "items": [
    { "kind": "url", "value": "https://example.com/article" },
    { "kind": "file", "value": "@notes.md" },
    { "kind": "text", "value": "Local reading notes", "label": "Notes" }
  ]
}
```

Each item accepts `url`, `file`, `text`, or `markdown`, a `value`, and an optional `label` for text/Markdown (URL/file titles come from extraction/the filename). Relative files resolve against Pi's working directory; a leading `@` is stripped. Single-source calls retain their original `kind`, `value`, `label`, and optional `recapture` shape. Do not mix single-source fields with `items`.

## Partial success and duplicate behavior

A batch is **a set of per-item transactions**, not an all-or-nothing transaction across the whole collection. Results retain input order using zero-based `index`, even when independent URL acquisition finishes out of order. Each outcome is one of:

| Status | Meaning |
|---|---|
| `captured` | A new immutable source, faithful archive, and structure index were persisted. |
| `exact-duplicate` | Existing verified source/archive IDs were reused; nothing was recaptured. |
| `changed-content` | Canonical content changed; IDs point to the existing capture, **not** the incoming content. Nothing new was stored. |
| `failed` | The item failed validation/acquisition/publication; successful siblings remain. |
| `cancelled` | Acquisition or pending publication was cancelled; successful siblings remain. |

Successful and duplicate/changed outcomes include source/archive IDs and a **library-relative** source content path. Use `reads_library` with those IDs for bounded retrieval. Outcomes never contain source prose, HTML, titles, raw network errors, or user-supplied URLs/paths. Counts summarize every status without replacing or dropping per-item outcomes.

`changed-content` is not a successful new capture. Get explicit user approval and use an **individual** `reads_ingest` call with `recapture: true` if a linked immutable successor is wanted. Batch mode does not accept recapture flags and never silently creates successors.

Reported ordinary persistence failures compensate only the new item: newly created source/archive/index directories are removed in reverse order, including when publishing the derived library catalog fails. Existing records, duplicate matches, and conflicting files/directories are never removed by compensation. Canonical file sets are prepared before publication and each record directory is published complete, using the existing immutable writer. Catalog publication and compensation run under the library's serialized mutation queue. These guarantees also improve individual capture.

An unsafe or failed compensation is reported as `failed` with `recovery-required`, and pending/in-flight work is cancelled. **Stop writers and inspect the library before retrying**. The transaction is an application-level compensation mechanism, not an operating-system atomic transaction across multiple directories: process termination, disk failure, or an unrelated writer bypassing these queues can require manual recovery. Do not run independent processes that mutate the same library concurrently. A dirty derived catalog can rebuild from canonical records on the next normal library operation.

## Limits and errors

- 1–50 items per request; split larger collections before invoking the tool. Every accepted item gets an outcome, without hidden truncation.
- At most 1 MiB of inline values/labels in a batch, with text/Markdown values at most 256 KiB each; URL/file locators at most 8192 bytes and labels at most 200 bytes.
- Local files must be regular UTF-8 `.txt`, `.md`, or `.markdown` files no larger than 10 MiB. File reads are size-bounded and cancellation-aware. These file safety limits also apply to individual ingestion.
- URL capture retains the shared public-network policy, redirect limits, 10 MiB HTML bound, and timeout; batch does not bypass network protections.
- Three concurrent acquisitions by default. The application API accepts `concurrency` from 1–4; the tool uses the default. Duplicate decisions and record publication remain serialized.
- Model-visible tool results stay below 32 KiB for the maximum accepted batch. The extension still registers four tools; there is no extra persistent batch tool.

Invalid batch envelopes/counts/aggregate size fail before capture begins. Once the batch is accepted, invalid individual inputs produce `invalid-input`; extraction, network, and compensated storage failures produce `capture-failed`. The public tool schema may reject malformed arguments before application execution. Error codes deliberately avoid echoing potentially sensitive content or upstream errors. Retry individual failed inputs for diagnosis; do not retry a whole successful collection expecting new IDs.

## Cancellation

The same abort signal reaches every active network acquisition. Pending inputs do not start acquisition after cancellation; workers drain and return one outcome per input. Injected fetch adapters must honor their signal, just like the default bounded HTTP adapter.

Cancellation is checked again after waiting for the catalog queue and immediately before publishing records. Once an item's publication begins, it finishes or compensates rather than leaving an incomplete pair because of cancellation. A capture that commits during cancellation remains `captured`, not falsely `cancelled`. Already completed items are retained and discoverable in the library.

## Application API and scope

`src/application/batch-ingestion-service.ts` exports `BatchIngestionService`. Construct it with `LibraryService` and optional fixture ingestion dependencies, then call `capture(SourceInput[], {concurrency?, signal?})`. Native application `SourceInput` descriptors use `url`, `path`, `text`, or `markdown` fields; the Pi adapter converts the compact tool `kind`/`value` form.

The batch service does not import Pi APIs or invoke a model. The thin extension handler uses Pi's file-mutation queue around the workflow and lazy-loads the service. Deterministic tests use injected HTML and abortable fixture fetches, not live internet.

This issue covers capture only. Multi-source generation UX, feed adapters, templates, transcript/clipboard adapters, and reading-pack export are separate follow-up issues. No export or external delivery is performed by a batch capture.
