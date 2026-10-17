import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { startOwnedBrowserFixture } from '../../../../test/browserFixture.js';
import { browserSuiteCanRun } from '../../../../lib/browserSuiteGate.js';

// A synthetic song: a verse line, a chorus line, a spoken direction, all word-timed.
const words = (text, start, step = 0.3) => text.split(' ').map((w, i) => ({ text: w, startSec: start + i * step, endSec: start + i * step + 0.25 }));
const MV = {
  render: { width: 1920, height: 1080, fps: 24, durationSec: 20 },
  song: { beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10], sections: [], words: [] },
  lyrics: [
    { id: 'l0', text: 'walking through the static', startSec: 1, endSec: 2.2, words: words('walking through the static', 1) },
    { id: 'l1', text: 'we light the signal', startSec: 4.1, endSec: 5.2, words: words('we light the signal', 4.1) },
    { id: 'l2', text: 'not anymore', startSec: 8, endSec: 8.6, words: words('not anymore', 8) },
  ],
  lyricMarkers: [
    { type: 'section', label: 'Verse 1', kind: 'verse', line: 0 },
    { type: 'section', label: 'Chorus', kind: 'chorus', line: 1 },
    { type: 'section', label: 'Verse 2', kind: 'verse', line: 2 },
    { type: 'direction', label: 'Spoken', kind: 'spoken', line: 2 },
  ],
  scenes: [
    { sceneId: 'a', startSec: 0, endSec: 3.5, textZone: 'upper-right' },
    { sceneId: 'b', startSec: 3.5, endSec: 7.5 },
    { sceneId: 'c', startSec: 7.5, endSec: 20, textZone: 'none' },
  ],
};

const chrome = [process.env.CHROME_PATH, chromium.executablePath(), '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((path) => path && existsSync(path));
const canRun = browserSuiteCanRun('lyric type browser', { Chrome: chrome });

describe.skipIf(!canRun)('lyricType in the layered template (browser pixels)', () => {
  let browser, browserFixture;
  beforeAll(async () => {
    browserFixture = await startOwnedBrowserFixture({ chromium, launchOptions: { executablePath: chrome, headless: true } });
    browser = browserFixture.browser;
  }, 30000);
  afterAll(async () => { await browserFixture?.close(); });

  it('keeps the hook accent outlined in ink on cream, pale-sky and busy light frames', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<canvas id="stage" width="960" height="540"></canvas>');
      await page.addScriptTag({ content: readFileSync(new URL('./lyricType.js', import.meta.url), 'utf8'), type: 'module' });
      await page.waitForFunction(() => globalThis.PORTOS_LYRIC_TYPE);
      const inkCounts = await page.evaluate(() => {
        const canvas = document.getElementById('stage');
        const ctx = canvas.getContext('2d');
        const type = globalThis.PORTOS_LYRIC_TYPE.createLyricType({}, {
          lines: [{ text: 'go signal', startSec: 0, endSec: 3, role: 'hook' }],
        });
        const placed = type.layout(type.lines[0], canvas.width, canvas.height, (text, font) => {
          ctx.font = font; return ctx.measureText(text).width;
        });
        const accent = placed.words.find((word) => word.index === type.lines[0].accent);
        return ['#f3ead7', '#dceefa', 'busy'].map((background) => {
          ctx.fillStyle = background === 'busy' ? '#ffffff' : background;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          if (background === 'busy') {
            ctx.fillStyle = '#e9e4d8';
            for (let x = 0; x < canvas.width; x += 20) ctx.fillRect(x, 0, 7, canvas.height);
          }
          type.draw(ctx, 2.5, { width: canvas.width, height: canvas.height });
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let ink = 0;
          // Count dark pixels only around the accent, separated from the filled word.
          for (let y = Math.floor(accent.y - placed.px - 10); y < accent.y + 10; y++) {
            for (let x = Math.ceil(accent.x - 5); x < accent.x + accent.w; x++) {
              const offset = (y * canvas.width + x) * 4;
              if (data[offset] < 60 && data[offset + 1] < 60 && data[offset + 2] < 60) ink++;
            }
          }
          return ink;
        });
      });
      expect(inkCounts).toHaveLength(3);
      for (const ink of inkCounts) expect(ink).toBeGreaterThan(100);
    } finally { await page.close(); }
  }, 30000);

  it('draws nothing before the onset and draws the line inside the shot\'s zone after it', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<canvas id="stage"></canvas>');
      await page.evaluate((mv) => { window.PORTOS_MV = mv; }, { ...MV, render: { ...MV.render, width: 640, height: 360 } });
      await page.addScriptTag({ content: readFileSync(new URL('./lyricType.js', import.meta.url), 'utf8'), type: 'module' });
      await page.waitForFunction(() => globalThis.PORTOS_LYRIC_TYPE);
      await page.addScriptTag({ content: readFileSync(new URL('../layered/engine.js', import.meta.url), 'utf8') });
      const lit = (t) => page.evaluate(async (time) => {
        await globalThis.portosComposition.seek(time);
        const c = document.getElementById('stage');
        const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        // Bright cream pixels per half of the frame (the ground is black, grain is faint).
        let upperRight = 0; let lowerLeft = 0;
        for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
          const o = (y * c.width + x) * 4;
          if (data[o] > 200 && data[o + 1] > 200 && data[o + 2] > 180) {
            if (x >= c.width / 2 && y < c.height / 2) upperRight++;
            if (x < c.width / 2 && y >= c.height / 2) lowerLeft++;
          }
        }
        return { upperRight, lowerLeft };
      }, t);
      expect((await lit(0.9)).upperRight).toBe(0);
      const after = await lit(2);
      expect(after.upperRight).toBeGreaterThan(50);
      expect(after.lowerLeft).toBe(0);
    } finally { await page.close(); }
  }, 30000);
});
