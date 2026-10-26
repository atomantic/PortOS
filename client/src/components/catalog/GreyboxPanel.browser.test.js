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
const { chromium } = require('playwright-core');
const chrome = resolveTestChrome();
const isolate = origin => route => {
  const url = new URL(route.request().url());
  return url.origin === new URL(origin).origin && !url.pathname.startsWith('/api/') ? route.continue() : route.abort();
};

describe.skipIf(!chrome)('manual greybox in Chromium', () => {
  let fixture;
  beforeAll(async () => {
    fixture = await startBrowserFixture({ name: 'greybox-edit', createServer, chromium,
      launchOptions: { executablePath: chrome, args: ['--enable-unsafe-swiftshader'] },
      viteConfig: temp => ({
        configFile: false, cacheDir: join(temp, 'vite-cache'),
        root: fileURLToPath(new URL('../../..', import.meta.url)),
        resolve: { dedupe: ['three'] },
        optimizeDeps: { entries: ['src/components/catalog/GreyboxPanel.jsx', 'src/components/catalog/GreyboxViewer.jsx'], include: ['react', 'react-dom/client', 'react-router', 'three', '@react-three/fiber', '@react-three/drei'] },
        plugins: [react(), {
          name: 'greybox-fixture', enforce: 'pre',
          resolveId(id) {
            if (id === '/greybox-fixture.jsx') return '\0greybox-fixture.jsx';
            if (id.endsWith('/apiCatalog')) return '\0api-stub';
            if (id.endsWith('/MusicVideoLlmPicker')) return '\0picker-stub';
          },
          load(id) {
            if (id === '\0picker-stub') return 'export default () => null;';
            if (id === '\0api-stub') return `
              export const saveCatalogGreybox = async (id, greybox) => ({id, payload: {greybox}});
              export const detachCatalogIngredientMedia = async () => ({});
              export const uploadCatalogIngredientMediaFile = async () => ({});
              export const captureCatalogGreyboxShot = async () => ({});
              export const renderCatalogGreyboxShot = async () => { throw Error('Unexpected headless render'); };
              export const draftCatalogGreybox = async () => { throw Error('Unexpected provider call'); };
              export const previewCatalogGreyboxPrompt = async () => ({});
            `;
            if (id !== '\0greybox-fixture.jsx') return;
            return `
              import React, {useState} from 'react';
              import {createRoot} from 'react-dom/client';
              import {MemoryRouter} from 'react-router';
              import {PerspectiveCamera, Vector3} from 'three';
              import GreyboxPanel from '/src/components/catalog/GreyboxPanel.jsx';
              import {blankGreybox, fovFromFocalLength} from '/src/lib/greybox.js';
              import '/src/index.css';
              const scene = blankGreybox();
              scene.anchors = [{id:'figure', label:'Example figure', kind:'figure', position:[0,0,0], facingDegrees:0, heightMeters:1.7}];
              scene.shots[0].figures = [{anchorId:'figure'}];
              function Fixture() {
                const [record, setRecord] = useState({id:'example', payload:{greybox:scene}});
                return React.createElement(MemoryRouter, {initialEntries:['/?shot=wide']}, React.createElement(GreyboxPanel, {record, media:[], onSaved:next => {window.saveCount=(window.saveCount||0)+1;window.savedScene=next.payload.greybox;setRecord(next);}}));
              }
              window.figurePoint = () => {
                const rect = document.querySelector('canvas').getBoundingClientRect();
                const camera = new PerspectiveCamera(fovFromFocalLength(28), rect.width/rect.height, .1, 2000);
                camera.position.set(0,6,16); camera.lookAt(0,1,0); camera.updateMatrixWorld();
                const p = new Vector3(0,.85,0).project(camera);
                return {x:rect.x+(p.x+1)*rect.width/2,y:rect.y+(1-p.y)*rect.height/2};
              };
              createRoot(document.getElementById('root')).render(React.createElement(Fixture));
            `;
          },
          configureServer(vite) {
            vite.middlewares.use('/greybox-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/greybox-test', '<div id="root" style="padding:8px"></div><script type="module" src="/greybox-fixture.jsx"></script>'));
            });
          },
        }], server: { host: '127.0.0.1', port: 0 },
      }),
      warmup: async (page, origin) => {
        await page.route('**/*', isolate(origin));
        const runtimeError = new Promise((_, reject) => page.once('pageerror', reject));
        await Promise.race([runtimeError, (async () => {
          await page.goto(`${origin}greybox-test`);
          await page.getByTestId('greybox-viewer').locator('.port-media-overlay-strong').waitFor();
        })()]);
      },
    });
  }, BROWSER_FIXTURE_STARTUP_MS);
  afterAll(() => fixture?.close());

  it.each([360, 768, 1440])('keeps the editor within %spx and drags the real anchor without orbiting', async width => {
    const page = await fixture.browser.newPage({ viewport: { width, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.route('**/*', isolate(fixture.origin));
      await page.goto(`${fixture.origin}greybox-test`);
      await page.getByTestId('greybox-viewer').locator('.port-media-overlay-strong').waitFor();
      const point = await page.evaluate(() => window.figurePoint());
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.move(point.x + 30, point.y + 10, { steps: 5 });
      await page.mouse.up();
      await page.getByRole('button', { name: 'Save layout edits', exact: true }).waitFor();
      await page.getByText('Anchors (1)', { exact: true }).click();
      const x = page.getByLabel('Position (m) X', { exact: true });
      const z = page.getByLabel('Position (m) Z', { exact: true });
      expect(Math.abs(Number(await x.inputValue()))).toBeGreaterThan(0);
      for (const value of [await x.inputValue(), await z.inputValue()]) expect(Number(value) * 10).toBeCloseTo(Math.round(Number(value) * 10));
      await page.getByRole('button', { name: 'Add anchor', exact: true }).click();
      const newAnchorRow = page.getByRole('button', { name: 'New anchor', exact: true }).locator('../..');
      await newAnchorRow.getByLabel('Label', { exact: true }).fill('New figure');
      const fields = await page.locator('input:visible,select:visible,button:visible').evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width };
      }));
      for (const rect of fields) {
        expect(rect.left).toBeGreaterThanOrEqual(0);
        expect(rect.right).toBeLessThanOrEqual(width);
        expect(rect.width).toBeGreaterThan(0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.getByRole('button', { name: 'Save layout edits', exact: true }).click();
      await page.getByRole('button', { name: 'Capture reference image', exact: true }).waitFor();
      expect(await page.evaluate(() => window.savedScene.anchors.map(anchor => anchor.label))).toEqual(['Example figure', 'New figure']);
      await page.getByRole('button', { name: 'Update “Wide” to this view', exact: true }).click();
      await page.waitForFunction(() => window.saveCount === 2);
      expect(await page.evaluate(() => window.savedScene.shots[0].position)).toEqual([0,6,16]);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
});
