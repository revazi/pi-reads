import { StringEnum, Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Citation } from '../../src/core/domain.ts';
import { executeReadsExport, resolveReadsExportRequest } from './export-handlers.ts';
import { sourceInput, withReadsMutationQueue as withFileMutationQueue } from './operations.ts';
import { openReadsServices } from './runtime.ts';

const SourceKind = StringEnum(['url', 'text', 'markdown', 'file'] as const);
const GeneratedMode = StringEnum(['digest', 'synthesis'] as const);
const ExportFormat = StringEnum(['markdown', 'html', 'pdf', 'epub'] as const);
const ExportDestination = StringEnum(['local', 'obsidian', 'kindle'] as const);

const CitationLocatorSchema = Type.Object({
  url: Type.Optional(Type.String()),
  heading: Type.Optional(Type.String()),
  paragraph: Type.Optional(Type.Integer({ minimum: 1 })),
  fragment: Type.Optional(Type.String()),
});

const CitationSchema = Type.Object({
  id: Type.String({ description: 'Citation marker ID such as cite_source_1' }),
  sourceId: Type.String({ description: 'Captured src_ ID supporting the claim' }),
  locator: Type.Optional(CitationLocatorSchema),
  quote: Type.Optional(Type.String()),
  note: Type.Optional(Type.String()),
});

export function registerReadsTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'reads_ingest',
    label: 'Reads Ingest',
    description:
      'Capture a URL, pasted text, Markdown, or local text/Markdown file into the Pi Reads library. Creates an immutable source and faithful archive article. Returns IDs and local paths; output is bounded and never includes the full article body.',
    promptSnippet: 'Capture reading sources as immutable source and archive records',
    promptGuidelines: [
      'Use reads_ingest before generating a digest or synthesis, and preserve the returned source IDs for citations.',
      'After reads_ingest, read the returned source content path before authoring generated prose.',
    ],
    parameters: Type.Object({
      kind: SourceKind,
      value: Type.String({ description: 'URL, text/Markdown content, or local file path according to kind' }),
      label: Type.Optional(Type.String({ description: 'Optional title for pasted text or Markdown' })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const services = await openReadsServices(ctx.cwd);
      onUpdate?.({ content: [{ type: 'text', text: `Capturing ${params.kind} source…` }], details: {} });
      const result = await withFileMutationQueue(services.libraryDir, () =>
        services.library.capture(sourceInput(params.kind, params.value, params.label, ctx.cwd), {}, signal),
      );

      return {
        content: [
          {
            type: 'text',
            text: [
              `Captured source ${result.source.id}.`,
              `Created faithful archive ${result.archiveArticle.id}.`,
              `Source content: ${result.sourceContentPath}`,
              `Archive content: ${result.articleContentPath}`,
              'Read the source content path before creating a digest or synthesis.',
            ].join('\n'),
          },
        ],
        details: {
          libraryDir: services.libraryDir,
          sourceId: result.source.id,
          archiveArticleId: result.archiveArticle.id,
          sourceManifestPath: result.sourceManifestPath,
          sourceContentPath: result.sourceContentPath,
          articleManifestPath: result.articleManifestPath,
          articleContentPath: result.articleContentPath,
        },
      };
    },
  });

  pi.registerTool({
    name: 'reads_save_article',
    label: 'Reads Save Article',
    description:
      'Save an AI-authored digest or synthesis as a separate immutable article. Requires captured source IDs, citation metadata, and matching inline [^cite_id] markers. Never overwrites archive content.',
    promptSnippet: 'Save cited digest or synthesis articles separately from source archives',
    promptGuidelines: [
      'Use reads_save_article only for digest or synthesis content, never for faithful source capture.',
      'Every reads_save_article citation must be supported by a captured source and referenced nearby as [^cite_id] in the body.',
    ],
    parameters: Type.Object({
      mode: GeneratedMode,
      title: Type.String(),
      slug: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      body: Type.String({ description: 'Generated Markdown with inline [^cite_id] markers' }),
      sourceIds: Type.Array(Type.String(), { minItems: 1 }),
      citations: Type.Array(CitationSchema, { minItems: 1 }),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const services = await openReadsServices(ctx.cwd);
      if (!ctx.model) {
        throw new Error('An active Pi model is required to record generation provenance');
      }
      onUpdate?.({ content: [{ type: 'text', text: `Saving ${params.mode} article…` }], details: {} });
      const generatedAt = new Date().toISOString();
      const result = await withFileMutationQueue(services.libraryDir, () =>
        services.library.saveGenerated({
          mode: params.mode,
          title: params.title,
          ...(params.slug ? { slug: params.slug } : {}),
          ...(params.description ? { description: params.description } : {}),
          body: params.body,
          sourceIds: params.sourceIds,
          citations: params.citations as Citation[],
          generatedBy: {
            provider: ctx.model!.provider,
            model: ctx.model!.id,
            thinkingLevel: ctx.thinkingLevel,
            sessionId: ctx.sessionManager.getSessionId(),
            generatedAt,
          },
        }),
      );

      return {
        content: [
          {
            type: 'text',
            text: [
              `Saved ${result.article.mode} article ${result.article.id}.`,
              `Article content: ${result.contentPath}`,
              `Manifest: ${result.manifestPath}`,
            ].join('\n'),
          },
        ],
        details: {
          libraryDir: services.libraryDir,
          articleId: result.article.id,
          mode: result.article.mode,
          slug: result.article.slug,
          contentPath: result.contentPath,
          manifestPath: result.manifestPath,
        },
      };
    },
  });

  pi.registerTool({
    name: 'reads_export',
    label: 'Reads Export',
    description:
      'Export a stored article locally as Markdown, standalone light-print HTML, PDF, or validated EPUB; deliver Markdown to Obsidian; or dry-run/send EPUB or PDF to Kindle. Kindle dry runs return a prepared export ID that a later confirmed send can reuse without rendering again. Format is required except for Kindle, which uses its configured default. Kindle sending always requires an interactive confirmation. Archive exports enforce text fidelity.',
    promptSnippet: 'Export stored reading articles locally, to Obsidian, or to Kindle with confirmation',
    promptGuidelines: [
      'For reads_export Obsidian conflicts, never set overwrite true unless the user explicitly approved replacing the listed vault files.',
      'Preserve the preparedExportId returned by a Kindle dry run and pass it to a later send for the same article and format.',
      'Never substitute another prepared export after the user reviewed a Kindle dry run.',
    ],
    parameters: Type.Object({
      articleId: Type.String(),
      format: Type.Optional(ExportFormat),
      destination: Type.Optional(ExportDestination),
      overwrite: Type.Optional(Type.Boolean({ description: 'Obsidian only; requires explicit user approval for conflicting files' })),
      open: Type.Optional(Type.Boolean({ description: 'Obsidian only; open the delivered note after export' })),
      send: Type.Optional(Type.Boolean({ description: 'Kindle only; false/omitted is dry-run, true requests an interactive send confirmation' })),
      preparedExportId: Type.Optional(Type.String({ description: 'Kindle only; reuse the immutable exp_ ID returned by an earlier dry run' })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const services = await openReadsServices(ctx.cwd);
      const request = resolveReadsExportRequest(params, services);
      onUpdate?.({
        content: [{ type: 'text', text: `Preparing ${request.destination} ${request.format} export…` }],
        details: {},
      });
      return executeReadsExport(request, { pi, services, signal, ctx });
    },
  });

  pi.registerTool({
    name: 'reads_library',
    label: 'Reads Library',
    description:
      'List or search stored Pi Reads article metadata, or inspect source/article metadata by ID. Returns metadata and paths, not full article bodies. List/search output is limited to at most 50 articles.',
    promptSnippet: 'List or inspect Pi Reads library records',
    parameters: Type.Object({
      action: StringEnum(['list', 'search', 'show'] as const),
      id: Type.Optional(Type.String({ description: 'src_ or art_ ID required for show' })),
      query: Type.Optional(Type.String({ description: 'Metadata query required for search' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const services = await openReadsServices(ctx.cwd);
      if (params.action === 'list' || params.action === 'search') {
        if (params.action === 'search' && !params.query?.trim()) {
          throw new Error('query is required for reads_library search');
        }
        const articles = params.action === 'search'
          ? await services.library.searchArticles(params.query!, params.limit ?? 20)
          : (await services.library.listArticles()).slice(0, params.limit ?? 20);
        const text = articles.length
          ? articles
              .map((article) => `${article.id}  ${article.mode.padEnd(9)}  ${article.title}  [${article.slug}]`)
              .join('\n')
          : 'Pi Reads library has no articles.';
        return {
          content: [{ type: 'text', text }],
          details: {
            libraryDir: services.libraryDir,
            action: params.action,
            ...(params.query ? { query: params.query } : {}),
            articles: articles.map(({ id, mode, title, slug, createdAt }) => ({ id, mode, title, slug, createdAt })),
          },
        };
      }

      if (!params.id) {
        throw new Error('id is required for reads_library show');
      }
      if (params.id.startsWith('src_')) {
        const source = await services.library.loadSource(params.id);
        return {
          content: [
            {
              type: 'text',
              text: [
                `${source.source.id}  source  ${source.source.title ?? '(untitled)'}`,
                `Content: ${source.contentPath}`,
                `Manifest: ${source.manifestPath}`,
              ].join('\n'),
            },
          ],
          details: { libraryDir: services.libraryDir, record: source.source, contentPath: source.contentPath, manifestPath: source.manifestPath },
        };
      }

      const article = await services.library.loadArticle(params.id);
      return {
        content: [
          {
            type: 'text',
            text: [
              `${article.article.id}  ${article.article.mode}  ${article.article.title}`,
              `Content: ${article.contentPath}`,
              `Manifest: ${article.manifestPath}`,
            ].join('\n'),
          },
        ],
        details: { libraryDir: services.libraryDir, record: article.article, contentPath: article.contentPath, manifestPath: article.manifestPath },
      };
    },
  });
}
