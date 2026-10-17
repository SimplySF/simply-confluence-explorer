import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { remarkBaseLinks } from './plugins/remark-base-links.mjs';

// The GitHub Pages URL is tied to the repo name (SimplySF/simply-confluence-explorer), so this is the
// path prefix every page is served under. `remarkBaseLinks` applies it to root-relative links
// written in markdown; anything outside markdown body content (hero actions in index.mdx) has to
// carry the prefix by hand.
const base = '/simply-confluence-explorer';

export default defineConfig({
  site: 'https://simplysf.github.io',
  base,
  markdown: {
    remarkPlugins: [remarkBaseLinks(base)],
  },
  integrations: [
    starlight({
      title: 'Confluence Explorer',
      description:
        'A local web app by SimplySF for Confluence Server and Data Center: browse a space, keep a copy on disk as Markdown, ask an AI about it, and improve pages, with every write checked against the version it was made from.',
      logo: {
        light: './src/assets/logo-icon.png',
        dark: './src/assets/logo-icon-dark.png',
        alt: 'Simply SF logo',
      },
      favicon: '/favicon.png',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/SimplySF/simply-confluence-explorer' }],
      editLink: {
        // The guides are copied in from the package by scripts/sync-docs.mjs, so the file to edit is
        // the one in the package, not the copy under site/.
        baseUrl: 'https://github.com/SimplySF/simply-confluence-explorer/edit/main/packages/simply-confluence-explorer/docs/',
      },
      sidebar: [
        { label: 'Get Started', slug: 'getting-started' },
        {
          // Each guide carries a `sidebar.order`, so the group keeps reading order, not alphabetical.
          label: 'Guides',
          items: [{ autogenerate: { directory: 'guides' } }],
        },
      ],
    }),
  ],
});
