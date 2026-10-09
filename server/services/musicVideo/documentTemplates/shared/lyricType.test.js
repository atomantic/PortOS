import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { createLyricType, TEXT_ZONES } from './lyricType.js';

// zoneRect is the module's public text-zone geometry, reached through the global classic scripts use.
const { zoneRect } = globalThis.PORTOS_LYRIC_TYPE;
const roles = (mv, options) => createLyricType(mv, options).lines.map((l) => l.role);

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
    const unzoned = { ...MV, scenes: [] };
    expect(roles(unzoned)).toEqual(['line', 'hook', 'stamp']);
    expect(roles(unzoned, { overrides: { l1: 'data', 0: 'stamp' } })).toEqual(['stamp', 'data', 'stamp']);
    // No sheet markers: the timed section label decides.
    const timed = { ...unzoned, lyricMarkers: [], song: { ...MV.song, sections: [{ label: 'Verse', startSec: 0 }, { label: 'Final Chorus', startSec: 4 }] } };
    expect(roles(timed)).toEqual(['line', 'hook', 'hook']);
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

  it.each([
    { role: 'line', nextRole: 'line', gap: 0.1, cut: true },
    { role: 'line', nextRole: 'data', gap: 1, cut: true },
    { role: 'data', nextRole: 'line', gap: 1.2, cut: false },
  ])('never overlaps a $role cue with the next $nextRole cue in its zone (gap $gap)', ({ role, nextRole, gap, cut }) => {
    const onset = 2;
    const nextOnset = onset + gap;
    const type = createLyricType({ render: { fps: 24 } }, { lines: [
      { text: 'Example first', role, zone: 'lower-left', words: words('Example first', onset, 0.4) },
      { text: 'Example next', role: nextRole, zone: 'lower-left', words: words('Example next', nextOnset, 0.02) },
    ] });
    const [first, next] = type.lines;
    expect(first.endSec).toBeLessThanOrEqual(nextOnset);
    if (cut) expect(first.exitSec).toBe(nextOnset);
    else {
      expect(first.endSec).toBe(nextOnset);
      expect(first.endSec - first.exitSec).toBeCloseTo(8 / 24, 6);
    }
    for (let frame = onset * 24; frame <= (nextOnset + 1) * 24; frame++) {
      expect(type.linesAt(frame / 24).length).toBeLessThanOrEqual(1);
    }
    expect(type.linesAt(nextOnset)).toEqual([next]);
  });

  it('keeps cues in different zones independent', () => {
    const type = createLyricType({}, { lines: [
      { text: 'Example first', role: 'line', zone: 'upper-right', words: words('Example first', 2, 0.02) },
      { text: 'Example next', role: 'line', zone: 'lower-left', words: words('Example next', 2.1, 0.02) },
    ] });
    expect(type.linesAt(2.3)).toEqual(type.lines);
    expect(type.lines[0].exitSec).toBeCloseTo(2.8, 6);
    expect(type.lines[0].endSec - type.lines[0].exitSec).toBeCloseTo(8 / 24, 6);
  });

  it('preserves hook beat cuts and stamp minimum holds for crowded cues', () => {
    const type = createLyricType({ song: { beats: [3, 4] } }, { exclusive: false, lines: [
      { text: 'Example hook', role: 'hook', words: words('Example hook', 2, 0.02) },
      { text: 'Example hook next', role: 'hook', words: words('Example hook next', 2.1, 0.02) },
      { text: 'Example stamp', role: 'stamp', words: words('Example stamp', 5, 0.02) },
      { text: 'Example stamp next', role: 'stamp', words: words('Example stamp next', 5.1, 0.02) },
    ] });
    expect(type.lines[0]).toMatchObject({ exitSec: 3, endSec: 3 });
    expect(type.lines[2].exitSec).toBeCloseTo(5.8, 6);
    expect(type.lines[2].endSec).toBe(type.lines[2].exitSec);
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

  it('accepts centred upper/lower shot zones and lays hooks clear of the frame centre', () => {
    for (const zone of ['upper', 'lower']) {
      expect(TEXT_ZONES).toContain(zone);
      const type = createLyricType({ ...MV, scenes: MV.scenes.map((s) => ({ ...s, textZone: zone })) });
      const hook = type.lines[1];
      expect(hook.zone).toBe(zone);
      for (const [width, height] of [[1920, 1080], [1080, 1920]]) {
        const placed = type.layout(hook, width, height, measure);
        for (const y of new Set(placed.words.map((word) => word.y))) {
          const row = placed.words.filter((word) => word.y === y);
          const first = row[0];
          const last = row[row.length - 1];
          const right = last.x + last.w - measure(' ', `${Math.round(placed.px)}px`);
          expect((first.x + right) / 2).toBeCloseTo(width / 2, 6);
        }
        for (const word of placed.words) {
          if (zone === 'upper') expect(word.y).toBeLessThan(height / 2);
          else expect(word.y - placed.px).toBeGreaterThan(height / 2);
        }
      }
    }
  });

  it('keeps a slamming hook word inside its zone on the first frame', () => {
    for (const zone of ['upper-right', 'lower-left', 'center']) {
      // One word that fills the whole zone width at the base size (0.5em per char).
      const type = createLyricType({}, { lines: [{ text: 'UNIVERSEWORDS', role: 'hook', zone, startSec: 1, endSec: 3, words: [{ text: 'UNIVERSEWORDS', startSec: 1, endSec: 2 }] }] });
      const hook = type.lines[0];
      const placed = type.layout(hook, 1920, 1080, (str, font) => str.length * Number(/(\d+)px/.exec(font)[1]) * 0.5);
      const [word] = placed.words;
      const [state] = type.wordStates(hook, 1);
      expect(state.scale).toBeGreaterThan(1);
      const space = placed.px * 0.5;
      const ink = word.w - space;
      const scaled = ink * Math.min(state.scale, word.maxScale);
      const centre = word.x + ink / 2;
      expect(centre - scaled / 2).toBeGreaterThanOrEqual(placed.rect.x - 1e-6);
      expect(centre + scaled / 2).toBeLessThanOrEqual(placed.rect.x + placed.rect.w + 1e-6);
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
