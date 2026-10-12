import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { browserSuiteCanRun } from './browserSuiteGate.js';
import { filmLookFilterMarkup, filmLookPreset, filmLookRuntimeSource } from './filmLook.js';

const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((path) => path && existsSync(path));
const canRun = browserSuiteCanRun('film look runtime browser', { Chrome: chrome });
const width = 390;
const height = 219;
const picture = '<button id="picture" style="position:fixed;inset:0;width:100%;height:100%;border:0;background:linear-gradient(35deg,#261349,#e8bf43)">Example picture</button><div id="lyric" style="position:fixed;inset:0;z-index:2147483647;pointer-events:none;color:white">Example lyric</div>';
const composition = '<script>portosComposition = { fps: 30, seek() {} };</script>';
const html = (head, body) => `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%}</style>${head}</head><body>${body}</body></html>`;

describe.skipIf(!canRun)('film look runtime in Chrome', () => {
  let browser;
  beforeAll(async () => { browser = await chromium.launch({ executablePath: chrome, headless: true }); });
  afterAll(async () => { await browser?.close(); });

  // Uniquely pins the rendered pixels, rather than just checking unchanged SVG source.
  it('keeps exact render captures byte-identical to the standalone filter across frames and restores them after playing', async () => {
    const page = await browser.newPage({ viewport: { width, height } });
    const reference = await browser.newPage({ viewport: { width, height } });
    try {
      const look = filmLookPreset('neon-rain');
      await page.setContent(html(`<script>${filmLookRuntimeSource(look)}</script>`, picture + composition));
      for (const frame of [12, 47]) {
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
      }
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
        const image = grain.style.backgroundImage;
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
          reused: grain === overlay.querySelector('[data-film-look-layer="grain"]') && grain.style.backgroundImage === image,
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
