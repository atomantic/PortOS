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

describe.skipIf(!chrome)('Catalog gallery picker touch targets in Chromium', () => {
  let fixture;
  beforeAll(async () => {
    fixture = await startBrowserFixture({
      name: 'catalog-gallery-picker', createServer, chromium,
      launchOptions: { executablePath: chrome, args: ['--mute-audio'] },
      viteConfig: temp => ({
        configFile: false, root, cacheDir: join(temp, 'vite-cache'),
        optimizeDeps: { entries: ['src/pages/CatalogIngredient.jsx'], include: ['react', 'react-dom/client', 'lucide-react'] },
        plugins: [react(), {
          name: 'catalog-gallery-picker-fixture', enforce: 'pre',
          resolveId(id) {
            if (id === '/gallery-picker-fixture.jsx') return '\0gallery-picker-fixture.jsx';
            if (id === '../hooks/useGalleryPage') return '\0gallery-fixture-hook';
          },
          load(id) {
            if (id === '\0gallery-fixture-hook') return `export function useGalleryPage(){return {items:[{filename:'synthetic-one.png',path:'/data/images/synthetic-one.png'},{filename:'synthetic-two.png',path:'/data/images/synthetic-two.png'}],loading:false,error:null,hasMore:false}}`;
            if (id !== '\0gallery-picker-fixture.jsx') return;
            return `
              import React from 'react';
              import { createRoot } from 'react-dom/client';
              import { GalleryPickerModal } from '/src/pages/CatalogIngredient.jsx';
              import '/src/index.css';
              window.picks = [];
              createRoot(document.getElementById('root')).render(
                React.createElement(GalleryPickerModal, { onClose(){}, onPick(filename, portrait){window.picks.push({filename,portrait})} })
              );`;
          },
          configureServer(vite) {
            vite.middlewares.use('/gallery-picker-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/gallery-picker-test', '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/gallery-picker-fixture.jsx"></script></body></html>'));
            });
          },
        }],
        server: { host: '127.0.0.1', port: 0 },
      }),
    });
  }, BROWSER_FIXTURE_STARTUP_MS);
  afterAll(() => fixture?.close());

  it.each([360, 768, 1024])('shows separate 44px actions on a no-hover touch display at %i px', async width => {
    const context = await fixture.browser.newContext({ viewport: { width, height: 900 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    try {
      await page.goto(`${fixture.origin}gallery-picker-test`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Attach' }).first().waitFor({ state: 'attached' });
      expect(await page.evaluate(() => window.innerWidth)).toBe(width);
      const session = await context.newCDPSession(page);
      await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }] });
      const attach = page.getByRole('button', { name: 'Attach' }).first();
      const actionBar = attach.locator('xpath=..');
      const tile = actionBar.locator('xpath=..');
      const actions = actionBar.getByRole('button');
      await actions.first().waitFor({ state: 'attached' });
      const geometry = await actions.evaluateAll(buttons => buttons.map(button => {
        const rect = button.getBoundingClientRect();
        return { text: button.textContent.trim(), width: rect.width, height: rect.height, left: rect.left, right: rect.right,
          opacity: getComputedStyle(button.parentElement).opacity };
      }));
      expect(geometry.map(action => action.text)).toEqual(['Attach', 'Portrait']);
      for (const action of geometry) {
        expect(action.opacity).toBe('1');
        expect(action.width).toBeGreaterThanOrEqual(44);
        expect(action.height).toBeGreaterThanOrEqual(44);
      }
      expect(geometry[0].right).toBeLessThanOrEqual(geometry[1].left + 1);
      const tileBounds = await tile.boundingBox();
      expect(geometry[0].left).toBeGreaterThanOrEqual(tileBounds.x);
      expect(geometry[1].right).toBeLessThanOrEqual(tileBounds.x + tileBounds.width);
      await actions.nth(0).click();
      await actions.nth(1).click();
      expect(await page.evaluate(() => window.picks)).toEqual([
        { filename: 'synthetic-one.png', portrait: false },
        { filename: 'synthetic-one.png', portrait: true },
      ]);
    } finally { await context.close(); }
  });

  it('keeps hover and keyboard focus reveal on a hover-capable desktop', async () => {
    const page = await fixture.browser.newPage({ viewport: { width: 1024, height: 900 } });
    page.setDefaultTimeout(5000);
    try {
      await page.goto(`${fixture.origin}gallery-picker-test`, { waitUntil: 'domcontentloaded' });
      const attach = page.getByRole('button', { name: 'Attach' }).first();
      const actionBar = attach.locator('xpath=..');
      const tile = actionBar.locator('xpath=..');
      expect(await actionBar.evaluate(bar => getComputedStyle(bar).opacity)).toBe('0');
      await tile.hover();
      await page.waitForFunction(bar => getComputedStyle(bar).opacity === '1', await actionBar.elementHandle());
      expect(await actionBar.evaluate(bar => getComputedStyle(bar).opacity)).toBe('1');
      await tile.getByRole('button', { name: 'Attach' }).click();
      await page.getByPlaceholder('Search gallery…').focus();
      await page.mouse.move(0, 0);
      await page.waitForFunction(bar => getComputedStyle(bar).opacity === '0', await actionBar.elementHandle());
      expect(await actionBar.evaluate(bar => getComputedStyle(bar).opacity)).toBe('0');
      await tile.getByRole('button', { name: 'Attach' }).focus();
      await page.waitForFunction(bar => getComputedStyle(bar).opacity === '1', await actionBar.elementHandle());
      expect(await actionBar.evaluate(bar => getComputedStyle(bar).opacity)).toBe('1');
      await tile.getByRole('button', { name: 'Portrait' }).click();
      expect(await page.evaluate(() => window.picks)).toEqual([
        { filename: 'synthetic-one.png', portrait: false },
        { filename: 'synthetic-one.png', portrait: true },
      ]);
    } finally { await page.close(); }
  });
});
