export type ArticleMode = 'archive' | 'digest' | 'synthesis';
export type SourceKind = 'url' | 'text' | 'markdown' | 'file';
export type ExportFormat = 'markdown' | 'html' | 'pdf' | 'epub';
export type ExportStatus = 'prepared' | 'delivered' | 'failed';
export type Sha256Digest = `sha256:${string}`;

export interface StoredFile {
  path: string;
  mediaType: string;
  contentHash: Sha256Digest;
  byteLength: number;
}

export interface StoredText extends StoredFile {
  textHash: Sha256Digest;
}

export interface SourceRecord {
  schemaVersion: 1;
  id: string;
  kind: SourceKind;
  title?: string;
  description?: string;
  authors?: string[];
  language?: string;
  publishedAt?: string;
  capturedAt: string;
  origin: {
    locator: string;
    canonicalUrl?: string;
  };
  content: StoredText;
  rawCapture?: StoredFile;
  assets?: StoredFile[];
  capture: {
    adapter: string;
    adapterVersion?: string;
    extractor?: string;
    extractorVersion?: string;
  };
}

export interface Citation {
  id: string;
  sourceId: string;
  locator?: {
    url?: string;
    heading?: string;
    paragraph?: number;
    fragment?: string;
  };
  quote?: string;
  note?: string;
}

export interface GeneratedBy {
  provider: string;
  model: string;
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  sessionId?: string;
  generatedAt: string;
}

export interface ArticleRecord {
  schemaVersion: 1;
  id: string;
  mode: ArticleMode;
  title: string;
  slug: string;
  description?: string;
  authors?: string[];
  language?: string;
  sourceIds: string[];
  body: StoredText;
  citations: Citation[];
  createdAt: string;
  supersedesArticleId?: string;
  archiveVerification?: {
    sourceId: string;
    sourceTextHash: Sha256Digest;
    verifiedAt?: string;
  };
  generatedBy?: GeneratedBy;
  presentation?: {
    sourceFontStyle?: 'serif' | 'sans-serif';
    bodyFontSizeAdjustment?: -1;
    imageScalePercent?: number;
  };
}

export type ExportDestination =
  | { type: 'local' }
  | { type: 'obsidian'; vaultName: string; notePath: string }
  | { type: 'kindle'; deviceLabel?: string };

export interface ExportRecord {
  schemaVersion: 1;
  id: string;
  articleId: string;
  format: ExportFormat;
  destination: ExportDestination;
  status: ExportStatus;
  artifact: StoredFile;
  createdAt: string;
  delivery?: {
    attemptedAt?: string;
    confirmedAt?: string;
    confirmationMethod?: 'interactive';
    deliveredAt?: string;
    failure?: string;
  };
}

export interface PiReadsConfig {
  schemaVersion: 1;
  libraryDir?: string;
  defaults?: {
    mode?: ArticleMode;
    exportFormat?: ExportFormat;
  };
}

export interface IngestedSourceDraft {
  kind: SourceKind;
  locator: string;
  canonicalUrl?: string;
  title?: string;
  description?: string;
  authors?: string[];
  publishedAt?: string;
  content: string;
  mediaType: 'text/markdown';
  contentHash: Sha256Digest;
  textHash: Sha256Digest;
  rawContent?: string;
  rawMediaType?: string;
  sourceFontStyle?: 'serif' | 'sans-serif';
  capture: SourceRecord['capture'];
}
