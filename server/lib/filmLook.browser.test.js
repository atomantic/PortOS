import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startOwnedBrowserFixture } from '../test/browserFixture.js';
import sharp from 'sharp';
import { browserSuiteCanRun, resolveTestChrome } from './browserSuiteGate.js';
import { filmLookFilterMarkup, filmLookPreset, filmLookRuntimeSource } from './filmLook.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from './mockPathsDataRoot.js';

vi.mock('./paths.js', async (original) => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('portos-film-look-browser-'),
}));
vi.mock('../services/browserService.js', () => ({ loadConfig: async () => ({ chromePath: chrome }), cdpRequest: vi.fn() }));
afterAll(() => cleanupTempDataRoots());

const chrome = resolveTestChrome();
const canRun = browserSuiteCanRun('film look runtime browser', { Chrome: chrome });
const width = 390;
const height = 219;
const picture = '<button id="picture" style="position:fixed;inset:0;width:100%;height:100%;border:0;background:linear-gradient(35deg,#261349,#e8bf43)">Example picture</button><div id="lyric" style="position:fixed;inset:0;z-index:2147483647;pointer-events:none;color:white">Example lyric</div>';
const composition = '<script>portosComposition = { fps: 30, seek() {} };</script>';
const html = (head, body) => `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%}</style>${head}</head><body>${body}</body></html>`;

describe.skipIf(!canRun)('film look runtime in Chrome', () => {
  let browser, browserFixture;
  beforeAll(async () => {
    browserFixture = await startOwnedBrowserFixture({ chromium, launchOptions: { executablePath: chrome, headless: true } });
    browser = browserFixture.browser;
  });
  afterAll(async () => { await browserFixture?.close(); });

  it('paints cached grain and tape under the worker media CSP and blends the cast with the document pixels', async ({ signal }) => {
    const { PATHS } = await import('./paths.js');
    const { openComposition } = await import('../services/htmlComposition/browser.js');
    const directory = 'composition';
    await mkdir(join(PATHS.data, directory), { recursive: true });
    const base = '<div style="position:fixed;inset:0;background:#406080"></div>';
    await writeFile(join(PATHS.data, directory, 'index.html'), html('', base));
    // The same browser entry point and default CSP used by the preview worker;
    // this trusted fixture needs no OS jail (egress has its own contract suite).
    const page = await openComposition(directory, { ownedBrowser: true, mediaMode: 'code-only',
      signal, initScripts: [filmLookRuntimeSource()],
    });
    const reference = await browser.newPage({ viewport: { width, height } });
    const shot = async () => Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
    try {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      const textures = await page.evaluate(`(() => {
        window.__portosFilmLook.apply({ grain: 1, tapeNoise: 1 });
        window.__portosFilmLook.playback(true);
        const canvases = [...document.querySelectorAll('[data-portos-film-look-motion] canvas')];
        const pixels = canvases.map((canvas) => new Set(canvas.getContext('2d').getImageData(0, 0, 100, 100).data).size);
        window.portosComposition = { fps: 30, seek() {} }; window.portosComposition.seek(1);
        return { pixels, reused: canvases.every((canvas, i) => canvas === document.querySelectorAll('[data-portos-film-look-motion] canvas')[i]) };
      })()`);
      expect(textures.reused).toBe(true);
      expect(textures.pixels).toHaveLength(2);
      expect(textures.pixels.every((colors) => colors > 20)).toBe(true);
      const noise = await sharp(await shot()).raw().toBuffer();
      await page.evaluate("window.__portosFilmLook.apply(null)");
      expect(Buffer.compare(noise, await sharp(await shot()).raw().toBuffer())).not.toBe(0);
      await page.evaluate("window.__portosFilmLook.apply({ cast: 1, castColor: '#ff9a3c' })");
      await reference.setContent(html('', base + '<div style="position:fixed;inset:0;background:#ff9a3c;mix-blend-mode:soft-light"></div>'));
      expect(Buffer.compare(await sharp(await shot()).raw().toBuffer(), await sharp(await reference.screenshot()).raw().toBuffer())).toBe(0);
      // Image restrictions remain enforced even after trusted textures paint.
      await page.evaluate("const image = document.createElement('img'); image.src = 'data:image/svg+xml,%3Csvg/%3E'; document.body.appendChild(image)")
        .catch((error) => expect(error.message).toMatch(/Refused composition request: data/));
      await vi.waitFor(() => expect(() => page.check()).toThrow(/Refused composition request: data/));
    } finally { await page.close(); await reference.close(); }
  }, 30000);

  // Uniquely pins the rendered pixels, rather than just checking unchanged SVG source.
  it.each([12, 47])('keeps exact render capture at frame %i byte-identical and restores it after playing', async (frame) => {
    const page = await browser.newPage({ viewport: { width, height } });
    const reference = await browser.newPage({ viewport: { width, height } });
    try {
      const look = filmLookPreset('neon-rain');
      await page.setContent(html(`<script>${filmLookRuntimeSource(look)}</script>`, picture + composition));
      const exact = filmLookFilterMarkup(look, { frame, width, height });
      await reference.setContent(html('', picture + exact.svg));
      await reference.evaluate((filter) => { document.documentElement.style.filter = filter; }, exact.css);
      await page.evaluate((n) => globalThis.portosComposition.seek(n / 30), frame);
      const expected = await reference.screenshot();
      expect(Buffer.compare(await page.screenshot(), expected)).toBe(0);
      await page.evaluate(() => globalThis.__portosFilmLook.playback(true));
      expect(await page.evaluate(() => document.documentElement.style.filter)).not.toContain('url(');
      await page.evaluate(() => globalThis.__portosFilmLook.playback(false));
      expect(Buffer.compare(await page.screenshot(), expected)).toBe(0);
    } finally { await page.close(); await reference.close(); }
  }, 30000);

  it('keeps motion overlays above max-z-index lyrics and out of hit testing while reusing their tiles', async () => {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      const look = { ...filmLookPreset('vhs'), vignette: 1, weave: 0 };
      await page.setContent(html(`<script>${filmLookRuntimeSource(look)}</script>`, picture + composition));
      const result = await page.evaluate(() => {
        globalThis.__portosFilmLook.playback(true);
        const overlay = document.querySelector('[data-portos-film-look-motion]');
        const grain = overlay.querySelector('[data-film-look-layer="grain"]');
        const canvas = grain.firstElementChild;
        globalThis.portosComposition.seek(1);
        const hit = document.elementFromPoint(195, 100);
        // Temporarily make only the vignette interactive to ask Chrome which layer paints on top.
        const vignette = overlay.querySelector('[data-film-look-layer="vignette"]');
        vignette.style.pointerEvents = 'auto';
        const top = document.elementFromPoint(195, 100);
        vignette.style.pointerEvents = 'none';
        return {
          last: document.documentElement.lastElementChild === overlay,
          hit: hit.id, top: top.dataset.filmLookLayer,
          reused: grain === overlay.querySelector('[data-film-look-layer="grain"]') && grain.firstElementChild === canvas,
          filter: document.documentElement.style.filter,
          pointers: [...overlay.children].map((child) => getComputedStyle(child).pointerEvents),
        };
      });
      expect(result).toMatchObject({ last: true, hit: 'picture', top: 'vignette', reused: true });
      expect(result.filter).not.toContain('url(');
      expect(result.pointers.every((value) => value === 'none')).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });
});
