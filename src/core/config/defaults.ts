import type { ArticleMode, ExportFormat, PiReadsConfig } from '../domain.ts';
import { assertJsonObject, assertKnownKeys } from './shared.ts';

const ARTICLE_MODES: ReadonlySet<ArticleMode> = new Set(['archive', 'digest', 'synthesis']);
const EXPORT_FORMATS: ReadonlySet<ExportFormat> = new Set(['markdown', 'html', 'pdf', 'epub']);

function optionalTemplateId(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/u.test(value)) {
    throw new Error(`${name} must be a valid generation template ID`);
  }
  return value;
}

export function parseDefaultConfig(value: unknown): NonNullable<PiReadsConfig['defaults']> {
  assertJsonObject(value, 'defaults');
  assertKnownKeys(value, new Set(['mode', 'exportFormat', 'digestTemplateId', 'synthesisTemplateId']), 'defaults');
  const mode = value.mode;
  const exportFormat = value.exportFormat;
  const digestTemplateId = value.digestTemplateId;
  const synthesisTemplateId = value.synthesisTemplateId;
  if (mode !== undefined && (typeof mode !== 'string' || !ARTICLE_MODES.has(mode as ArticleMode))) {
    throw new Error(`Unsupported default article mode: ${String(mode)}`);
  }
  if (exportFormat !== undefined && (typeof exportFormat !== 'string' || !EXPORT_FORMATS.has(exportFormat as ExportFormat))) {
    throw new Error(`Unsupported default export format: ${String(exportFormat)}`);
  }
  const parsedDigestTemplateId = optionalTemplateId(digestTemplateId, 'digestTemplateId');
  const parsedSynthesisTemplateId = optionalTemplateId(synthesisTemplateId, 'synthesisTemplateId');
  return {
    ...(mode === undefined ? {} : { mode: mode as ArticleMode }),
    ...(exportFormat === undefined ? {} : { exportFormat: exportFormat as ExportFormat }),
    ...(parsedDigestTemplateId === undefined ? {} : { digestTemplateId: parsedDigestTemplateId }),
    ...(parsedSynthesisTemplateId === undefined ? {} : { synthesisTemplateId: parsedSynthesisTemplateId }),
  };
}
