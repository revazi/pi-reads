import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ResolvedObsidianConfig } from '../src/core/config.ts';
import type { RecordIdPrefix } from '../src/core/library.ts';
import { ExportService } from '../src/application/export-service.ts';
import { LibraryService } from '../src/application/library-service.ts';
import { ObsidianConflictError, ObsidianService } from '../src/application/obsidian-service.ts';

function deterministicIds(): (prefix: RecordIdPrefix) => string {
  const counts: Record<RecordIdPrefix, number> = { src: 0, art: 0, cite: 0, exp: 0 };
  const letters: Record<RecordIdPrefix, string> = { src: 'o', art: 'p', cite: 'q', exp: 'r' };
  return (prefix) => {
    counts[prefix] += 1;
    return `${prefix}_${letters[prefix].repeat(15)}${counts[prefix].toString(36)}`;
  };
}

test('Obsidian export writes metadata and assets, detects conflicts, and preserves unrelated files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-obsidian-'));
  const libraryDir = path.join(root, 'library');
  const vaultPath = path.join(root, 'vault');
  const sourceDir = path.join(root, 'source');
  await Promise.all([mkdir(vaultPath), mkdir(sourceDir)]);
  await writeFile(path.join(vaultPath, 'Unrelated.md'), 'Do not change.');
  await writeFile(path.join(sourceDir, 'local.png'), Buffer.from([1, 2, 3, 4]));
  await writeFile(path.join(sourceDir, 'html.png'), Buffer.from([8, 9]));
  await writeFile(
    path.join(sourceDir, 'article.md'),
    [
      '# Obsidian Fixture',
      '',
      'Faithful prose.',
      '',
      '![Local diagram](local.png)',
      '',
      '![Remote diagram](https://images.example/remote?id=1)',
      '',
      '<img alt="html.png" src="html.png">',
      '',
      '```md',
      '![Code example](ignored.png)',
      '```',
    ].join('\n'),
  );

  const createId = deterministicIds();
  const now = () => new Date('2026-08-21T10:30:00Z');
  const library = new LibraryService({ libraryDir, createId, now });
  const exports = new ExportService({ library, createId, now });
  const fetched: string[] = [];
  const obsidian = new ObsidianService({
    library,
    exports,
    createId,
    now,
    fetchAsset: async (url) => {
      fetched.push(url);
      return { contents: new Uint8Array([5, 6, 7]), mediaType: 'image/webp' };
    },
  });
  const config: ResolvedObsidianConfig = {
    vaultPath,
    vaultName: 'Fixture Vault',
    inboxFolder: 'Reading Inbox',
    attachmentFolder: 'Attachments/pi-reads',
    noteNameTemplate: '{{title}}',
    tags: ['pi-reads', 'reading'],
    frontmatter: { status: 'unread', priority: 2 },
    openAfterExport: false,
  };

  try {
    const capture = await library.capture({ kind: 'file', path: path.join(sourceDir, 'article.md') });
    const plan = await obsidian.plan(capture.archiveArticle.id, config);
    assert.deepEqual(plan.inspection, {
      conflicts: [],
      unchanged: [],
      missing: [
        'Attachments/pi-reads/article/001-local.png',
        'Attachments/pi-reads/article/002-remote.webp',
        'Attachments/pi-reads/article/003-html.png',
        'Reading Inbox/article.md',
      ],
    });
    assert.deepEqual(fetched, ['https://images.example/remote?id=1']);
    assert.equal(
      plan.openUri,
      'obsidian://open?vault=Fixture+Vault&file=Reading+Inbox%2Farticle.md',
    );

    const delivered = await obsidian.deliver(plan);
    const note = await readFile(delivered.notePath, 'utf8');
    assert.match(note, /"piReadsArticleId": "art_/);
    assert.match(note, /"mode": "archive"/);
    assert.match(note, /"sourceIds": \["src_/);
    assert.match(note, /"tags": \["pi-reads","reading"\]/);
    assert.match(note, /"status": "unread"/);
    assert.match(note, /!\[Local diagram\]\(\.\.\/Attachments\/pi-reads\/article\/001-local\.png\)/);
    assert.match(note, /!\[Remote diagram\]\(\.\.\/Attachments\/pi-reads\/article\/002-remote\.webp\)/);
    assert.match(note, /<img alt="html\.png" src="\.\.\/Attachments\/pi-reads\/article\/003-html\.png">/);
    assert.match(note, /!\[Code example\]\(ignored\.png\)/);
    assert.deepEqual(
      await readFile(path.join(vaultPath, 'Attachments/pi-reads/article/001-local.png')),
      Buffer.from([1, 2, 3, 4]),
    );
    assert.deepEqual(
      await readFile(path.join(vaultPath, 'Attachments/pi-reads/article/002-remote.webp')),
      Buffer.from([5, 6, 7]),
    );
    assert.equal(await readFile(path.join(vaultPath, 'Unrelated.md'), 'utf8'), 'Do not change.');
    assert.equal(delivered.record.destination.type, 'obsidian');
    assert.equal(delivered.record.status, 'delivered');
    assert.deepEqual(
      await readFile(path.join(vaultPath, 'Attachments/pi-reads/article/003-html.png')),
      Buffer.from([8, 9]),
    );
    assert.equal(delivered.record.assets?.length, 3);
    assert.match(await readFile(delivered.artifactPath, 'utf8'), /Faithful prose/);

    const repeatedPlan = await obsidian.plan(capture.archiveArticle.id, config);
    assert.equal(repeatedPlan.inspection.conflicts.length, 0);
    assert.equal(repeatedPlan.inspection.unchanged.length, 4);
    const repeated = await obsidian.deliver(repeatedPlan);
    assert.deepEqual(repeated.changedPaths, []);

    await writeFile(delivered.notePath, 'Rollback sentinel.');
    const collidingService = new ObsidianService({
      library,
      exports,
      now,
      createId: (prefix) => prefix === 'exp' ? delivered.record.id : createId(prefix),
      fetchAsset: async () => ({ contents: new Uint8Array([5, 6, 7]), mediaType: 'image/webp' }),
    });
    const rollbackPlan = await collidingService.plan(capture.archiveArticle.id, config);
    await assert.rejects(
      () => collidingService.deliver(rollbackPlan, { overwrite: true }),
      /already exists/,
    );
    assert.equal(await readFile(delivered.notePath, 'utf8'), 'Rollback sentinel.');

    await writeFile(delivered.notePath, 'Manual vault edit.');
    const conflictPlan = await obsidian.plan(capture.archiveArticle.id, config);
    assert.deepEqual(conflictPlan.inspection.conflicts, ['Reading Inbox/article.md']);
    await assert.rejects(() => obsidian.deliver(conflictPlan), ObsidianConflictError);
    assert.equal(await readFile(delivered.notePath, 'utf8'), 'Manual vault edit.');

    const overwritten = await obsidian.deliver(conflictPlan, {
      overwrite: true,
      confirmedAt: '2026-08-21T10:31:00Z',
    });
    assert.match(await readFile(overwritten.notePath, 'utf8'), /Faithful prose/);
    assert.equal(overwritten.record.delivery?.confirmationMethod, 'interactive');

    const pasted = await library.capture({
      kind: 'markdown',
      label: 'Untrusted local reference',
      markdown: `![Local secret](file://${path.join(sourceDir, 'local.png')})`,
    });
    await assert.rejects(
      () => obsidian.plan(pasted.archiveArticle.id, { ...config, noteNameTemplate: '{{id}}' }),
      /Local image paths require exactly one captured local file source/,
    );

    const outside = path.join(root, 'outside');
    const unsafeVault = path.join(root, 'unsafe-vault');
    await Promise.all([mkdir(outside), mkdir(unsafeVault)]);
    await symlink(outside, path.join(unsafeVault, 'Linked'));
    const unsafeConfig = { ...config, vaultPath: unsafeVault, inboxFolder: 'Linked' };
    await assert.rejects(
      () => obsidian.plan(capture.archiveArticle.id, unsafeConfig),
      /symlink outside the vault/,
    );
    await assert.rejects(() => readFile(path.join(outside, 'article.md')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
