import { JSDOM } from 'jsdom';
import { normalizeText } from '../text.ts';

export interface FontFamilySample {
  fontFamily: string;
  textLength: number;
}

export type SourceFontStyle = 'serif' | 'sans-serif';

function articleParagraphSamples(contentHtml: string): string[] {
  const dom = new JSDOM(`<!doctype html><main>${contentHtml}</main>`);
  return [...dom.window.document.querySelectorAll('p')]
    .map((paragraph) => normalizeText(paragraph.textContent ?? ''))
    .filter((text) => text.length >= 80)
    .sort((left, right) => right.length - left.length)
    .slice(0, 12);
}

export function classifyFontFamily(fontFamily: string): SourceFontStyle | null {
  const families = fontFamily
    .split(',')
    .map((family) => family.trim().replace(/^['"]|['"]$/g, '').toLowerCase())
    .filter(Boolean);

  for (const family of families) {
    if (
      family === 'sans-serif' ||
      family === 'ui-sans-serif' ||
      family === 'system-ui' ||
      /(^|[\s-])(sans|grotesk|grotesque)([\s-]|$)/.test(family) ||
      /^(arial|helvetica|inter|roboto|verdana|tahoma|trebuchet ms|segoe ui|calibri|avenir|futura)$/.test(family)
    ) {
      return 'sans-serif';
    }

    if (
      family === 'serif' ||
      family === 'ui-serif' ||
      /(^|[\s-])serif([\s-]|$)/.test(family) ||
      /^(georgia|cambria|charter|garamond|baskerville|palatino|times|times new roman|merriweather|literata|lora)$/.test(family)
    ) {
      return 'serif';
    }
  }

  return null;
}

export function chooseSourceFontStyle(samples: FontFamilySample[]): SourceFontStyle {
  const weights: Record<SourceFontStyle, number> = { serif: 0, 'sans-serif': 0 };
  for (const sample of samples) {
    const style = classifyFontFamily(sample.fontFamily);
    if (style) weights[style] += Math.min(sample.textLength, 1_000);
  }
  return weights['sans-serif'] > weights.serif ? 'sans-serif' : 'serif';
}

/**
 * Infer presentation from the already captured document. JSDOM applies inline
 * and embedded styles without loading linked stylesheets or navigating again.
 * Unknown, external-only, or malformed styling safely defaults to serif.
 */
export function inferSourceFontStyle(contentHtml: string, capturedHtml = contentHtml): SourceFontStyle {
  try {
    const expectedPrefixes = articleParagraphSamples(contentHtml).map((text) => text.slice(0, 160));
    const dom = new JSDOM(capturedHtml);
    const { document } = dom.window;
    const paragraphs = [...document.querySelectorAll('p')].filter((paragraph) => {
      const text = normalizeText(paragraph.textContent ?? '');
      return text.length >= 40;
    });
    let candidates = paragraphs.filter((paragraph) => {
      const text = normalizeText(paragraph.textContent ?? '');
      return expectedPrefixes.some((prefix) => text.includes(prefix));
    });
    if (candidates.length === 0) {
      candidates = paragraphs.filter((paragraph) =>
        paragraph.matches('article p, [role="article"] p, main p, [role="main"] p, body p'),
      );
    }
    const samples = candidates
      .map((paragraph) => ({
        fontFamily: dom.window.getComputedStyle(paragraph).fontFamily,
        textLength: normalizeText(paragraph.textContent ?? '').length,
      }))
      .filter((sample) => sample.fontFamily.trim())
      .sort((left, right) => right.textLength - left.textLength)
      .slice(0, 20);
    return chooseSourceFontStyle(samples);
  } catch {
    return 'serif';
  }
}

/** @deprecated Use inferSourceFontStyle; this compatibility wrapper performs no browser work. */
export async function detectSourceFontStyle(
  _url: string,
  contentHtml: string,
  capturedHtml = contentHtml,
): Promise<SourceFontStyle> {
  return inferSourceFontStyle(contentHtml, capturedHtml);
}
