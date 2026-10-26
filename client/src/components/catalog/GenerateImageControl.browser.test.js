// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../../test/browserFixture.js';
import { resolveTestChrome } from '../../../../scripts/lib/testChrome.js';

const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright-core', { paths: [fileURLToPath(new URL('../../..', import.meta.url))] }));
const chrome = resolveTestChrome();

describe.skipIf(!chrome)('catalog image composer layering', () => {
  let fixture;
  beforeAll(async () => {
    fixture = await startBrowserFixture({ name: 'catalog-image-composer', createServer, chromium,
      launchOptions: { executablePath: chrome },
      warmup: async (page, origin) => {
        await page.goto(`${origin}composer-test`);
        await page.getByRole('button', { name: 'Generate', exact: true }).waitFor();
      },
      viteConfig: temp => ({
        cacheDir: join(temp, 'vite'), configFile: false,
        root: fileURLToPath(new URL('../../..', import.meta.url)),
        optimizeDeps: { entries: ['src/components/catalog/GenerateImageControl.jsx'], include: ['react', 'react-dom/client'] },
        plugins: [react(), {
          name: 'catalog-composer-fixture',
          resolveId(id) { if (id === '/composer-fixture.jsx') return '\0composer-fixture.jsx'; },
          load(id) {
            if (id.endsWith('/src/services/apiSystem.js')) return 'export async function generateImage(body) { window.renderedBody = body; return { filename: "synthetic.png" }; }';
            if (id.endsWith('/src/services/apiUniverseBuilder.js')) return 'export async function getUniverse() { return { id: "synthetic-world", influences: { embrace: ["Analog photography"] } }; }';
            if (id.endsWith('/src/services/apiImageVideo.js')) return 'export async function previewImagePrompt(body) { return { sentPrompt: body.prompt, promptAdditions: body.promptAdditions }; }';
            if (id.endsWith('/src/components/pipeline/MediaJobThumb.jsx')) return 'export default function MediaJobThumb() { return null; }';
            if (id !== '\0composer-fixture.jsx') return;
            return `
              import React from 'react';
              import { createRoot } from 'react-dom/client';
              import GenerateImageControl from '/src/components/catalog/GenerateImageControl.jsx';
              import '/src/index.css';
              createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null,
                React.createElement('section', { id: 'clipped-card', style: { height: 150, overflow: 'hidden', transform: 'translateZ(0)', position: 'relative', zIndex: 1, padding: 20 } },
                  React.createElement('h1', null, 'Synthetic universe record'),
                  React.createElement(GenerateImageControl, { ingredientId: 'synthetic-subject', name: 'Synthetic subject', description: 'A blue coat and brass details', universeId: 'synthetic-world' })),
                React.createElement('section', { style: { height: 500, position: 'relative', zIndex: 20, background: '#334155' } }, 'Later card with a higher stacking context')
              ));
            `;
          },
          configureServer(vite) {
            vite.middlewares.use('/composer-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/composer-test', '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/composer-fixture.jsx"></script>'));
            });
          },
        }], server: { host: '127.0.0.1', port: 0 },
      }),
    });
  }, BROWSER_FIXTURE_STARTUP_MS);
  afterAll(() => fixture?.close());

  it.each([[360, 640], [1440, 900]])('keeps the editor and Render reachable above later cards at %sx%s', async (width, height) => {
    const page = await fixture.browser.newPage({ viewport: { width, height } });
    try {
      await page.goto(`${fixture.origin}composer-test`);
      await page.getByRole('button', { name: 'Generate', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      expect(await dialog.evaluate(el => document.getElementById('clipped-card').contains(el))).toBe(false);
      const bounds = await dialog.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
      await page.getByRole('button', { name: '+ Universe style' }).waitFor();
      const render = dialog.getByRole('button', { name: 'Render', exact: true });
      await render.scrollIntoViewIfNeeded();
      expect(await render.evaluate(el => {
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      })).toBe(true);
      await render.click();
      await dialog.waitFor({ state: 'detached' });
      expect(await page.evaluate(() => window.renderedBody.prompt)).toBe('Analog photography. Synthetic subject: A blue coat and brass details');
    } finally { await page.close(); }
  });
});
