import assert from 'node:assert/strict';
import test from 'node:test';
import { buildObsidianGraphFiles, type ObsidianGraphEntry } from '../src/core/obsidian-graph.ts';
import { defaultArticleUserState } from '../src/core/user-state.ts';
import type { ArticleRecord } from '../src/core/domain.ts';

function article(id: string, mode: ArticleRecord['mode'], title: string, sourceIds: string[]): ArticleRecord {
  return {
    schemaVersion: 1,
    id,
    mode,
    title,
    slug: title.toLowerCase().replace(/\s+/gu, '-'),
    sourceIds,
    body: {
      path: `articles/${mode}/${id}/content.md`,
      mediaType: 'text/markdown',
      contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      textHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      byteLength: 1,
    },
    citations: [],
    createdAt: '2026-08-20T00:00:00.000Z',
  };
}

function entry(
  id: string,
  mode: ArticleRecord['mode'],
  title: string,
  sourceIds: string[],
  noteRelativePath: string,
  state: Partial<ObsidianGraphEntry['state']> = {},
): ObsidianGraphEntry {
  return {
    article: article(id, mode, title, sourceIds),
    state: { ...defaultArticleUserState(id), ...state },
    noteRelativePath,
    exportedNote: `---\n"piReadsArticleId": ${JSON.stringify(id)}\n---\n\nBody for ${title}.\n`,
  };
}

test('Obsidian graph files are deterministic metadata views with synthesis-to-source links', () => {
  const entries = [
    entry('art_aaaaaaaaaaaaaaaa', 'archive', 'Source [A]', ['src_aaaaaaaaaaaaaaaa'], 'Reading/Source A.md', {
      status: 'reading', tags: ['architecture'], priority: 3,
    }),
    entry('art_bbbbbbbbbbbbbbbb', 'synthesis', 'Connected ideas', ['src_aaaaaaaaaaaaaaaa'], 'Reading/Connected.md', {
      tags: ['architecture', 'synthesis'], priority: 5,
    }),
  ];
  const first = buildObsidianGraphFiles(entries);
  assert.deepEqual(buildObsidianGraphFiles([...entries].reverse()), first);
  assert.deepEqual(first.map(({ relativePath }) => relativePath), [
    'Pi Reads/Library.md',
    'Pi Reads/Topics.md',
    'Pi Reads/Reading Status.md',
    'Pi Reads/Reading Queue.md',
    'Reading/Connected.md',
  ]);
  assert.doesNotMatch(first.map(({ relativePath }) => relativePath).join('\n'), /Source A\.md/u);
  assert.match(first[1]!.contents, /## architecture/u);
  assert.ok(first[3]!.contents.indexOf('Connected ideas') < first[3]!.contents.indexOf('Source \\[A\\]'));
  assert.ok(first[4]!.contents.startsWith(entries[1]!.exportedNote));
  assert.ok(first[4]!.contents.includes('## Pi Reads source notes'));
  assert.ok(first[4]!.contents.includes('[Source \\[A\\]](Source%20A.md)'));
});

test('Obsidian graph refuses a fixed view path that collides with an exported synthesis', () => {
  assert.throws(
    () => buildObsidianGraphFiles([
      entry('art_cccccccccccccccc', 'synthesis', 'Library collision', ['src_cccccccccccccccc'], 'Pi Reads/Library.md'),
      entry('art_dddddddddddddddd', 'archive', 'Source', ['src_cccccccccccccccc'], 'Reading/Source.md'),
    ]),
    /target collides/u,
  );
});
