import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startOwnedBrowserFixture } from '../test/browserFixture.js';
import sharp from 'sharp';
import { browserSuiteCanRun, resolveTestChrome } from './browserSuiteGate.js';
import { filmLookRuntimeSource } from './filmLook.js';
import { TITLE_CARD_FONT_FACES, titleCardRuntimeSource } from './musicVideoTitleCard.js';

/**
 * The title card runtime in real Chrome, installed the way the preview and the
 * render install it (after the film look, before the document): a seek draws
 * the card over the document's own frame inside its window and nothing outside
 * it, chaining the film look's seek wrapper rather than replacing it. A steady
 * card is held still and clean over the look; any other card is in the film.
 */
const chrome = resolveTestChrome();
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
  let browser, browserFixture;
  let page;
  const errors = [];
  const lowerLeft = { left: 0, top: H / 2, width: W / 2, height: H / 2 };
  const upperRight = { left: W / 2, top: 0, width: W / 2, height: H / 2 };
  const shotAt = async (t) => { await page.evaluate((at) => globalThis.portosComposition.seek(at), t); return page.screenshot(); };

  beforeAll(async () => {
    browserFixture = await startOwnedBrowserFixture({ chromium, launchOptions: { executablePath: chrome, headless: true } });
    browser = browserFixture.browser;
    page = await browser.newPage({ viewport: { width: W, height: H } });
    page.on('pageerror', (error) => errors.push(error.message));
    const card = { title: 'Example Song', artist: 'Example Artist', year: '2026', startSec: 2, endSec: 8, fadeSec: 0.5 };
    await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:#000}</style>
<script>${filmLookRuntimeSource({ preset: 'none' })}</script><script>${titleCardRuntimeSource(card)}</script></head><body>${DOCUMENT}</body></html>`);
  }, 30000);
  afterAll(async () => { await browserFixture?.close(); });

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

  it('draws the classic MTV lower third: the artist as typed over a yellow title, on a dark plate with a coloured bar', async () => {
    await page.evaluate(() => globalThis.__portosTitleCard.apply({ ...globalThis.__portosTitleCard.card, style: 'mtv', position: 'lower-left', titleColor: '', accentColor: '#00ff00' }));
    const lines = await page.evaluate(() => globalThis.__portosTitleCard.layout());
    expect(lines.map((l) => l.text)).toEqual(['Example Artist', '“Example Song”', '2026']);
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

  it('draws a bundled face it was handed, on a page that declares none', async () => {
    const { family, file } = TITLE_CARD_FONT_FACES.pacifico;
    const src = `data:font/woff2;base64,${readFileSync(new URL(`../services/musicVideo/titleCardFonts/${file}`, import.meta.url)).toString('base64')}`;
    const other = await browser.newPage({ viewport: { width: W, height: H } });
    const card = { title: 'Example Song', artist: 'Example Artist', startSec: 0, endSec: 8, font: 'pacifico' };
    await other.setContent(`<!doctype html><html><head><script>${titleCardRuntimeSource(card, { fonts: { [family]: src } })}</script></head><body></body></html>`);
    await other.evaluate(() => globalThis.__portosTitleCard.apply(globalThis.__portosTitleCard.card));
    const lines = await other.evaluate(() => globalThis.__portosTitleCard.layout());
    expect(lines[0].font).toContain(family);
    expect(await other.evaluate((font) => document.fonts.check(font), lines[0].font)).toBe(true);
    await other.close();
  }, 30000);

  it('shows again in its end window when the end showing is on', async () => {
    const other = await browser.newPage({ viewport: { width: W, height: H } });
    const card = { title: 'Example Song', artist: 'Example Artist', startSec: 2, endSec: 5, fadeSec: 0.5, outro: true, outroStartSec: 14, outroEndSec: 18 };
    await other.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:#000}</style>
<script>${titleCardRuntimeSource(card)}</script></head><body>${DOCUMENT}</body></html>`);
    const at = async (t) => { await other.evaluate((s) => globalThis.portosComposition.seek(s), t); return brightIn(await other.screenshot(), lowerLeft); };
    expect(await at(10)).toBe(0);
    expect(await at(16)).toBeGreaterThan(200);
    expect(await at(19)).toBe(0);
    await other.close();
  }, 30000);

  // Two song frames a second apart: the look's gate weave puts the picture about a pixel and a half apart on them.
  const WEAVE_FRAMES = [3, 4];
  const lookPage = async (look, card) => {
    const other = await browser.newPage({ viewport: { width: W, height: H } });
    other.on('pageerror', (error) => errors.push(error.message));
    await other.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:#000}</style>
<script>${filmLookRuntimeSource(look)}</script><script>${titleCardRuntimeSource(card)}</script></head><body>${DOCUMENT}</body></html>`);
    return other;
  };
  // The card's corner, clear of the frame edges the weave uncovers (the browser's white base shows there).
  const cardCorner = { left: 16, top: H / 2, width: W / 2, height: H / 2 - 16 };
  const corner = async (target, t) => {
    await target.evaluate((at) => globalThis.portosComposition.seek(at), t);
    return sharp(await target.screenshot()).extract(cardCorner).raw().toBuffer();
  };
  const layerState = (target) => target.evaluate(() => {
    const canvas = document.querySelector('canvas[data-portos-title-card]');
    return { popover: canvas.getAttribute('popover'), open: canvas.matches(':popover-open'), shown: getComputedStyle(canvas).display !== 'none', layer: !!globalThis.__portosTitleCard.layer };
  });

  // Uniquely catches a steady card moved by the look's gate weave (drawn under the root filter or
  // transform, exact or playing), a card that is not steady lifted out of the film, a live switch
  // between the two that leaves the canvas where it was, and a hidden card left open in the top layer.
  it('holds a steady card still over a weaving film look, paused and playing, and leaves any other card weaving with the film', async () => {
    const card = { title: 'Example Song', artist: 'Example Artist', year: '2026', startSec: 0, endSec: 20, fadeSec: 0, steady: true };
    const other = await lookPage({ weave: 1 }, card);
    const [first, second] = [await corner(other, WEAVE_FRAMES[0]), await corner(other, WEAVE_FRAMES[1])];
    expect(await brightIn(await other.screenshot(), cardCorner)).toBeGreaterThan(200);
    expect(Buffer.compare(first, second)).toBe(0);
    expect(await layerState(other)).toEqual({ popover: 'manual', open: true, shown: true, layer: true });
    // While a preview plays the look is a transform on the root and overlay layers: still no motion.
    await other.evaluate(() => globalThis.__portosFilmLook.playback(true));
    expect(Buffer.compare(await corner(other, WEAVE_FRAMES[0]), await corner(other, WEAVE_FRAMES[1]))).toBe(0);
    await other.evaluate(() => globalThis.__portosFilmLook.playback(false));

    // The panel's Keep steady, switched off on the live page: the same canvas goes back into the film.
    await other.evaluate(() => globalThis.__portosTitleCard.apply({ ...globalThis.__portosTitleCard.card, steady: false }));
    expect(await layerState(other)).toEqual({ popover: null, open: false, shown: true, layer: true });
    expect(Buffer.compare(await corner(other, WEAVE_FRAMES[0]), await corner(other, WEAVE_FRAMES[1]))).not.toBe(0);
    // And back on: its pixels are the ones it had before.
    await other.evaluate(() => globalThis.__portosTitleCard.apply({ ...globalThis.__portosTitleCard.card, steady: true }));
    expect(Buffer.compare(await corner(other, WEAVE_FRAMES[0]), first)).toBe(0);

    // Outside its window nothing stays open in the top layer.
    await other.evaluate(() => globalThis.portosComposition.seek(25));
    expect(await layerState(other)).toEqual({ popover: null, open: false, shown: false, layer: false });
    expect(await brightIn(await other.screenshot(), cardCorner)).toBe(0);
    await other.close();
    expect(errors).toEqual([]);
  }, 30000);

  // Uniquely catches a steady card dimmed or speckled by the look's flicker and grain: under them
  // not one pixel keeps the card's exact colour from one frame to the next.
  it('keeps a steady card\'s own colour through flicker and grain', async () => {
    const card = { title: 'Example Song', artist: 'Example Artist', startSec: 0, endSec: 20, fadeSec: 0, steady: true, size: 200 };
    const other = await lookPage({ weave: 1, flicker: 1, grain: 1 }, card);
    const cream = async (t) => {
      const raw = await corner(other, t);
      const at = [];
      for (let i = 0; i < raw.length; i += 4) if (raw[i] === 0xf3 && raw[i + 1] === 0xea && raw[i + 2] === 0xd7) at.push(i);
      return at;
    };
    const [first, second] = [await cream(WEAVE_FRAMES[0]), await cream(WEAVE_FRAMES[1])];
    expect(first.length).toBeGreaterThan(200);
    expect(second).toEqual(first);
    await other.evaluate(() => globalThis.__portosTitleCard.apply({ ...globalThis.__portosTitleCard.card, steady: false }));
    expect((await cream(WEAVE_FRAMES[0])).length).toBeLessThan(first.length / 10);
    await other.close();
    expect(errors).toEqual([]);
  }, 30000);

  // Uniquely catches a slide the pages do not draw (the motion lives in the inlined runtime), one
  // from the wrong side or of the wrong length, and a layout that reports the sliding position.
  it('slides the card in from its side and reports its resting layout throughout', async () => {
    const other = await browser.newPage({ viewport: { width: W, height: H } });
    const card = { title: 'Example Song', artist: 'Example Artist', startSec: 2, endSec: 8, fadeSec: 0, slideIn: 'right', slideSec: 1, slidePct: 25 };
    await other.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:#000}</style>
<script>${titleCardRuntimeSource(card)}</script></head><body>${DOCUMENT}</body></html>`);
    // The leftmost bright column of the card.
    const leading = async (t) => {
      await other.evaluate((at) => globalThis.portosComposition.seek(at), t);
      const { data, info } = await sharp(await other.screenshot()).raw().toBuffer({ resolveWithObject: true });
      let left = info.width;
      for (let i = 0; i < data.length; i += info.channels) {
        if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 180) left = Math.min(left, (i / info.channels) % info.width);
      }
      return left;
    };
    const resting = await leading(5);
    const layout = await other.evaluate(() => globalThis.__portosTitleCard.layout());
    // A quarter of the frame to the right at the start, an eighth of that left halfway (ease-out), then still.
    expect(await leading(2) - resting).toBeGreaterThanOrEqual(W * 0.25 - 1);
    expect(await leading(2) - resting).toBeLessThanOrEqual(W * 0.25 + 1);
    expect(await other.evaluate(() => globalThis.__portosTitleCard.layout())).toEqual(layout);
    expect(Math.abs(await leading(2.5) - resting - W * 0.25 / 8)).toBeLessThanOrEqual(1);
    expect(await leading(3)).toBe(resting);
    expect(await leading(7.9)).toBe(resting);
    await other.close();
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
