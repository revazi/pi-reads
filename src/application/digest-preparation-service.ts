import type { PreparedEpubExport } from './epub-service.ts';
import { EpubService } from './epub-service.ts';
import type { StoredReadingCollection } from './reading-collection-service.ts';
import { ReadingCollectionService } from './reading-collection-service.ts';

export interface PrepareReadingDigestInput {
  title: string;
  articleIds: readonly string[];
  trigger: 'interactive' | 'scheduled' | 'tool';
}

export interface PreparedReadingDigest {
  collection: StoredReadingCollection;
  epub: PreparedEpubExport;
}

/** Creates immutable local records only. This service has no mail transport or delivery method. */
export class DigestPreparationService {
  private readonly collections: ReadingCollectionService;
  private readonly epub: EpubService;

  constructor(options: { collections: ReadingCollectionService; epub: EpubService }) {
    this.collections = options.collections;
    this.epub = options.epub;
  }

  async prepare(input: PrepareReadingDigestInput, signal?: AbortSignal): Promise<PreparedReadingDigest> {
    signal?.throwIfAborted();
    const collection = await this.collections.create({
      title: input.title,
      articleIds: input.articleIds,
      createdBy: input.trigger,
    }, signal);
    try {
      const epub = await this.epub.prepareCollection(collection.collection.id, signal);
      return { collection, epub };
    } catch (error) {
      throw new Error(
        `Reading collection ${collection.collection.id} was retained, but its local EPUB could not be prepared: ${String(error)}`,
      );
    }
  }
}
