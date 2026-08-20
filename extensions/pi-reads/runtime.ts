import { resolveConfiguration } from '../../src/core/config.ts';
import { EpubService } from '../../src/application/epub-service.ts';
import { ExportService } from '../../src/application/export-service.ts';
import { KindleService } from '../../src/application/kindle-service.ts';
import { LibraryService } from '../../src/application/library-service.ts';
import { ObsidianService } from '../../src/application/obsidian-service.ts';

export async function openReadsServices(cwd: string): Promise<{
  configPath: string;
  libraryDir: string;
  library: LibraryService;
  exports: ExportService;
  epub: EpubService;
  kindle: KindleService;
  kindleConfig: Awaited<ReturnType<typeof resolveConfiguration>>['kindle'];
  obsidian?: ObsidianService;
  obsidianConfig: Awaited<ReturnType<typeof resolveConfiguration>>['obsidian'];
}> {
  const configuration = await resolveConfiguration({ cwd });
  const library = new LibraryService({ libraryDir: configuration.libraryDir });
  const exports = new ExportService({ library });
  const epub = new EpubService({ library });
  return {
    configPath: configuration.configPath,
    libraryDir: configuration.libraryDir,
    library,
    exports,
    epub,
    kindle: new KindleService({
      library,
      exports,
      epub,
      ...(configuration.kindle ? { config: configuration.kindle } : {}),
    }),
    kindleConfig: configuration.kindle,
    ...(configuration.obsidian ? { obsidian: new ObsidianService({ library, exports }) } : {}),
    obsidianConfig: configuration.obsidian,
  };
}
