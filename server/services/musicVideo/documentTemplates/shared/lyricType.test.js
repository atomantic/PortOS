import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { createLyricType, resolveLineRoles, zoneRect } from './lyricType.js';

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

// A deterministic measure: 0.5em per character.
const measure = (str, font) => str.length * Number(/(\d+)px/.exec(font)[1]) * 0.5;

describe('lyricType roles', () => {
  it('takes roles from the lyric sheet: section headers, then a line\'s delivery direction, overrides first', () => {
    expect(resolveLineRoles(MV.lyrics, { lyricMarkers: MV.lyricMarkers })).toEqual(['line', 'hook', 'stamp']);
    expect(resolveLineRoles(MV.lyrics, { lyricMarkers: MV.lyricMarkers, overrides: { l1: 'data', 0: 'stamp' } })).toEqual(['stamp', 'data', 'stamp']);
    // No sheet markers: the timed section label decides.
    expect(resolveLineRoles(MV.lyrics, { sections: [{ label: 'Verse', startSec: 0 }, { label: 'Final Chorus', startSec: 4 }] })).toEqual(['line', 'hook', 'hook']);
  });

  it('lets a shot override the role of the lines sung over it', () => {
    const type = createLyricType({ ...MV, scenes: MV.scenes.map((s) => (s.sceneId === 'a' ? { ...s, lyricRole: 'stamp' } : s)) });
    expect(type.lines.map((l) => l.role)).toEqual(['stamp', 'hook', 'stamp']);
  });
});

describe('lyricType timing', () => {
  const type = createLyricType(MV);
  const [verse, hook] = type.lines;

  it('never shows a line before its first word onset, and reveals each word on its own onset', () => {
    expect(type.linesAt(0.99)).toEqual([]);
    expect(type.linesAt(1)).toEqual([verse]);
    const states = type.wordStates(verse, 1.35);
    expect(states.map((s) => s.shown)).toEqual([true, true, false, false]);
    expect(states[1].alpha).toBeLessThan(1);
    expect(type.wordStates(verse, 1.6)[0]).toMatchObject({ alpha: 1, dy: 0 });
  });

  it('exits a sung line 0.3s after its last word and cuts a hook on the next beat', () => {
    expect(verse.exitSec).toBeCloseTo(1.9 + 0.25 + 0.3, 6);
    expect(verse.endSec - verse.exitSec).toBeCloseTo(8 / 24, 6);
    expect(type.linesAt(verse.endSec)).toEqual([]);
    // Last hook word ends at 5.15 (cue end 5.2): the next beat is 5.5, no fade.
    expect(hook.exitSec).toBe(5.5);
    expect(hook.endSec).toBe(5.5);
    expect(hook.accent).toBe(3); // the longest word ("signal") is the outline-only accent
  });

  it('keeps a short line on screen for at least 0.8s', () => {
    const quick = createLyricType({ ...MV, lyricMarkers: [], lyrics: [{ text: 'no', startSec: 2, endSec: 2.1, words: [{ text: 'no', startSec: 2, endSec: 2.1 }] }] });
    expect(quick.lines[0].exitSec).toBeCloseTo(2.8, 6);
  });
});

describe('lyricType text zones', () => {
  const type = createLyricType(MV);
  const [verse, hook, spoken] = type.lines;

  it('places each line inside its shot\'s text zone, and keeps a `none` shot clear', () => {
    expect(verse.zone).toBe('upper-right');
    expect(hook.zone).toBe('center');
    expect(spoken.zone).toBe('none');
    expect(type.linesAt(8.2)).toEqual([]);
    for (const line of [verse, hook]) {
      const placed = type.layout(line, 1920, 1080, measure);
      const rect = zoneRect(line.zone, 1920, 1080);
      for (const word of placed.words) {
        expect(word.x).toBeGreaterThanOrEqual(rect.x - 1e-6);
        expect(word.x + word.w - measure(' ', `${placed.px}px`)).toBeLessThanOrEqual(rect.x + rect.w + 1e-6);
        expect(word.y).toBeGreaterThan(rect.y);
        expect(word.y).toBeLessThanOrEqual(rect.y + rect.h);
      }
      expect(placed.px).toBeGreaterThanOrEqual(56);
    }
  });

  it('reframes zones for a portrait frame', () => {
    const rect = zoneRect('lower-left', 1080, 1920);
    expect(rect.x + rect.w).toBeCloseTo(1080 - rect.x, 6);
    expect(rect.y + rect.h).toBeLessThan(1920);
  });
});

const chrome = [process.env.CHROME_PATH, chromium.executablePath(), '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((path) => path && existsSync(path));

describe.skipIf(!chrome)('lyricType in the layered template (browser pixels)', () => {
  let browser;
  beforeAll(async () => { browser = await chromium.launch({ executablePath: chrome, headless: true }); }, 30000);
  afterAll(async () => { await browser?.close(); });

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
