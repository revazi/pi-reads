#!/usr/bin/env node
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DigestPreparationService } from '../src/application/digest-preparation-service.ts';
import { EpubService } from '../src/application/epub-service.ts';
import { LibraryService } from '../src/application/library-service.ts';
import { ReadingCollectionService } from '../src/application/reading-collection-service.ts';
import { resolveConfiguration } from '../src/core/config.ts';
import { errorMessage } from '../src/core/errors.ts';

export interface ScheduledDigestArguments {
  title: string;
  articleIds: string[];
  libraryDir?: string;
}

export function parseScheduledDigestArguments(args: readonly string[]): ScheduledDigestArguments {
  let title: string | undefined;
  let libraryDir: string | undefined;
  const articleIds: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === '--title' && value) { title = value; index++; continue; }
    if (argument === '--article' && value) { articleIds.push(value); index++; continue; }
    if (argument === '--library' && value) { libraryDir = value; index++; continue; }
    throw new Error(`Unsupported scheduled digest argument: ${argument ?? '(empty)'}`);
  }
  if (!title?.trim()) throw new Error('--title is required');
  if (articleIds.length < 2) throw new Error('At least two --article IDs are required');
  return { title, articleIds, ...(libraryDir ? { libraryDir } : {}) };
}

export async function prepareScheduledDigest(
  input: ScheduledDigestArguments,
  options: { cwd?: string } = {},
): Promise<{ collectionId: string; exportId: string; artifactPath: string; contentHash: string }> {
  const libraryDir = input.libraryDir ?? (await resolveConfiguration({ cwd: options.cwd ?? process.cwd() })).libraryDir;
  const library = new LibraryService({ libraryDir });
  const collections = new ReadingCollectionService({ library });
  const epub = new EpubService({ library, collections });
  const preparation = new DigestPreparationService({ collections, epub });
  const prepared = await preparation.prepare({
    title: input.title,
    articleIds: input.articleIds,
    trigger: 'scheduled',
  });
  return {
    collectionId: prepared.collection.collection.id,
    exportId: prepared.epub.record.id,
    artifactPath: prepared.epub.artifactPath,
    contentHash: prepared.epub.record.artifact.contentHash,
  };
}

async function main(): Promise<void> {
  const result = await prepareScheduledDigest(parseScheduledDigestArguments(process.argv.slice(2)));
  console.log([
    `Prepared collection: ${result.collectionId}`,
    `Prepared export: ${result.exportId}`,
    `Artifact: ${result.artifactPath}`,
    `Content hash: ${result.contentHash}`,
    'No email was sent. Delivery requires a later interactive confirmation of this exact prepared export.',
  ].join('\n'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
