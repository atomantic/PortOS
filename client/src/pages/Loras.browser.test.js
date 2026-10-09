// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../test/browserFixture.js';

const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => path && existsSync(path));

const isFixtureRequest = (origin, route) => {
  const url = new URL(route.request().url());
  return url.origin === new URL(origin).origin && !/^\/(api|socket\.io)(\/|$)/.test(url.pathname);
};

describe.skipIf(!chrome)('LoRA touch targets (#10692)', () => {
  let browser;
  let fixture;
  let origin;

  beforeAll(async () => {
    fixture = await startBrowserFixture({
      name: 'loras-touch-targets', createServer, chromium,
      launchOptions: { executablePath: chrome, args: ['--mute-audio'] },
      viteConfig: temp => ({
        configFile: false,
        cacheDir: join(temp, 'vite-cache'),
        optimizeDeps: { entries: ['src/pages/Loras.jsx'], include: ['react', 'react-dom/client', 'react-router'] },
        root: fileURLToPath(new URL('../..', import.meta.url)),
        plugins: [react(), {
          name: 'loras-touch-fixture',
          enforce: 'pre',
          resolveId(id) {
            if (id === '/loras-fixture.jsx') return '\0loras-fixture.jsx';
            if (/\/services\/api(?:\.js)?$/.test(id)) return '\0loras-api';
          },
          load(id) {
            if (id === '\0loras-api') return `
              export const listLorasFull = async () => [];
              export const installLoraFromCivitai = async () => {};
              export const previewLoraInstall = async () => ({ verdict: 'ok' });
              export const installLoraFromHuggingfaceStream = async () => {};
              export const deleteLoraFull = async () => {};
              export const getCivitaiAuth = async () => ({ hasKey: false, source: 'none' });
              export const setCivitaiAuth = async () => {};
              export const clearCivitaiAuth = async () => {};
              export const getCivitaiSuggestions = async () => ({ runners: {}, video: [], fetchedAt: null });
              export const searchCivitaiLoras = async () => ({ items: [], nextCursor: null });
              export const searchVideoLoras = async () => ({ items: [], nextCursor: null });
              export const probeLoraEffect = async () => {};
            `;
            if (id !== '\0loras-fixture.jsx') return;
            return `
              import React from 'react';
              import { createRoot } from 'react-dom/client';
              import { MemoryRouter } from 'react-router';
              import Loras from '/src/pages/Loras.jsx';
              import '/src/index.css';
              createRoot(document.getElementById('root')).render(
                React.createElement(MemoryRouter, { initialEntries: ['/models/loras'] },
                  React.createElement('main', { className: 'w-full min-w-0 p-4' }, React.createElement(Loras)))
              );
            `;
          },
          configureServer(vite) {
            vite.middlewares.use('/loras-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/loras-test',
                '<div id="root"></div><script type="module" src="/loras-fixture.jsx"></script>'));
            });
          },
        }],
        server: { host: '127.0.0.1', port: 0 },
      }),
      warmup: async (page, url) => {
        await page.route('**/*', route => (isFixtureRequest(url, route) ? route.continue() : route.abort()));
        await page.goto(`${url}loras-test`);
        await page.getByRole('tab', { name: /Installed/ }).waitFor({ timeout: 10000 });
      },
    });
    ({ browser, origin } = fixture);
  }, BROWSER_FIXTURE_STARTUP_MS);

  afterAll(() => fixture?.close());

  it.each([
    { width: 360, height: 800 }, { width: 768, height: 1024 }, { width: 1440, height: 900 },
  ])('keeps LoRA controls reachable at $width x $height', async viewport => {
    const page = await browser.newPage({ viewport, hasTouch: viewport.width < 640 });
    const errors = [];
    const unexpectedRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (isFixtureRequest(origin, route)) return route.continue();
      unexpectedRequests.push(new URL(route.request().url()).pathname);
      return route.abort();
    });
    try {
      await page.goto(`${origin}loras-test`);
      await page.getByRole('button', { name: 'All', exact: true }).waitFor();
      const measureAndCheck = async (locator, { filter = false } = {}) => {
        await locator.scrollIntoViewIfNeeded();
        const geometry = await locator.evaluate(element => {
          const rect = element.getBoundingClientRect();
          return {
            left: rect.left, right: rect.right, width: rect.width, height: rect.height,
            centerPlus16Hits: element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2 + 16)),
          };
        });
        expect(geometry.height).toBeGreaterThanOrEqual(44);
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(viewport.width);
        if (filter) expect(geometry.centerPlus16Hits).toBe(true);
      };
      const checkToolbar = async () => {
        for (const name of ['All', 'Image', 'Video']) {
          await measureAndCheck(page.getByRole('button', { name, exact: true }), { filter: true });
        }
      };

      await checkToolbar();
      await measureAndCheck(page.getByRole('button', { name: 'Install LoRA', exact: true }));
      const layout = await page.evaluate(() => ({
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
        contentOverflow: document.querySelector('main').scrollWidth - document.querySelector('main').clientWidth,
      }));
      expect(layout.pageOverflow).toBeLessThanOrEqual(0);
      expect(layout.contentOverflow).toBeLessThanOrEqual(0);

      await page.getByRole('tab', { name: /Discover \/ install/ }).click();
      await page.getByLabel('Civitai model URL').waitFor();
      await checkToolbar();
      await measureAndCheck(page.getByLabel('Civitai model URL'));
      await measureAndCheck(page.getByLabel('HuggingFace LoRA URL'));
      await measureAndCheck(page.getByRole('button', { name: 'Install', exact: true }).first());
      await measureAndCheck(page.getByRole('button', { name: 'Install', exact: true }).nth(1));

      const videoSearch = page.getByLabel('Search HuggingFace video LoRAs by name or repository');
      await videoSearch.scrollIntoViewIfNeeded();
      await measureAndCheck(page.getByRole('button', { name: 'All video' } ), { filter: true });
      for (const name of ['LTX-Video', 'MiniMax H3']) {
        await measureAndCheck(page.getByRole('button', { name, exact: true }).last(), { filter: true });
      }
      await measureAndCheck(videoSearch);
      await measureAndCheck(page.getByLabel('Filter HuggingFace video LoRAs by author'));
      const videoForm = videoSearch.locator('xpath=ancestor::form');
      await measureAndCheck(videoForm.getByRole('button', { name: 'Search' }));
      await videoSearch.fill('touch target');
      await videoForm.getByRole('button', { name: 'Search' }).click();
      await measureAndCheck(videoForm.getByRole('button', { name: 'Clear' }));

      const civitaiSearch = page.getByLabel('Search Flux 1 LoRAs on Civitai');
      await civitaiSearch.scrollIntoViewIfNeeded();
      await measureAndCheck(civitaiSearch);
      const civitaiForm = civitaiSearch.locator('xpath=ancestor::form');
      await measureAndCheck(civitaiForm.getByRole('button', { name: 'Search' }));
      await civitaiSearch.fill('touch target');
      await civitaiForm.getByRole('button', { name: 'Search' }).click();
      await measureAndCheck(civitaiForm.getByRole('button', { name: 'Clear' }));

      const finalLayout = await page.evaluate(() => ({
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
        contentOverflow: document.querySelector('main').scrollWidth - document.querySelector('main').clientWidth,
      }));
      expect(finalLayout.pageOverflow).toBeLessThanOrEqual(0);
      expect(finalLayout.contentOverflow).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
      expect(unexpectedRequests).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60000);
});
