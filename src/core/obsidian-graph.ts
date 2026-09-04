import type { ArticleRecord } from './domain.ts';
import { filterAndSortStatefulArticles, type ArticleUserState } from './user-state.ts';

const OBSIDIAN_GRAPH_FOLDER = 'Pi Reads';
export const OBSIDIAN_GRAPH_MARKER = 'obsidian-graph-v1';

export interface ObsidianGraphEntry {
  article: ArticleRecord;
  state: ArticleUserState;
  noteRelativePath: string;
  exportedNote: string;
}

export interface ObsidianGraphFile {
  relativePath: string;
  contents: string;
  kind: 'view' | 'relationship';
  articleId?: string;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function encodePath(relativePath: string): string {
  return relativePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function escapeLabel(value: string): string {
  return value.replace(/([\\[\]])/gu, '\\$1').replace(/[\r\n]+/gu, ' ');
}

function markdownLink(fromPath: string, entry: ObsidianGraphEntry): string {
  const fromSegments = fromPath.split('/');
  fromSegments.pop();
  const targetSegments = entry.noteRelativePath.split('/');
  while (fromSegments.length && targetSegments.length && fromSegments[0] === targetSegments[0]) {
    fromSegments.shift();
    targetSegments.shift();
  }
  const relative = [...fromSegments.map(() => '..'), ...targetSegments].join('/');
  return `[${escapeLabel(entry.article.title)}](${encodePath(relative)})`;
}

function managedFrontmatter(view: string): string {
  return [
    '---',
    `"piReadsManaged": ${JSON.stringify(OBSIDIAN_GRAPH_MARKER)}`,
    `"piReadsView": ${JSON.stringify(view)}`,
    '---',
    '',
    '> Generated from Pi Reads metadata. Rebuild through Pi Reads instead of editing this note.',
    '',
  ].join('\n');
}

function listLine(fromPath: string, entry: ObsidianGraphEntry): string {
  const tags = entry.state.tags.length ? `; tags: ${entry.state.tags.join(', ')}` : '';
  const rating = entry.state.rating === undefined ? '' : `; rating: ${entry.state.rating}/5`;
  const due = entry.state.dueAt ? `; due: ${entry.state.dueAt}` : '';
  const readLater = entry.state.readLaterAt ? `; read later: ${entry.state.readLaterAt}` : '';
  return `- ${markdownLink(fromPath, entry)} — ${entry.article.mode}; ${entry.state.status}; priority: ${entry.state.priority}${rating}${due}${readLater}${tags}`;
}

function renderLibrary(entries: readonly ObsidianGraphEntry[], relativePath: string): string {
  const lines = entries.map((entry) => listLine(relativePath, entry));
  return `${managedFrontmatter('library')}# Pi Reads Library\n\n${lines.length ? lines.join('\n') : '_No exported Pi Reads notes._'}\n`;
}

function renderTopics(entries: readonly ObsidianGraphEntry[], relativePath: string): string {
  const topics = [...new Set(entries.flatMap((entry) => entry.state.tags))].sort(compareText);
  const sections = topics.map((topic) => {
    const matches = entries.filter((entry) => entry.state.tags.includes(topic));
    return `## ${topic}\n\n${matches.map((entry) => listLine(relativePath, entry)).join('\n')}`;
  });
  return `${managedFrontmatter('topics')}# Pi Reads Topics\n\n${sections.length ? sections.join('\n\n') : '_No tagged exported notes._'}\n`;
}

function renderStatuses(entries: readonly ObsidianGraphEntry[], relativePath: string): string {
  const statuses: ArticleUserState['status'][] = ['unread', 'reading', 'completed', 'archived'];
  const sections = statuses.map((status) => {
    const matches = entries.filter((entry) => entry.state.status === status);
    return `## ${status}\n\n${matches.length ? matches.map((entry) => listLine(relativePath, entry)).join('\n') : '_None._'}`;
  });
  return `${managedFrontmatter('reading-status')}# Pi Reads Reading Status\n\n${sections.join('\n\n')}\n`;
}

function renderQueue(entries: readonly ObsidianGraphEntry[], relativePath: string): string {
  const queued = filterAndSortStatefulArticles(
    entries.map(({ article, state }) => ({ article, state })),
    {},
    'priority',
  ).filter(({ state }) => state.status === 'unread' || state.status === 'reading');
  const byId = new Map(entries.map((entry) => [entry.article.id, entry]));
  const lines = queued.map(({ article }) => listLine(relativePath, byId.get(article.id)!));
  return `${managedFrontmatter('reading-queue')}# Pi Reads Reading Queue\n\n${lines.length ? lines.join('\n') : '_The reading queue is empty._'}\n`;
}

function sourceEntries(entry: ObsidianGraphEntry, entries: readonly ObsidianGraphEntry[]): ObsidianGraphEntry[] {
  const sourceIds = new Set(entry.article.sourceIds);
  return entries
    .filter((candidate) => candidate.article.mode === 'archive' && candidate.article.sourceIds.some((id) => sourceIds.has(id)))
    .sort((left, right) => compareText(left.article.title, right.article.title) || compareText(left.article.id, right.article.id));
}

function relationshipFile(entry: ObsidianGraphEntry, entries: readonly ObsidianGraphEntry[]): ObsidianGraphFile | undefined {
  if (entry.article.mode !== 'synthesis') return undefined;
  const sources = sourceEntries(entry, entries);
  if (!sources.length) return undefined;
  const links = sources.map((source) => `- ${markdownLink(entry.noteRelativePath, source)}`).join('\n');
  const separator = entry.exportedNote.endsWith('\n\n') ? '' : entry.exportedNote.endsWith('\n') ? '\n' : '\n\n';
  const contents = `${entry.exportedNote}${separator}<!-- pi-reads-relationships:${OBSIDIAN_GRAPH_MARKER} -->\n\n## Pi Reads source notes\n\n${links}\n`;
  return {
    relativePath: entry.noteRelativePath,
    contents,
    kind: 'relationship',
    articleId: entry.article.id,
  };
}

export function buildObsidianGraphFiles(entries: readonly ObsidianGraphEntry[]): ObsidianGraphFile[] {
  const sorted = [...entries].sort((left, right) =>
    compareText(left.article.title, right.article.title) || compareText(left.article.id, right.article.id));
  const viewPaths = {
    library: `${OBSIDIAN_GRAPH_FOLDER}/Library.md`,
    topics: `${OBSIDIAN_GRAPH_FOLDER}/Topics.md`,
    statuses: `${OBSIDIAN_GRAPH_FOLDER}/Reading Status.md`,
    queue: `${OBSIDIAN_GRAPH_FOLDER}/Reading Queue.md`,
  };
  const files: ObsidianGraphFile[] = [
    { relativePath: viewPaths.library, contents: renderLibrary(sorted, viewPaths.library), kind: 'view' },
    { relativePath: viewPaths.topics, contents: renderTopics(sorted, viewPaths.topics), kind: 'view' },
    { relativePath: viewPaths.statuses, contents: renderStatuses(sorted, viewPaths.statuses), kind: 'view' },
    { relativePath: viewPaths.queue, contents: renderQueue(sorted, viewPaths.queue), kind: 'view' },
    ...sorted.map((entry) => relationshipFile(entry, sorted)).filter((file): file is ObsidianGraphFile => Boolean(file)),
  ];
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.relativePath)) {
      throw new Error(`Obsidian graph target collides with an exported article note: ${file.relativePath}`);
    }
    seen.add(file.relativePath);
  }
  return files;
}
