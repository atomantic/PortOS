import { describe, it, expect } from 'vitest';
import {
  parseDrumChart, isDrumNotation, drumChartHasMusic, kitPiece,
  describeDrumCell, describeDrumPosition, drumGlyphLegend,
  KIT_PIECES, CELL_GLYPHS, DEFAULT_DRUM_TEMPO, SUBDIVISION_MAX,
} from './drumNotation.js';

// All fixtures are invented grooves (privacy convention) — no transcribed music.
const ROCK_BEAT = `time: 4/4
tempo: 96
subdivision: 4

# Bar 1 — basic rock beat
HH: x x x x x x x x
S:  - - - - o - - -
K:  o - - - - - o -`;

const cellIds = (cells) => cells.map((c) => c.id);

describe('parseDrumChart — headers', () => {
  it('reads time / tempo / subdivision', () => {
    const chart = parseDrumChart(ROCK_BEAT);
    expect(chart.time).toEqual({ beats: 4, beatValue: 4 });
    expect(chart.tempo).toBe(96);
    expect(chart.subdivision).toBe(4);
    expect(chart.stepsPerBar).toBe(16);
    expect(chart.errors).toEqual([]);
  });

  it('defaults a headerless chart to 4/4 @ 90 with subdivision 4', () => {
    const chart = parseDrumChart('K: o - - -\nS: - - o -');
    expect(chart.time).toEqual({ beats: 4, beatValue: 4 });
    expect(chart.tempo).toBe(DEFAULT_DRUM_TEMPO);
    expect(chart.subdivision).toBe(4);
    expect(chart.errors).toEqual([]);
  });

  it('accepts headers in any order and a non-4/4 signature', () => {
    const chart = parseDrumChart('subdivision: 2\ntempo: 140\ntime: 6/8\n\nHH: xxxxxx');
    expect(chart.time).toEqual({ beats: 6, beatValue: 8 });
    expect(chart.tempo).toBe(140);
    expect(chart.subdivision).toBe(2);
    expect(chart.stepsPerBar).toBe(12);
  });

  it('collects bad header values into errors and keeps the defaults', () => {
    const chart = parseDrumChart('time: banana\ntempo: soon\nsubdivision: 99\n\nK: o---');
    expect(chart.time).toEqual({ beats: 4, beatValue: 4 });
    expect(chart.tempo).toBe(DEFAULT_DRUM_TEMPO);
    expect(chart.subdivision).toBe(4);
    expect(chart.errors).toEqual([
      'bad time signature "banana"',
      'bad tempo "soon"',
      `bad subdivision "99" (expected 1–${SUBDIVISION_MAX})`,
    ]);
  });

  it('ignores (and reports) a header that appears after the music', () => {
    const chart = parseDrumChart('K: o---\n\ntempo: 200\n\nS: --o-');
    expect(chart.tempo).toBe(DEFAULT_DRUM_TEMPO);
    expect(chart.errors).toContain('header "tempo" appears after the music started — ignored');
  });

  it('honors a kit: row-order override, filtered to the pieces present', () => {
    const chart = parseDrumChart('kit: K, S, HH\n\nHH: xxxx\nS: --o-\nK: o---');
    expect(chart.pieces).toEqual(['K', 'S', 'HH']);
  });

  it('kit: REORDERS rows, never hides one the chart plays', () => {
    // A piece the header omits is still scheduled, so dropping it from `pieces`
    // would sound a snare the sheet never draws. Listed pieces come first, the
    // rest follow in default kit order.
    const chart = parseDrumChart('kit: K, HH\n\nHH: xxxx\nS: --o-\nK: o---');
    expect(chart.pieces).toEqual(['K', 'HH', 'S']);
    const played = new Set(chart.bars.flatMap((b) => b.rows.map((r) => r.piece)));
    for (const id of played) expect(chart.pieces).toContain(id);
  });

  it('never invents an empty row for a kit: piece the chart does not use', () => {
    const chart = parseDrumChart('kit: CR, RD, K\n\nK: o---');
    expect(chart.pieces).toEqual(['K']);
  });

  it('falls back to kit order when kit: names nothing known', () => {
    const chart = parseDrumChart('kit: cowbell, vuvuzela\n\nHH: xxxx\nK: o---');
    expect(chart.pieces).toEqual(['HH', 'K']);
    expect(chart.errors[0]).toMatch(/names no known pieces/);
  });
});

describe('parseDrumChart — bars and rows', () => {
  it('orders rows by kit position regardless of how they were typed', () => {
    const chart = parseDrumChart('K: o---\nHH: xxxx\nS: --o-');
    expect(chart.bars[0].rows.map((r) => r.piece)).toEqual(['HH', 'S', 'K']);
    expect(chart.pieces).toEqual(['HH', 'S', 'K']);
  });

  it('splits blocks on blank lines and labels them from the leading comment', () => {
    const chart = parseDrumChart(`# Groove
HH: xxxxxxxx
K: o-------

# Fill
S: xxxxxxxx`);
    expect(chart.bars).toHaveLength(2);
    expect(chart.bars.map((b) => b.label)).toEqual(['Groove', 'Fill']);
    expect(chart.bars.map((b) => b.index)).toEqual([1, 2]);
  });

  it('parses spaced and unspaced rows identically', () => {
    const spaced = parseDrumChart('HH: x x x x x x x x');
    const tight = parseDrumChart('HH: xxxxxxxx');
    expect(cellIds(tight.bars[0].rows[0].cells)).toEqual(cellIds(spaced.bars[0].rows[0].cells));
  });

  it('tolerates decorative bar-line pipes inside a row', () => {
    const chart = parseDrumChart('subdivision: 1\n\nHH: |x-x-|');
    expect(cellIds(chart.bars[0].rows[0].cells)).toEqual(['normal', 'rest', 'normal', 'rest']);
  });

  it('pads a short row with rests to the full bar', () => {
    const chart = parseDrumChart('time: 4/4\nsubdivision: 4\n\nK: o');
    const cells = chart.bars[0].rows[0].cells;
    expect(cells).toHaveLength(16);
    expect(cells[0].rest).toBe(false);
    expect(cells.slice(1).every((c) => c.rest)).toBe(true);
    expect(chart.errors).toEqual([]);
  });

  it('truncates an over-long row and reports it', () => {
    const chart = parseDrumChart('subdivision: 1\n\nK: oooooo');
    expect(chart.bars[0].rows[0].cells).toHaveLength(4);
    expect(chart.errors).toEqual(['bar 1 K: 6 cells for a 4-step bar — extra cells truncated']);
  });

  it('skips an unknown piece row, reports it, and still parses the rest', () => {
    const chart = parseDrumChart('CB: xxxx\nHH: xxxx');
    expect(chart.pieces).toEqual(['HH']);
    expect(chart.errors).toEqual(['unknown kit piece "CB" — row skipped']);
    expect(chart.bars).toHaveLength(1);
  });

  it('reports a line that is not a header, comment or piece row', () => {
    const chart = parseDrumChart('HH: xxxx\njust some prose');
    expect(chart.errors).toEqual(['unrecognized line "just some prose"']);
    expect(chart.bars[0].rows).toHaveLength(1);
  });

  it('merges a piece typed twice in one block, hits winning over rests', () => {
    const chart = parseDrumChart('subdivision: 1\n\nHH: x---\nHH: --x-');
    const rows = chart.bars[0].rows;
    expect(rows).toHaveLength(1);
    expect(cellIds(rows[0].cells)).toEqual(['normal', 'rest', 'normal', 'rest']);
  });

  it('treats an unknown cell char as a rest and reports it', () => {
    const chart = parseDrumChart('subdivision: 1\n\nK: o?o?');
    expect(cellIds(chart.bars[0].rows[0].cells)).toEqual(['open', 'rest', 'open', 'rest']);
    expect(chart.errors).toEqual(['bar 1 K: unknown cell "?" — treated as a rest']);
  });

  it('drops a block with no valid rows instead of emitting an empty bar', () => {
    const chart = parseDrumChart('HH: xxxx\n\n# orphan label only\n\nK: o---');
    expect(chart.bars).toHaveLength(2);
    expect(chart.bars.map((b) => b.rows[0].piece)).toEqual(['HH', 'K']);
  });

  it('returns a usable empty chart for empty / nullish input', () => {
    for (const input of ['', null, undefined, '   \n\n']) {
      const chart = parseDrumChart(input);
      expect(chart.bars).toEqual([]);
      expect(chart.pieces).toEqual([]);
      expect(chart.errors).toEqual([]);
    }
  });
});

describe('parseDrumChart — repeats', () => {
  it('expands an x2 block into two numbered bars', () => {
    const chart = parseDrumChart('# Groove x2\nHH: xxxx\nK: o---');
    expect(chart.bars).toHaveLength(2);
    expect(chart.bars.map((b) => b.index)).toEqual([1, 2]);
    expect(chart.bars.map((b) => b.repeatPass)).toEqual([1, 2]);
    expect(chart.bars[0].label).toBe('Groove');
  });

  it('expands x4 and keeps later blocks numbered after the expansion', () => {
    const chart = parseDrumChart('# A x4\nHH: xxxx\n\n# B\nS: xxxx');
    expect(chart.bars.map((b) => b.index)).toEqual([1, 2, 3, 4, 5]);
    expect(chart.bars[4].label).toBe('B');
  });

  it('accepts the × form and treats x1 / x0 as a single pass', () => {
    expect(parseDrumChart('# A ×3\nHH: xxxx').bars).toHaveLength(3);
    expect(parseDrumChart('# A x1\nHH: xxxx').bars).toHaveLength(1);
    expect(parseDrumChart('# A x0\nHH: xxxx').bars).toHaveLength(1);
  });
});

describe('parseDrumChart — kit pieces and glyphs', () => {
  it('parses all nine kit pieces by id', () => {
    const text = KIT_PIECES.map((p) => `${p.id}: x---`).join('\n');
    const chart = parseDrumChart(`subdivision: 1\n\n${text}`);
    expect(chart.pieces).toEqual(KIT_PIECES.map((p) => p.id));
    expect(chart.errors).toEqual([]);
  });

  it('accepts every long alias and lowercase spelling', () => {
    for (const piece of KIT_PIECES) {
      for (const token of [piece.id.toLowerCase(), ...piece.aliases]) {
        const chart = parseDrumChart(`subdivision: 1\n\n${token}: x---`);
        expect(chart.pieces, `alias "${token}"`).toEqual([piece.id]);
      }
    }
  });

  it('parses all six cell glyphs with their velocities', () => {
    const chart = parseDrumChart('subdivision: 3\n\nHH: -xXogf');
    const cells = chart.bars[0].rows[0].cells.slice(0, 6);
    expect(cellIds(cells)).toEqual(['rest', 'normal', 'accent', 'open', 'ghost', 'flam']);
    expect(cells.map((c) => c.velocity)).toEqual([
      CELL_GLYPHS['-'].velocity, CELL_GLYPHS.x.velocity, CELL_GLYPHS.X.velocity,
      CELL_GLYPHS.o.velocity, CELL_GLYPHS.g.velocity, CELL_GLYPHS.f.velocity,
    ]);
    expect(cells[2].accent).toBe(true);
    expect(cells[3].open).toBe(true);
    expect(cells[4].ghost).toBe(true);
    expect(cells[5].flam).toBe(true);
  });

  it('treats . and _ as rest synonyms', () => {
    const chart = parseDrumChart('subdivision: 1\n\nK: o._o');
    expect(cellIds(chart.bars[0].rows[0].cells)).toEqual(['open', 'rest', 'rest', 'open']);
    expect(chart.errors).toEqual([]);
  });

  it('exposes a descriptor per piece and null for an unknown id', () => {
    expect(kitPiece('HH')).toMatchObject({ label: 'Hi-Hat', sound: 'hihat' });
    expect(kitPiece('CB')).toBeNull();
    // Every piece carries the fields the renderer + synth read.
    for (const piece of KIT_PIECES) {
      expect(piece).toMatchObject({
        id: expect.any(String), label: expect.any(String),
        midi: expect.any(Number), sound: expect.any(String),
      });
      expect(['cross', 'head']).toContain(piece.glyph);
    }
  });
});

describe('isDrumNotation', () => {
  it('recognizes a drum chart', () => {
    expect(isDrumNotation(ROCK_BEAT)).toBe(true);
    expect(isDrumNotation('HH: xxxx\nK: o---')).toBe(true);
  });

  it('recognizes a single row when a drum-only header is present', () => {
    expect(isDrumNotation('subdivision: 4\n\nHH: xxxxxxxx')).toBe(true);
    expect(isDrumNotation('HH: xxxxxxxx')).toBe(false);
  });

  it('rejects a chord sheet, a tab staff, and prose', () => {
    expect(isDrumNotation('[Verse]\nC  G  Am  F\nPlaceholder words here')).toBe(false);
    expect(isDrumNotation('e|--0--2--3--|\nB|--------3--|')).toBe(false);
    expect(isDrumNotation('S: something someone said')).toBe(false);
    expect(isDrumNotation('')).toBe(false);
    expect(isDrumNotation(null)).toBe(false);
  });

  it('rejects an all-rest grid (ambiguous, no hits)', () => {
    expect(isDrumNotation('HH: ----\nK: ----')).toBe(false);
  });
});

describe('drumChartHasMusic', () => {
  it('is true only when a cell is actually struck', () => {
    expect(drumChartHasMusic(ROCK_BEAT)).toBe(true);
    expect(drumChartHasMusic('HH: ----\nK: ----')).toBe(false);
    expect(drumChartHasMusic('time: 4/4')).toBe(false);
    expect(drumChartHasMusic('')).toBe(false);
  });
});

describe('describeDrumCell', () => {
  const cellOf = (text, piece, step = 0) => {
    const chart = parseDrumChart(text);
    return chart.bars[0].rows.find((r) => r.piece === piece).cells[step];
  };

  it('names the piece, the articulation, and how to strike it', () => {
    const info = describeDrumCell('CR', cellOf('subdivision: 1\n\nCR: X---', 'CR'));
    expect(info.pieceLabel).toBe('Crash');
    expect(info.char).toBe('X');
    expect(info.articulation).toBe('Accent');
    expect(info.detail).toMatch(/harder/i);
    expect(info.technique).toMatch(/crash cymbal/i);
    expect(info.rest).toBe(false);
    // The accent's own mark is explained — the whole point of tapping an X with
    // a chevron over it.
    expect(info.detail).toContain('>');
  });

  it('reports the hit strength playback actually uses', () => {
    expect(describeDrumCell('S', cellOf('subdivision: 1\n\nS: x---', 'S')).velocityPercent)
      .toBe(Math.round(CELL_GLYPHS.x.velocity * 100));
    expect(describeDrumCell('S', cellOf('subdivision: 1\n\nS: g---', 'S')).velocityPercent)
      .toBe(Math.round(CELL_GLYPHS.g.velocity * 100));
    expect(describeDrumCell('S', CELL_GLYPHS['-']).velocityPercent).toBe(0);
  });

  it('explains `o` as OPEN on a cymbal and as a normal hit on a drum', () => {
    // The renderer only rings the × on cross-glyph pieces, so calling a kick's
    // `o` "open" would describe a technique the sheet never drew.
    const hat = describeDrumCell('HH', cellOf('subdivision: 1\n\nHH: o---', 'HH'));
    expect(hat.articulation).toBe('Open');
    expect(hat.detail).toMatch(/ring/i);

    const kick = describeDrumCell('K', cellOf('subdivision: 1\n\nK: o---', 'K'));
    expect(kick.articulation).toBe('Normal hit');
    expect(kick.detail).toMatch(/only changes hi-hats and cymbals/i);
    expect(kick.char).toBe('o');
  });

  it('does not send a crash or ride player to the hi-hat pedal for an "o"', () => {
    // The parser accepts `o` on any row and the renderer rings every cross glyph,
    // but only the hi-hat VOICE sustains it (drumPlayback's `openDecay`) — so the
    // wording has to follow the piece, not just the glyph shape.
    for (const id of ['CR', 'RD']) {
      const info = describeDrumCell(id, CELL_GLYPHS.o);
      expect(info.articulation).toBe('Open (let it ring)');
      expect(info.detail).not.toMatch(/pedal/i);
      expect(info.detail).toMatch(/same as a normal hit/i);
    }
  });

  it('reads an "o" on the hi-hat FOOT row as a splash, not a stick-played open hat', () => {
    const info = describeDrumCell('HF', CELL_GLYPHS.o);
    expect(info.articulation).toBe('Open (foot splash)');
    expect(info.detail).toMatch(/splash/i);
  });

  it('describes ghosts, flams and rests', () => {
    expect(describeDrumCell('S', cellOf('subdivision: 1\n\nS: g---', 'S')).articulation).toBe('Ghost note');
    expect(describeDrumCell('S', cellOf('subdivision: 1\n\nS: f---', 'S')).articulation).toBe('Flam');
    const rest = describeDrumCell('S', cellOf('subdivision: 1\n\nS: -x--', 'S'));
    expect(rest.articulation).toBe('Rest');
    expect(rest.rest).toBe(true);
  });

  it('falls back to a rest for a missing cell, and null for an unknown piece', () => {
    // A stale selection into an edited chart hands us a null cell — describe it
    // as a rest (what the parser would have made of it) rather than throwing.
    expect(describeDrumCell('S', null).articulation).toBe('Rest');
    expect(describeDrumCell('S', { id: 'not-a-glyph' }).articulation).toBe('Rest');
    expect(describeDrumCell('CB', CELL_GLYPHS.x)).toBeNull();
  });
});

describe('notation legend coverage', () => {
  it('covers every cell character exactly once, with text', () => {
    for (const pieces of [[], ['HH'], ['CR', 'S', 'K', 'HF']]) {
      const legend = drumGlyphLegend(pieces);
      expect(legend.map((g) => g.char).sort()).toEqual(Object.keys(CELL_GLYPHS).sort());
      for (const glyph of legend) {
        expect(glyph.name).toBeTruthy();
        expect(glyph.detail).toBeTruthy();
      }
    }
  });

  it('resolves the legend\'s "o" row for the pieces the chart actually uses', () => {
    // A fixed row would tell someone reading a crash-only chart to work the
    // hi-hat pedal — contradicting what tapping that same note says.
    const openRow = (pieces) => drumGlyphLegend(pieces).find((g) => g.char === 'o');
    expect(openRow(['HH']).name).toBe('Open');
    expect(openRow(['HH']).detail).toMatch(/pedal/i);
    expect(openRow(['CR', 'RD']).name).toBe('Open (let it ring)');
    expect(openRow(['CR', 'RD']).detail).not.toMatch(/pedal/i);
    expect(openRow(['S', 'K']).name).toBe('Normal hit');
    expect(openRow(['HF']).name).toBe('Open (foot splash)');
  });

  it('gives a mixed kit every applicable reading of "o", in kit order', () => {
    // One sentence can't cover a hi-hat and a crash at once, so the row carries
    // both rather than silently picking one.
    const mixed = drumGlyphLegend(['CR', 'HH', 'K']).find((g) => g.char === 'o');
    expect(mixed.name).toBe('Open');
    expect(mixed.detail).toMatch(/pedal/i);                    // the hi-hat reading
    expect(mixed.detail).toMatch(/let the cymbal sustain/i);   // the crash/ride reading
    expect(mixed.detail).toMatch(/nothing to open/i);          // the kick reading
    expect(mixed.detail.indexOf('pedal')).toBeLessThan(mixed.detail.indexOf('let the cymbal sustain'));
    // An unknown piece id can't invent a reading.
    expect(drumGlyphLegend(['CB']).find((g) => g.char === 'o').name).toBe('Open');
  });

  it('has playing instructions for every kit piece', () => {
    // The sheet's legend prints `technique` for whatever pieces a chart uses, so
    // a tenth piece added without one would render a blank row.
    for (const piece of KIT_PIECES) expect(piece.technique.length).toBeGreaterThan(10);
  });
});

describe('describeDrumPosition', () => {
  it('counts subdivisions the way a drummer says them', () => {
    expect(describeDrumPosition(6, 0, 4)).toBe('bar 6, count “1”');
    expect(describeDrumPosition(1, 5, 4)).toBe('bar 1, count “2 e”');
    expect(describeDrumPosition(1, 6, 4)).toBe('bar 1, count “2 &”');
    expect(describeDrumPosition(1, 7, 4)).toBe('bar 1, count “2 a”');
    expect(describeDrumPosition(2, 3, 2)).toBe('bar 2, count “2 &”');
    expect(describeDrumPosition(2, 4, 3)).toBe('bar 2, count “2 trip”');
  });

  it('falls back to an exact fraction where no syllable is conventional', () => {
    // Better an unfamiliar-but-correct "+2/5" than borrowing a syllable from a
    // different subdivision and misnaming the position.
    expect(describeDrumPosition(1, 2, 5)).toBe('bar 1, count “1 +2/5”');
    expect(describeDrumPosition(1, 5, 5)).toBe('bar 1, count “2”');
  });
});
// @vitest-environment node
