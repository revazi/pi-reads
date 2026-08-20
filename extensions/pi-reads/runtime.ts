import { resolveConfiguration } from '../../src/core/config.ts';
import { ExportService } from '../../src/application/export-service.ts';
import { LibraryService } from '../../src/application/library-service.ts';
import { ObsidianService } from '../../src/application/obsidian-service.ts';

export async function openReadsServices(cwd: string): Promise<{
  configPath: string;
  libraryDir: string;
  library: LibraryService;
  exports: ExportService;
  obsidian?: ObsidianService;
  obsidianConfig: Awaited<ReturnType<typeof resolveConfiguration>>['obsidian'];
}> {
  const configuration = await resolveConfiguration({ cwd });
  const library = new LibraryService({ libraryDir: configuration.libraryDir });
  const exports = new ExportService({ library });
  return {
    configPath: configuration.configPath,
    libraryDir: configuration.libraryDir,
    library,
    exports,
    ...(configuration.obsidian ? { obsidian: new ObsidianService({ library, exports }) } : {}),
    obsidianConfig: configuration.obsidian,
  };
}
