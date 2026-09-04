import { resolveConfiguration } from '../../src/core/config.ts';
import { errorMessage } from '../../src/core/errors.ts';
import type { SystemKindleCredentialStore } from '../../src/adapters/credentials/keyring.ts';
import type { EpubService } from '../../src/application/epub-service.ts';
import type { ExportService } from '../../src/application/export-service.ts';
import type { KindleService } from '../../src/application/kindle-service.ts';
import type { LibraryService } from '../../src/application/library-service.ts';
import type { ObsidianService } from '../../src/application/obsidian-service.ts';
import type { SearchService } from '../../src/application/search-service.ts';
import type { UserStateService } from '../../src/application/user-state-service.ts';

type ResolvedConfiguration = Awaited<ReturnType<typeof resolveConfiguration>>;

function capabilityError(capability: string, error: unknown): Error {
  return new Error(`${capability} could not be loaded. Reinstall or update Pi Reads. ${errorMessage(error)}`);
}

export interface ReadsServices {
  configPath: string;
  libraryDir: string;
  library: LibraryService;
  kindleConfig: ResolvedConfiguration['kindle'];
  obsidianConfig: ResolvedConfiguration['obsidian'];
  getExports(): Promise<ExportService>;
  getEpub(): Promise<EpubService>;
  getKindle(): Promise<KindleService>;
  getKindleCredentialStore(): Promise<SystemKindleCredentialStore>;
  getObsidian(): Promise<ObsidianService | undefined>;
  getSearch(): Promise<SearchService>;
  getUserState(): Promise<UserStateService>;
}

export async function openReadsServices(cwd: string): Promise<ReadsServices> {
  const configuration = await resolveConfiguration({ cwd });
  const { LibraryService } = await import('../../src/application/library-service.ts');
  const library = new LibraryService({ libraryDir: configuration.libraryDir });
  let exportsPromise: Promise<ExportService> | undefined;
  let epubPromise: Promise<EpubService> | undefined;
  let kindlePromise: Promise<KindleService> | undefined;
  let credentialStorePromise: Promise<SystemKindleCredentialStore> | undefined;
  let obsidianPromise: Promise<ObsidianService | undefined> | undefined;
  let searchPromise: Promise<SearchService> | undefined;
  let userStatePromise: Promise<UserStateService> | undefined;

  const getExports = (): Promise<ExportService> => {
    exportsPromise ??= import('../../src/application/export-service.ts')
      .then(({ ExportService }) => new ExportService({ library }))
      .catch((error: unknown) => { throw capabilityError('Local export support', error); });
    return exportsPromise;
  };
  const getEpub = (): Promise<EpubService> => {
    epubPromise ??= import('../../src/application/epub-service.ts')
      .then(({ EpubService }) => new EpubService({ library }))
      .catch((error: unknown) => { throw capabilityError('EPUB export support', error); });
    return epubPromise;
  };
  const getKindleCredentialStore = (): Promise<SystemKindleCredentialStore> => {
    credentialStorePromise ??= import('../../src/adapters/credentials/keyring.ts')
      .then(({ SystemKindleCredentialStore }) => new SystemKindleCredentialStore())
      .catch((error: unknown) => { throw capabilityError('System credential-store support', error); });
    return credentialStorePromise;
  };
  const getKindle = (): Promise<KindleService> => {
    kindlePromise ??= Promise.all([
      import('../../src/application/kindle-service.ts'),
      getExports(),
      getEpub(),
      getKindleCredentialStore(),
    ]).then(([{ KindleService }, exports, epub, credentialStore]) => new KindleService({
      library,
      exports,
      epub,
      ...(configuration.kindle ? { config: configuration.kindle } : {}),
      credentialStore,
    })).catch((error: unknown) => { throw capabilityError('Kindle delivery support', error); });
    return kindlePromise;
  };
  const getUserState = (): Promise<UserStateService> => {
    userStatePromise ??= import('../../src/application/user-state-service.ts')
      .then(({ UserStateService }) => new UserStateService({ library }))
      .catch((error: unknown) => { throw capabilityError('Reading-state support', error); });
    return userStatePromise;
  };
  const getSearch = (): Promise<SearchService> => {
    searchPromise ??= Promise.all([
      import('../../src/application/search-service.ts'),
      getUserState(),
    ]).then(([{ SearchService }, userState]) => new SearchService({ library, userState }))
      .catch((error: unknown) => { throw capabilityError('Full-text search support', error); });
    return searchPromise;
  };
  const getObsidian = (): Promise<ObsidianService | undefined> => {
    if (!configuration.obsidian) return Promise.resolve(undefined);
    obsidianPromise ??= Promise.all([
      import('../../src/application/obsidian-service.ts'),
      getExports(),
      getUserState(),
    ]).then(([{ ObsidianService }, exports, userState]) => new ObsidianService({ library, exports, userState }))
      .catch((error: unknown) => { throw capabilityError('Obsidian export support', error); });
    return obsidianPromise;
  };

  return {
    configPath: configuration.configPath,
    libraryDir: configuration.libraryDir,
    library,
    kindleConfig: configuration.kindle,
    obsidianConfig: configuration.obsidian,
    getExports,
    getEpub,
    getKindle,
    getKindleCredentialStore,
    getObsidian,
    getSearch,
    getUserState,
  };
}
