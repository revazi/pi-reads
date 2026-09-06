import type { IngestedSourceDraft } from '../domain.ts';
import { ingestMarkdown, ingestText } from './text.ts';

export function ingestClipboard(
  content: string,
  format: 'text' | 'markdown' = 'text',
  label = 'Clipboard capture',
): IngestedSourceDraft {
  const draft = format === 'markdown' ? ingestMarkdown(content, label) : ingestText(content, label);
  return {
    ...draft,
    kind: 'clipboard',
    locator: label,
    capture: { adapter: `clipboard-${format}`, adapterVersion: '1' },
  };
}
