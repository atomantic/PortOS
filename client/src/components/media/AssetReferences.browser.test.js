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
const { chromium, webkit } = require('playwright-core');
// A local WebKit executable can exercise the same touch layout on Safari's
// engine; CI normally runs the installed Chrome.
const webkitPath = process.env.ASSET_REFERENCE_TEST_WEBKIT;
const browserType = webkitPath ? { launch: options => webkit.launch(options) } : chromium;
const executablePath = webkitPath || resolveTestChrome();

describe.skipIf(!executablePath)('asset references on touch cards', () => {
  let fixture;
  let browser;
  let origin;

  beforeAll(async () => {
    fixture = await startBrowserFixture({
      name: 'asset-reference-cards', createServer, chromium: browserType, launchOptions: { executablePath },
      viteConfig: temp => ({
        cacheDir: join(temp, 'vite'),
        optimizeDeps: { entries: ['src/components/media/MediaCard.jsx', 'src/components/musicVideo/SceneTakeStrip.jsx'], include: ['react', 'react-dom/client'] },
        configFile: false,
        root: fileURLToPath(new URL('../../..', import.meta.url)),
        plugins: [react(), {
          name: 'asset-reference-fixture',
          resolveId(id) { if (id === '/asset-reference-fixture.jsx') return '\0asset-reference-fixture.jsx'; },
          load(id) {
            if (id.endsWith('/src/services/socket.js')) return 'export default { on() {}, off() {} };';
            if (id !== '\0asset-reference-fixture.jsx') return;
            return [
              "import React from 'react';",
              "import { createRoot } from 'react-dom/client';",
              "import MediaCard from '/src/components/media/MediaCard.jsx';",
              "import SceneTakeStrip from '/src/components/musicVideo/SceneTakeStrip.jsx';",
              "import '/src/index.css';",
              "const image = { kind: 'image', filename: 'frame.png', key: 'image:frame.png', previewUrl: '/data/images/frame.png', downloadUrl: '/data/images/frame.png', prompt: 'Image' };",
              "const video = { kind: 'video', id: 'clip-1', filename: 'real.mp4', key: 'video:clip-1', previewUrl: '/data/video-thumbnails/clip-1.jpg', downloadUrl: '/data/videos/real.mp4', prompt: 'Video' };",
              "const scene = { sceneId: 'scene', order: 0, takes: [{ takeId: 'take', assetId: 'shot-clip', kind: 'video', status: 'candidate' }] };",
              "const note = name => () => { window.actions.push(name); };",
              "createRoot(document.getElementById('root')).render(React.createElement('main', {className:'p-2'},",
              "  React.createElement('div', {id:'cards', className:'grid grid-cols-2 md:grid-cols-4 gap-2'},",
              "    React.createElement(MediaCard, {item:image, onPreview:note('image preview'), showCollectionMenu:false, showMoodBoardMenu:false}),",
              "    React.createElement(MediaCard, {item:video, onPreview:note('video preview'), showCollectionMenu:false, showMoodBoardMenu:false})),",
              "  React.createElement('div', {id:'takes', className:'mt-4'}, React.createElement(SceneTakeStrip, {scene, kind:'video', grid:true, onOpenPreview:note('take preview'), onSelect:note('take select')}))));",
            ].join('\n');
          },
          configureServer(vite) {
            vite.middlewares.use('/asset-reference-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/asset-reference-test',
                '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/asset-reference-fixture.jsx"></script>'));
            });
          },
        }],
        server: { host: '127.0.0.1', port: 0 },
      }),
    });
    ({ browser, origin } = fixture);
  }, BROWSER_FIXTURE_STARTUP_MS);

  afterAll(() => fixture?.close());

  it.each([[320, 800], [390, 844], [1440, 900]])('copies or shows a manual fallback without changing the card at %dx%d', async (width, height) => {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: true, isMobile: width < 500 });
    page.setDefaultTimeout(7000);
    try {
      await page.addInitScript(() => {
        window.actions = [];
        window.copied = [];
        window.denyCopy = false;
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
          writeText: async value => {
            if (window.denyCopy) throw new Error('denied');
            window.copied.push(value);
          },
        } });
      });
      await page.route('**/api/video-gen/history/shot-clip', route => route.fulfill({ json: { id: 'shot-clip', filename: 'shot-original.webm' } }));
      await page.goto(origin + 'asset-reference-test');
      const videoCard = page.locator('#cards > div').nth(1);
      const take = page.locator('#takes li').first();
      // A take card shows the compact chips, which keep a 44px target on a
      // touch phone and stay small on a desktop pointer.
      for (const [card, fullTarget] of [[videoCard, true], [take, width < 500]]) {
        for (const name of ['Copy ID', 'Copy URL']) {
          const button = card.getByRole('button', { name, exact: true });
          await button.scrollIntoViewIfNeeded();
          const rect = await button.boundingBox();
          const parent = await card.boundingBox();
          if (fullTarget) {
            expect(rect.width).toBeGreaterThanOrEqual(44);
            expect(rect.height).toBeGreaterThanOrEqual(44);
          }
          expect(rect.x).toBeGreaterThanOrEqual(parent.x);
          expect(rect.x + rect.width).toBeLessThanOrEqual(parent.x + parent.width);
        }
      }
      const activate = control => width < 500 ? control.tap() : control.click();
      await activate(videoCard.getByRole('button', { name: 'Copy ID' }));
      await videoCard.getByText('ID copied').waitFor();
      expect(await page.evaluate(() => window.copied)).toEqual(['clip-1']);
      await take.getByRole('button', { name: 'View clip take full size' }).focus();
      expect(await take.locator('video').count()).toBe(1);
      await activate(take.getByRole('button', { name: 'Copy URL' }));
      await take.getByText('URL copied').waitFor();
      expect(await take.locator('video').count()).toBe(1);
      expect(await page.evaluate(() => window.copied)).toEqual(['clip-1', origin + 'data/videos/shot-original.webm']);
      await page.evaluate(() => { window.denyCopy = true; });
      await activate(videoCard.getByRole('button', { name: 'Copy URL' }));
      const fallback = videoCard.getByRole('textbox', { name: 'URL to copy' });
      await fallback.waitFor();
      expect(await fallback.inputValue()).toBe(origin + 'data/videos/real.mp4');
      await fallback.tap();
      await page.waitForFunction(el => el.selectionEnd === el.value.length, await fallback.elementHandle());
      expect(await fallback.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([0, (await fallback.inputValue()).length]);
      expect(await page.evaluate(() => window.actions)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await page.close();
    }
  }, 60000);
});
