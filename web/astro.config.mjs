// @ts-check
import { defineConfig } from 'astro/config';

import svelte from '@astrojs/svelte';

/**
 * @typedef {{ type: string; tagName?: string; properties?: Record<string, any>; children?: HastNode[] }} HastNode
 */

/** Markdown has no syntax for link targets, so open off-site links in a new tab here instead. */
function rehypeExternalLinks() {
  /** @param {HastNode} node */
  const visit = (node) => {
    if (node.type === 'element' && node.tagName === 'a' && node.properties) {
      const href = node.properties.href ?? '';
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
