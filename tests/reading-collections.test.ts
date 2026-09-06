import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { registerReadsCommands } from '../extensions/pi-reads/commands.ts';
import type { KindleMail, KindleMailTransport } from '../src/adapters/destinations/kindle.ts';
import { DigestPreparationService } from '../src/application/digest-preparation-service.ts';
import { EpubService, validateEpub } from '../src/application/epub-service.ts';
import { ExportService } from '../src/application/export-service.ts';
import { KindleService, type KindleEnvironment } from '../src/application/kindle-service.ts';
import { inspectLibrary } from '../src/application/library-verification.ts';
import { LibraryService } from '../src/application/library-service.ts';
import { ReadingCollectionService } from '../src/application/reading-collection-service.ts';
import type { ResolvedKindleConfig } from '../src/core/config.ts';
import type { RecordIdPrefix } from '../src/core/library.ts';
import { versionedSha256 } from '../src/core/text.ts';
import { parseScheduledDigestArguments } from '../scripts/prepare-kindle-digest.ts';

function deterministicIds(): (prefix: RecordIdPrefix) => string {
  const counts: Record<RecordIdPrefix, number> = { src: 0, art: 0, cite: 0, exp: 0 };
  const letters: Record<RecordIdPrefix, string> = { src: 'n', art: 'o', cite: 'p', exp: 'q' };
  return (prefix) => {
    counts[prefix] += 1;
    return `${prefix}_${letters[prefix].repeat(15)}${counts[prefix].toString(36)}`;
  };
}

class FakeTransport implements KindleMailTransport {
  readonly sent: KindleMail[] = [];
  async send(mail: KindleMail): Promise<void> { this.sent.push(mail); }
}

const environment: KindleEnvironment = {
  TEST_KINDLE_RECIPIENT: ['collection-reader', 'kindle.com'].join('@'),
  TEST_SMTP_USER: 'approved-sender',
  TEST_SMTP_PASSWORD: 'fixture-password',
  TEST_SMTP_FROM: ['sender', 'example.test'].join('@'),
};
const kindleConfig: ResolvedKindleConfig = {
  defaultFormat: 'epub',
  credentialStore: 'environment',
  credentialProfile: 'default',
  recipientEnv: 'TEST_KINDLE_RECIPIENT',
  smtp: {
    host: 'smtp.example.test',
    port: 587,
    secure: false,
    userEnv: 'TEST_SMTP_USER',
    passwordEnv: 'TEST_SMTP_PASSWORD',
    fromEnv: 'TEST_SMTP_FROM',
  },
};

test('ordered collection EPUB keeps article provenance, citations, assets, and one spine item per article', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-collection-epub-'));
  const sourceDir = path.join(root, 'source');
  const libraryDir = path.join(root, 'library');
  await mkdir(sourceDir);
  await writeFile(path.join(sourceDir, 'figure.png'), Buffer.from([137, 80, 78, 71, 9, 8, 7]));
  await writeFile(path.join(sourceDir, 'first.md'), '# First chapter\n\nFaithful first prose.\n\n![Figure](figure.png)');
  const createId = deterministicIds();
  const now = () => new Date('2026-09-06T05:00:00Z');
  const library = new LibraryService({ libraryDir, createId, now });
  const collections = new ReadingCollectionService({
    library,
    now,
    createId: () => 'col_rrrrrrrrrrrrrrrr',
  });
  const epub = new EpubService({ library, collections, createId, now });

  try {
    const first = await library.capture({ kind: 'file', path: path.join(sourceDir, 'first.md') });
    const second = await library.capture({ kind: 'markdown', label: 'Second source', markdown: '# Second\n\nGrounded second prose.' });
    const sourceIndex = (await library.loadSourceIndex(second.source.id)).index;
    const digest = await library.saveGenerated({
      mode: 'digest',
      title: 'Second digest',
      body: 'A grounded digest.[^cite_second]',
      sourceIds: [second.source.id],
      citations: [{ id: 'cite_second', sourceId: second.source.id, quote: 'Grounded second prose.' }],
      coverage: {
        policy: 'complete',
        sources: [{
          sourceId: second.source.id,
          sourceContentHash: sourceIndex.sourceContentHash,
          consideredLocators: [...sourceIndex.headings, ...sourceIndex.paragraphs].map(({ id }) => id),
        }],
      },
      generatedBy: { provider: 'fixture', model: 'fixture', generatedAt: now().toISOString() },
    });
    const stored = await collections.create({
      title: 'Weekend reading pack',
      articleIds: [first.archiveArticle.id, digest.article.id],
      createdBy: 'interactive',
    });
    assert.deepEqual(stored.collection.articleIds, [first.archiveArticle.id, digest.article.id]);
    assert.equal(stored.collection.articles[0]?.mode, 'archive');
    assert.equal(stored.collection.articles[1]?.mode, 'digest');
    assert.deepEqual(stored.collection.articles[1]?.sourceIds, [second.source.id]);
    assert.deepEqual(stored.collection.articles[1]?.citations, digest.article.citations);
    assert.deepEqual((await collections.load(stored.collection.id)).collection, stored.collection);

    const prepared = await epub.prepareCollection(stored.collection.id);
    assert.equal(prepared.record.collectionId, stored.collection.id);
    const bytes = await readFile(prepared.artifactPath);
    const validation = validateEpub(bytes);
    assert.equal(validation.spineItems, 2);
    assert.equal(validation.embeddedAssets, 1);
    const files = unzipSync(bytes);
    const nav = strFromU8(files['EPUB/nav.xhtml']);
    assert.ok(nav.indexOf('First chapter') < nav.indexOf('Second digest'));
    const chapters = validation.files.filter((name) => /^EPUB\/chapters\/.*\.xhtml$/u.test(name));
    assert.equal(chapters.length, 2);
    const firstChapter = strFromU8(files[chapters[0]!]);
    const secondChapter = strFromU8(files[chapters[1]!]);
    assert.match(firstChapter, /Mode: archive/u);
    assert.match(firstChapter, /Faithful first prose/u);
    assert.match(firstChapter, /\.\.\/assets\/first\/001-figure\.png/u);
    assert.match(secondChapter, /Mode: digest/u);
    assert.match(secondChapter, /epub:type="noteref"/u);
    assert.match(secondChapter, /Grounded second prose/u);
    const verification = await inspectLibrary(await realpath(libraryDir), false);
    assert.equal(verification.report.ok, true, JSON.stringify(verification.report.findings));
    assert.equal(verification.report.collectionCount, 1);
    assert.equal(verification.report.exportCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scheduled preparation cannot send, and later confirmed Kindle delivery reuses exact collection bytes', async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-scheduled-digest-'));
  const createId = deterministicIds();
  const now = () => new Date('2026-09-06T06:00:00Z');
  const library = new LibraryService({ libraryDir, createId, now });
  const collections = new ReadingCollectionService({ library, now, createId: () => 'col_ssssssssssssssss' });
  const epub = new EpubService({ library, collections, createId, now });
  const preparation = new DigestPreparationService({ collections, epub });
  const transport = new FakeTransport();
  const kindle = new KindleService({
    library,
    collections,
    exports: new ExportService({ library, createId, now }),
    epub,
    env: environment,
    config: kindleConfig,
    transport,
    createId,
    now,
  });

  try {
    const first = await library.capture({ kind: 'text', text: 'First scheduled article.', label: 'First scheduled' });
    const second = await library.capture({ kind: 'text', text: 'Second scheduled article.', label: 'Second scheduled' });
    const prepared = await preparation.prepare({
      title: 'Scheduled reading digest',
      articleIds: [first.archiveArticle.id, second.archiveArticle.id],
      trigger: 'scheduled',
    });
    assert.equal(prepared.collection.collection.createdBy, 'scheduled');
    assert.equal(transport.sent.length, 0);
    const exactBytes = await readFile(prepared.epub.artifactPath);

    const preview = await kindle.previewPreparedCollection(
      prepared.collection.collection.id,
      prepared.epub.record.id,
    );
    assert.equal(preview.contentHash, versionedSha256(exactBytes));
    await assert.rejects(
      () => kindle.deliver(preview, { confirmedAt: '', confirmationMethod: 'interactive' }),
      /requires interactive confirmation/u,
    );
    assert.equal(transport.sent.length, 0);
    const delivered = await kindle.deliver(preview, {
      confirmedAt: '2026-09-06T06:01:00Z',
      confirmationMethod: 'interactive',
    });
    assert.equal(delivered.record.collectionId, prepared.collection.collection.id);
    assert.equal(delivered.record.delivery?.preparedExportId, prepared.epub.record.id);
    assert.equal(transport.sent.length, 1);
    assert.deepEqual(transport.sent[0]?.content, new Uint8Array(exactBytes));
    assert.equal(versionedSha256(transport.sent[0]!.content), preview.contentHash);
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});

test('/reads prepares a selected reading pack locally without invoking Kindle delivery', async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-command-pack-'));
  const previousLibrary = process.env.PI_READS_LIBRARY_DIR;
  process.env.PI_READS_LIBRARY_DIR = libraryDir;
  const library = new LibraryService({ libraryDir });
  const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
  const notifications: string[] = [];
  const selections = [
    'Reading pack — ordered multi-article EPUB',
    0,
    0,
  ];
  const pi = {
    registerCommand(name: string, command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  registerReadsCommands(pi);
  try {
    await library.capture({ kind: 'text', text: 'First command article.', label: 'First command' });
    await library.capture({ kind: 'text', text: 'Second command article.', label: 'Second command' });
    const context = {
      cwd: process.cwd(),
      hasUI: true,
      mode: 'tui',
      ui: {
        async select(_title: string, options: string[]) {
          const choice = selections.shift();
          return typeof choice === 'number' ? options[choice] : choice;
        },
        async input() { return 'Command reading pack'; },
        notify(message: string) { notifications.push(message); },
        setStatus() {},
      },
    } as unknown as ExtensionCommandContext;
    await commands.get('reads')!.handler('', context);
    assert.match(notifications.at(-1) ?? '', /No email was sent/u);
    const collectionIds = await readdir(path.join(libraryDir, 'collections'));
    assert.equal(collectionIds.length, 1);
    const exportIds = await readdir(path.join(libraryDir, 'exports', collectionIds[0]!));
    assert.equal(exportIds.length, 1);
  } finally {
    if (previousLibrary === undefined) delete process.env.PI_READS_LIBRARY_DIR;
    else process.env.PI_READS_LIBRARY_DIR = previousLibrary;
    await rm(libraryDir, { recursive: true, force: true });
  }
});

test('scheduled digest CLI accepts only local preparation arguments', () => {
  assert.deepEqual(parseScheduledDigestArguments([
    '--title', 'Morning pack',
    '--article', 'art_aaaaaaaaaaaaaaaa',
    '--article', 'art_bbbbbbbbbbbbbbbb',
    '--library', './library',
  ]), {
    title: 'Morning pack',
    articleIds: ['art_aaaaaaaaaaaaaaaa', 'art_bbbbbbbbbbbbbbbb'],
    libraryDir: './library',
  });
  assert.throws(
    () => parseScheduledDigestArguments(['--title', 'Unsafe', '--article', 'art_aaaaaaaaaaaaaaaa', '--article', 'art_bbbbbbbbbbbbbbbb', '--send']),
    /Unsupported scheduled digest argument/u,
  );
});
