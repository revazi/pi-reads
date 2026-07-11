import crypto from 'node:crypto';
import path from 'node:path';

export type Frontmatter = Record<string, unknown>;

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function parseFrontmatter(markdown: string): Frontmatter {
  const lines = markdown.split('\n');
  if (lines[0] !== '---') {
    return {};
  }

  const end = lines.indexOf('---', 1);
  if (end === -1) {
    return {};
  }

  const metadata: Frontmatter = {};
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    try {
      const parsed: unknown = JSON.parse(rawValue);
      metadata[key] = parsed;
    } catch {
      metadata[key] = rawValue;
    }
  }

  return metadata;
}

export function articleSlug(articlePath: string, metadata: Frontmatter): string {
  const slug = metadata.slug;
  return typeof slug === 'string' ? slug : path.basename(articlePath, '.md');
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
