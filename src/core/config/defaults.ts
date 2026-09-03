import type { ArticleMode, ExportFormat, PiReadsConfig } from '../domain.ts';
import { assertJsonObject, assertKnownKeys } from './shared.ts';

const ARTICLE_MODES: ReadonlySet<ArticleMode> = new Set(['archive', 'digest', 'synthesis']);
const EXPORT_FORMATS: ReadonlySet<ExportFormat> = new Set(['markdown', 'html', 'pdf', 'epub']);

export function parseDefaultConfig(value: unknown): NonNullable<PiReadsConfig['defaults']> {
  assertJsonObject(value, 'defaults');
  assertKnownKeys(value, new Set(['mode', 'exportFormat']), 'defaults');
  const mode = value.mode;
  const exportFormat = value.exportFormat;
  if (mode !== undefined && (typeof mode !== 'string' || !ARTICLE_MODES.has(mode as ArticleMode))) {
    throw new Error(`Unsupported default article mode: ${String(mode)}`);
  }
  if (exportFormat !== undefined && (typeof exportFormat !== 'string' || !EXPORT_FORMATS.has(exportFormat as ExportFormat))) {
    throw new Error(`Unsupported default export format: ${String(exportFormat)}`);
  }
  return {
    ...(mode === undefined ? {} : { mode: mode as ArticleMode }),
    ...(exportFormat === undefined ? {} : { exportFormat: exportFormat as ExportFormat }),
  };
}
