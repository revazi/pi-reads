import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/** Read one stable regular file without following a stream or accepting growth during the read. */
export async function readBoundedRegularFile(
  absolutePath: string,
  maximumBytes: number,
  label: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  // NONBLOCK prevents a named pipe from hanging before regular-file validation.
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximumBytes) {
      throw new Error(`${label} must be a regular file no larger than ${maximumBytes} bytes`);
    }
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const chunk = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!chunk.bytesRead) break;
      offset += chunk.bytesRead;
    }
    signal?.throwIfAborted();
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error(`${label} changed while reading`);
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
