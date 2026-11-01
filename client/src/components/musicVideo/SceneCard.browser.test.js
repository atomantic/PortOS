// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../../test/browserFixture.js';
import { resolveTestChrome } from '../../../../scripts/lib/testChrome.js';

const chrome = resolveTestChrome();
const root = fileURLToPath(new URL('../../..', import.meta.url));

describe.skipIf(!chrome)('shot editor render selector layout', () => {
  let fixture;

  beforeAll(async () => {
    fixture = await startBrowserFixture({
      name: 'shot-editor-render-selector', createServer, chromium,
      launchOptions: { executablePath: chrome, args: ['--mute-audio'] },
      viteConfig: temp => ({
        configFile: false, root, cacheDir: join(temp, 'vite-cache'),
        optimizeDeps: { entries: ['src/components/musicVideo/SceneCard.jsx'], include: ['react', 'react-dom/client'] },
        plugins: [react(), {
          name: 'shot-editor-layout-fixture',
          resolveId(id) { if (id === '/shot-editor-fixture.jsx') return '\0shot-editor-fixture.jsx'; },
          load(id) {
            if (id !== '\0shot-editor-fixture.jsx') return;
            return `
              import React from 'react';
              import { createRoot } from 'react-dom/client';
              import SceneCard from '/src/components/musicVideo/SceneCard.jsx';
              import '/src/index.css';
              const h = React.createElement;
              const width = Number(new URLSearchParams(location.search).get('width'));
              const scene = { sceneId: 'layout', order: 0, startSec: 0, endSec: 4, referenceImageId: 'synthetic.png',
                visualIntent: 'Synthetic direction', takes: [] };
              const models = [{ id: 'synthetic-long-model', name: 'An exceptionally long local video rendering model name for layout validation',
                runtime: 'ltx25', supportedModes: ['image'] }];
              createRoot(document.getElementById('root')).render(
                h('main', { style: { width: width + 'px', maxWidth: '100%', padding: '8px', boxSizing: 'border-box' } },
                  h(SceneCard, { scene, index: 0, expanded: true, videoModels: models, onEditLocal: () => {}, onSave: () => {} })));
            `;
          },
          configureServer(vite) {
            vite.middlewares.use('/shot-editor-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/shot-editor-test', '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/shot-editor-fixture.jsx"></script></body></html>'));
            });
          },
        }],
        server: { host: '127.0.0.1', port: 0 },
      }),
    });
  }, BROWSER_FIXTURE_STARTUP_MS);

  afterAll(() => fixture?.close());

  it.each([
    [320, 320], [390, 390], [768, 768], [820, 820], [900, 900], [1024, 1024], [1280, 1280], [1440, 1440],
    [1440, 240], [1440, 320], [1440, 480], [1440, 820],
  ])('keeps renderer controls inside the shot column at viewport %i and container %i', async (viewportWidth, containerWidth) => {
    const page = await fixture.browser.newPage({ viewport: { width: viewportWidth, height: 1000 } });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === new URL(fixture.origin).origin && !/^\/(api|data|socket\.io)(\/|$)/.test(url.pathname)
        ? route.continue() : route.abort();
    });
    try {
      await page.goto(`${fixture.origin}shot-editor-test?width=${containerWidth}`);
      const renderer = page.getByLabel('Render on');
      await renderer.waitFor();
      for (const value of ['', 'grok', 'local']) {
        await renderer.selectOption(value);
        if (value === 'local') {
          const model = page.getByLabel('Model', { exact: true });
          await model.selectOption('synthetic-long-model');
          expect(await model.locator('option:checked').textContent()).toContain('exceptionally long');
        }
        const geometry = await renderer.evaluate(select => {
          const section = select.closest('section[aria-label="Render"]');
          const row = select.parentElement.parentElement;
          const direction = document.querySelector('[data-testid="shot-group-direction"]').getBoundingClientRect();
          const bounds = section.getBoundingClientRect();
          const controls = [...row.querySelectorAll('select')].map(control => {
            const rect = control.getBoundingClientRect();
            return { id: control.id, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
          });
          return { left: bounds.left, right: bounds.right, direction: { left: direction.left, right: direction.right, top: direction.top, bottom: direction.bottom }, controls };
        });
        for (const control of geometry.controls) {
          expect(control.left, control.id).toBeGreaterThanOrEqual(geometry.left - 1);
          expect(control.right, control.id).toBeLessThanOrEqual(geometry.right + 1);
          expect(control.width, control.id).toBeGreaterThan(20);
          const overlapsDirection = control.left < geometry.direction.right && control.right > geometry.direction.left
            && control.top < geometry.direction.bottom && control.bottom > geometry.direction.top;
          expect(overlapsDirection, control.id).toBe(false);
        }
      }
    } finally {
      await page.close();
    }
  }, 60000);
});
