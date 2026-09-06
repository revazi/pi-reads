import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ArticleRecord,
  ReadingCollectionEntry,
  ReadingCollectionRecord,
} from '../core/domain.ts';
import {
  collectionDirectory,
  createCollectionId,
  createImmutableRecordDirectory,
  resolveLibraryPath,
} from '../core/library.ts';
import { validateRecord } from '../core/record-validation.ts';
import { slugify } from '../core/slugs.ts';
import { LibraryService } from './library-service.ts';

const MIN_COLLECTION_ARTICLES = 2;
const MAX_COLLECTION_ARTICLES = 50;

export interface CreateReadingCollectionInput {
  title: string;
  articleIds: readonly string[];
  createdBy: ReadingCollectionRecord['createdBy'];
}

export interface StoredReadingCollection {
  collection: ReadingCollectionRecord;
  manifestPath: string;
}

export interface ReadingCollectionServiceOptions {
  library: LibraryService;
  now?: () => Date;
  createId?: () => string;
  allowGitWorkingTree?: boolean;
}

function normalizedTitle(value: string): string {
  const title = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!title) throw new Error('Reading collection title is required');
  if ([...title].length > 200) throw new Error('Reading collection title must not exceed 200 characters');
  return title;
}

function orderedArticleIds(values: readonly string[]): string[] {
  if (values.length < MIN_COLLECTION_ARTICLES || values.length > MAX_COLLECTION_ARTICLES) {
    throw new Error(`Reading collection requires ${MIN_COLLECTION_ARTICLES}–${MAX_COLLECTION_ARTICLES} articles`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error('Reading collection article order must not contain duplicate IDs');
  }
  for (const value of values) {
    if (!/^art_[a-z0-9]{16,64}$/u.test(value)) throw new Error(`Invalid article ID: ${value}`);
  }
  return [...values];
}

export function readingCollectionEntry(article: ArticleRecord, order: number): ReadingCollectionEntry {
  return {
    order,
    articleId: article.id,
    mode: article.mode,
    title: article.title,
    articleContentHash: article.body.contentHash,
    sourceIds: [...article.sourceIds],
    citations: article.citations.map((citation) => ({
      ...citation,
      ...(citation.locator ? { locator: { ...citation.locator } } : {}),
    })),
    ...(article.generatedBy ? { generatedBy: { ...article.generatedBy } } : {}),
  };
}

function assertEntrySnapshot(entry: ReadingCollectionEntry, article: ArticleRecord, order: number): void {
  const expected = readingCollectionEntry(article, order);
  if (JSON.stringify(entry) !== JSON.stringify(expected)) {
    throw new Error(`Reading collection article snapshot no longer matches ${article.id}`);
  }
}

export class ReadingCollectionService {
  private readonly library: LibraryService;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly allowGitWorkingTree: boolean;

  constructor(options: ReadingCollectionServiceOptions) {
    this.library = options.library;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => createCollectionId());
    this.allowGitWorkingTree = options.allowGitWorkingTree ?? false;
  }

  async create(input: CreateReadingCollectionInput, signal?: AbortSignal): Promise<StoredReadingCollection> {
    signal?.throwIfAborted();
    const title = normalizedTitle(input.title);
    const articleIds = orderedArticleIds(input.articleIds);
    const storedArticles = await Promise.all(articleIds.map((articleId) => this.library.loadArticle(articleId)));
    signal?.throwIfAborted();
    const id = this.createId();
    if (!/^col_[a-z0-9]{16,64}$/u.test(id)) throw new Error(`Invalid collection ID: ${id}`);
    const collection: ReadingCollectionRecord = {
      schemaVersion: 1,
      id,
      title,
      slug: slugify(title),
      articleIds,
      articles: storedArticles.map(({ article }, index) => readingCollectionEntry(article, index + 1)),
      createdAt: this.now().toISOString(),
      createdBy: input.createdBy,
    };
    const directory = collectionDirectory(id);
    await createImmutableRecordDirectory(
      this.library.libraryDir,
      directory,
      [{ path: 'manifest.json', contents: `${JSON.stringify(collection, null, 2)}\n` }],
      { allowGitWorkingTree: this.allowGitWorkingTree },
    );
    return {
      collection,
      manifestPath: resolveLibraryPath(this.library.libraryDir, path.posix.join(directory, 'manifest.json')),
    };
  }

  async load(collectionId: string): Promise<StoredReadingCollection> {
    if (!/^col_[a-z0-9]{16,64}$/u.test(collectionId)) throw new Error(`Invalid collection ID: ${collectionId}`);
    const relative = path.posix.join(collectionDirectory(collectionId), 'manifest.json');
    const manifestPath = resolveLibraryPath(this.library.libraryDir, relative);
    const collection = await validateRecord<ReadingCollectionRecord>(
      'collection',
      JSON.parse(await readFile(manifestPath, 'utf8')) as unknown,
    );
    if (collection.id !== collectionId || collection.articleIds.length !== collection.articles.length) {
      throw new Error(`Reading collection identity mismatch for ${collectionId}`);
    }
    for (const [index, articleId] of collection.articleIds.entries()) {
      const entry = collection.articles[index];
      if (!entry || entry.articleId !== articleId || entry.order !== index + 1) {
        throw new Error(`Reading collection order mismatch for ${collectionId}`);
      }
      assertEntrySnapshot(entry, (await this.library.loadArticle(articleId)).article, index + 1);
    }
    return { collection, manifestPath };
  }
}
