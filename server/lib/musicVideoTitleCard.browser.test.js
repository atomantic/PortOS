import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { browserSuiteCanRun } from './browserSuiteGate.js';
import { filmLookRuntimeSource } from './filmLook.js';
import { titleCardRuntimeSource } from './musicVideoTitleCard.js';

/**
 * The title card runtime in real Chrome, installed the way the preview and the
 * render install it (after the film look, before the document): a seek draws
 * the card over the document's own frame inside its window and nothing outside
 * it, chaining the film look's seek wrapper rather than replacing it.
 */
const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((p) => p && existsSync(p));
const canRun = browserSuiteCanRun('title card browser', { Chrome: chrome });

const W = 640;
const H = 360;
// A stand-in composition document: a full-frame canvas painted flat grey on every seek.
const DOCUMENT = `<canvas id="doc" width="${W}" height="${H}" style="position:fixed;inset:0;width:100vw;height:100vh"></canvas>
<script>
  window.PORTOS_MV = { render: { width: ${W}, height: ${H}, fps: 24 } };
  window.seeks = [];
  window.portosComposition = { durationSec: 20, fps: 24, width: ${W}, height: ${H},
    seek(t) { window.seeks.push(t); const ctx = document.getElementById('doc').getContext('2d'); ctx.fillStyle = '#404040'; ctx.fillRect(0, 0, ${W}, ${H}); } };
</script>`;

// Count bright (cream) pixels in a region of a PNG screenshot.
async function brightIn(png, { left, top, width, height }) {
  const { data, info } = await sharp(png).extract({ left, top, width, height }).raw().toBuffer({ resolveWithObject: true });
  let bright = 0;
  for (let i = 0; i < data.length; i += info.channels) if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 180) bright += 1;
  return bright;
}

describe.skipIf(!canRun)('title card runtime in Chrome', () => {
  let browser;
  let page;
  const errors = [];
  const lowerLeft = { left: 0, top: H / 2, width: W / 2, height: H / 2 };
  const upperRight = { left: W / 2, top: 0, width: W / 2, height: H / 2 };
  const shotAt = async (t) => { await page.evaluate((at) => globalThis.portosComposition.seek(at), t); return page.screenshot(); };

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    page = await browser.newPage({ viewport: { width: W, height: H } });
    page.on('pageerror', (error) => errors.push(error.message));
    const card = { title: 'Example Song', artist: 'Example Artist', year: '2026', startSec: 2, endSec: 8, fadeSec: 0.5 };
    await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:#000}</style>
<script>${filmLookRuntimeSource({ preset: 'none' })}</script><script>${titleCardRuntimeSource(card)}</script></head><body>${DOCUMENT}</body></html>`);
  }, 30000);
  afterAll(async () => { await browser?.close(); });

  it('draws the card in the lower-left inside its window, nothing outside it, and the same pixels on a repeat seek', async () => {
    const before = await shotAt(1);
    const during = await shotAt(5);
    await shotAt(12);
    const again = await shotAt(5);
    const after = await shotAt(12);
    expect(await brightIn(before, lowerLeft)).toBe(0);
    expect(await brightIn(during, lowerLeft)).toBeGreaterThan(200);
    expect(await brightIn(during, upperRight)).toBe(0);
    expect(await brightIn(after, lowerLeft)).toBe(0);
    expect(Buffer.compare(during, again)).toBe(0);
    // The document still ran every seek, through both wrappers.
    expect(await page.evaluate(() => window.seeks)).toEqual([1, 5, 12, 5, 12]);
    expect(await page.evaluate(() => [globalThis.portosComposition.__portosFilmLookWrapped, globalThis.portosComposition.__portosTitleCardWrapped])).toEqual([true, true]);
    expect(errors).toEqual([]);
  }, 30000);

  it('lays the block out inside the title-safe corner and shrinks a long one to fit, with the real faces', async () => {
    const lines = await page.evaluate(() => globalThis.__portosTitleCard.layout());
    expect(lines.map((l) => l.text)).toEqual(['“Example Song”', 'Example Artist', '2026']);
    expect(lines.every((l) => l.align === 'left' && Math.abs(l.x - W * 0.06) < 1e-6)).toBe(true);
    expect(lines[0].px).toBeGreaterThan(lines[1].px);
    expect(lines.at(-1).y).toBeLessThan(H - H * 0.07);
    const long = await page.evaluate(() => {
      const card = globalThis.__portosTitleCard.card;
      globalThis.__portosTitleCard.apply({ ...card, title: 'An Extremely Long Song Title That Would Run Straight Off The Frame', size: 200 });
      const ctx = document.createElement('canvas').getContext('2d');
      const widths = globalThis.__portosTitleCard.layout().map((l) => { ctx.font = l.font; return ctx.measureText(l.text).width; });
      globalThis.__portosTitleCard.apply(card);
      return Math.max(...widths);
    });
    expect(long).toBeLessThanOrEqual(W * 0.62 + 0.5);
  }, 30000);

  it('draws the classic MTV lower third: artist in caps over a yellow title, on a dark plate with a coloured bar', async () => {
    await page.evaluate(() => globalThis.__portosTitleCard.apply({ ...globalThis.__portosTitleCard.card, style: 'mtv', position: 'lower-left', titleColor: '', accentColor: '#00ff00' }));
    const lines = await page.evaluate(() => globalThis.__portosTitleCard.layout());
    expect(lines.map((l) => l.text)).toEqual(['EXAMPLE ARTIST', '“Example Song”', '2026']);
    expect(lines[1].fill).toBe('#f5d33a');
    expect(lines.every((l) => l.outline === 0)).toBe(true);
    const shot = await shotAt(5);
    const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
    let bar = 0;
    let yellow = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (g > 200 && r < 60 && b < 60) bar += 1;
      if (r > 200 && g > 170 && b < 110) yellow += 1;
    }
    expect(bar).toBeGreaterThan(100);
    expect(yellow).toBeGreaterThan(50);
    // The plate stays inside the frame and in the lower-left quarter.
    expect(await brightIn(shot, upperRight)).toBe(0);
    await page.evaluate(() => globalThis.__portosTitleCard.apply({ ...globalThis.__portosTitleCard.card, style: 'outline' }));
    expect(errors).toEqual([]);
  }, 30000);

  it('takes a live change from the panel and redraws the paused frame, and clears on null', async () => {
    await shotAt(5);
    await page.evaluate(() => globalThis.__portosTitleCard.apply({ ...globalThis.__portosTitleCard.card, position: 'upper-right' }));
    const moved = await page.screenshot();
    expect(await brightIn(moved, upperRight)).toBeGreaterThan(200);
    expect(await brightIn(moved, lowerLeft)).toBe(0);
    await page.evaluate(() => globalThis.__portosTitleCard.apply(null));
    expect(await brightIn(await page.screenshot(), upperRight)).toBe(0);
    expect(errors).toEqual([]);
  }, 30000);
});
