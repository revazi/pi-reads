import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { EpubService, validateEpub } from '../src/application/epub-service.ts';
import { LibraryService } from '../src/application/library-service.ts';
import type { RecordIdPrefix } from '../src/core/library.ts';

function deterministicIds(): (prefix: RecordIdPrefix) => string {
  const counts: Record<RecordIdPrefix, number> = { src: 0, art: 0, cite: 0, exp: 0 };
  const letters: Record<RecordIdPrefix, string> = { src: 'e', art: 'f', cite: 'g', exp: 'h' };
  return (prefix) => {
    counts[prefix] += 1;
    return `${prefix}_${letters[prefix].repeat(15)}${counts[prefix].toString(36)}`;
  };
}

test('EPUB export creates a validated reflowable book with embedded assets and citations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-epub-'));
  const sourceDir = path.join(root, 'source');
  const libraryDir = path.join(root, 'library');
  await mkdir(sourceDir);
  await writeFile(path.join(sourceDir, 'figure.png'), Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  await writeFile(
    path.join(sourceDir, 'article.md'),
    '# EPUB Fixture\n\nFaithful source prose.\n\n![Figure](figure.png)\n\n```ts\nconst readable = true;\n```',
  );

  const createId = deterministicIds();
  const now = () => new Date('2026-08-22T09:15:00Z');
  const library = new LibraryService({ libraryDir, createId, now });
  const epub = new EpubService({ library, createId, now });

  try {
    const captured = await library.capture({ kind: 'file', path: path.join(sourceDir, 'article.md') });
    const archiveExport = await epub.prepare(captured.archiveArticle.id);
    const archiveBytes = await readFile(archiveExport.artifactPath);
    assert.equal(archiveExport.record.format, 'epub');
    assert.equal(archiveExport.record.artifact.mediaType, 'application/epub+zip');
    assert.equal(archiveExport.validation.embeddedAssets, 1);
    assert.equal(validateEpub(archiveBytes).spineItems, 1);

    const files = unzipSync(archiveBytes);
    assert.equal(strFromU8(files.mimetype), 'application/epub+zip');
    assert.ok(files['EPUB/assets/article/001-figure.png']);
    const articleXhtml = strFromU8(files['EPUB/article.xhtml']);
    assert.match(articleXhtml, /Faithful source prose\./);
    assert.match(articleXhtml, /src="assets\/article\/001-figure\.png"/);
    assert.match(articleXhtml, /const readable = true/);
    assert.match(strFromU8(files['EPUB/package.opf']), /media-type="image\/png"/);

    const { index: sourceIndex } = await library.loadSourceIndex(captured.source.id);
    const generated = await library.saveGenerated({
      mode: 'digest',
      title: 'Cited EPUB digest',
      body: 'A generated observation.[^cite_epub]',
      sourceIds: [captured.source.id],
      citations: [{ id: 'cite_epub', sourceId: captured.source.id, quote: 'Faithful source prose.' }],
      coverage: {
        policy: 'complete',
        sources: [{
          sourceId: captured.source.id,
          sourceContentHash: sourceIndex.sourceContentHash,
          consideredLocators: [
            ...sourceIndex.headings.map(({ id }) => id),
            ...sourceIndex.paragraphs.map(({ id }) => id),
          ],
        }],
      },
      generatedBy: {
        provider: 'fixture-provider',
        model: 'fixture-model',
        generatedAt: '2026-08-22T09:15:00Z',
      },
    });
    const digestExport = await epub.prepare(generated.article.id);
    const digestFiles = unzipSync(await readFile(digestExport.artifactPath));
    const digestXhtml = strFromU8(digestFiles['EPUB/article.xhtml']);
    assert.match(digestXhtml, /epub:type="noteref"/);
    assert.match(digestXhtml, /epub:type="bibliography"/);
    assert.match(digestXhtml, /Faithful source prose\./);

    const corrupted = new Uint8Array(archiveBytes);
    corrupted[0] = 0;
    assert.throws(() => validateEpub(corrupted), /ZIP local file header/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
