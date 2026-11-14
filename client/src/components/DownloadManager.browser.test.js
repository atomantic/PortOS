// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../test/browserFixture.js';
import { resolveTestChrome } from '../../../scripts/lib/testChrome.js';

const chrome = resolveTestChrome();
const root = fileURLToPath(new URL('../..', import.meta.url));

describe.skipIf(!chrome)('saving a shot from a mobile drawer', () => {
  let fixture;
  beforeAll(async () => {
    fixture = await startBrowserFixture({
      name: 'shot-mobile-save', createServer, chromium,
      launchOptions: { executablePath: chrome },
      viteConfig: temp => ({
        configFile: false, root, cacheDir: join(temp, 'vite-cache'),
        optimizeDeps: { entries: ['src/components/DownloadManager.jsx', 'src/components/musicVideo/ShotDownload.jsx', 'src/components/Drawer.jsx'], include: ['react', 'react-dom/client'] },
        plugins: [react(), {
          name: 'shot-mobile-save-fixture',
          resolveId(id) { if (id === '/shot-mobile-save.jsx') return '\0shot-mobile-save.jsx'; },
          load(id) {
            if (id !== '\0shot-mobile-save.jsx') return;
            return `
              import React from 'react';
              import { createRoot } from 'react-dom/client';
              import Drawer from '/src/components/Drawer.jsx';
              import DownloadManager from '/src/components/DownloadManager.jsx';
              import ShotDownload from '/src/components/musicVideo/ShotDownload.jsx';
              import '/src/index.css';
              const originalFetch = window.fetch.bind(window);
              const response = () => new Response(new Blob(['synthetic video'], { type: 'video/mp4' }), { status: 200 });
              window.fetch = (url, options) => {
                if (!String(url).startsWith('/api/music-video/')) return originalFetch(url, options);
                window.prepareSignal = options.signal;
                if (window.denyPrepare) return Promise.resolve(new Response(JSON.stringify({ error: 'Operator access required', code: 'HOST_CONTROL_FORBIDDEN' }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
                if (window.deferPrepare) return new Promise(resolve => { window.finishPrepare = () => resolve(response()); });
                return Promise.resolve(response());
              };
              Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
              Object.defineProperty(navigator, 'share', { configurable: true, value: (data) => {
                window.sharedFile = { name: data.files[0].name, type: data.files[0].type, size: data.files[0].size };
                window.shareHadActivation = navigator.userActivation.isActive;
                const failure = window.shareFailure;
                window.shareFailure = null;
                if (failure) return Promise.reject(Object.assign(new Error('Share failed'), { name: failure === 'cancel' ? 'AbortError' : 'Error' }));
                return Promise.resolve();
              } });
              const h = React.createElement;
              createRoot(document.getElementById('root')).render(h(React.Fragment, null,
                h(Drawer, { open: true, title: 'Shot editor', onClose: () => {} },
                  h(ShotDownload, { projectId: 'p', sceneId: 's', basis: 'saved', startSec: 2, endSec: 3 })),
                h(DownloadManager)));
            `;
          },
          configureServer(vite) {
            vite.middlewares.use('/shot-mobile-save-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/shot-mobile-save-test', '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/shot-mobile-save.jsx"></script></body></html>'));
            });
          },
        }],
        server: { host: '127.0.0.1', port: 0 },
      }),
    });
  }, BROWSER_FIXTURE_STARTUP_MS);
  afterAll(() => fixture?.close());

  it('shows an actionable save sheet above the shot drawer on repeated downloads', async () => {
    const context = await fixture.browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    try {
      await page.goto(`${fixture.origin}shot-mobile-save-test`);
      await page.getByRole('button', { name: 'Prepare clip with music' }).click();
      for (let i = 0; i < 2; i++) {
        await page.getByRole('link', { name: 'Download clip' }).click();
        const sheet = page.getByRole('dialog', { name: 'Save download' });
        await sheet.getByRole('button', { name: 'Save', exact: true }).waitFor({ state: 'visible' });
        const save = sheet.getByRole('button', { name: 'Save', exact: true });
        await save.click({ timeout: 3000 });
        expect(await page.evaluate(() => window.sharedFile)).toEqual({ name: 'music-video-shot.mp4', type: 'video/mp4', size: 15 });
        expect(await page.evaluate(() => window.shareHadActivation)).toBe(true);
        await sheet.waitFor({ state: 'hidden' });
      }
    } finally { await context.close(); }
  });

  it('cancels preparation and retains the clip after a canceled or failed share', async () => {
    const context = await fixture.browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    try {
      await page.goto(`${fixture.origin}shot-mobile-save-test`);
      await page.evaluate(() => { window.deferPrepare = true; });
      await page.getByRole('button', { name: 'Prepare clip with music' }).click();
      await page.getByRole('button', { name: 'Cancel' }).click();
      expect(await page.evaluate(() => window.prepareSignal.aborted)).toBe(true);
      await page.evaluate(() => { window.deferPrepare = false; window.finishPrepare(); });
      await page.evaluate(() => { window.denyPrepare = true; });
      await page.getByRole('button', { name: 'Prepare clip with music' }).click();
      expect(await page.getByRole('alert').textContent()).toContain('Operator access required');
      await page.evaluate(() => { window.denyPrepare = false; });
      await page.getByRole('button', { name: 'Prepare clip with music' }).click();
      await page.getByRole('link', { name: 'Download clip' }).click();
      const sheet = page.getByRole('dialog', { name: 'Save download' });
      const save = sheet.getByRole('button', { name: 'Save', exact: true });
      await page.evaluate(() => { window.shareFailure = 'cancel'; });
      await save.click();
      await save.waitFor({ state: 'visible' });
      expect(await sheet.getByRole('alert').count()).toBe(0);
      await page.evaluate(() => { window.shareFailure = 'error'; });
      await save.click();
      await sheet.getByRole('alert').waitFor({ state: 'visible' });
      expect(await sheet.getByRole('alert').textContent()).toContain('Share failed');
      await save.click();
      await sheet.waitFor({ state: 'hidden' });
      expect(await page.evaluate(() => window.sharedFile.name)).toBe('music-video-shot.mp4');
    } finally { await context.close(); }
  });
});
