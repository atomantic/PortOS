import { describe, expect, it } from 'vitest';
import { creditsOutroPrefill, creditsOutroSeconds, drawCreditsOutro, normalizeCreditsOutro } from './musicVideoCreditsOutro.js';
import { endingParts, endingPartAt, endingSeconds } from './musicVideoEnding.js';

describe('credits ending', () => {
  it('keeps every line as typed, drops empty ones and clamps its length', () => {
    expect(normalizeCreditsOutro(null)).toBeNull();
    const credits = normalizeCreditsOutro({
      enabled: true, durationSec: 99, title: '  Example   Song ', lines: [{ role: 'Directed by', name: 'Alice' }, { role: ' ', name: '' }, { name: 'Bob' }],
    });
    expect(credits).toMatchObject({ enabled: true, durationSec: 30, title: 'Example Song', lines: [{ role: 'Directed by', name: 'Alice' }, { role: '', name: 'Bob' }] });
    // On with nothing to show adds no time.
    expect(creditsOutroSeconds({ enabled: true })).toBe(0);
    expect(creditsOutroSeconds({ ...credits, enabled: false })).toBe(0);
    expect(creditsOutroSeconds(credits)).toBe(30);
  });

  it('fills from the track, its artist\'s credit name and album, falling back to the project name', () => {
    const credits = creditsOutroPrefill({
      project: { name: 'Example Song v3' },
      track: { title: 'Example Song', artist: 'Track Text' },
      artist: { name: 'Example Artist', creditName: 'E. Artist' },
      album: { title: 'Example Album' },
      year: 2026,
    });
    expect(credits).toMatchObject({
      enabled: true, title: 'Example Song', artist: 'E. Artist', footer: '© 2026 E. Artist',
      lines: [
        { role: 'Directed by', name: 'E. Artist' }, { role: 'Music by', name: 'E. Artist' },
        { role: 'Produced by', name: 'E. Artist' }, { role: 'From the album', name: 'Example Album' },
      ],
    });
    const bare = creditsOutroPrefill({ project: { name: 'Example Song v2' }, year: 2026 });
    expect(bare).toMatchObject({ title: 'Example Song', artist: '', footer: '' });
  });

  it('plays after the floor on one clock', () => {
    const project = {
      statsOutro: { enabled: true, durationSec: 8 },
      creditsOutro: { enabled: true, durationSec: 10, title: 'Example Song' },
    };
    const parts = endingParts(project);
    expect(parts.map(({ kind, startSec, durationSec }) => ({ kind, startSec, durationSec })))
      .toEqual([{ kind: 'floor', startSec: 0, durationSec: 8 }, { kind: 'credits', startSec: 8, durationSec: 10 }]);
    expect(endingSeconds(project)).toBe(18);
    expect(endingPartAt(parts, 3)).toMatchObject({ part: { kind: 'floor' }, t: 3 });
    expect(endingPartAt(parts, 9.5)).toMatchObject({ part: { kind: 'credits' }, t: 1.5 });
    expect(endingPartAt(parts, 40)).toMatchObject({ part: { kind: 'credits' }, t: 10 });
    expect(endingSeconds({ statsOutro: null, creditsOutro: null })).toBe(0);
  });

  it('holds a short card still and rolls a long one up the frame', () => {
    const texts = (credits, t) => {
      const drawn = [];
      const ctx = new Proxy({ measureText: (text) => ({ width: text.length * 10 }), fillText: (text, _x, y) => drawn.push({ text, y }) }, {
        get: (target, key) => (key in target ? target[key] : () => {}),
        set: () => true,
      });
      drawCreditsOutro(ctx, { width: 1280, height: 720, t, durationSec: 10, credits: normalizeCreditsOutro(credits) });
      return drawn;
    };
    const short = { enabled: true, title: 'Example Song', artist: 'Example Artist', lines: [{ role: 'Directed by', name: 'Alice' }] };
    expect(texts(short, 3).find((d) => d.text === 'Alice').y).toBe(texts(short, 7).find((d) => d.text === 'Alice').y);
    const long = { ...short, lines: Array.from({ length: 20 }, (_, i) => ({ role: 'Special thanks', name: `Person ${i}` })) };
    const early = texts(long, 3).find((d) => d.text === 'Person 0');
    const later = texts(long, 3.2).find((d) => d.text === 'Person 0');
    expect(later.y).toBeLessThan(early.y);
    // The grid shows every credit on the one frame, still.
    const grid = texts({ ...long, layout: 'grid' }, 5);
    expect(grid.filter((d) => d.text.startsWith('Person '))).toHaveLength(20);
    expect(grid.every((d) => d.y > 0 && d.y < 720)).toBe(true);
    expect(texts({ ...long, layout: 'grid' }, 7)).toEqual(grid);
  });
});
