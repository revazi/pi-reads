#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  BENCHMARK_NAMES,
  evaluateBenchmarkBudgets,
  runBenchmarkSuite,
  type BenchmarkBudgets,
  type BenchmarkName,
  type PiTokenUsage,
} from '../src/benchmarks/suite.ts';
import { errorMessage } from './shared.ts';

interface CliOptions {
  browser: boolean;
  gatePath?: string;
  outputPath?: string;
  tokenUsagePath?: string;
}

function usage(): string {
  return `Usage: pnpm benchmark [-- --browser] [--output <path>] [--gate <budgets.json>] [--token-usage <usage.json>]

--browser      Include the Playwright PDF benchmark (Chromium must be installed).
--output       Also write the JSON report to a local file.
--gate         Explicitly enforce maximum budgets from a JSON file.
--token-usage  Attach Pi token metrics captured by an external model-driven run.
`;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { browser: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--browser') options.browser = true;
    else if (argument === '--help' || argument === '-h') {
      process.stdout.write(usage());
      process.exit(0);
    } else if (argument === '--output' || argument === '--gate' || argument === '--token-usage') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path`);
      index += 1;
      if (argument === '--output') options.outputPath = value;
      else if (argument === '--gate') options.gatePath = value;
      else options.tokenUsagePath = value;
    } else {
      throw new Error(`Unknown benchmark option: ${argument}`);
    }
  }
  return options;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8')) as T;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const piTokenUsage = options.tokenUsagePath
    ? await readJson<Partial<Record<BenchmarkName, PiTokenUsage>>>(options.tokenUsagePath)
    : undefined;
  if (piTokenUsage) {
    for (const name of Object.keys(piTokenUsage)) {
      if (!BENCHMARK_NAMES.includes(name as BenchmarkName)) throw new Error(`Unknown token-usage benchmark name: ${name}`);
    }
  }

  const report = await runBenchmarkSuite({
    includeBrowser: options.browser,
    ...(piTokenUsage ? { piTokenUsage } : {}),
  });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(output);

  if (options.outputPath) {
    const outputPath = path.resolve(options.outputPath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, output);
  }

  if (options.gatePath) {
    const budgets = await readJson<BenchmarkBudgets>(options.gatePath);
    const failures = evaluateBenchmarkBudgets(report, budgets);
    if (failures.length > 0) throw new Error(`Benchmark budget gate failed:\n- ${failures.join('\n- ')}`);
  }
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
