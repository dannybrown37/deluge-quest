// @ts-check
import { defineConfig } from 'astro/config';

import svelte from '@astrojs/svelte';

/** Markdown has no syntax for link targets, so open off-site links in a new tab here instead. */
function rehypeExternalLinks() {
  const visit = (node) => {
    if (node.type === 'element' && node.tagName === 'a') {
      const href = node.properties?.href ?? '';
      if (/^https?:\/\//.test(href)) {
        node.properties.target = '_blank';
        node.properties.rel = 'noopener';
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  return visit;
}

// https://astro.build/config
export default defineConfig({
  integrations: [svelte()],
  markdown: {
    rehypePlugins: [rehypeExternalLinks],
  },
});