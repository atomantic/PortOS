import { describe, expect, it } from 'vitest';
import { createLyricType, LYRIC_FIT, TEXT_ZONES } from './lyricType.js';

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

  it('ranks a shot\'s lyricRole above sectionRoles', () => {
    const song = { ...MV, lyricMarkers: [], scenes: [{ sceneId: 'a', startSec: 0, endSec: 3.5, lyricRole: 'hook' }],
      song: { ...MV.song, sections: [{ label: 'Verse 1', startSec: 0 }] } };
    expect(roles(song, { sectionRoles: { verse: 'stamp' } })).toEqual(['hook', 'stamp', 'stamp']);
  });

  it('slams a chorus phrase the first time it is sung and brings its repeats back as sung lines', () => {
    const chorus = (id, start) => ({ id, text: 'We Light the signal', startSec: start, words: words('We Light the signal', start) });
    const song = {
      ...MV, scenes: [],
      lyrics: [chorus('c0', 1), { id: 'v0', text: 'walking through the static', startSec: 4, words: words('walking through the static', 4) }, chorus('c1', 8)],
      lyricMarkers: [{ type: 'section', kind: 'chorus', line: 0 }, { type: 'section', kind: 'verse', line: 1 }, { type: 'section', kind: 'chorus', line: 2 }],
    };
    const type = createLyricType(song);
    expect(type.lines.map((l) => l.role)).toEqual(['hook', 'line', 'line']);
    // The repeat takes the sung line's zone, not the hook's band.
    expect(type.lines.map((l) => l.zone)).toEqual(['lower', 'lower-left', 'lower-left']);
    expect(roles(song, { hookRepeats: 'hook' })).toEqual(['hook', 'line', 'hook']);
    // A shot that asks for a hook slam keeps it.
    expect(roles({ ...song, scenes: [{ sceneId: 'late', startSec: 7, endSec: 12, lyricRole: 'hook' }] })).toEqual(['hook', 'line', 'hook']);
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

  it('exits a sung line once its last word has held 0.8s and cuts a hook on the next beat', () => {
    // "static" starts at 1.9: 0.3s past its end (2.45) would fade it before it is read.
    expect(verse.exitSec).toBeCloseTo(1.9 + 0.8, 6);
    expect(verse.endSec - verse.exitSec).toBeCloseTo(8 / 24, 6);
    expect(type.linesAt(verse.endSec)).toEqual([]);
    // Last hook word starts at 5.0, so it holds to 5.8: the next beat is 6, no fade.
    expect(hook.exitSec).toBe(6);
    expect(hook.endSec).toBe(6);
    expect(hook.accent).toBe(3); // the longest word ("signal") is the outline-only accent
  });

  it('keeps a short line on screen for at least 0.8s', () => {
    const quick = createLyricType({ ...MV, lyricMarkers: [], lyrics: [{ text: 'no', startSec: 2, endSec: 2.1, words: [{ text: 'no', startSec: 2, endSec: 2.1 }] }] });
    expect(quick.lines[0].exitSec).toBeCloseTo(2.8, 6);
  });

  // Uniquely catches a short final word fading out before it can be read (sung and released fast).
  it('holds a short final word on screen until it has been read', () => {
    const type = createLyricType({ render: { fps: 24 } }, { lines: [
      { text: 'then changed the scene', role: 'line', zone: 'lower-left', words: [
        { text: 'then', startSec: 2, endSec: 2.2 }, { text: 'changed', startSec: 2.2, endSec: 2.5 },
        { text: 'the', startSec: 2.5, endSec: 2.6 }, { text: 'scene', startSec: 2.6, endSec: 2.7 },
      ] },
    ] });
    const [line] = type.lines;
    expect(line.exitSec).toBeCloseTo(3.4, 6);
    expect(type.linesAt(3.39)).toEqual([line]);
    expect(type.wordStates(line, 3.39)[3]).toMatchObject({ shown: true, alpha: 1 });
  });

  it.each([
    { role: 'line', nextRole: 'line', gap: 0.1, cut: true },
    { role: 'line', nextRole: 'data', gap: 1, cut: true },
    { role: 'data', nextRole: 'line', gap: 1.6, cut: false },
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
    else expect(first.endSec - first.exitSec).toBeCloseTo(8 / 24, 6);
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
    expect(type.lines[0].exitSec).toBeCloseTo(2.02 + 0.8, 6);
    expect(type.lines[0].endSec - type.lines[0].exitSec).toBeCloseTo(8 / 24, 6);
  });

  it('cuts a hook at the next hook onset when it comes before the beat', () => {
    const type = createLyricType({ song: { beats: [1, 3.5] } }, { exclusive: false, lines: [
      { text: 'Example hook', role: 'hook', zone: 'upper-right', words: words('Example hook', 2, 0.02) },
      { text: 'Example hook next', role: 'hook', zone: 'upper-right', words: words('Example hook next', 2.35, 0.02) },
    ] });
    expect(type.lines[0].endSec).toBeLessThanOrEqual(type.lines[1].startSec);
    expect(type.lines[0]).toMatchObject({ exitSec: 2.35, endSec: 2.35 });
  });

  it('preserves hook beat cuts and stamp minimum holds for crowded cues', () => {
    const type = createLyricType({ song: { beats: [3, 4] } }, { exclusive: false, lines: [
      { text: 'Example hook', role: 'hook', words: words('Example hook', 2, 0.02) },
      { text: 'Example hook next', role: 'hook', words: words('Example hook next', 2.1, 0.02) },
      { text: 'Example stamp', role: 'stamp', words: words('Example stamp', 5, 0.02) },
      { text: 'Example stamp next', role: 'stamp', words: words('Example stamp next', 5.1, 0.02) },
    ] });
    expect(type.lines[0]).toMatchObject({ exitSec: 2.1, endSec: 2.1 });
    expect(type.lines[2].exitSec).toBeCloseTo(5.02 + 0.8, 6);
    expect(type.lines[2].endSec).toBe(type.lines[2].exitSec);
  });
});

describe('lyricType text zones', () => {
  const type = createLyricType(MV);
  const [verse, hook, spoken] = type.lines;

  it('places each line inside its shot\'s text zone, and keeps a `none` shot clear', () => {
    expect(verse.zone).toBe('upper-right');
    expect(hook.zone).toBe('lower');
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

  it('keeps each caption to a small share of the frame, shrinking long lines but never below the phone floor', () => {
    const long = 'every frame we never used is stacked against the wall tonight';
    const type = createLyricType({}, {
      lines: ['line', 'hook', 'stamp', 'data'].map((role, i) => ({ text: long, role, startSec: i * 10, words: words(long, i * 10) })),
    });
    for (const [width, height] of [[1920, 1080], [1080, 1920], [1080, 1080]]) {
      const unit = Math.min(width, height) / 1080;
      for (const line of type.lines) {
        const placed = type.layout(line, width, height, measure);
        const rowH = placed.px * (line.role === 'data' ? 1.3 : 1.02);
        const covered = placed.words.reduce((sum, word) => sum + word.w, 0) * rowH;
        const floor = (line.role === 'data' ? 40 : 56) * unit;
        expect(placed.px).toBeGreaterThanOrEqual(floor - 1e-6);
        // Only the legibility floor may stop the shrink.
        if (placed.px <= floor + 1e-6) continue;
        expect(covered).toBeLessThanOrEqual(LYRIC_FIT.maxCover[line.role] * width * height + 1e-6);
        expect(placed.rows).toBeLessThanOrEqual(LYRIC_FIT.maxRows);
      }
    }
  });

  it('balances a wrapped line instead of leaving its last word alone on a row', () => {
    const text = 'I found a shot, then changed the scene';
    const type = createLyricType({}, { lines: [{ text, role: 'line', zone: 'lower-left', startSec: 0, words: words(text, 0) }] });
    const placed = type.layout(type.lines[0], 1920, 1080, measure);
    const rows = [...new Set(placed.words.map((word) => word.y))].map((y) => placed.words.filter((word) => word.y === y).map((word) => word.text).join(' '));
    expect(rows).toEqual(['I found a shot, then', 'changed the scene']);
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
          // A portrait frame centres in the social-safe band (6% left, 18% right), not on the frame.
          expect((first.x + right) / 2).toBeCloseTo(width > height ? width / 2 : width * 0.44, 6);
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

  it('places corner lyrics in all four corners, right-aligned on the right side', () => {
    const text = 'a short sung line';
    for (const zone of ['upper-left', 'upper-right', 'lower-left', 'lower-right']) {
      expect(TEXT_ZONES).toContain(zone);
      const type = createLyricType({}, { lines: [{ text, role: 'line', zone, startSec: 0, words: words(text, 0) }] });
      const placed = type.layout(type.lines[0], 1920, 1080, measure);
      const right = Math.max(...placed.words.map((word) => word.x + word.w - measure(' ', `${Math.round(placed.px)}px`)));
      const left = Math.min(...placed.words.map((word) => word.x));
      if (zone.endsWith('right')) expect(right).toBeCloseTo(placed.rect.x + placed.rect.w, 6);
      else expect(left).toBeCloseTo(placed.rect.x, 6);
      for (const word of placed.words) {
        if (zone.startsWith('upper')) expect(word.y).toBeLessThan(1080 / 2);
        else expect(word.y - placed.px).toBeGreaterThan(1080 / 2);
      }
    }
  });

  it('sizes a shot\'s lyrics small or large without going under the phone floor', () => {
    const text = 'a short sung line';
    const sizeOf = (lyricSize) => {
      const type = createLyricType({ scenes: [{ sceneId: 's', startSec: 0, endSec: 9, lyricSize }] }, { lines: [{ text, role: 'line', startSec: 0, words: words(text, 0) }] });
      return type.layout(type.lines[0], 1920, 1080, measure).px;
    };
    const normal = sizeOf(null);
    expect(sizeOf('large')).toBeCloseTo(normal * 1.25, 6);
    expect(sizeOf('small')).toBe(56);
    expect(normal).toBe(60);
  });

  it('steps a default-zoned line off the title card\'s corner while the card shows, but keeps a zone the shot names', () => {
    const mv = (textZone) => ({
      titleCard: { position: 'lower-left', windows: [{ startSec: 0, endSec: 2 }, { startSec: 10, endSec: 14 }] },
      scenes: [{ sceneId: 's', startSec: 0, endSec: 20, textZone }],
    });
    const lines = [
      { text: 'under the end card', role: 'line', startSec: 11, words: words('under the end card', 11) },
      { text: 'after the card', role: 'line', startSec: 16, words: words('after the card', 16) },
    ];
    expect(createLyricType(mv(null), { lines }).lines.map((l) => l.zone)).toEqual(['upper-left', 'lower-left']);
    expect(createLyricType(mv('lower-left'), { lines }).lines.map((l) => l.zone)).toEqual(['lower-left', 'lower-left']);
    // A hook's centred band shares the card's lower edge too.
    const hook = createLyricType(mv(null), { lines: [{ text: 'big hook', role: 'hook', startSec: 0.5, words: words('big hook', 0.5) }] });
    expect(hook.lines[0].zone).toBe('upper');
  });

  it('keeps every portrait zone inside the social-safe band, with the picture untouched', () => {
    for (const zone of TEXT_ZONES.filter((z) => z !== 'none')) {
      const rect = zoneRect(zone, 1080, 1920);
      expect(rect.x, zone).toBeGreaterThanOrEqual(0.06 * 1080 - 1e-6);
      expect(rect.x + rect.w, zone).toBeLessThanOrEqual(0.82 * 1080 + 1e-6);
      expect(rect.y, zone).toBeGreaterThanOrEqual(0.15 * 1920 - 1e-6);
      expect(rect.y + rect.h, zone).toBeLessThanOrEqual(0.65 * 1920 + 1e-6);
    }
    const lower = zoneRect('lower', 1080, 1920);
    expect([lower.x, lower.x + lower.w, lower.y, lower.y + lower.h].map(Math.round)).toEqual([65, 886, 672, 1248]);
    expect(zoneRect('none', 1080, 1920)).toBeNull();
  });

  it('keeps the framed insets on 16:9 and 1:1 frames, and on a cinematic portrait frame', () => {
    expect(zoneRect('lower', 1920, 1080)).toMatchObject({ h: 324, w: expect.closeTo(1920 - 230.4, 6), x: expect.closeTo(115.2, 6), y: expect.closeTo(1080 - 75.6 - 324, 6) });
    expect(zoneRect('lower', 1080, 1080).y + zoneRect('lower', 1080, 1080).h).toBeCloseTo(1080 - 75.6, 6);
    const cinematic = zoneRect('lower', 1080, 1920, { layout: 'cinematic' });
    expect(cinematic).toMatchObject({ x: 72, w: 936, h: 576 });
    expect(cinematic.y + cinematic.h).toBeCloseTo(1920 - 134.4, 6);
    expect(cinematic.social).toBeUndefined();
  });

  it('reads the layout from the project and lays a portrait line out in the band or the film frame', () => {
    const lines = [{ text: 'we light the signal', role: 'line', zone: 'lower', startSec: 0, words: words('we light the signal', 0) }];
    const social = createLyricType({ project: { lyricLayout: 'social' } }, { lines });
    const cinematic = createLyricType({ project: { lyricLayout: 'cinematic' } }, { lines });
    const bottomOf = (type) => Math.max(...type.layout(type.lines[0], 1080, 1920, measure).words.map((w) => w.y));
    expect(bottomOf(social)).toBeLessThanOrEqual(1248);
    expect(bottomOf(cinematic)).toBeGreaterThan(1248);
  });

  describe('unfit', () => {
    const ctx = { canvas: { width: 1080, height: 1920 }, font: '', measureText(str) { return { width: measure(str, this.font) }; } };
    const long = 'every frame we never used is stacked against the wall tonight and the next one too';
    const typeFor = (layout, text) => createLyricType({ project: { lyricLayout: layout } }, {
      lines: [{ text: 'short line', role: 'line', zone: 'lower', startSec: 1, words: words('short line', 1) },
        { text, role: 'hook', zone: 'lower', startSec: 8, words: words(text, 8) }],
    });

    it('names a portrait line that cannot fit the band, scoped to the window', () => {
      const text = `${'supercalifragilisticexpialidocious '.repeat(3)}`.trim();
      const type = typeFor('social', text);
      expect(type.unfit(ctx).map((l) => [l.startSec, l.text])).toEqual([[8, text]]);
      expect(type.unfit(ctx, { startSec: 0, endSec: 5 })).toEqual([]);
      expect(typeFor('social', long).unfit(ctx)).toEqual([]);
    });

    it('never reports on a cinematic or landscape frame', () => {
      const text = `${'supercalifragilisticexpialidocious '.repeat(3)}`.trim();
      expect(typeFor('cinematic', text).unfit(ctx)).toEqual([]);
      expect(typeFor('social', text).unfit({ ...ctx, canvas: { width: 1920, height: 1080 } })).toEqual([]);
    });
  });
});


it('honors automatic overlay visibility without hiding authored lines or changing timing data', () => {
  const mv = { ...MV, composition: { lyricOverlayEnabled: false } };
  const before = structuredClone(mv.lyrics);
  const automatic = createLyricType(mv);
  expect(automatic.linesAt(1.5)).toEqual([]);
  expect(automatic.lines).toEqual([]);
  const authored = createLyricType(mv, { lines: MV.lyrics });
  expect(authored.linesAt(1.5)).not.toEqual([]);
  expect(mv.lyrics).toEqual(before);
});
