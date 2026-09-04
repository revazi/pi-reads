import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MaintenanceService } from '../src/application/maintenance-service.ts';
import { LibraryService } from '../src/application/library-service.ts';
import { ExportService } from '../src/application/export-service.ts';
import { UserStateService } from '../src/application/user-state-service.ts';
import { inspectLibrary } from '../src/application/library-verification.ts';
import { walkMaintenanceFiles } from '../src/core/maintenance-files.ts';
import { versionedSha256 } from '../src/core/text.ts';
import { analyzeMarkdown } from '../src/core/ingest/text.ts';
import type { ArticleRecord, ExportRecord } from '../src/core/domain.ts';

async function fixture(t: test.TestContext) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pi-reads-maintenance-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'library');
  const library = new LibraryService({ libraryDir: root });
  const capture = await library.capture({ kind: 'text', label: 'Fixture', text: 'Exact maintenance evidence.' });
  const { index } = await library.loadSourceIndex(capture.source.id);
  const generated = await library.saveGenerated({
    mode: 'digest', title: 'Fixture digest', body: 'Grounded evidence.[^cite_fixture]',
    sourceIds: [capture.source.id],
    citations: [{ id: 'cite_fixture', sourceId: capture.source.id, quote: 'Exact maintenance evidence', locator: { paragraph: 1 } }],
    coverage: { policy: 'complete', sources: [{ sourceId: capture.source.id, sourceContentHash: index.sourceContentHash, consideredLocators: [...index.headings, ...index.paragraphs].map(({ id }) => id) }] },
    generatedBy: { provider: 'fixture', model: 'fixture', generatedAt: '2026-09-03T00:00:00.000Z' },
  });
  const state = new UserStateService({ library });
  await state.update({ articleId: generated.article.id, expectedRevision: 0, patch: { status: 'reading', tags: ['fixture'], priority: 3 } });
  const exported = await new ExportService({ library }).prepare(generated.article.id, 'markdown');
  const service = new MaintenanceService(root);
  return { parent, root, library, service, capture, generated, exported };
}

async function diskSnapshot(root: string): Promise<Record<string, string>> {
  const files = await walkMaintenanceFiles(root, '');
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, versionedSha256(await readFile(path.join(root, file)))])));
}

test('maintenance round trip preserves all canonical bytes, citations, raw input, exports, assets and state; excludes secrets', async (t) => {
  const f = await fixture(t);
  // Add a manifest-referenced binary asset, never an arbitrary directory copy.
  const assetPath = `sources/${f.capture.source.id}/assets/fixture.bin`;
  const asset = Buffer.from([0, 1, 2, 255]);
  await mkdir(path.dirname(path.join(f.root, assetPath)), { recursive: true });
  await writeFile(path.join(f.root, assetPath), asset);
  const source = JSON.parse(await readFile(f.capture.sourceManifestPath, 'utf8'));
  source.assets = [{ path: assetPath, mediaType: 'application/octet-stream', byteLength: asset.length, contentHash: versionedSha256(asset) }];
  await writeFile(f.capture.sourceManifestPath, JSON.stringify(source));
  await writeFile(path.join(f.root, '.env'), 'SMTP_PASSWORD=secret-sentinel');
  await writeFile(path.join(f.root, 'pi-reads.json'), '{"password":"secret-sentinel"}');
  await f.service.rebuild();
  const before = await diskSnapshot(f.root);
  const report = await f.service.verify();
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.warningCount, 0, JSON.stringify(report));
  const backup = path.join(f.parent, 'backup');
  await f.service.backup(backup, {
    schemaVersion: 1, libraryDir: '/private/path', defaults: { mode: 'digest', exportFormat: 'epub' },
    kindle: { deviceLabel: 'secret-sentinel', smtp: { passwordEnv: 'secret-sentinel' } },
    obsidian: { vaultPath: '/private/vault', frontmatter: { token: 'secret-sentinel' } },
  });
  assert.deepEqual(await diskSnapshot(f.root), before, 'backup and verification are read-only');
  const snapshot = JSON.parse(await readFile(path.join(backup, 'snapshot.json'), 'utf8'));
  assert.deepEqual(snapshot.config, { schemaVersion: 1, defaults: { mode: 'digest', exportFormat: 'epub' } });
  for (const name of await walkMaintenanceFiles(backup, '')) assert.doesNotMatch(await readFile(path.join(backup, name), 'utf8'), /secret-sentinel/u);
  const restoredRoot = path.join(f.parent, 'restored');
  const restored = await new MaintenanceService(restoredRoot).restore(backup);
  assert.equal(restored.verification.warningCount, 0);
  for (const file of snapshot.files) assert.deepEqual(await readFile(path.join(restoredRoot, file.path)), await readFile(path.join(f.root, file.path)));
  assert.deepEqual((await new LibraryService({ libraryDir: restoredRoot }).loadArticle(f.generated.article.id)).article, f.generated.article);
  assert.equal((await new UserStateService({ library: new LibraryService({ libraryDir: restoredRoot }) }).get(f.generated.article.id)).status, 'reading');
  await assert.rejects(() => new MaintenanceService(restoredRoot).restore(backup), /EEXIST/u);
  await assert.rejects(() => f.service.backup(backup), /EEXIST/u);
  const empty = path.join(f.parent, 'empty'); await mkdir(empty);
  await assert.rejects(() => new MaintenanceService(empty).restore(backup), /EEXIST/u);
  assert.deepEqual(await diskSnapshot(empty), {});
});

test('verification reports corruption without repairing indexes; rebuild repairs every derived index only', async (t) => {
  const f = await fixture(t);
  const verified = await inspectLibrary(f.root, false);
  assert.equal(verified.report.ok, true, JSON.stringify(verified.report));
  const originals = new Map(await Promise.all(verified.files.map(async (file) => [file.path, await readFile(path.join(f.root, file.path))] as const)));
  await writeFile(path.join(f.root, 'indexes/library.json'), '{}');
  await writeFile(path.join(f.root, 'indexes/search-v1.json'), '{}');
  await writeFile(path.join(f.root, `indexes/sources/${f.capture.source.id}/structure-v1.json`), '{}');
  await writeFile(path.join(f.root, 'indexes/dirty'), 'interrupted');
  const before = await diskSnapshot(f.root);
  const report = await f.service.verify();
  assert.equal(report.ok, true);
  assert.equal(report.warningCount, 3, JSON.stringify(report));
  assert.deepEqual(await diskSnapshot(f.root), before);
  const rebuilt = await f.service.rebuild();
  assert.equal(rebuilt.sourceIndexes, 1);
  assert.equal(rebuilt.searchDocuments, 2);
  assert.equal((await f.service.verify()).warningCount, 0);
  for (const [name, bytes] of originals) assert.deepEqual(await readFile(path.join(f.root, name)), bytes);
});

test('tampered prose and invalid schemas fail verification and backup closed with bounded diagnostics', async (t) => {
  const f = await fixture(t);
  await writeFile(f.capture.sourceContentPath, 'Changed immutable evidence.');
  const report = await f.service.verify();
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === 'integrity'));
  const backup = path.join(f.parent, 'bad-backup');
  await assert.rejects(() => f.service.backup(backup), /verification failed/u);
  await assert.rejects(() => f.service.rebuild(), /verification failed/u);
  await assert.rejects(() => readFile(path.join(backup, 'snapshot.json')), /ENOENT/u);
  for (let i = 0; i < 65; i++) {
    const dir = path.join(f.root, `sources/src_${i.toString().padStart(16, '0')}`);
    await mkdir(dir); await writeFile(path.join(dir, 'manifest.json'), '{"secret":"do-not-echo"}');
  }
  const bounded = await f.service.verify();
  assert.equal(bounded.findings.length, 50);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.errorCount > 50);
  assert.doesNotMatch(JSON.stringify(bounded), /do-not-echo|Changed immutable/u);
});

test('restore rejects tampered inventories, path traversal, duplicate paths and extra files before creating a destination', async (t) => {
  const f = await fixture(t);
  const backup = path.join(f.parent, 'backup'); await f.service.backup(backup);
  const manifestPath = path.join(backup, 'snapshot.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const target = path.join(f.parent, 'restored');
  const restore = () => new MaintenanceService(target).restore(backup);
  for (const change of [
    (value: typeof manifest) => { value.files[0].path = '../escape'; },
    (value: typeof manifest) => { value.files.push(value.files[0]); },
    (value: typeof manifest) => { value.files[0].contentHash = `sha256:${'0'.repeat(64)}`; },
    (value: typeof manifest) => { value.config.kindle = { smtp: { password: 'do-not-restore' } }; },
  ]) {
    const changed = structuredClone(manifest); change(changed);
    await writeFile(manifestPath, JSON.stringify(changed)); await assert.rejects(restore);
    await assert.rejects(() => readFile(path.join(target, 'portable-config.json')), /ENOENT/u);
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(path.join(backup, 'unexpected-secret'), 'secret');
  await assert.rejects(restore, /unexpected files/u);
  await rm(path.join(backup, 'unexpected-secret'));
  await writeFile(path.join(backup, 'library', manifest.files[0].path), 'tampered');
  await assert.rejects(restore, /hash or byte length/u);
});

test('maintenance rejects symlink reads/writes, nested destinations, missing roots and empty record directories', async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.service.backup(path.join(f.root, 'backup')), /non-nested/u);
  const missing = await new MaintenanceService(path.join(f.parent, 'missing')).verify();
  assert.equal(missing.ok, false);
  const linked = path.join(f.parent, 'linked'); await symlink(f.root, linked, 'dir');
  assert.equal((await new MaintenanceService(linked).verify()).ok, false);
  await assert.rejects(() => f.service.backup(path.join(linked, 'outside')), /Symbolic links/u);
  await rm(path.join(f.root, 'indexes'), { recursive: true });
  const outside = path.join(f.parent, 'outside'); await mkdir(outside);
  await symlink(outside, path.join(f.root, 'indexes'), 'dir');
  await assert.rejects(() => f.service.rebuild(), /Symbolic links/u);
  assert.deepEqual(await diskSnapshot(outside), {});
  await rm(f.capture.sourceContentPath);
  await symlink(path.join(f.parent, 'secret'), f.capture.sourceContentPath);
  assert.equal((await f.service.verify()).ok, false);
  await rm(f.capture.sourceContentPath);
  const empty = path.join(f.root, 'sources/src_0000000000000000'); await mkdir(empty);
  assert.equal((await f.service.verify()).ok, false);
});

test('semantic verification catches archive fidelity and citation/coverage tampering even with recomputed content hashes', async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.generated.manifestPath);
  const mutate = async (change: (article: ArticleRecord) => void) => {
    const article = JSON.parse(original.toString('utf8')) as ArticleRecord;
    change(article);
    await writeFile(f.generated.manifestPath, JSON.stringify(article));
    assert.equal((await f.service.verify()).ok, false);
  };
  await mutate((article) => { article.citations[0]!.quote = 'Fabricated evidence'; });
  await mutate((article) => { article.citations[0]!.locator = { paragraph: 999 }; });
  await mutate((article) => { article.sourceCoverage!.sources[0]!.indexLocatorHash = `sha256:${'0'.repeat(64)}`; });
  await mutate((article) => { article.supersedesArticleId = article.id; });
  await writeFile(f.generated.manifestPath, original);
  const archive = JSON.parse(await readFile(f.capture.articleManifestPath, 'utf8')) as ArticleRecord;
  const changed = 'Rewritten archive prose.';
  archive.body = { ...archive.body, ...analyzeMarkdown(changed), byteLength: Buffer.byteLength(changed) };
  await writeFile(f.capture.articleContentPath, changed);
  await writeFile(f.capture.articleManifestPath, JSON.stringify(archive));
  assert.equal((await f.service.verify()).ok, false);
});

test('verification catches duplicate IDs across modes, orphan state, missing raw captures and export references', async (t) => {
  const f = await fixture(t);
  const orphan = 'art_0000000000000000';
  const orphanPath = path.join(f.root, `state/articles/${orphan}.json`);
  await writeFile(orphanPath, JSON.stringify({ schemaVersion: 1, articleId: orphan, revision: 1, status: 'unread', tags: [], priority: 0, updatedAt: '2026-09-03T00:00:00Z' }));
  assert.ok((await f.service.verify()).findings.some((finding) => finding.code === 'state'));
  await rm(orphanPath);
  const copied = structuredClone(f.generated.article);
  copied.mode = 'synthesis';
  copied.body.path = `articles/synthesis/${copied.id}/content.md`;
  const copiedDir = path.join(f.root, `articles/synthesis/${copied.id}`);
  await mkdir(copiedDir, { recursive: true });
  await writeFile(path.join(copiedDir, 'manifest.json'), JSON.stringify(copied));
  await writeFile(path.join(copiedDir, 'content.md'), f.generated.content);
  assert.equal((await f.service.verify()).ok, false);
  await rm(copiedDir, { recursive: true });
  const exportRecord = JSON.parse(await readFile(f.exported.manifestPath, 'utf8')) as ExportRecord;
  exportRecord.articleId = orphan;
  await writeFile(f.exported.manifestPath, JSON.stringify(exportRecord));
  assert.equal((await f.service.verify()).ok, false);
  await writeFile(f.exported.manifestPath, JSON.stringify(f.exported.record));
  await rm(path.join(f.root, f.capture.source.rawCapture!.path));
  assert.ok((await f.service.verify()).findings.some((finding) => finding.code === 'integrity'));
});

test('portable restore supports historical generated records and shared prepared Kindle artifact references without delivery', async (t) => {
  const f = await fixture(t);
  const legacy = structuredClone(f.generated.article);
  delete legacy.sourceCoverage; delete legacy.citationDiagnostics;
  await writeFile(f.generated.manifestPath, JSON.stringify(legacy));
  const id = 'exp_0000000000000000';
  const dir = path.join(f.root, `exports/${f.generated.article.id}/${id}`);
  await mkdir(dir);
  const record: ExportRecord = {
    ...f.exported.record, id, destination: { type: 'kindle' }, status: 'failed',
    delivery: { preparedExportId: f.exported.record.id, failure: 'Fixture transport failed' },
  };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(record));
  const backup = path.join(f.parent, 'backup');
  await f.service.backup(backup);
  const result = await new MaintenanceService(path.join(f.parent, 'restored')).restore(backup);
  assert.equal(result.verification.exportCount, 2);
  assert.equal(result.verification.warningCount, 0);
  record.delivery!.preparedExportId = id;
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(record));
  assert.equal((await f.service.verify()).ok, false);
});

test('restore revalidates record relationships even when an attacker recomputes snapshot hashes', async (t) => {
  const f = await fixture(t);
  const backup = path.join(f.parent, 'backup'); await f.service.backup(backup);
  const snapshotPath = path.join(backup, 'snapshot.json');
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  const relative = path.relative(f.root, f.generated.manifestPath).split(path.sep).join('/');
  const record = structuredClone(f.generated.article);
  record.citations[0]!.sourceId = 'src_0000000000000000';
  const bytes = Buffer.from(JSON.stringify(record));
  await writeFile(path.join(backup, 'library', relative), bytes);
  const file = snapshot.files.find((entry: { path: string }) => entry.path === relative);
  file.contentHash = versionedSha256(bytes); file.byteLength = bytes.length;
  await writeFile(snapshotPath, JSON.stringify(snapshot));
  const target = path.join(f.parent, 'restored');
  await assert.rejects(() => new MaintenanceService(target).restore(backup), /verification failed/u);
  await assert.rejects(() => readFile(path.join(target, relative)), /ENOENT/u);
});

test('maintenance CLI works from another cwd, emits bounded JSON, and requires an explicit restore destination', async (t) => {
  const f = await fixture(t);
  const script = fileURLToPath(new URL('../scripts/maintain-library.ts', import.meta.url));
  const invoke = (...args: string[]) => spawnSync(process.execPath, [script, ...args], {
    cwd: f.parent, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PI_READS_CONFIG: path.join(f.parent, 'absent-config.json') },
  });
  const rebuilt = invoke('rebuild', '--library', f.root);
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  const verified = invoke('verify', '--library', f.root);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).warningCount, 0);
  const backup = path.join(f.parent, 'cli-backup');
  const backedUp = invoke('backup', '--library', f.root, '--backup', backup);
  assert.equal(backedUp.status, 0, backedUp.stderr);
  const implicit = invoke('restore', '--backup', backup);
  assert.equal(implicit.status, 1);
  assert.match(implicit.stderr, /explicit --library/u);
  const restored = invoke('restore', '--backup', backup, '--library', path.join(f.parent, 'cli-restored'));
  assert.equal(restored.status, 0, restored.stderr);
  await writeFile(f.capture.sourceContentPath, 'corrupt private prose');
  const corrupt = invoke('verify', '--library', f.root);
  assert.equal(corrupt.status, 1);
  assert.equal(JSON.parse(corrupt.stdout).ok, false);
  assert.doesNotMatch(corrupt.stdout, /corrupt private prose/u);
});

test('concurrent backup/restore reservations allow one writer and never remove a colliding destination', async (t) => {
  const f = await fixture(t);
  const backup = path.join(f.parent, 'backup');
  const backups = await Promise.allSettled([f.service.backup(backup), f.service.backup(backup)]);
  assert.equal(backups.filter((result) => result.status === 'fulfilled').length, 1);
  const target = path.join(f.parent, 'restored');
  const restores = await Promise.allSettled([
    new MaintenanceService(target).restore(backup), new MaintenanceService(target).restore(backup),
  ]);
  assert.equal(restores.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await new MaintenanceService(target).verify()).ok, true);
  const repo = path.join(f.parent, 'repo'); await mkdir(path.join(repo, '.git'), { recursive: true });
  await assert.rejects(() => f.service.backup(path.join(repo, 'backup')), /Git working tree/u);
  await assert.rejects(() => new MaintenanceService(path.join(repo, 'restored')).restore(backup), /Git working tree/u);
});
