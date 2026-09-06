import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import piReadsExtension from '../extensions/pi-reads/index.ts';
import { LibraryService, type SaveGeneratedArticleInput } from '../src/application/library-service.ts';
import type { SourceCoverageInput } from '../src/core/source-coverage.ts';

async function completeCoverage(library: LibraryService, sourceIds: readonly string[]): Promise<SourceCoverageInput> {
  return {
    policy: 'complete',
    sources: await Promise.all(sourceIds.map(async (sourceId) => {
      const { index } = await library.loadSourceIndex(sourceId);
      return {
        sourceId,
        sourceContentHash: index.sourceContentHash,
        consideredLocators: [...index.headings, ...index.paragraphs]
          .sort((left, right) => left.startByte - right.startByte)
          .map(({ id }) => id),
      };
    })),
  };
}

async function captureFixtures(library: LibraryService) {
  return Promise.all([
    library.capture({ kind: 'markdown', label: 'Alpha source', markdown: '# Alpha\n\nExact alpha evidence.\n' }),
    library.capture({ kind: 'markdown', label: 'Beta source', markdown: '# Beta\n\nExact beta evidence.\n' }),
    library.capture({ kind: 'markdown', label: 'Gamma source', markdown: '# Gamma\n\nExact gamma evidence.\n' }),
  ]);
}

test('multi-source synthesis planning and review bind order, citations, exact draft, and archive immutability', async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-multi-source-'));
  const library = new LibraryService({ libraryDir });
  try {
    const [alpha, beta, gamma] = await captureFixtures(library);
    const sourceIds = [gamma.source.id, alpha.source.id, beta.source.id];
    const plan = await library.planMultiSourceSynthesis(sourceIds);
    assert.deepEqual(plan.sources.map(({ sourceId }) => sourceId), sourceIds);
    assert.deepEqual(plan.sources.map(({ order }) => order), [1, 2, 3]);
    assert.ok(plan.sources.every(({ sourceContentHash, totalLocatorCount }) =>
      sourceContentHash.startsWith('sha256:') && totalLocatorCount === 2));

    const archiveBytes = await Promise.all(
      [alpha, beta, gamma].map((capture) => readFile(capture.articleContentPath, 'utf8')),
    );
    const input: SaveGeneratedArticleInput = {
      mode: 'synthesis',
      title: 'Ordered synthesis',
      body: '# Combined finding\n\nGamma and alpha support this comparison.[^cite_gamma][^cite_alpha]',
      sourceIds,
      citations: [
        { id: 'cite_gamma', sourceId: gamma.source.id, locator: { paragraph: 1 }, quote: 'Exact gamma evidence.' },
        { id: 'cite_alpha', sourceId: alpha.source.id, locator: { paragraph: 1 }, quote: 'Exact alpha evidence.' },
      ],
      coverage: await completeCoverage(library, sourceIds),
      generatedBy: {
        provider: 'fixture-provider',
        model: 'fixture-model',
        thinkingLevel: 'high',
        sessionId: 'fixture-session',
        generatedAt: '2026-09-05T12:00:00.000Z',
      },
    };

    const articleCountBeforeReview = (await library.listArticles()).length;
    const review = await library.reviewMultiSourceSynthesis(input);
    assert.deepEqual(review.selectedSourceIds, sourceIds);
    assert.deepEqual(review.usedSourceIds, [gamma.source.id, alpha.source.id]);
    assert.deepEqual(review.unusedSourceIds, [beta.source.id]);
    assert.deepEqual(review.citationDistribution, [
      { sourceId: gamma.source.id, citationCount: 1 },
      { sourceId: alpha.source.id, citationCount: 1 },
      { sourceId: beta.source.id, citationCount: 0 },
    ]);
    assert.equal(review.uncitedArticleSectionCount, 0);
    assert.equal((await library.listArticles()).length, articleCountBeforeReview);

    await assert.rejects(() => library.saveGenerated(input), /requires pre-persistence review/u);
    await assert.rejects(
      () => library.saveGenerated({ ...input, body: `${input.body}\n\nChanged after review.[^cite_alpha]` }, {
        reviewToken: review.reviewToken,
      }),
      /changed after review/u,
    );
    assert.equal((await library.listArticles()).length, articleCountBeforeReview);

    const saved = await library.saveGenerated(input, { reviewToken: review.reviewToken });
    assert.deepEqual(saved.article.sourceIds, sourceIds);
    assert.deepEqual(saved.article.generatedBy, input.generatedBy);
    assert.deepEqual(saved.article.citationDiagnostics?.sources.map(({ sourceId, citationCount }) => ({ sourceId, citationCount })),
      review.citationDistribution);
    assert.deepEqual(
      await Promise.all([alpha, beta, gamma].map((capture) => readFile(capture.articleContentPath, 'utf8'))),
      archiveBytes,
    );

    await assert.rejects(
      () => library.reviewMultiSourceSynthesis({
        ...input,
        title: 'Uncited section',
        body: '# Cited\n\nSupported.[^cite_gamma]\n\n## Uncited\n\nUnsupported claim.',
        citations: [input.citations[0]!],
      }),
      /citation marker in every non-empty article section/u,
    );
    await assert.rejects(
      () => library.reviewMultiSourceSynthesis({ ...input, sourceIds: [alpha.source.id, alpha.source.id] }),
      /must not repeat/u,
    );
    const twoSourceCoverage = await completeCoverage(library, [alpha.source.id, beta.source.id]);
    await assert.rejects(
      () => library.reviewMultiSourceSynthesis({
        ...input,
        body: '# Outside source\n\nThis marker references an unselected source.[^cite_gamma]',
        sourceIds: [alpha.source.id, beta.source.id],
        citations: [{ id: 'cite_gamma', sourceId: gamma.source.id, quote: 'Exact gamma evidence.' }],
        coverage: twoSourceCoverage,
      }),
      /unavailable source/u,
    );
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: Record<string, unknown>;
}

interface RegisteredTool {
  execute: (...args: unknown[]) => Promise<ToolResult>;
}

interface RegisteredCommand {
  handler: (args: string, ctx: unknown) => Promise<void>;
}

test('/reads selects and orders captured sources while reads_save_article reviews before persisting provenance', async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-multi-command-'));
  const previousLibraryDir = process.env.PI_READS_LIBRARY_DIR;
  const previousConfigPath = process.env.PI_READS_CONFIG;
  process.env.PI_READS_LIBRARY_DIR = libraryDir;
  process.env.PI_READS_CONFIG = path.join(libraryDir, 'config', 'pi-reads.json');

  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const sentMessages: string[] = [];
  const pi = {
    registerTool(tool: { name: string } & RegisteredTool) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); },
    sendUserMessage(message: string) { sentMessages.push(message); },
  } as unknown as ExtensionAPI;
  const context = {
    cwd: process.cwd(),
    model: { provider: 'active-provider', id: 'active-model' },
    thinkingLevel: 'xhigh',
    sessionManager: { getSessionId: () => 'active-session' },
    hasUI: false,
    mode: 'print',
    ui: {
      notify() {},
      setStatus() {},
      async select() { return undefined; },
      async input() { return undefined; },
      async editor() { return undefined; },
      async confirm() { return false; },
    },
  };
  const signal = new AbortController().signal;

  try {
    piReadsExtension(pi);
    const library = new LibraryService({ libraryDir });
    const [alpha, beta, gamma] = await captureFixtures(library);

    await commands.get('reads')!.handler(`${gamma.source.id} ${alpha.source.id}`, context);
    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0]!.indexOf(gamma.source.id) < sentMessages[0]!.indexOf(alpha.source.id));
    assert.match(sentMessages[0]!, new RegExp(gamma.source.content.contentHash, 'u'));
    assert.match(sentMessages[0]!, /Call reads_save_article without reviewToken first/u);
    assert.match(sentMessages[0]!, /changed drafts require a new review/u);

    let sourceSelection = 0;
    await commands.get('reads')!.handler('', {
      ...context,
      hasUI: true,
      mode: 'tui',
      ui: {
        ...context.ui,
        async select(title: string, options: string[]) {
          if (title === 'Source type') return options.find((option) => option.startsWith('Captured sources'));
          if (title.startsWith('Source #')) {
            sourceSelection += 1;
            if (sourceSelection === 1) return options.find((option) => option.includes(beta.source.id));
            if (sourceSelection === 2) return options.find((option) => option.includes(gamma.source.id));
            return options.find((option) => option.startsWith('Done'));
          }
          if (title === 'Export destination/format') return 'epub';
          return undefined;
        },
      },
    });
    assert.equal(sentMessages.length, 2);
    assert.ok(sentMessages[1]!.indexOf(beta.source.id) < sentMessages[1]!.indexOf(gamma.source.id));
    assert.doesNotMatch(sentMessages[1]!, new RegExp(alpha.source.id, 'u'));
    assert.match(sentMessages[1]!, /reads_export locally as epub/u);

    const sourceIds = [beta.source.id, gamma.source.id];
    const request = {
      mode: 'synthesis',
      title: 'Tool-reviewed synthesis',
      body: '# Tool synthesis\n\nBoth sources support the result.[^cite_beta][^cite_gamma]',
      sourceIds,
      citations: [
        { id: 'cite_beta', sourceId: beta.source.id, locator: { paragraph: 1 }, quote: 'Exact beta evidence.' },
        { id: 'cite_gamma', sourceId: gamma.source.id, locator: { paragraph: 1 }, quote: 'Exact gamma evidence.' },
      ],
      coverage: await completeCoverage(library, sourceIds),
    };
    const before = (await library.listArticles()).length;
    const preview = await tools.get('reads_save_article')!.execute(
      'review-call', request, signal, undefined, context,
    );
    assert.equal(preview.details?.persisted, false);
    assert.equal(preview.details?.reviewRequired, true);
    assert.match(preview.content[0]?.text ?? '', /no article was persisted/u);
    assert.match(preview.content[0]?.text ?? '', /Unused selected sources: none/u);
    const reviewToken = String((preview.details?.review as { reviewToken: string }).reviewToken);
    assert.match(reviewToken, /^sha256:[0-9a-f]{64}$/u);
    assert.equal((await library.listArticles()).length, before);

    await assert.rejects(
      () => tools.get('reads_save_article')!.execute(
        'changed-call', { ...request, title: 'Changed title', reviewToken }, signal, undefined, context,
      ),
      /changed after review/u,
    );
    const saved = await tools.get('reads_save_article')!.execute(
      'save-call', { ...request, reviewToken }, signal, undefined, context,
    );
    const manifest = JSON.parse(await readFile(String(saved.details?.manifestPath), 'utf8')) as {
      sourceIds: string[];
      generatedBy: { provider: string; model: string; thinkingLevel: string; sessionId: string; generatedAt: string };
    };
    assert.deepEqual(manifest.sourceIds, sourceIds);
    assert.equal(manifest.generatedBy.provider, 'active-provider');
    assert.equal(manifest.generatedBy.model, 'active-model');
    assert.equal(manifest.generatedBy.thinkingLevel, 'xhigh');
    assert.equal(manifest.generatedBy.sessionId, 'active-session');
    assert.match(manifest.generatedBy.generatedAt, /^\d{4}-\d{2}-\d{2}T/u);
  } finally {
    if (previousLibraryDir === undefined) delete process.env.PI_READS_LIBRARY_DIR;
    else process.env.PI_READS_LIBRARY_DIR = previousLibraryDir;
    if (previousConfigPath === undefined) delete process.env.PI_READS_CONFIG;
    else process.env.PI_READS_CONFIG = previousConfigPath;
    await rm(libraryDir, { recursive: true, force: true });
  }
});
