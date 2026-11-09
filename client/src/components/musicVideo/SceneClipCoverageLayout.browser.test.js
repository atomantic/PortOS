// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../../test/browserFixture.js';
import { resolveTestChrome } from '../../../../scripts/lib/testChrome.js';

const chrome = resolveTestChrome();
const root = fileURLToPath(new URL('../../..', import.meta.url));
// One second of black H.264. The shot span is 8s with loop off, so the coverage notice appears once metadata loads.
const SHORT_CLIP = readFileSync(fileURLToPath(new URL('./short-clip.fixture.mp4', import.meta.url)));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fulfillClip(route) {
  const header = route.request().headers().range || '';
  const match = /bytes=(\d+)-(\d*)/.exec(header);
  if (!match) {
    return route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(SHORT_CLIP.length),
      },
      body: SHORT_CLIP,
    });
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : SHORT_CLIP.length - 1;
  const slice = SHORT_CLIP.subarray(start, end + 1);
  return route.fulfill({
    status: 206,
    headers: {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${SHORT_CLIP.length}`,
      'Content-Length': String(slice.length),
    },
    body: slice,
  });
}

describe.skipIf(!chrome)('shot card body stays laid out under a short-clip notice', () => {
  let fixture;

  beforeAll(async () => {
    fixture = await startBrowserFixture({
      name: 'shot-clip-coverage-layout', createServer, chromium,
      launchOptions: { executablePath: chrome, args: ['--mute-audio'] },
      viteConfig: temp => ({
        configFile: false, root, cacheDir: join(temp, 'vite-cache'),
        optimizeDeps: { entries: ['src/components/musicVideo/SceneCard.jsx'], include: ['react', 'react-dom/client'] },
        plugins: [react(), {
          name: 'shot-clip-coverage-layout-fixture',
          resolveId(id) { if (id === '/coverage-layout-fixture.jsx') return '\0coverage-layout-fixture.jsx'; },
          load(id) {
            if (id !== '\0coverage-layout-fixture.jsx') return;
            return `
              import React from 'react';
              import { createRoot } from 'react-dom/client';
              import SceneCard from '/src/components/musicVideo/SceneCard.jsx';
              import '/src/index.css';
              const h = React.createElement;
              function Fixture() {
                const [scene, setScene] = React.useState({
                  sceneId: 'coverage-layout', order: 0, beatAligned: true, visualLayer: 'footage',
                  startSec: 0, endSec: 8, loop: false, referenceImageId: 'synthetic.png',
                  videoHistoryId: 'short-clip', takes: [],
                });
                return h('main', { style: { width: '1100px', maxWidth: '100%', padding: '16px', boxSizing: 'border-box' } },
                  h(SceneCard, {
                    scene, index: 0, expanded: true, project: { id: 'mv-example', scenes: [scene] },
                    onGenerateEndFrame: () => {}, onGenerateVideo: () => {},
                    onEditLocal: (_id, patch) => setScene(current => ({ ...current, ...patch })),
                    onSave: () => {},
                  }));
              }
              createRoot(document.getElementById('root')).render(h(Fixture));
            `;
          },
          configureServer(vite) {
            vite.middlewares.use('/coverage-layout-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/coverage-layout-test', '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/coverage-layout-fixture.jsx"></script></body></html>'));
            });
          },
        }],
        server: { host: '127.0.0.1', port: 0 },
      }),
    });
  }, BROWSER_FIXTURE_STARTUP_MS);

  afterAll(() => fixture?.close());

  // Catches the shot-card body collapsing to 0×0 while the short-clip notice is showing.
  it('keeps Frames and Render at full size on every load while the notice is showing', async () => {
    const page = await fixture.browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    // Hold the clip until the body has laid out, then release it. That is the
    // production sequence (the notice appears when metadata arrives) and the
    // one that collapses the body when the notice shares the body's fieldset.
    let gate = deferred();
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/data/videos/short-clip.mp4') {
        return gate.promise.then(() => fulfillClip(route));
      }
      return url.origin === new URL(fixture.origin).origin && !/^\/(api|data|socket\.io)(\/|$)/.test(url.pathname)
        ? route.continue() : route.abort();
    });
    const frames = () => page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Frames' });
    const notice = () => page.getByRole('alert');
    const measure = () => page.evaluate(() => {
      const box = (el) => {
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { w: Math.round(rect.width), h: Math.round(rect.height) };
      };
      const button = (name) => [...document.querySelectorAll('button')].find(el => (el.textContent || '').trim() === name);
      const container = [...document.querySelectorAll('div')].find(el => el.classList.contains('@container'));
      return {
        frames: box(button('Frames')),
        render: box(button('Render again')),
        trim: box(button('Trim to clip')),
        loop: box(button('Loop clip')),
        notice: box(document.querySelector('[role="alert"]')),
        container: box(container),
        grid: box(container?.firstElementChild),
      };
    });
    const expectLaidOut = async (label) => {
      const geometry = await measure();
      expect(geometry.frames?.w, `${label} frames ${JSON.stringify(geometry)}`).toBeGreaterThan(0);
      expect(geometry.frames?.h, `${label} frames height`).toBeGreaterThan(0);
      expect(geometry.render?.w, `${label} render width`).toBeGreaterThan(0);
      expect(geometry.render?.h, `${label} render height`).toBeGreaterThan(0);
      expect(geometry.notice?.w, `${label} notice width`).toBeGreaterThan(0);
      expect(geometry.notice?.h, `${label} notice height`).toBeGreaterThan(0);
      expect(geometry.trim?.w, `${label} trim width`).toBeGreaterThan(0);
      expect(geometry.loop?.h, `${label} loop height`).toBeGreaterThan(0);
    };

    try {
      const runs = 20;
      for (let run = 1; run <= runs; run += 1) {
        gate = deferred();
        await page.goto(`${fixture.origin}coverage-layout-test?run=${run}`);
        await frames().waitFor({ state: 'visible' });
        const before = await measure();
        expect(before.frames?.w, `run ${run} laid out before the notice ${JSON.stringify(before)}`).toBeGreaterThan(0);
        gate.resolve();
        await notice().waitFor({ state: 'visible' });
        expect(await notice().textContent()).toMatch(/Shot runs 8\.0s but its clip is 1\.0s/);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expectLaidOut(`run ${run}`);
        await page.getByRole('button', { name: 'Trim to clip' }).waitFor({ state: 'visible' });
        await page.getByRole('button', { name: 'Loop clip' }).waitFor({ state: 'visible' });
      }
      await page.getByRole('button', { name: 'Trim to clip' }).click();
      await notice().waitFor({ state: 'hidden' });
      const trimmed = await measure();
      expect(trimmed.frames?.h, `after trim ${JSON.stringify(trimmed)}`).toBeGreaterThan(0);
      expect(trimmed.render?.w, 'after trim render').toBeGreaterThan(0);

      gate = deferred();
      await page.goto(`${fixture.origin}coverage-layout-test?run=trim-reset`);
      await frames().waitFor({ state: 'visible' });
      gate.resolve();
      await notice().waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Loop clip' }).click();
      await notice().waitFor({ state: 'hidden' });
      const looped = await measure();
      expect(looped.frames?.h, `after loop ${JSON.stringify(looped)}`).toBeGreaterThan(0);
      expect(looped.render?.w, 'after loop render').toBeGreaterThan(0);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 120000);
});
