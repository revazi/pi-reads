import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ingestFile } from '../src/core/ingest/file.ts';
import { ingestSource } from '../src/core/ingest/index.ts';
import { ingestMarkdown, ingestText } from '../src/core/ingest/text.ts';
import { normalizeText, versionedSha256 } from '../src/core/text.ts';

test('plain text ingestion preserves visible prose and exact raw input', () => {
  const text = 'A *literal* heading\r\n\r\n- not a requested list\r\n<script>alert("x")</script>';
  const source = ingestText(text, 'Fixture text');

  assert.equal(source.kind, 'text');
  assert.equal(source.title, 'Fixture text');
  assert.equal(source.rawContent, text);
  assert.equal(source.rawMediaType, 'text/plain');
  assert.match(source.content, /\\\*literal\\\*/);
  assert.match(source.content, /\\- not a requested list/);
  assert.match(source.content, /&lt;script&gt;/);
  assert.equal(source.textHash, versionedSha256(normalizeText(text)));
});

test('Markdown ingestion hashes rendered visible text while preserving source bytes', () => {
  const markdown = '# Heading\n\nRead [the source](https://example.test).';
  const source = ingestMarkdown(markdown, 'Fixture Markdown');

  assert.equal(source.content, markdown);
  assert.equal(source.contentHash, versionedSha256(markdown));
  assert.equal(source.textHash, versionedSha256('Heading Read the source.'));
});

test('file ingestion accepts Markdown and text and rejects unsupported files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-ingest-'));
  try {
    await writeFile(path.join(directory, 'note.md'), '# Note\n\nBody');
    await writeFile(path.join(directory, 'plain.txt'), 'Plain body');
    await writeFile(path.join(directory, 'data.json'), '{}');
    await writeFile(path.join(directory, 'invalid.txt'), Buffer.from([0xff, 0xfe]));

    const markdown = await ingestFile('note.md', directory);
    assert.equal(markdown.kind, 'file');
    assert.equal(markdown.capture.adapter, 'markdown-file');
    assert.equal(markdown.title, 'note');

    const text = await ingestFile('plain.txt', directory);
    assert.equal(text.capture.adapter, 'text-file');
    assert.equal(text.rawContent, 'Plain body');

    await assert.rejects(() => ingestFile('data.json', directory), /Unsupported source file type/);
    await assert.rejects(() => ingestFile('invalid.txt', directory), /not valid UTF-8 text/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('empty and unknown source input fails closed', async () => {
  assert.throws(() => ingestText('   '), /empty text/);
  assert.throws(() => ingestMarkdown('\n'), /empty markdown/);
  assert.throws(() => ingestMarkdown('<script>alert("x")</script>'), /unsafe raw HTML/);
  await assert.rejects(
    () => ingestSource({ kind: 'rss' } as never),
    /Unsupported source input kind: rss/,
  );
});
