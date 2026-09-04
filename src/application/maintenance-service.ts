import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PiReadsConfig } from '../core/domain.ts';
import { resolveLibraryPath, assertSafeLibraryRoot } from '../core/library.ts';
import { assertFileMatches, describeFile, readMaintenanceFile, safeMaintenanceTarget, walkMaintenanceFiles, MAX_FILES, MAX_TOTAL_BYTES, MAX_FILE_BYTES, type MaintenanceFile } from '../core/maintenance-files.ts';
import { validateRecord } from '../core/record-validation.ts';
import { inspectLibrary, type VerificationReport, type VerifiedLibrary } from './library-verification.ts';
import { LibraryService } from './library-service.ts';
import { SearchService } from './search-service.ts';
import { UserStateService } from './user-state-service.ts';

interface PortableSnapshot {
  schemaVersion: 1;
  format: 'pi-reads-portable-v1';
  createdAt: string;
  config: Pick<PiReadsConfig, 'schemaVersion' | 'defaults'>;
  files: MaintenanceFile[];
}
export interface BackupResult {
  backupDir: string; fileCount: number; byteLength: number;
  excluded: string[]; verification: VerificationReport;
}
const EXCLUDED = ['credentials and credential-store entries', 'environment variables', 'Kindle/SMTP and Obsidian destination settings', 'machine-specific paths', 'derived indexes and locks', 'unreferenced files'];

function requireHealthy(verified: VerifiedLibrary): void {
  if (!verified.report.ok) throw new Error(`Library verification failed with ${verified.report.errorCount} error(s); run verify for bounded recovery findings`);
}

function assertDisjoint(left: string, right: string): void {
  const a = path.resolve(left).toLowerCase();
  const b = path.resolve(right).toLowerCase();
  if (a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`)) {
    throw new Error('Library and backup paths must be separate, non-nested directories');
  }
}

async function writePrivate(root: string, relative: string, bytes: string | Buffer): Promise<void> {
  const target = resolveLibraryPath(root, relative);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
}

async function copyVerified(from: string, to: string, file: MaintenanceFile): Promise<void> {
  const bytes = await readMaintenanceFile(from, file.path);
  assertFileMatches(file, bytes);
  await writePrivate(to, file.path, bytes);
}

async function portableConfig(config: PiReadsConfig): Promise<PortableSnapshot['config']> {
  // Deliberately reconstruct rather than spreading caller configuration. Never read a credential provider.
  const result: PortableSnapshot['config'] = { schemaVersion: 1 };
  if (config.defaults) {
    result.defaults = {
      ...(config.defaults.mode === undefined ? {} : { mode: config.defaults.mode }),
      ...(config.defaults.exportFormat === undefined ? {} : { exportFormat: config.defaults.exportFormat }),
    };
  }
  return validateRecord<PortableSnapshot['config']>('config', result);
}

function objectKeys(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('Invalid portable snapshot shape');
}

function snapshotFile(value: unknown): MaintenanceFile {
  objectKeys(value, ['path', 'contentHash', 'byteLength']);
  const checks = [
    typeof value.path === 'string',
    typeof value.contentHash === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value.contentHash),
    Number.isSafeInteger(value.byteLength),
    (value.byteLength as number) >= 0,
    (value.byteLength as number) <= MAX_FILE_BYTES,
  ];
  if (!checks.every(Boolean)) throw new Error('Invalid snapshot file');
  const file = value as unknown as MaintenanceFile;
  assertPortablePath(file.path);
  return file;
}

function assertPortablePath(relative: string): void {
  resolveLibraryPath('/portable', relative);
  const valid = [
    relative.length <= 1024,
    /^(sources|articles|exports|assets|state\/articles)\//u.test(relative),
    !/[\x00-\x1f\x7f<>:"|?*]/u.test(relative),
    !relative.split('/').some((part) => /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)),
  ];
  if (!valid.every(Boolean)) throw new Error('Non-portable snapshot path');
}

async function parseSnapshot(value: unknown): Promise<PortableSnapshot> {
  objectKeys(value, ['schemaVersion', 'format', 'createdAt', 'config', 'files']);
  await validateRecord('portable-snapshot', value);
  objectKeys(value.config, ['schemaVersion', 'defaults']);
  await validateRecord('config', value.config);
  if (!Array.isArray(value.files) || value.files.length > MAX_FILES) throw new Error('Invalid snapshot file count');
  const seen = new Set<string>();
  let total = 0;
  for (const input of value.files) {
    const file = snapshotFile(input);
    const folded = file.path.normalize('NFC').toLowerCase();
    if (seen.has(folded)) throw new Error('Snapshot path collision');
    seen.add(folded); total += file.byteLength as number;
    if (total > MAX_TOTAL_BYTES) throw new Error('Snapshot exceeds 2 GiB');
  }
  return value as unknown as PortableSnapshot;
}

async function checkSnapshotFiles(backupDir: string, snapshot: PortableSnapshot): Promise<VerifiedLibrary> {
  const expected = ['snapshot.json', ...snapshot.files.map((file) => `library/${file.path}`)].sort();
  const actual = await walkMaintenanceFiles(backupDir, '');
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Backup has missing or unexpected files');
  const sourceRoot = path.join(backupDir, 'library');
  for (const file of snapshot.files) assertFileMatches(file, await readMaintenanceFile(sourceRoot, file.path));
  const verified = await inspectLibrary(sourceRoot, false);
  requireHealthy(verified);
  // Only canonical manifests, their verified references, and validated state can be restored.
  if (JSON.stringify(verified.files) !== JSON.stringify(snapshot.files)) throw new Error('Backup inventory contains unreferenced or inconsistent files');
  return verified;
}

export class MaintenanceService {
  readonly libraryDir: string;
  constructor(libraryDir: string) { this.libraryDir = path.resolve(libraryDir); }

  async verify(): Promise<VerificationReport> { return (await inspectLibrary(this.libraryDir)).report; }

  async rebuild(): Promise<{ sourceIndexes: number; articleCount: number; searchDocuments: number }> {
    const verified = await inspectLibrary(this.libraryDir, false);
    requireHealthy(verified);
    await assertSafeLibraryRoot(this.libraryDir);
    // Do not let existing derived-cache links redirect any writes.
    await walkMaintenanceFiles(this.libraryDir, 'indexes');
    const library = new LibraryService({ libraryDir: this.libraryDir });
    const catalog = await library.rebuildIndex();
    for (const id of verified.sources.keys()) await library.rebuildSourceIndex(id);
    const search = await new SearchService({ library, userState: new UserStateService({ library }) }).rebuild();
    return { sourceIndexes: verified.sources.size, articleCount: catalog.articleCount, searchDocuments: search.documentCount };
  }

  async backup(backupDir: string, config: PiReadsConfig = { schemaVersion: 1 }): Promise<BackupResult> {
    const target = await safeMaintenanceTarget(backupDir);
    assertDisjoint(this.libraryDir, target);
    const verified = await inspectLibrary(this.libraryDir, false);
    requireHealthy(verified);
    const snapshot: PortableSnapshot = {
      schemaVersion: 1, format: 'pi-reads-portable-v1', createdAt: new Date().toISOString(),
      config: await portableConfig(config), files: verified.files,
    };
    await parseSnapshot(snapshot);
    // mkdir is an exclusive reservation, unlike rename which can replace an empty directory.
    await mkdir(target, { mode: 0o700 });
    try {
      const outputRoot = path.join(target, 'library');
      await mkdir(outputRoot, { mode: 0o700 });
      for (const file of snapshot.files) await copyVerified(this.libraryDir, outputRoot, file);
      const after = await inspectLibrary(this.libraryDir, false);
      requireHealthy(after);
      if (JSON.stringify(after.files) !== JSON.stringify(snapshot.files)) throw new Error('Library changed during backup; stop writers and retry');
      await writePrivate(target, 'snapshot.json', `${JSON.stringify(snapshot, null, 2)}\n`);
      await checkSnapshotFiles(target, snapshot);
    } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
    return {
      backupDir: target, fileCount: snapshot.files.length,
      byteLength: snapshot.files.reduce((sum, file) => sum + file.byteLength, 0),
      excluded: [...EXCLUDED], verification: verified.report,
    };
  }

  async restore(backupDir: string): Promise<{ libraryDir: string; fileCount: number; portableConfigPath: string; verification: VerificationReport }> {
    const target = await safeMaintenanceTarget(this.libraryDir);
    assertDisjoint(target, backupDir);
    const manifestBytes = await readMaintenanceFile(backupDir, 'snapshot.json');
    const snapshot = await parseSnapshot(JSON.parse(manifestBytes.toString('utf8')));
    await checkSnapshotFiles(backupDir, snapshot);
    await mkdir(target, { mode: 0o700 }); // Any existing directory, file, or symlink fails closed.
    try {
      for (const file of snapshot.files) await copyVerified(path.join(backupDir, 'library'), target, file);
      assertFileMatches(describeFile('snapshot.json', manifestBytes), await readMaintenanceFile(backupDir, 'snapshot.json'));
      const restored = await inspectLibrary(target, false);
      requireHealthy(restored);
      if (JSON.stringify(restored.files) !== JSON.stringify(snapshot.files)) throw new Error('Restored inventory mismatch');
      // This inert file does not change the active library, vault, or delivery configuration.
      await writePrivate(target, 'portable-config.json', `${JSON.stringify(snapshot.config, null, 2)}\n`);
      await new MaintenanceService(target).rebuild();
      const verification = await new MaintenanceService(target).verify();
      if (!verification.ok || verification.warningCount) throw new Error('Restored library did not pass verification');
      return { libraryDir: target, fileCount: snapshot.files.length, portableConfigPath: path.join(target, 'portable-config.json'), verification };
    } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
  }
}
