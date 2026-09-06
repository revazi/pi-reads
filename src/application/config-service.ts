import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseConfig, readConfig } from '../core/config.ts';
import type { GenerationTemplateDefinition, KindleConfig, ObsidianConfig, PiReadsConfig } from '../core/domain.ts';

async function writeConfig(configPath: string, config: PiReadsConfig): Promise<void> {
  const validated = parseConfig(config);
  const absolutePath = path.resolve(configPath);
  const parent = path.dirname(absolutePath);
  await mkdir(parent, { recursive: true });
  const temporary = path.join(parent, `.${path.basename(absolutePath)}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { flag: 'wx' });
  try {
    await rename(temporary, absolutePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function updateLibraryDir(configPath: string, libraryDir: string): Promise<PiReadsConfig> {
  if (!libraryDir.trim()) {
    throw new Error('Library directory is required');
  }
  const current = await readConfig(configPath);
  const next: PiReadsConfig = { ...current, libraryDir };
  await writeConfig(configPath, next);
  return next;
}

export async function updateGenerationTemplates(
  configPath: string,
  defaults: { digestTemplateId: string; synthesisTemplateId: string },
  generationTemplates?: GenerationTemplateDefinition[],
): Promise<PiReadsConfig> {
  const current = await readConfig(configPath);
  const next: PiReadsConfig = {
    ...current,
    defaults: { ...current.defaults, ...defaults },
    ...(generationTemplates ? { generationTemplates } : {}),
  };
  await writeConfig(configPath, next);
  return next;
}

export async function updateKindleConfig(
  configPath: string,
  kindle: KindleConfig,
): Promise<PiReadsConfig> {
  const current = await readConfig(configPath);
  const next: PiReadsConfig = { ...current, kindle };
  await writeConfig(configPath, next);
  return next;
}

export async function updateObsidianConfig(
  configPath: string,
  obsidian: ObsidianConfig,
): Promise<PiReadsConfig> {
  const current = await readConfig(configPath);
  const next: PiReadsConfig = { ...current, obsidian };
  await writeConfig(configPath, next);
  return next;
}
