# Multi-source cited synthesis

Pi Reads can generate one synthesis from 2–20 already captured sources while preserving explicit source order and immutable archive records.

## Start the workflow

Run `/reads` without arguments, choose **Captured sources — ordered multi-source synthesis**, then choose sources one at a time. The selection number is the persisted source order. Choose **Done** after at least two sources, then select an export destination.

A non-interactive caller can start the same workflow with ordered IDs:

```text
/reads src_first… src_second…
```

The command validates every ID before asking the active Pi model to write. Its compact plan binds each selected source to its current immutable content hash and locator count. No source prose is copied into the plan.

## Retrieval and citations

For every source in order, the model must:

1. request its bounded `reads_library` outline;
2. retain the returned source content hash;
3. read or search only relevant exact locator ranges;
4. submit the considered locators as `complete` or `targeted` coverage;
5. cite only selected source IDs with registered `[^cite_id]` markers.

Multi-source synthesis is capped at 20 sources so complete citation-distribution diagnostics remain bounded. Source order is preserved in the generated article and duplicate source IDs are rejected.

## Mandatory review before persistence

The first `reads_save_article` call for a multi-source synthesis must omit `reviewToken`. Pi Reads verifies source hashes, coverage, citation IDs, locators, and exact quotes, then returns a review without creating an article. The review reports citation counts in selected-source order and lists every selected source with zero citations.

As a conservative deterministic claim-citation gate, every non-empty Markdown section in a multi-source synthesis must contain at least one registered citation marker. Pi Reads cannot infer the truth or semantics of arbitrary prose; section-level enforcement prevents an uncited section from being silently persisted without claiming semantic fact-checking.

If the exact draft and diagnostics are intended, repeat the same `reads_save_article` request with the returned `reviewToken`. The token binds mode, title, body, ordered sources, citations, coverage, the versioned generation template, and active provider/model/thinking/session identity. Any change requires a new review. Generation time is recorded when the final immutable article is saved.

The review token is a workflow integrity check, not an external-delivery confirmation. Existing Obsidian overwrite and Kindle send confirmations still apply independently.

## Persistence and export

The final article stores ordered source IDs, coverage, citation-grounding diagnostics, and active Pi provider/model/thinking/session provenance. It is written under `articles/synthesis/`; captured sources and archive articles are never rewritten. Existing local, Obsidian, EPUB, PDF, and Kindle export paths operate on the new generated article normally.
