import process from 'node:process';
import { StringEnum, Type } from '@earendil-works/pi-ai';
import { withFileMutationQueue, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Citation } from '../../src/core/domain.ts';
import type { SourceInput } from '../../src/core/ingest/index.ts';
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

function sourceInput(kind: 'url' | 'text' | 'markdown' | 'file', value: string, label: string | undefined, cwd: string): SourceInput {
  switch (kind) {
    case 'url':
      return { kind, url: value };
    case 'text':
      return { kind, text: value, ...(label ? { label } : {}) };
    case 'markdown':
      return { kind, markdown: value, ...(label ? { label } : {}) };
    case 'file':
      return { kind, path: value.replace(/^@/, ''), cwd };
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function openObsidianNote(
  pi: ExtensionAPI,
  uri: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', uri] : [uri];
  const result = await pi.exec(command, args, { signal, timeout: 15_000 });
  return result.code === 0 ? undefined : (result.stderr || `exit code ${result.code}`);
}

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
      'Export a stored article locally as Markdown, standalone light-print HTML, PDF, or validated EPUB; deliver Markdown to Obsidian; or dry-run/send EPUB or PDF to Kindle. Format is required except for Kindle, which uses its configured default. Kindle sending always requires an interactive confirmation. Archive exports enforce text fidelity.',
    promptSnippet: 'Export stored reading articles locally, to Obsidian, or to Kindle with confirmation',
    promptGuidelines: [
      'For reads_export Obsidian conflicts, never set overwrite true unless the user explicitly approved replacing the listed vault files.',
    ],
    parameters: Type.Object({
      articleId: Type.String(),
      format: Type.Optional(ExportFormat),
      destination: Type.Optional(ExportDestination),
      overwrite: Type.Optional(Type.Boolean({ description: 'Obsidian only; requires explicit user approval for conflicting files' })),
      open: Type.Optional(Type.Boolean({ description: 'Obsidian only; open the delivered note after export' })),
      send: Type.Optional(Type.Boolean({ description: 'Kindle only; false/omitted is dry-run, true requests an interactive send confirmation' })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const services = await openReadsServices(ctx.cwd);
      const destination = params.destination ?? 'local';
      const format = params.format ?? (destination === 'kindle' ? services.kindleConfig?.defaultFormat ?? 'epub' : undefined);
      if (!format) {
        throw new Error('format is required for local and Obsidian exports');
      }
      onUpdate?.({ content: [{ type: 'text', text: `Preparing ${destination} ${format} export…` }], details: {} });

      if (destination === 'local') {
        const result = await withFileMutationQueue(services.libraryDir, () =>
          format === 'epub'
            ? services.epub.prepare(params.articleId, signal)
            : services.exports.prepare(params.articleId, format, signal),
        );
        return {
          content: [
            {
              type: 'text',
              text: [
                `Prepared ${result.record.format} export ${result.record.id}.`,
                `Artifact: ${result.artifactPath}`,
                `Manifest: ${result.manifestPath}`,
              ].join('\n'),
            },
          ],
          details: {
            libraryDir: services.libraryDir,
            destination,
            exportId: result.record.id,
            articleId: result.record.articleId,
            format: result.record.format,
            artifactPath: result.artifactPath,
            manifestPath: result.manifestPath,
          },
        };
      }

      if (destination === 'kindle') {
        if (format !== 'epub' && format !== 'pdf') {
          throw new Error('Kindle delivery requires format epub or pdf');
        }
        const kindleFormat = format;
        const preview = await withFileMutationQueue(services.libraryDir, () =>
          services.kindle.preview(params.articleId, kindleFormat, signal),
        );
        const previewLines = [
          `Kindle ${params.send ? 'send preview' : 'dry run'} prepared.`,
          `Recipient: ${preview.redactedRecipient}`,
          `Subject: ${preview.subject}`,
          `File: ${preview.artifactPath}`,
          `Size: ${formatBytes(preview.size)}`,
        ];
        if (!params.send) {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `Kindle dry run\nRecipient: ${preview.recipient}\nSubject: ${preview.subject}\nFile: ${preview.filename}\nSize: ${formatBytes(preview.size)}`,
              'info',
            );
          }
          return {
            content: [{ type: 'text', text: previewLines.join('\n') }],
            details: {
              libraryDir: services.libraryDir,
              destination,
              dryRun: true,
              articleId: preview.articleId,
              format: preview.format,
              recipient: preview.redactedRecipient,
              subject: preview.subject,
              filename: preview.filename,
              size: preview.size,
              artifactPath: preview.artifactPath,
              manifestPath: preview.localManifestPath,
            },
          };
        }
        if (!ctx.hasUI) {
          throw new Error(`Kindle send requires interactive confirmation. Local export retained at ${preview.artifactPath}`);
        }
        const confirmed = await ctx.ui.confirm(
          'Send to Kindle?',
          `Recipient: ${preview.recipient}\nSubject: ${preview.subject}\nFile: ${preview.filename}\nSize: ${formatBytes(preview.size)}\n\nSend this attachment now?`,
        );
        if (!confirmed) {
          throw new Error(`Kindle delivery cancelled. Local export retained at ${preview.artifactPath}`);
        }
        const result = await withFileMutationQueue(services.libraryDir, () =>
          services.kindle.deliver(preview, {
            confirmedAt: new Date().toISOString(),
            confirmationMethod: 'interactive',
          }, signal),
        );
        return {
          content: [{
            type: 'text',
            text: [
              `Sent ${result.record.format} to ${result.redactedRecipient}.`,
              `Delivery manifest: ${result.manifestPath}`,
              `Retained local export: ${result.localArtifactPath}`,
            ].join('\n'),
          }],
          details: {
            libraryDir: services.libraryDir,
            destination,
            dryRun: false,
            exportId: result.record.id,
            articleId: result.record.articleId,
            format: result.record.format,
            recipient: result.redactedRecipient,
            artifactPath: result.artifactPath,
            manifestPath: result.manifestPath,
            localArtifactPath: result.localArtifactPath,
          },
        };
      }

      if (format !== 'markdown') {
        throw new Error('Obsidian exports require format markdown');
      }
      if (!services.obsidian || !services.obsidianConfig) {
        throw new Error('Obsidian is not configured. Run /reads-config and choose Obsidian destination.');
      }

      const plan = await services.obsidian.plan(params.articleId, services.obsidianConfig, signal);
      let overwrite = false;
      let confirmedAt: string | undefined;
      if (plan.inspection.conflicts.length > 0) {
        if (ctx.hasUI) {
          const confirmed = await ctx.ui.confirm(
            'Overwrite Obsidian files?',
            `The following files differ:\n${plan.inspection.conflicts.join('\n')}\n\nReplace only these Pi Reads targets?`,
          );
          if (!confirmed) {
            throw new Error('Obsidian export cancelled; no vault files were changed');
          }
          overwrite = true;
          confirmedAt = new Date().toISOString();
        } else if (params.overwrite) {
          overwrite = true;
        } else {
          throw new Error(`Obsidian export conflicts with ${plan.inspection.conflicts.join(', ')}; rerun with overwrite true only after explicit approval`);
        }
      }

      const result = await withFileMutationQueue(services.obsidianConfig.vaultPath, () =>
        services.obsidian!.deliver(plan, { overwrite, ...(confirmedAt ? { confirmedAt } : {}) }),
      );
      let openWarning: string | undefined;
      if (params.open ?? services.obsidianConfig.openAfterExport) {
        openWarning = await openObsidianNote(pi, result.openUri, signal);
      }
      return {
        content: [
          {
            type: 'text',
            text: [
              `Delivered Obsidian export ${result.record.id}.`,
              `Note: ${result.notePath}`,
              `Assets: ${result.assetPaths.length}`,
              `Manifest: ${result.manifestPath}`,
              ...(openWarning ? [`Obsidian open warning: ${openWarning}`] : []),
            ].join('\n'),
          },
        ],
        details: {
          libraryDir: services.libraryDir,
          destination,
          exportId: result.record.id,
          articleId: result.record.articleId,
          format: result.record.format,
          artifactPath: result.artifactPath,
          manifestPath: result.manifestPath,
          notePath: result.notePath,
          noteRelativePath: result.noteRelativePath,
          assetPaths: result.assetPaths,
          changedPaths: result.changedPaths,
          openUri: result.openUri,
          ...(openWarning ? { openWarning } : {}),
        },
      };
    },
  });

  pi.registerTool({
    name: 'reads_library',
    label: 'Reads Library',
    description:
      'List stored Pi Reads articles or inspect source/article metadata by ID. Returns metadata and paths, not full article bodies. List output is limited to at most 50 articles.',
    promptSnippet: 'List or inspect Pi Reads library records',
    parameters: Type.Object({
      action: StringEnum(['list', 'show'] as const),
      id: Type.Optional(Type.String({ description: 'src_ or art_ ID required for show' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const services = await openReadsServices(ctx.cwd);
      if (params.action === 'list') {
        const articles = (await services.library.listArticles()).slice(0, params.limit ?? 20);
        const text = articles.length
          ? articles
              .map((article) => `${article.id}  ${article.mode.padEnd(9)}  ${article.title}  [${article.slug}]`)
              .join('\n')
          : 'Pi Reads library has no articles.';
        return {
          content: [{ type: 'text', text }],
          details: {
            libraryDir: services.libraryDir,
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
