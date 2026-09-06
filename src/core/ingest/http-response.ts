async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      operation();
    };
    const abort = (): void => {
      void reader.cancel(signal.reason).catch(() => undefined);
      finish(() => reject(signal.reason));
    };
    signal.addEventListener('abort', abort, { once: true });
    reader.read().then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function assertDeclaredLength(
  response: Response,
  url: URL,
  maximum: number,
  label: 'Article' | 'Feed',
): Promise<void> {
  const header = response.headers.get('content-length');
  const declared = header === null ? undefined : Number(header);
  if (declared !== undefined && Number.isFinite(declared) && declared > maximum) {
    await response.body?.cancel();
    throw new Error(`${label} response exceeds the ${maximum} byte limit: ${url.href}`);
  }
}

async function responseBytes(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  url: URL,
  maximum: number,
  signal: AbortSignal,
  label: 'Article' | 'Feed',
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await readChunk(reader, signal);
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new Error(`${label} response exceeds the ${maximum} byte limit: ${url.href}`);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function readBoundedResponseText(
  response: Response,
  url: URL,
  maximum: number,
  signal: AbortSignal,
  label: 'Article' | 'Feed',
  fatalUtf8 = false,
): Promise<string> {
  await assertDeclaredLength(response, url, maximum, label);
  if (!response.body) return '';
  const bytes = await responseBytes(response.body.getReader(), url, maximum, signal, label);
  try { return new TextDecoder('utf-8', { fatal: fatalUtf8 }).decode(bytes); }
  catch { throw new Error(`${label} response is not valid UTF-8 XML: ${url.href}`); }
}

export async function assertAcceptedResponse(
  response: Response,
  url: URL,
  options: { resource: 'article' | 'feed'; contentLabel: 'URL' | 'feed'; mediaTypes: readonly string[] },
): Promise<void> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Could not fetch ${options.resource} ${url.href}: HTTP ${response.status}`);
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType && !options.mediaTypes.some((type) => contentType.includes(type))) {
    await response.body?.cancel();
    throw new Error(`Unsupported ${options.contentLabel} content type: ${contentType}`);
  }
}
