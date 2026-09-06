import { lstat, rm } from 'node:fs/promises';
import { createImmutableRecordDirectory, type ImmutableRecordFile } from './library.ts';

export interface NewRecordDirectory { directory: string; files: readonly ImmutableRecordFile[] }
interface CreatedDirectory { path: string; dev: number; ino: number }

export class CaptureRecoveryError extends Error {
  constructor() {
    super('Capture rollback could not complete; stop writers and inspect the library before retrying');
  }
}

/** Compensation for a serialized capture mutation, never deletion of existing records. */
export class ImmutableRecordGroup {
  private readonly created: CreatedDirectory[] = [];
  private readonly root: string;
  private readonly allowGitWorkingTree: boolean;

  constructor(root: string, allowGitWorkingTree = false) {
    this.root = root;
    this.allowGitWorkingTree = allowGitWorkingTree;
  }

  async create(records: readonly NewRecordDirectory[]): Promise<void> {
    try {
      for (const record of records) {
        const target = await createImmutableRecordDirectory(this.root, record.directory, record.files, {
          allowGitWorkingTree: this.allowGitWorkingTree,
        });
        const identity = await lstat(target);
        this.created.push({ path: target, dev: identity.dev, ino: identity.ino });
      }
    } catch (error) {
      await this.rollback();
      throw error;
    }
  }

  async rollback(): Promise<void> {
    try { await this.removeCreated(); }
    catch { throw new CaptureRecoveryError(); }
  }

  private async removeCreated(): Promise<void> {
    // Reverse publication order; refuse to delete a path replaced by another writer.
    while (this.created.length) {
      const created = this.created[this.created.length - 1]!;
      const current = await lstat(created.path);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== created.dev || current.ino !== created.ino) {
        throw new Error('Capture rollback blocked: a newly created record was replaced; stop writers and inspect the library');
      }
      await rm(created.path, { recursive: true });
      this.created.pop();
    }
  }
}
