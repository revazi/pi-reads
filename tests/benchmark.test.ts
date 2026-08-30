import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  evaluateBenchmarkBudgets,
  runBenchmarkSuite,
  type BenchmarkBudgets,
} from '../src/benchmarks/suite.ts';
import { createBenchmarkFixtures } from '../src/benchmarks/fixtures.ts';

test('benchmark fixtures provide deterministic short, medium, long, and five-source inputs', () => {
  const first = createBenchmarkFixtures();
  const second = createBenchmarkFixtures();
  assert.deepEqual(first, second);
  assert.ok(first.short.markdown.length < first.medium.markdown.length);
  assert.ok(first.medium.markdown.length < first.long.markdown.length);
  assert.equal(first.multiSource.length, 5);
  assert.ok(first.multiSource.every((fixture) => fixture.markdown.length > first.short.markdown.length));
});

test('non-browser benchmark reports workflow, model-context, storage, and optional token metrics', { timeout: 30_000 }, async () => {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-reads-benchmark-test-'));
  try {
    const report = await runBenchmarkSuite({
      libraryDir,
      packageVersion: 'test',
      gitCommit: 'fixture-commit',
      piTokenUsage: {
        'digest-long': { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      },
    });
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.environment.browserBenchmarks, false);
    assert.equal(report.environment.packageVersion, 'test');
    assert.equal(report.environment.gitCommit, 'fixture-commit');
    assert.equal(report.measurements.length, 8);

    const measurements = new Map(report.measurements.map((measurement) => [measurement.name, measurement]));
    assert.equal(measurements.get('archive-only-short')?.metrics.sourceCharactersExposedToModel, 0);
    assert.equal(measurements.get('archive-only-short')?.metrics.toolCalls, 0);
    assert.equal(
      measurements.get('digest-long')?.metrics.sourceCharactersExposedToModel,
      report.fixtureCharacters.long,
    );
    assert.deepEqual(
      measurements.get('digest-long')?.metrics.piTokenUsage,
      { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    );
    assert.equal(measurements.get('synthesis-five-source')?.metrics.toolCalls, 6);
    assert.equal(measurements.get('pdf-export')?.status, 'skipped');
    assert.match(measurements.get('pdf-export')?.skipReason ?? '', /opt-in/u);
    assert.equal(measurements.get('kindle-preview')?.status, 'measured');
    assert.equal(measurements.get('kindle-send')?.status, 'measured');
    assert.ok(report.storage.artifactCount >= 3);
    assert.ok(report.storage.duplicateArtifactBytes > 0);
  } finally {
    await rm(libraryDir, { recursive: true, force: true });
  }
});

test('performance budgets are enforced only when explicitly evaluated', () => {
  const report = {
    schemaVersion: 1 as const,
    generatedAt: '2026-08-24T12:00:00Z',
    suite: 'pi-reads' as const,
    environment: {
      nodeVersion: 'v24.0.0',
      platform: process.platform,
      architecture: process.arch,
      logicalCpuCount: 1,
      cpuModel: null,
      ci: false,
      packageVersion: null,
      gitCommit: null,
      browserBenchmarks: false,
    },
    fixtureCharacters: { short: 1, medium: 2, long: 3, multiSourceTotal: 5 },
    measurements: [{
      name: 'archive-only-short' as const,
      status: 'measured' as const,
      fixture: 'short',
      metrics: {
        wallTimeMs: 10,
        toolCalls: 0,
        sourceCharactersExposedToModel: 0,
        artifactBytesWritten: 0,
        totalBytesWritten: 100,
        piTokenUsage: null,
      },
    }],
    storage: { totalBytes: 100, artifactBytes: 0, artifactCount: 0, uniqueArtifactCount: 0, duplicateArtifactBytes: 0 },
  };
  const passing: BenchmarkBudgets = {
    schemaVersion: 1,
    maximums: { 'archive-only-short': { wallTimeMs: 10, toolCalls: 0 } },
  };
  const failing: BenchmarkBudgets = {
    schemaVersion: 1,
    maximums: { 'archive-only-short': { totalBytesWritten: 99 } },
  };
  assert.deepEqual(evaluateBenchmarkBudgets(report, passing), []);
  assert.deepEqual(
    evaluateBenchmarkBudgets(report, failing),
    ['archive-only-short.totalBytesWritten: 100 exceeds maximum 99'],
  );
});
