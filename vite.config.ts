import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const SITE_URL = 'https://andifathulms.github.io/query-planner/';

/** The one description, read from the file the app renders from. */
const { description: DESCRIPTION } = JSON.parse(
  readFileSync(new URL('./src/description.json', import.meta.url), 'utf8'),
) as { description: string };

/**
 * Write the one description into the head, rather than keeping five copies.
 *
 * The page, the meta tag, the two card descriptions and the manifest all said
 * the same thing by hand until they did not: the shipped description was an old
 * header tagline that no longer appeared on the page at all. Generating them
 * from the constant the lede renders makes that drift impossible.
 */
function metadata(): Plugin {
  return {
    name: 'query-planner-metadata',
    transformIndexHtml(html: string) {
      return html
        .replaceAll('%DESCRIPTION%', DESCRIPTION)
        .replaceAll('%SITE_URL%', SITE_URL);
    },
    /* The manifest is the fifth copy of the same sentence, and robots.txt did
     * not exist. Both are written here from the one source. */
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: readFileSync(new URL('./public/manifest.webmanifest', import.meta.url), 'utf8')
          .replaceAll('%DESCRIPTION%', DESCRIPTION),
      });
      this.emitFile({
        type: 'asset',
        fileName: 'robots.txt',
        source: `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}sitemap.xml\n`,
      });
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: '<?xml version="1.0" encoding="UTF-8"?>\n'
          + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
          + `  <url><loc>${SITE_URL}</loc></url>\n`
          + '</urlset>\n',
      });
    },
  };
}

// `base` is the repo path so GitHub Pages serves assets correctly.
export default defineConfig({
  plugins: [react(), metadata()],
  base: process.env.GITHUB_ACTIONS ? '/query-planner/' : '/',
  build: { target: 'es2022' },
});
