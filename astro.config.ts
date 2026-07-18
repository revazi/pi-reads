import { satteri } from '@astrojs/markdown-satteri';
import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  markdown: {
    processor: satteri({ features: { smartPunctuation: false } }),
    syntaxHighlight: 'shiki',
    shikiConfig: {
      theme: 'github-light',
    },
  },
});
