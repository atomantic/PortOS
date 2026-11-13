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
              import Drawer from '/src/components/Drawer.jsx';
              import '/src/index.css';
              const h = React.createElement;
              const params = new URLSearchParams(location.search);
              const width = Number(params.get('width'));
              const longPrompt = Array.from({ length: 26 }, (_, i) => 'Frame direction line ' + (i + 1)).join('\\n');
              const models = [{ id: 'synthetic-long-model', name: 'An exceptionally long local video rendering model name for layout validation',
                runtime: 'ltx25', supportedModes: ['image'] }];
              function Fixture() {
                const [scene, setScene] = React.useState({ sceneId: 'layout', order: 0, startSec: 0, endSec: 4, referenceImageId: 'synthetic.png',
                  visualIntent: 'Synthetic direction', framePrompt: longPrompt, endFramePrompt: longPrompt, takes: [] });
                const card = h('main', { style: { width: width + 'px', maxWidth: '100%', padding: params.has('drawer') ? '0' : '8px', boxSizing: 'border-box' } },
                  h(SceneCard, { scene, index: 0, expanded: true, videoModels: models,
                    onGenerateEndFrame: params.has('frames') ? () => {} : undefined,
                    onSetDone: (_id, checked) => setScene(current => ({ ...current, shotSheet: { ...current.shotSheet, checked } })),
                    onEditLocal: (_id, patch) => setScene(current => ({ ...current, ...patch })), onSave: () => {} }));
                return params.has('drawer') ? h(Drawer, { open: true, showHeader: false, title: 'Shot editor', onClose: () => {} }, card) : card;
              }
              createRoot(document.getElementById('root')).render(
                h(Fixture));
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

  it('keeps Done reachable and keyboard-operable on narrow and wide editors', async () => {
    const page = await fixture.browser.newPage();
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === new URL(fixture.origin).origin && !/^\/(api|data|socket\.io)(\/|$)/.test(url.pathname)
        ? route.continue() : route.abort();
    });
    try {
      for (const width of [360, 1100]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${fixture.origin}shot-editor-test?width=${width}`);
        const done = page.getByRole('checkbox', { name: 'Done', exact: true });
        await done.waitFor({ state: 'visible' });
        await done.focus();
        await page.keyboard.press('Space');
        await page.waitForFunction(() => document.querySelector('input[id$="-done"]')?.checked);
        expect(await done.isChecked()).toBe(true);
        const bounds = await done.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        await done.uncheck();
        expect(await done.isChecked()).toBe(false);
      }
    } finally { await page.close(); }
  });

  it('pins the shot header to the drawer top while scrolling', async () => {
    const page = await fixture.browser.newPage({ viewport: { width: 1100, height: 700 } });
    try {
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        return url.origin === new URL(fixture.origin).origin && !/^\/(api|data|socket\.io)(\/|$)/.test(url.pathname)
          ? route.continue() : route.abort();
      });
      for (const width of [360, 1100]) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto(`${fixture.origin}shot-editor-test?width=${width}&drawer=1`);
      const header = page.getByRole('dialog').locator('header');
      await header.waitFor();
      expect((await header.boundingBox()).y).toBeCloseTo(0, 0);
      const top = await header.evaluate(el => {
        const scroller = el.closest('[role="dialog"]').lastElementChild;
        scroller.scrollTop = 200;
        return scroller.getBoundingClientRect().top;
      });
      await page.waitForTimeout(100);
      expect((await header.boundingBox()).y).toBeCloseTo(top, 0);
      }
    } finally { await page.close(); }
  });

  // Catches measuring a hidden frame as zero, clipping long prompts, and stale heights after edits or wrapping changes.
  it('fits both frame prompts when opened, edited, and rewrapped', async () => {
    const page = await fixture.browser.newPage({ viewport: { width: 1000, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript(() => {
      window.frameLayoutErrors = [];
      window.addEventListener('error', event => window.frameLayoutErrors.push(event.message));
    });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === new URL(fixture.origin).origin && !/^\/(api|data|socket\.io)(\/|$)/.test(url.pathname)
        ? route.continue() : route.abort();
    });
    try {
      await page.goto(`${fixture.origin}shot-editor-test?width=1000&frames=1`);
      await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Frames' }).click();
      const start = page.getByRole('textbox', { name: 'Start frame prompt' });
      const end = page.getByRole('textbox', { name: 'End frame prompt' });
      const fit = async (locator) => {
        await locator.waitFor({ state: 'visible' });
        await page.waitForFunction(el => el.clientHeight > 0 && el.scrollHeight <= el.clientHeight + 1, await locator.elementHandle(), { timeout: 5000 });
        return locator.evaluate(el => el.clientHeight);
      };
      const initialHeight = await fit(start);
      expect(initialHeight).toBeGreaterThan(320);
      const initialEndHeight = await fit(end);
      expect(initialEndHeight).toBeGreaterThan(320);
      await end.fill('Short end prompt');
      expect(await fit(end)).toBeLessThan(initialEndHeight);

      await start.fill('Short prompt');
      expect(await fit(start)).toBeLessThan(initialHeight);
      await start.fill(Array(35).fill('A longer frame direction').join('\n'));
      expect(await fit(start)).toBeGreaterThan(initialHeight);

      await start.fill('A wrapping frame direction '.repeat(100));
      await fit(start);
      const wideWidth = await start.evaluate(el => el.clientWidth);
      await page.setViewportSize({ width: 420, height: 900 });
      await page.waitForFunction(([el, oldWidth]) => el.clientWidth !== oldWidth,
        [await start.elementHandle(), wideWidth], { timeout: 5000 });
      const middleHeight = await fit(start);
      const middleWidth = await start.evaluate(el => el.clientWidth);
      await page.locator('main').evaluate(el => { el.style.width = '120px'; });
      await page.waitForFunction(([el, oldHeight]) => el.clientHeight > oldHeight && el.scrollHeight <= el.clientHeight + 1,
        [await start.elementHandle(), middleHeight], { timeout: 5000 });
      expect(await start.evaluate(el => el.clientWidth)).toBeLessThan(middleWidth);
      await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Clip' }).click();
      await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Frames' }).click();
      await fit(start);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await page.evaluate(() => window.frameLayoutErrors)).toEqual([]);

      await page.goto(`${fixture.origin}shot-editor-test?width=1000`);
      await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Still' }).click();
      expect(await fit(page.getByRole('textbox', { name: 'Frame prompt' }))).toBeGreaterThan(320);
      const still = page.getByRole('region', { name: 'Still' });
      const frameService = still.getByLabel('Render on');
      await frameService.selectOption('codex');
      const frameModel = still.getByLabel('Model');
      await frameModel.fill('example-model');
      expect(await frameModel.inputValue()).toBe('example-model');
      await frameService.selectOption('grok');
      await still.getByLabel('Model').waitFor({ state: 'hidden' });
      await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Clip' }).click();
      expect(await page.getByRole('region', { name: 'Render' }).getByLabel('Render on').inputValue()).toBe('');
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30000);

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
      const renderer = page.getByRole('region', { name: 'Render' }).getByLabel('Render on');
      await page.locator('#mv-scene-layout-frame-render').waitFor({ state: 'hidden' });
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
