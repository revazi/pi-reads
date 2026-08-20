import { JSDOM } from 'jsdom';
import { chromium, type Browser } from 'playwright';
import { errorMessage } from '../errors.ts';
import { normalizeText } from '../text.ts';

interface FontFamilySample {
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
    if (style) {
      weights[style] += Math.min(sample.textLength, 1_000);
    }
  }

  return weights['sans-serif'] > weights.serif ? 'sans-serif' : 'serif';
}

async function collectFontFamilySamples(
  browser: Browser,
  url: string,
  articleSamples: string[],
): Promise<FontFamilySample[]> {
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);

    return await page.evaluate((expectedParagraphs) => {
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
      const expectedPrefixes = expectedParagraphs.map((text) => text.slice(0, 160));
      const visibleParagraphs = [...document.querySelectorAll('p')].filter((paragraph) => {
        const style = getComputedStyle(paragraph);
        const text = normalize(paragraph.textContent ?? '');
        return text.length >= 40 && style.display !== 'none' && style.visibility !== 'hidden';
      });

      let candidates = visibleParagraphs.filter((paragraph) => {
        const text = normalize(paragraph.textContent ?? '');
        return expectedPrefixes.some((prefix) => text.includes(prefix));
      });

      if (candidates.length === 0) {
        const selectors = ['article p', '[role="article"] p', 'main p', '[role="main"] p', 'body p'];
        for (const selector of selectors) {
          candidates = visibleParagraphs.filter((paragraph) => paragraph.matches(selector));
          if (candidates.length > 0) {
            break;
          }
        }
      }

      return candidates
        .map((paragraph) => ({
          fontFamily: getComputedStyle(paragraph).fontFamily,
          textLength: normalize(paragraph.textContent ?? '').length,
        }))
        .sort((left, right) => right.textLength - left.textLength)
        .slice(0, 20);
    }, articleSamples);
  } finally {
    await page.close();
  }
}

export async function detectSourceFontStyle(url: string, contentHtml: string): Promise<SourceFontStyle> {
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch();
    const samples = await collectFontFamilySamples(browser, url, articleParagraphSamples(contentHtml));
    return chooseSourceFontStyle(samples);
  } catch (error: unknown) {
    console.warn(`Could not detect source font style; using serif: ${errorMessage(error)}`);
    return 'serif';
  } finally {
    await browser?.close();
  }
}
