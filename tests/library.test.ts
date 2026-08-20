import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  defaultLibraryDir,
  expandLeadingTilde,
  parseConfig,
  resolveConfigPath,
  resolveConfiguration,
} from '../src/core/config.ts';
import type { ArticleRecord, Sha256Digest, SourceRecord } from '../src/core/domain.ts';
import {
  articleContentPath,
  assertArticleInvariants,
  assertSafeLibraryRoot,
  chooseAvailableSlug,
  createRecordId,
  resolveLibraryPath,
  sourceContentPath,
  writeLibraryFileCreateOnly,
} from '../src/core/library.ts';

const digest = `sha256:${'a'.repeat(64)}` as Sha256Digest;

function sourceRecord(): SourceRecord {
  return {
    schemaVersion: 1,
    id: 'src_aaaaaaaaaaaaaaaa',
    kind: 'text',
    capturedAt: '2026-08-20T00:00:00Z',
    origin: { locator: 'fixture' },
    content: {
      path: sourceContentPath('src_aaaaaaaaaaaaaaaa'),
      mediaType: 'text/markdown',
      contentHash: digest,
      textHash: digest,
      byteLength: 7,
    },
    capture: { adapter: 'fixture' },
  };
}

function archiveArticle(): ArticleRecord {
  return {
    schemaVersion: 1,
    id: 'art_bbbbbbbbbbbbbbbb',
    mode: 'archive',
    title: 'Fixture',
    slug: 'fixture',
    sourceIds: ['src_aaaaaaaaaaaaaaaa'],
    body: {
      path: articleContentPath('archive', 'art_bbbbbbbbbbbbbbbb'),
      mediaType: 'text/markdown',
      contentHash: digest,
      textHash: digest,
      byteLength: 7,
    },
    citations: [],
    createdAt: '2026-08-20T00:00:00Z',
    archiveVerification: {
      sourceId: 'src_aaaaaaaaaaaaaaaa',
      sourceTextHash: digest,
    },
  };
}

test('library paths physically separate archive and generated content', () => {
  const articleId = 'art_bbbbbbbbbbbbbbbb';
  assert.equal(articleContentPath('archive', articleId), `articles/archive/${articleId}/content.md`);
  assert.equal(articleContentPath('digest', articleId), `articles/digest/${articleId}/content.md`);
  assert.equal(articleContentPath('synthesis', articleId), `articles/synthesis/${articleId}/content.md`);
  assert.notEqual(articleContentPath('archive', articleId), articleContentPath('digest', articleId));
});

test('slug collisions are deterministic and IDs are opaque', () => {
  assert.equal(chooseAvailableSlug('An Example!', []), 'an-example');
  assert.equal(chooseAvailableSlug('An Example!', ['an-example', 'an-example-2']), 'an-example-3');
  assert.equal(createRecordId('src', '12345678-1234-1234-1234-123456789abc'), 'src_12345678123412341234123456789abc');
});

test('library path resolution rejects traversal, absolute paths, and backslashes', () => {
  const root = path.join(os.tmpdir(), 'pi-reads-library');
  assert.equal(resolveLibraryPath(root, 'sources/src_aaaaaaaaaaaaaaaa/content.md'), path.join(root, 'sources', 'src_aaaaaaaaaaaaaaaa', 'content.md'));
  assert.throws(() => resolveLibraryPath(root, '../outside'), /Unsafe library path/);
  assert.throws(() => resolveLibraryPath(root, '/tmp/outside'), /must be relative/);
  assert.throws(() => resolveLibraryPath(root, 'sources\\outside'), /forward slashes/);
});

test('production libraries reject Git working trees by default', async () => {
  const outsideGit = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-safe-root-'));
  try {
    await assert.doesNotReject(() => assertSafeLibraryRoot(outsideGit));
    await assert.rejects(() => assertSafeLibraryRoot(process.cwd()), /inside Git working tree/);
    await assert.doesNotReject(() => assertSafeLibraryRoot(process.cwd(), { allowGitWorkingTree: true }));
  } finally {
    await rm(outsideGit, { recursive: true, force: true });
  }
});

test('library writes reject symlinks that escape the configured root', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-symlink-'));
  const root = path.join(parent, 'library');
  const outside = path.join(parent, 'outside');
  try {
    await mkdir(path.join(root, 'sources'), { recursive: true });
    await mkdir(outside);
    await symlink(outside, path.join(root, 'sources', 'escaped'), 'dir');
    await assert.rejects(
      () => writeLibraryFileCreateOnly(root, 'sources/escaped/content.md', 'unsafe'),
      /crosses a symlink outside/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('create-only library writes are atomic and never overwrite', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-library-'));
  const relative = 'sources/src_aaaaaaaaaaaaaaaa/content.md';
  try {
    const target = await writeLibraryFileCreateOnly(root, relative, 'first');
    assert.equal(await readFile(target, 'utf8'), 'first');
    await assert.rejects(() => writeLibraryFileCreateOnly(root, relative, 'second'), /already exists/);
    assert.equal(await readFile(target, 'utf8'), 'first');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('article invariants reject archive/generated mixing and invalid citations', () => {
  const source = sourceRecord();
  const sources = new Map([[source.id, source]]);
  const archive = archiveArticle();
  assert.doesNotThrow(() => assertArticleInvariants(archive, sources));

  assert.throws(
    () => assertArticleInvariants({ ...archive, generatedBy: { provider: 'x', model: 'y', generatedAt: archive.createdAt } }, sources),
    /without generation metadata/,
  );

  const generated: ArticleRecord = {
    ...archive,
    mode: 'digest',
    body: { ...archive.body, path: articleContentPath('digest', archive.id) },
    archiveVerification: undefined,
    generatedBy: { provider: 'fixture', model: 'fixture', generatedAt: archive.createdAt },
    citations: [{ id: 'cite_fixture', sourceId: source.id }],
  };
  assert.doesNotThrow(() => assertArticleInvariants(generated, sources));
  assert.throws(
    () => assertArticleInvariants({ ...generated, citations: [{ id: 'cite_bad', sourceId: 'src_cccccccccccccccc' }] }, sources),
    /outside the article/,
  );
});

test('configuration follows explicit, environment, config, and default precedence', async () => {
  const home = path.join(os.tmpdir(), 'pi-reads-home');
  const cwd = path.join(os.tmpdir(), 'pi-reads-cwd');

  assert.equal(expandLeadingTilde('~/Library', home), path.join(home, 'Library'));
  assert.equal(defaultLibraryDir(home), path.join(home, 'Documents', 'pi-reads'));
  assert.equal(
    resolveConfigPath({ homeDir: home, cwd, env: { XDG_CONFIG_HOME: '~/config' } }),
    path.join(home, 'config', 'pi-reads', 'pi-reads.json'),
  );
  assert.deepEqual(parseConfig({ schemaVersion: 1, defaults: { mode: 'archive', exportFormat: 'pdf' } }), {
    schemaVersion: 1,
    defaults: { mode: 'archive', exportFormat: 'pdf' },
  });
  assert.throws(() => parseConfig({ schemaVersion: 1, defaults: { mode: 'rewrite' } }), /Unsupported default article mode/);
  assert.throws(() => parseConfig({ schemaVersion: 1, secret: 'never' }), /unsupported property secret/);

  const resolved = await resolveConfiguration({
    homeDir: home,
    cwd,
    env: { PI_READS_LIBRARY_DIR: './library', PI_READS_CONFIG: './missing.json' },
  });
  assert.equal(resolved.configPath, path.join(cwd, 'missing.json'));
  assert.equal(resolved.libraryDir, path.join(cwd, 'library'));
});
