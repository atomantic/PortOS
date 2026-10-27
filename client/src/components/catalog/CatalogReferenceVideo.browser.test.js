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

describe.skipIf(!chrome)('reference video framing', () => {
  let fixture;
  beforeAll(async () => {
    fixture = await startBrowserFixture({ name: 'reference-video', createServer, chromium,
      launchOptions: { executablePath: chrome },
      viteConfig: temp => ({
        cacheDir: join(temp, 'vite'), configFile: false,
        root: fileURLToPath(new URL('../../..', import.meta.url)),
        optimizeDeps: { entries: ['src/components/catalog/CatalogReferenceLibrary.jsx'], include: ['react', 'react-dom/client'] },
        plugins: [react(), {
          name: 'reference-video-fixture',
          resolveId(id) { if (id === '/reference-video-fixture.jsx') return '\0reference-video-fixture.jsx'; },
          load(id) {
            if (id !== '\0reference-video-fixture.jsx') return;
            return `import React from 'react';
              import { createRoot } from 'react-dom/client';
              import CatalogReferenceLibrary from '/src/components/catalog/CatalogReferenceLibrary.jsx';
              import '/src/index.css';
              createRoot(document.getElementById('root')).render(React.createElement(CatalogReferenceLibrary, {
                ingredientId: 'synthetic', media: ['landscape', 'portrait', 'square'].map(mediaKey => ({ kind: 'video', mediaKey })), onDetach: () => {}
              }));`;
          },
          configureServer(vite) {
            vite.middlewares.use('/reference-video-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/reference-video-test', '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/reference-video-fixture.jsx"></script>'));
            });
          },
        }], server: { host: '127.0.0.1', port: 0 },
      }),
    });
  }, BROWSER_FIXTURE_STARTUP_MS);
  afterAll(() => fixture?.close());

  it.each([[360, 'kestrel-neon'], [1440, 'kestrel-neon'], [360, 'kestrel-neon-day'], [1440, 'kestrel-neon-day']])
  ('displays both frame edges at %s pixels in %s', async (width, theme) => {
    const page = await fixture.browser.newPage({ viewport: { width, height: 1000 } });
    try {
      await page.goto(`${fixture.origin}reference-video-test`);
      await page.locator('video').first().waitFor();
      await page.evaluate(async themeName => {
        document.documentElement.dataset.portTheme = themeName;
        window.syntheticStreams = [];
        for (const [i, video] of [...document.querySelectorAll('video')].entries()) {
          const canvas = document.createElement('canvas');
          [canvas.width, canvas.height] = [[320, 180], [180, 320], [200, 200]][i];
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, i === 0 ? 40 : canvas.width, i === 0 ? canvas.height : canvas.height / 4);
          ctx.fillStyle = '#00ff00'; ctx.fillRect(i === 0 ? canvas.width - 40 : 0, i === 0 ? 0 : canvas.height * 3 / 4, i === 0 ? 40 : canvas.width, i === 0 ? canvas.height : canvas.height / 4);
          const stream = canvas.captureStream(5); window.syntheticStreams.push(stream);
          video.srcObject = stream; video.muted = true; await video.play();
        }
      }, theme);
      for (let i = 0; i < 3; i++) {
        const video = page.locator('video').nth(i);
        await video.scrollIntoViewIfNeeded();
        const geometry = await video.evaluate(el => ({ width: el.clientWidth, height: el.clientHeight, controls: el.controls, preload: el.preload }));
        expect(Math.abs(geometry.width - geometry.height)).toBeLessThan(2);
        expect(geometry.controls).toBe(true);
        expect(geometry.preload).toBe('none');
        await video.evaluate(el => { el.controls = false; });
        const screenshot = await video.screenshot();
        await video.evaluate(el => { el.controls = true; });
        const pixels = await page.evaluate(async ({ data, index }) => {
          const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
          const coords = index === 0 ? [[0.06, 0.5], [0.94, 0.5]] : [[0.5, 0.2], [0.5, 0.8]];
          return coords.map(([x, y]) => [...ctx.getImageData(Math.floor(x * image.width), Math.floor(y * image.height), 1, 1).data]);
        }, { data: screenshot.toString('base64'), index: i });
        expect(pixels[0][0]).toBeGreaterThan(180);
        expect(pixels[1][1]).toBeGreaterThan(180);
      }
      expect(await page.getByRole('button', { name: 'Detach', exact: true }).count()).toBe(3);
      await page.getByRole('button', { name: 'Detach', exact: true }).first().click();
      await expect.poll(() => page.getByRole('group', { name: 'Confirm media detach' }).count()).toBe(1);
    } finally { await page.close(); }
  });
});
