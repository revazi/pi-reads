import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { getLanguage } from './cleanup.ts';

function fenceFor(source: string): string {
  const runs = source.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function createTurndown(): TurndownService {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    bulletListMarker: '-',
  });

  turndown.use(gfm);

  turndown.addRule('preserveTablesAsHtml', {
    filter: 'table',
    replacement(_content, node) {
      return `\n\n${(node as Element).outerHTML}\n\n`;
    },
  });

  turndown.addRule('fencedCodeBlocksWithLanguage', {
    filter(node) {
      return node.nodeName === 'PRE' && node.firstElementChild?.nodeName === 'CODE';
    },
    replacement(_content, node) {
      const code = node.firstElementChild;
      if (!code) {
        return '';
      }

      const source = (code.textContent ?? '').replace(/\n$/, '');
      const language = getLanguage(code);
      const fence = fenceFor(source);
      return `\n\n${fence}${language}\n${source}\n${fence}\n\n`;
    },
  });

  return turndown;
}

export function markdownFromHtml(contentHtml: string): string {
  return createTurndown()
    .turndown(contentHtml)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
