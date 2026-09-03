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
  lineage?: {
    predecessorSourceId: string;
    rootSourceId: string;
    reason: 'content-changed' | 'explicit-duplicate';
    matchedBy: 'canonical-url' | 'content-hash';
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

export interface CitationGroundingSourceDiagnostics {
  sourceId: string;
  citationCount: number;
  locatedCitationCount: number;
  verifiedQuoteCount: number;
  sectionCitationCounts: Array<{ locator: string; citationCount: number }>;
  sectionCitationCountsTruncated: boolean;
  missingLocatorCount: number;
  missingLocatorCitationIds: string[];
  missingLocatorCitationIdsTruncated: boolean;
}

export interface CitationGroundingDiagnostics {
  algorithm: 'citation-grounding-v1';
  citationCount: number;
  locatedCitationCount: number;
  verifiedQuoteCount: number;
  sourceCount: number;
  sources: CitationGroundingSourceDiagnostics[];
  sourcesTruncated: boolean;
  articleSectionCount: number;
  citedArticleSectionCount: number;
  uncitedArticleSectionCount: number;
  articleSections: Array<{
    id: string;
    heading?: string;
    headingTruncated?: boolean;
    citationCount: number;
    citationIds: string[];
    citationIdsTruncated: boolean;
  }>;
  articleSectionsTruncated: boolean;
  uncitedArticleSections: Array<{ id: string; heading?: string; headingTruncated?: boolean }>;
  uncitedArticleSectionsTruncated: boolean;
}

export type SourceCoveragePolicy = 'complete' | 'targeted';

export interface SourceCoverageSummary {
  policy: SourceCoveragePolicy;
  warning?: string;
  sources: Array<{
    sourceId: string;
    sourceContentHash: Sha256Digest;
    indexAlgorithm: 'markdown-blocks-v1';
    indexLocatorHash: Sha256Digest;
    consideredLocatorHash: Sha256Digest;
    consideredLocatorCount: number;
    totalLocatorCount: number;
    missingLocatorCount: number;
    missingLocators: string[];
    missingLocatorsTruncated: boolean;
  }>;
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
  sourceCoverage?: SourceCoverageSummary;
  citationDiagnostics?: CitationGroundingDiagnostics;
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
  assets?: StoredFile[];
  createdAt: string;
  delivery?: {
    preparedExportId?: string;
    attemptedAt?: string;
    confirmedAt?: string;
    confirmationMethod?: 'interactive';
    deliveredAt?: string;
    failure?: string;
  };
}

export type FrontmatterValue = string | number | boolean | string[];

export interface ObsidianConfig {
  vaultPath: string;
  vaultName?: string;
  inboxFolder?: string;
  attachmentFolder?: string;
  noteNameTemplate?: string;
  tags?: string[];
  frontmatter?: Record<string, FrontmatterValue>;
  openAfterExport?: boolean;
}

export interface KindleConfig {
  deviceLabel?: string;
  defaultFormat?: 'epub' | 'pdf';
  credentialStore?: 'system' | 'environment';
  credentialProfile?: string;
  recipientEnv?: string;
  smtp?: {
    host?: string;
    port?: number;
    secure?: boolean;
    userEnv?: string;
    passwordEnv?: string;
    fromEnv?: string;
  };
}

export interface PiReadsConfig {
  schemaVersion: 1;
  libraryDir?: string;
  defaults?: {
    mode?: ArticleMode;
    exportFormat?: ExportFormat;
  };
  obsidian?: ObsidianConfig;
  kindle?: KindleConfig;
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
