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
import { UserStateService } from '../src/application/user-state-service.ts';
import { downloadImageAsset } from '../src/adapters/destinations/obsidian.ts';

function deterministicIds(): (prefix: RecordIdPrefix) => string {
  const counts: Record<RecordIdPrefix, number> = { src: 0, art: 0, cite: 0, exp: 0 };
  const letters: Record<RecordIdPrefix, string> = { src: 'o', art: 'p', cite: 'q', exp: 'r' };
  return (prefix) => {
    counts[prefix] += 1;
    return `${prefix}_${letters[prefix].repeat(15)}${counts[prefix].toString(36)}`;
  };
}

test('Obsidian image downloads reject local and credential-bearing URLs before fetching', async () => {
  await assert.rejects(() => downloadImageAsset('http://127.0.0.1/image.png'), /private or non-routable/);
  await assert.rejects(() => downloadImageAsset('http://[::1]/image.png'), /private or non-routable/);
  await assert.rejects(() => downloadImageAsset('https://user:secret@example.com/image.png'), /must not contain credentials/);
});

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
  const userState = new UserStateService({ library, now });
  const fetched: string[] = [];
  const obsidian = new ObsidianService({
    library,
    exports,
    createId,
    now,
    userState,
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

    await userState.update({
      articleId: capture.archiveArticle.id,
      expectedRevision: 0,
      patch: {
        status: 'reading',
        tags: ['architecture'],
        priority: 4,
        dueAt: '2026-08-25',
      },
    });
    const { index: sourceIndex } = await library.loadSourceIndex(capture.source.id);
    const synthesis = await library.saveGenerated({
      mode: 'synthesis',
      title: 'Obsidian synthesis',
      body: 'A connected observation.[^cite_graph]',
      sourceIds: [capture.source.id],
      citations: [{ id: 'cite_graph', sourceId: capture.source.id, quote: 'Faithful prose.' }],
      coverage: {
        policy: 'targeted',
        sources: [{
          sourceId: capture.source.id,
          sourceContentHash: sourceIndex.sourceContentHash,
          consideredLocators: [sourceIndex.paragraphs[0]!.id],
        }],
      },
      generatedBy: { provider: 'fixture', model: 'fixture', generatedAt: now().toISOString() },
    });
    const synthesisPlan = await obsidian.plan(synthesis.article.id, config);
    const synthesisExport = await obsidian.deliver(synthesisPlan);
    await userState.update({
      articleId: synthesis.article.id,
      expectedRevision: 0,
      patch: {
        tags: ['architecture', 'synthesis'],
        priority: 5,
        readLaterAt: '2026-08-24',
      },
    });

    const archiveBeforeGraph = await readFile(overwritten.notePath);
    const graphPlan = await obsidian.planGraph(config);
    assert.deepEqual(graphPlan.unmanagedConflicts, []);
    assert.deepEqual([...graphPlan.inspection.missing].sort(), [
      'Pi Reads/Library.md',
      'Pi Reads/Reading Queue.md',
      'Pi Reads/Reading Status.md',
      'Pi Reads/Topics.md',
    ]);
    assert.deepEqual(graphPlan.inspection.conflicts, [synthesisExport.noteRelativePath]);
    await assert.rejects(() => obsidian.deliverGraph(graphPlan), ObsidianConflictError);
    const graph = await obsidian.deliverGraph(graphPlan, { overwrite: true });
    assert.equal(graph.linkedArticleCount, 2);
    assert.equal(graph.relationshipCount, 1);
    assert.equal(graph.changedPaths.length, 5);
    assert.deepEqual(await readFile(overwritten.notePath), archiveBeforeGraph);
    assert.match(
      await readFile(synthesisExport.notePath, 'utf8'),
      /## Pi Reads source notes[\s\S]*\[article\]\(article\.md\)/u,
    );
    assert.match(await readFile(path.join(vaultPath, 'Pi Reads/Topics.md'), 'utf8'), /## architecture/u);
    assert.match(await readFile(path.join(vaultPath, 'Pi Reads/Reading Status.md'), 'utf8'), /## reading/u);
    assert.match(await readFile(path.join(vaultPath, 'Pi Reads/Reading Queue.md'), 'utf8'), /Obsidian synthesis[\s\S]*\[article\]/u);
    assert.equal(await readFile(path.join(vaultPath, 'Unrelated.md'), 'utf8'), 'Do not change.');

    const repeatedGraphPlan = await obsidian.planGraph(config);
    assert.equal(repeatedGraphPlan.inspection.conflicts.length, 0);
    assert.equal(repeatedGraphPlan.inspection.unchanged.length, 5);
    const repeatedGraph = await obsidian.deliverGraph(repeatedGraphPlan);
    assert.deepEqual(repeatedGraph.changedPaths, []);

    const topicsPath = path.join(vaultPath, 'Pi Reads/Topics.md');
    await writeFile(topicsPath, `${await readFile(topicsPath, 'utf8')}\nManual managed edit.\n`);
    const managedConflict = await obsidian.planGraph(config);
    assert.deepEqual(managedConflict.inspection.conflicts, ['Pi Reads/Topics.md']);
    assert.deepEqual(managedConflict.unmanagedConflicts, []);
    await assert.rejects(() => obsidian.deliverGraph(managedConflict), ObsidianConflictError);
    await writeFile(topicsPath, `${await readFile(topicsPath, 'utf8')}Changed after preview.\n`);
    await assert.rejects(
      () => obsidian.deliverGraph(managedConflict, { overwrite: true }),
      /changed after preview/u,
    );
    await obsidian.deliverGraph(await obsidian.planGraph(config), { overwrite: true });

    const libraryIndexPath = path.join(vaultPath, 'Pi Reads/Library.md');
    await writeFile(libraryIndexPath, 'Unrelated replacement.');
    const unmanagedConflict = await obsidian.planGraph(config);
    assert.deepEqual(unmanagedConflict.unmanagedConflicts, ['Pi Reads/Library.md']);
    await assert.rejects(
      () => obsidian.deliverGraph(unmanagedConflict, { overwrite: true }),
      /will not overwrite unmanaged files/u,
    );
    assert.equal(await readFile(libraryIndexPath, 'utf8'), 'Unrelated replacement.');

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
