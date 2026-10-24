// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../test/browserFixture.js';
import { resolveTestChrome } from '../../../scripts/lib/testChrome.js';

vi.setConfig({ testTimeout: 30000 });
const chrome = resolveTestChrome();
const root = fileURLToPath(new URL('../..', import.meta.url));
const image = { name: 'reference.png', mimeType: 'image/png', buffer: Buffer.from('isolated image fixture') };
const video = { name: 'motion.mp4', mimeType: 'video/mp4', buffer: Buffer.from('isolated video fixture') };
const savedImage = { filename: 'upload-image.png', path: '/data/images/upload-image.png', metadata: { prompt: 'Paper boat' } };
const savedVideo = { id: 'upload-video', filename: 'upload-video.mp4', thumbnail: 'upload-video.jpg', prompt: 'Clouds' };
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

// Every request is contained by this fixture; no live API, catalog or provider.
async function openBoard(fixture, viewport, containerWidth) {
  const page = await fixture.browser.newPage({ viewport });
  page.setDefaultTimeout(10000);
  const boards = { a: { id: 'a', name: 'Example A', items: [] }, b: { id: 'b', name: 'Example B', items: [] } };
  const state = { calls: [], failures: 0, hold: null, release: null, errors: [] };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(fixture.origin).origin) return route.abort();
    if (url.pathname.startsWith('/data/')) return route.fulfill({ contentType: 'image/png', body: pixel });
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const path = url.pathname.slice(4);
    state.calls.push(path);
    if (path.endsWith('/upload')) {
      if (state.hold) await state.hold;
      return route.fulfill({ json: path === '/image-gen/upload' ? savedImage : savedVideo });
    }
    if (path === '/mood-boards/a/pinterest/import') {
      const { url } = route.request().postDataJSON();
      const item = { id: 'pinterest-pin', type: 'image', source: url, imageUrl: '/data/images/pinterest-pin.jpg' };
      boards.a.items.push(item);
      return route.fulfill({ json: { board: boards.a, added: 1, found: 1 } });
    }
    const match = path.match(/^\/mood-boards\/([ab])(?:\/(items))?$/);
    if (!match) { state.errors.push(`Unexpected API: ${path}`); return route.abort(); }
    const board = boards[match[1]];
    if (!match[2]) return route.fulfill({ json: board });
    const payload = route.request().postDataJSON();
    let item = board.items.find(row => row.mediaKey === payload.mediaKey);
    if (!item) { item = { ...payload, id: `pin-${board.items.length}` }; board.items.push(item); }
    if (state.failures-- > 0) return route.fulfill({ status: 503, json: { error: 'Synthetic lost pin response' } });
    return route.fulfill({ json: item });
  });
  await page.goto(`${fixture.origin}board-test`);
  if (containerWidth) await page.locator('main').evaluate((main, width) => { main.style.width = `${width}px`; }, containerWidth);
  await page.getByLabel('Name', { exact: true }).waitFor();
  if (viewport.width < 896 || containerWidth < 896) await page.getByRole('navigation', { name: 'Board tools' }).getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('Upload', { exact: true }).waitFor();
  return { page, boards, state };
}

describe.skipIf(!chrome)('direct mood board upload in Chromium', () => {
  let fixture;
  beforeAll(async () => {
    fixture = await startBrowserFixture({
      name: 'mood-board-upload', createServer, chromium,
      launchOptions: { executablePath: chrome, args: ['--mute-audio'] },
      viteConfig: temp => ({
        configFile: false, root, cacheDir: join(temp, 'vite-cache'),
        optimizeDeps: { entries: ['src/pages/MoodBoardDetail.jsx'], include: ['react', 'react-dom/client', 'react-router', 'lucide-react'] },
        plugins: [react(), {
          name: 'mood-board-upload-fixture', enforce: 'pre',
          resolveId(id, importer) {
            if (id === '/board-fixture.jsx') return '\0board-fixture.jsx';
            if (!importer?.endsWith('/MoodBoardDetail.jsx')) return;
            if (id === '../services/api') return join(root, 'src/services/apiMoodBoard.js');
            if (id === '../services/socket') return '\0board-socket';
            if (/MoodBoard(Generate|Style|Collage)Panel|Gallery(Image|Video)Picker|VideoFramePicker|MediaLightbox/.test(id)) return '\0board-empty';
            if (id.endsWith('/PromptFromMedia')) return '\0board-prompt';
          },
          load(id) {
            if (id === '\0board-empty') return 'export default () => null;';
            if (id === '\0board-prompt') return 'export const PromptFromMediaModal = () => null;';
            if (id === '\0board-socket') return 'export default { on() {}, off() {} };';
            if (id !== '\0board-fixture.jsx') return;
            return `
              import React from 'react';
              import { createRoot } from 'react-dom/client';
              import { MemoryRouter, Routes, Route, Link } from 'react-router';
              import MoodBoardDetail from '/src/pages/MoodBoardDetail.jsx';
              import { THEMES } from '/src/themes/portosThemes.js';
              import '/src/index.css';
              document.documentElement.dataset.portTheme = 'lumen-glass-day';
              document.documentElement.dataset.portThemeFamily = 'glass';
              for (const [name, value] of Object.entries({ ...THEMES['lumen-glass-day'].colors, ...THEMES['lumen-glass-day'].tokens })) {
                document.documentElement.style.setProperty(name, value);
              }
              const h = React.createElement;
              createRoot(document.getElementById('root')).render(
                h(MemoryRouter, { initialEntries: ['/mood-boards/a'] },
                  h('nav', null, h(Link, { to: '/mood-boards/a' }, 'Example A'), ' ', h(Link, { to: '/mood-boards/b' }, 'Example B')),
                  h('main', { className: 'p-4' }, h(Routes, null,
                    h(Route, { path: '/mood-boards/:id', element: h(MoodBoardDetail) }))))
              );`;
          },
          configureServer(vite) {
            vite.middlewares.use('/board-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/board-test', '<div id="root"></div><script type="module" src="/board-fixture.jsx"></script>'));
            });
          },
        }],
        server: { host: '127.0.0.1', port: 0 },
      }),
    });
  }, BROWSER_FIXTURE_STARTUP_MS);
  afterAll(() => fixture?.close());

  it.each([
    { width: 320, height: 740 },
    { width: 390, height: 844 },
    { width: 1440, height: 900, containerWidth: 640 },
    { width: 1440, height: 900 },
  ])('keeps import controls and evenly centered tool tabs usable at $width px', async ({ containerWidth, ...viewport }) => {
    const { page, boards, state } = await openBoard(fixture, viewport, containerWidth);
    try {
      await page.getByRole('tab', { name: 'Import', exact: true }).click();
      await page.getByLabel('Pin or board URL', { exact: true }).waitFor();
      const tabs = page.getByRole('tablist', { name: 'Board tool' });
      const geometry = await tabs.evaluate(strip => {
        const rect = strip.getBoundingClientRect();
        return {
          left: rect.left, right: rect.right, width: strip.clientWidth, scrollWidth: strip.scrollWidth,
          tabs: [...strip.querySelectorAll('[role="tab"]')].map(tab => {
            const box = tab.getBoundingClientRect();
            const icon = tab.querySelector('svg').getBoundingClientRect();
            return { left: box.left, right: box.right, width: box.width, height: box.height,
              iconOffset: Math.abs((box.left + box.right) / 2 - (icon.left + icon.right) / 2) };
          }),
        };
      });
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
      expect(Math.max(...geometry.tabs.map(tab => tab.width)) - Math.min(...geometry.tabs.map(tab => tab.width))).toBeLessThan(1);
      for (const tab of geometry.tabs) {
        expect(tab.left).toBeGreaterThanOrEqual(geometry.left);
        expect(tab.right).toBeLessThanOrEqual(geometry.right);
        if (viewport.width < 640) {
          expect(tab.height).toBeGreaterThanOrEqual(44);
          expect(tab.width).toBeGreaterThanOrEqual(44);
          expect(tab.iconOffset).toBeLessThan(1);
        }
      }
      for (const label of ['Pin or board URL', 'Post URL']) {
        const field = page.getByLabel(label, { exact: true });
        const bounds = await field.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      }
      const pinUrl = 'https://www.pinterest.com/pin/9999999999999999999/';
      await page.getByLabel('Pin or board URL', { exact: true }).fill(pinUrl);
      await page.getByRole('button', { name: 'Import pins', exact: true }).click();
      await vi.waitFor(() => expect(boards.a.items).toHaveLength(1));
      expect(boards.a.items[0].source).toBe(pinUrl);
      expect(state.errors).toEqual([]);
    } finally { await page.close(); }
  });

  it.each([{ width: 390, height: 844 }, { width: 1440, height: 900 }])('imports a mixed batch, rejects repeated actions and retries assignment at $width px', async viewport => {
    const { page, boards, state } = await openBoard(fixture, viewport);
    try {
      state.failures = 1;
      state.hold = new Promise(resolve => { state.release = resolve; });
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.locator('label').filter({ hasText: /^\s*Upload\s*$/ }).click(),
      ]);
      await chooser.setFiles([image, video]);
      await page.getByRole('list', { name: 'Import queue' }).waitFor();
      await page.getByLabel('Upload', { exact: true }).dispatchEvent('change');
      expect(await page.getByLabel('Upload', { exact: true }).isDisabled()).toBe(true);
      expect(state.calls.filter(path => path.endsWith('/upload'))).toHaveLength(1);
      state.release();
      await page.getByRole('button', { name: 'Retry failed / cancelled' }).waitFor();
      await page.getByText('1 of 2 imported', { exact: true }).waitFor();
      expect(await page.getByRole('list', { name: 'Import queue' }).count()).toBe(0);
      await page.getByRole('tab', { name: 'Import', exact: true }).click();
      await page.getByRole('tab', { name: 'Add', exact: true }).click();
      await page.getByRole('button', { name: 'Retry failed / cancelled' }).evaluate(button => { button.click(); button.click(); });
      await page.getByText('2 of 2 imported', { exact: true }).waitFor();
      expect(state.calls.filter(path => path.endsWith('/upload'))).toHaveLength(2);
      expect(boards.a.items.map(item => item.mediaKey)).toEqual(['image:upload-image.png', 'video:upload-video.mp4']);
      expect(await page.getByLabel('Item prompt').evaluateAll(inputs => inputs.map(input => input.value))).toEqual(['Clouds', 'Paper boat']);
      expect(await page.getByRole('region', { name: 'Imports needing attention' }).count()).toBe(0);
      expect(await page.getByRole('button', { name: 'Pick from gallery' }).isVisible()).toBe(true);
      const labelBox = await page.locator('label').filter({ hasText: /^\s*Upload\s*$/ }).boundingBox();
      expect(labelBox.x).toBeGreaterThanOrEqual(0);
      expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(viewport.width);
      expect(state.errors).toEqual([]);
    } finally { state.release?.(); await page.close(); }
  });

  it('cancels remaining files and finishes an active upload on the original board after navigation', async () => {
    const { page, boards, state } = await openBoard(fixture, { width: 1100, height: 800 });
    try {
      state.hold = new Promise(resolve => { state.release = resolve; });
      await page.getByLabel('Upload', { exact: true }).setInputFiles([image, video]);
      await page.getByRole('button', { name: 'Cancel remaining' }).click();
      await page.getByRole('link', { name: 'Example B' }).click();
      await page.getByLabel('Name', { exact: true }).waitFor();
      state.release();
      await vi.waitFor(() => expect(boards.a.items).toHaveLength(1));
      expect(state.calls.filter(path => path.endsWith('/upload'))).toEqual(['/image-gen/upload']);
      expect(boards.b.items).toEqual([]);
      expect(await page.getByLabel('Name', { exact: true }).inputValue()).toBe('Example B');
      expect(await page.getByLabel('Item prompt').count()).toBe(0);
      expect(await page.getByRole('list', { name: 'Import queue' }).count()).toBe(0);
      expect(state.errors).toEqual([]);
    } finally { state.release?.(); await page.close(); }
  });
});
