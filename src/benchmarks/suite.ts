import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { KindleMail, KindleMailTransport } from '../adapters/destinations/kindle.ts';
import { EpubService } from '../application/epub-service.ts';
import { ExportService } from '../application/export-service.ts';
import { KindleService, type KindleEnvironment, type KindlePreview } from '../application/kindle-service.ts';
import { LibraryService } from '../application/library-service.ts';
import type { ResolvedKindleConfig } from '../core/config.ts';
import type { RecordIdPrefix } from '../core/library.ts';
import { createBenchmarkFixtures } from './fixtures.ts';

export const BENCHMARK_NAMES = [
  'archive-only-short',
  'digest-long',
  'synthesis-five-source',
  'library-list',
  'epub-export',
  'pdf-export',
  'kindle-preview',
  'kindle-send',
] as const;

export type BenchmarkName = (typeof BENCHMARK_NAMES)[number];

export interface PiTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens: number;
}

export interface BenchmarkMetrics {
  wallTimeMs: number | null;
  toolCalls: number;
  sourceCharactersExposedToModel: number;
  artifactBytesWritten: number;
  totalBytesWritten: number;
  piTokenUsage: PiTokenUsage | null;
}

export interface BenchmarkMeasurement {
  name: BenchmarkName;
  status: 'measured' | 'skipped';
  fixture: string;
  metrics: BenchmarkMetrics;
  skipReason?: string;
}

export interface BenchmarkStorageSummary {
  totalBytes: number;
  artifactBytes: number;
  artifactCount: number;
  uniqueArtifactCount: number;
  duplicateArtifactBytes: number;
}

export interface BenchmarkReport {
  schemaVersion: 1;
  generatedAt: string;
  suite: 'pi-reads';
  environment: {
    nodeVersion: string;
    platform: NodeJS.Platform;
    architecture: string;
    logicalCpuCount: number;
    cpuModel: string | null;
    ci: boolean;
    packageVersion: string | null;
    gitCommit: string | null;
    browserBenchmarks: boolean;
  };
  fixtureCharacters: {
    short: number;
    medium: number;
    long: number;
    multiSourceTotal: number;
  };
  measurements: BenchmarkMeasurement[];
  storage: BenchmarkStorageSummary;
}

export interface BenchmarkSuiteOptions {
  libraryDir?: string;
  includeBrowser?: boolean;
  packageVersion?: string;
  gitCommit?: string;
  piTokenUsage?: Partial<Record<BenchmarkName, PiTokenUsage>>;
}

export type BenchmarkBudgetMetric = keyof Pick<
  BenchmarkMetrics,
  'wallTimeMs' | 'toolCalls' | 'sourceCharactersExposedToModel' | 'artifactBytesWritten' | 'totalBytesWritten'
>;

export interface BenchmarkBudgets {
  schemaVersion: 1;
  maximums: Partial<Record<BenchmarkName, Partial<Record<BenchmarkBudgetMetric, number>>>>;
}

interface ByteSnapshot {
  totalBytes: number;
  artifactBytes: number;
}

function deterministicIds(): (prefix: RecordIdPrefix) => string {
  const counts: Record<RecordIdPrefix, number> = { src: 0, art: 0, cite: 0, exp: 0 };
  const letters: Record<RecordIdPrefix, string> = { src: 'p', art: 'q', cite: 'r', exp: 's' };
  return (prefix) => {
    counts[prefix] += 1;
    return `${prefix}_${letters[prefix].repeat(15)}${counts[prefix].toString(36)}`;
  };
}

async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }
  await visit(root);
  return files;
}

async function byteSnapshot(root: string): Promise<ByteSnapshot> {
  let totalBytes = 0;
  let artifactBytes = 0;
  for (const filePath of await filesUnder(root)) {
    const bytes = (await stat(filePath)).size;
    totalBytes += bytes;
    const relative = path.relative(root, filePath).split(path.sep).join('/');
    if (relative.startsWith('exports/') && !relative.endsWith('/manifest.json')) artifactBytes += bytes;
  }
  return { totalBytes, artifactBytes };
}

async function storageSummary(root: string): Promise<BenchmarkStorageSummary> {
  const snapshot = await byteSnapshot(root);
  const artifacts: { contentHash: string; byteLength: number }[] = [];
  for (const filePath of await filesUnder(path.join(root, 'exports'))) {
    if (!filePath.endsWith(`${path.sep}manifest.json`)) continue;
    const value = JSON.parse(await readFile(filePath, 'utf8')) as {
      artifact?: { contentHash?: unknown; byteLength?: unknown };
    };
    if (typeof value.artifact?.contentHash === 'string' && typeof value.artifact.byteLength === 'number') {
      artifacts.push({ contentHash: value.artifact.contentHash, byteLength: value.artifact.byteLength });
    }
  }
  const unique = new Map<string, number>();
  for (const artifact of artifacts) unique.set(`${artifact.contentHash}:${artifact.byteLength}`, artifact.byteLength);
  const uniqueBytes = [...unique.values()].reduce((sum, bytes) => sum + bytes, 0);
  const recordedArtifactBytes = artifacts.reduce((sum, artifact) => sum + artifact.byteLength, 0);
  return {
    totalBytes: snapshot.totalBytes,
    artifactBytes: snapshot.artifactBytes,
    artifactCount: artifacts.length,
    uniqueArtifactCount: unique.size,
    duplicateArtifactBytes: recordedArtifactBytes - uniqueBytes,
  };
}

function validateTokenUsage(value: PiTokenUsage): PiTokenUsage {
  for (const [name, count] of Object.entries(value)) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Pi token metric ${name} must be a non-negative integer`);
  }
  if (value.totalTokens !== value.inputTokens + value.outputTokens) {
    throw new Error('Pi token metric totalTokens must equal inputTokens + outputTokens');
  }
  return value;
}

class BenchmarkTransport implements KindleMailTransport {
  readonly messages: KindleMail[] = [];

  async send(mail: KindleMail): Promise<void> {
    this.messages.push(mail);
  }
}

export async function runBenchmarkSuite(options: BenchmarkSuiteOptions = {}): Promise<BenchmarkReport> {
  const ownLibrary = !options.libraryDir;
  const libraryDir = options.libraryDir ?? await mkdtemp(path.join(os.tmpdir(), 'pi-reads-benchmark-'));
  const includeBrowser = options.includeBrowser ?? false;
  const fixtures = createBenchmarkFixtures();
  const createId = deterministicIds();
  const now = () => new Date('2026-08-24T12:00:00Z');
  const library = new LibraryService({ libraryDir, createId, now });
  const exports = new ExportService({ library, createId, now });
  const epub = new EpubService({ library, createId, now });
  const measurements: BenchmarkMeasurement[] = [];

  const tokenUsageFor = (name: BenchmarkName): PiTokenUsage | null => {
    const usage = options.piTokenUsage?.[name];
    return usage ? validateTokenUsage(usage) : null;
  };

  const measure = async (
    name: BenchmarkName,
    fixture: string,
    toolCalls: number,
    sourceCharactersExposedToModel: number,
    operation: () => Promise<void>,
  ): Promise<void> => {
    const before = await byteSnapshot(libraryDir);
    const startedAt = performance.now();
    await operation();
    const wallTimeMs = Math.round((performance.now() - startedAt) * 1_000) / 1_000;
    const after = await byteSnapshot(libraryDir);
    measurements.push({
      name,
      status: 'measured',
      fixture,
      metrics: {
        wallTimeMs,
        toolCalls,
        sourceCharactersExposedToModel,
        artifactBytesWritten: after.artifactBytes - before.artifactBytes,
        totalBytesWritten: after.totalBytes - before.totalBytes,
        piTokenUsage: tokenUsageFor(name),
      },
    });
  };

  let shortArticleId = '';
  let digestArticleId = '';
  let kindlePreview: KindlePreview | undefined;
  const transport = new BenchmarkTransport();
  const address = ['benchmark-reader', 'kindle.com'].join('@');
  const sender = ['benchmark-sender', 'example.test'].join('@');
  const kindleEnv: KindleEnvironment = {
    BENCHMARK_KINDLE_ADDRESS: address,
    BENCHMARK_SMTP_USER: 'benchmark-user',
    BENCHMARK_SMTP_PASSWORD: 'benchmark-fixture-only',
    BENCHMARK_SMTP_FROM: sender,
  };
  const kindleConfig: ResolvedKindleConfig = {
    defaultFormat: 'epub',
    credentialStore: 'environment',
    credentialProfile: 'benchmark',
    recipientEnv: 'BENCHMARK_KINDLE_ADDRESS',
    smtp: {
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      userEnv: 'BENCHMARK_SMTP_USER',
      passwordEnv: 'BENCHMARK_SMTP_PASSWORD',
      fromEnv: 'BENCHMARK_SMTP_FROM',
    },
  };
  const kindle = new KindleService({
    library,
    exports,
    epub,
    env: kindleEnv,
    config: kindleConfig,
    transport,
    createId,
    now,
  });

  try {
    await measure('archive-only-short', fixtures.short.name, 1, 0, async () => {
      const captured = await library.capture({ kind: 'markdown', label: fixtures.short.label, markdown: fixtures.short.markdown });
      shortArticleId = captured.archiveArticle.id;
    });

    await measure('digest-long', fixtures.long.name, 2, fixtures.long.markdown.length, async () => {
      const captured = await library.capture({ kind: 'markdown', label: fixtures.long.label, markdown: fixtures.long.markdown });
      const digest = await library.saveGenerated({
        mode: 'digest',
        title: 'Benchmark long digest',
        body: 'A deterministic digest records the benchmark source and its provenance.[^cite_long]',
        sourceIds: [captured.source.id],
        citations: [{ id: 'cite_long', sourceId: captured.source.id, quote: 'deterministic reading-library behavior' }],
        generatedBy: { provider: 'benchmark', model: 'deterministic-fixture', generatedAt: now().toISOString() },
      });
      digestArticleId = digest.article.id;
    });

    await measure(
      'synthesis-five-source',
      'multi-source (5 medium sources)',
      6,
      fixtures.multiSource.reduce((sum, fixture) => sum + fixture.markdown.length, 0),
      async () => {
        const captures = [];
        for (const fixture of fixtures.multiSource) {
          captures.push(await library.capture({ kind: 'markdown', label: fixture.label, markdown: fixture.markdown }));
        }
        const citations = captures.map((capture, index) => ({
          id: `cite_source_${index + 1}`,
          sourceId: capture.source.id,
          quote: 'deterministic reading-library behavior',
        }));
        const body = citations.map((citation, index) => `Source ${index + 1} contributes a bounded benchmark observation.[^${citation.id}]`).join('\n\n');
        await library.saveGenerated({
          mode: 'synthesis',
          title: 'Benchmark five-source synthesis',
          body,
          sourceIds: captures.map((capture) => capture.source.id),
          citations,
          generatedBy: { provider: 'benchmark', model: 'deterministic-fixture', generatedAt: now().toISOString() },
        });
      },
    );

    await measure('library-list', 'populated benchmark library', 1, 0, async () => {
      await library.listArticles();
    });

    await measure('epub-export', fixtures.long.name, 1, 0, async () => {
      await epub.prepare(digestArticleId);
    });

    if (includeBrowser) {
      await measure('pdf-export', fixtures.short.name, 1, 0, async () => {
        await exports.prepare(shortArticleId, 'pdf');
      });
    } else {
      measurements.push({
        name: 'pdf-export',
        status: 'skipped',
        fixture: fixtures.short.name,
        skipReason: 'Browser benchmarks are opt-in; rerun with --browser after installing Playwright Chromium.',
        metrics: {
          wallTimeMs: null,
          toolCalls: 0,
          sourceCharactersExposedToModel: 0,
          artifactBytesWritten: 0,
          totalBytesWritten: 0,
          piTokenUsage: tokenUsageFor('pdf-export'),
        },
      });
    }

    await measure('kindle-preview', fixtures.short.name, 1, 0, async () => {
      kindlePreview = await kindle.preview(shortArticleId, 'epub');
    });

    await measure('kindle-send', fixtures.short.name, 1, 0, async () => {
      if (!kindlePreview) throw new Error('Kindle preview benchmark did not produce an artifact');
      await kindle.deliver(kindlePreview, {
        confirmedAt: now().toISOString(),
        confirmationMethod: 'interactive',
      });
      if (transport.messages.length !== 1) throw new Error('Fake Kindle transport did not record exactly one delivery');
    });

    const cpu = os.cpus();
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      suite: 'pi-reads',
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        logicalCpuCount: cpu.length,
        cpuModel: cpu[0]?.model ?? null,
        ci: process.env.CI === 'true',
        packageVersion: options.packageVersion ?? process.env.npm_package_version ?? null,
        gitCommit: options.gitCommit ?? process.env.GITHUB_SHA ?? null,
        browserBenchmarks: includeBrowser,
      },
      fixtureCharacters: {
        short: fixtures.short.markdown.length,
        medium: fixtures.medium.markdown.length,
        long: fixtures.long.markdown.length,
        multiSourceTotal: fixtures.multiSource.reduce((sum, fixture) => sum + fixture.markdown.length, 0),
      },
      measurements,
      storage: await storageSummary(libraryDir),
    };
  } finally {
    if (ownLibrary) await rm(libraryDir, { recursive: true, force: true });
  }
}

export function evaluateBenchmarkBudgets(report: BenchmarkReport, budgets: BenchmarkBudgets): string[] {
  if (budgets.schemaVersion !== 1 || !budgets.maximums || typeof budgets.maximums !== 'object') {
    throw new Error('Benchmark budget file must use schemaVersion 1 and define maximums');
  }
  const measurements = new Map(report.measurements.map((measurement) => [measurement.name, measurement]));
  const failures: string[] = [];
  for (const [name, maximums] of Object.entries(budgets.maximums) as [BenchmarkName, Partial<Record<BenchmarkBudgetMetric, number>>][]) {
    if (!BENCHMARK_NAMES.includes(name)) throw new Error(`Unknown benchmark budget name: ${name}`);
    const measurement = measurements.get(name);
    if (!measurement || measurement.status !== 'measured') {
      failures.push(`${name}: benchmark was not measured`);
      continue;
    }
    for (const [metric, maximum] of Object.entries(maximums) as [BenchmarkBudgetMetric, number][]) {
      if (!['wallTimeMs', 'toolCalls', 'sourceCharactersExposedToModel', 'artifactBytesWritten', 'totalBytesWritten'].includes(metric)) {
        throw new Error(`Unknown benchmark metric: ${metric}`);
      }
      if (typeof maximum !== 'number' || !Number.isFinite(maximum) || maximum < 0) {
        throw new Error(`${name}.${metric} maximum must be a non-negative number`);
      }
      const actual = measurement.metrics[metric];
      if (actual === null) failures.push(`${name}.${metric}: metric was unavailable`);
      else if (actual > maximum) failures.push(`${name}.${metric}: ${actual} exceeds maximum ${maximum}`);
    }
  }
  return failures;
}
