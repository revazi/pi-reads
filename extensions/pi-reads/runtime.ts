import { resolveConfiguration } from '../../src/core/config.ts';
import { ExportService } from '../../src/application/export-service.ts';
import { LibraryService } from '../../src/application/library-service.ts';

export async function openReadsServices(cwd: string): Promise<{
  configPath: string;
  libraryDir: string;
  library: LibraryService;
  exports: ExportService;
}> {
  const configuration = await resolveConfiguration({ cwd });
  const library = new LibraryService({ libraryDir: configuration.libraryDir });
  const exports = new ExportService({ library });
  return {
    configPath: configuration.configPath,
    libraryDir: configuration.libraryDir,
    library,
    exports,
  };
}
