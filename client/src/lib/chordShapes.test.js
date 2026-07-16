// Node-env-safe (no browser APIs) — this suite also runs in the server CI job.
import { describe, it, expect } from 'vitest';
import {
  parseChordName,
  getChordVoicing,
  splitJoinedChords,
  toVoicingInstrument,
  VOICING_INSTRUMENTS,
} from './chordShapes.js';
import { transposeChordName, NOTE_TO_PC } from './tabNotation.js';

const QUALITIES = [
  'major', 'minor', '7', 'm7', 'maj7', 'm7b5', 'dim', 'dim7', 'aug',
  'sus2', 'sus4', 'add9', '6', 'm6', '9',
];
const QUALITY_SUFFIX = {
  major: '', minor: 'm', 7: '7', m7: 'm7', maj7: 'maj7', m7b5: 'm7b5',
  dim: 'dim', dim7: 'dim7', aug: 'aug', sus2: 'sus2', sus4: 'sus4',
  add9: 'add9', 6: '6', m6: 'm6', 9: '9',
};
const ROOTS = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B'];

describe('parseChordName', () => {
  it('parses root, quality, and slash bass', () => {
    expect(parseChordName('Am7')).toEqual({ root: 'A', rootPc: 9, quality: 'm7', bass: null, bassPc: null });
    expect(parseChordName('F#m7b5')).toMatchObject({ root: 'F#', rootPc: 6, quality: 'm7b5' });
    expect(parseChordName('Bb/D')).toMatchObject({ root: 'Bb', rootPc: 10, quality: 'major', bass: 'D', bassPc: 2 });
    expect(parseChordName('C/G')).toMatchObject({ quality: 'major', bass: 'G' });
  });

  it('normalizes quality aliases', () => {
    expect(parseChordName('Cmaj').quality).toBe('major');
    expect(parseChordName('CM7').quality).toBe('maj7');
    expect(parseChordName('Cmin7').quality).toBe('m7');
    expect(parseChordName('C+').quality).toBe('aug');
    expect(parseChordName('C°').quality).toBe('dim');
    expect(parseChordName('Co7').quality).toBe('dim7');
    expect(parseChordName('Csus').quality).toBe('sus4');
    expect(parseChordName('Cm7(b5)').quality).toBe('m7b5');
  });

  it('rejects non-chords, N.C., and qualities outside the curated set', () => {
    expect(parseChordName('N.C.')).toBeNull();
    expect(parseChordName('NC')).toBeNull();
    expect(parseChordName('Hm')).toBeNull();
    expect(parseChordName('lyric')).toBeNull();
    expect(parseChordName('C13')).toBeNull(); // valid token, uncurated quality
    expect(parseChordName('C6/9')).toBeNull();
    expect(parseChordName('')).toBeNull();
    expect(parseChordName(null)).toBeNull();
    expect(parseChordName(undefined)).toBeNull();
  });
});

describe('splitJoinedChords', () => {
  it('splits dash-joined chord runs when every segment is a chord', () => {
    expect(splitJoinedChords('Am-Am7')).toEqual(['Am', 'Am7']);
    expect(splitJoinedChords('C-G/B-Am')).toEqual(['C', 'G/B', 'Am']);
  });

  it('leaves hyphenated words and partial runs whole (tabNotation dash rules)', () => {
    expect(splitJoinedChords('well-known')).toEqual(['well-known']);
    expect(splitJoinedChords('Am-')).toEqual(['Am-']);
    expect(splitJoinedChords('-Am')).toEqual(['-Am']);
    expect(splitJoinedChords('C')).toEqual(['C']);
    expect(splitJoinedChords(null)).toEqual(['']);
  });
});

describe('toVoicingInstrument', () => {
  it('passes through the three diagram instruments and maps the rest to guitar', () => {
    expect(toVoicingInstrument('guitar')).toBe('guitar');
    expect(toVoicingInstrument('ukulele')).toBe('ukulele');
    expect(toVoicingInstrument('piano')).toBe('piano');
    expect(toVoicingInstrument('bass')).toBe('guitar');
    expect(toVoicingInstrument('voice')).toBe('guitar');
    expect(toVoicingInstrument('other')).toBe('guitar');
    expect(toVoicingInstrument(undefined)).toBe('guitar');
  });
});

describe('getChordVoicing — guitar', () => {
  it('returns the classic open shapes', () => {
    expect(getChordVoicing('Am', 'guitar')).toMatchObject({ frets: [-1, 0, 2, 2, 1, 0], baseFret: 1 });
    expect(getChordVoicing('C', 'guitar')).toMatchObject({ frets: [-1, 3, 2, 0, 1, 0], baseFret: 1 });
    expect(getChordVoicing('E', 'guitar')).toMatchObject({ frets: [0, 2, 2, 1, 0, 0], baseFret: 1 });
    expect(getChordVoicing('G', 'guitar')).toMatchObject({ frets: [3, 2, 0, 0, 0, 3], baseFret: 1 });
    expect(getChordVoicing('D', 'guitar')).toMatchObject({ frets: [-1, -1, 0, 2, 3, 2], baseFret: 1 });
    expect(getChordVoicing('A7', 'guitar')).toMatchObject({ frets: [-1, 0, 2, 0, 2, 0], baseFret: 1 });
    expect(getChordVoicing('Em7', 'guitar')).toMatchObject({ frets: [0, 2, 0, 0, 0, 0], baseFret: 1 });
    expect(getChordVoicing('B7', 'guitar')).toMatchObject({ frets: [-1, 2, 1, 2, 0, 2], baseFret: 1 });
    expect(getChordVoicing('Dsus4', 'guitar')).toMatchObject({ frets: [-1, -1, 0, 2, 3, 3], baseFret: 1 });
    expect(getChordVoicing('Cadd9', 'guitar')).toMatchObject({ frets: [-1, 3, 2, 0, 3, 0], baseFret: 1 });
  });

  it('derives barre shapes with a baseFret window', () => {
    // F = E-form barre at fret 1 (window stays absolute).
    expect(getChordVoicing('F', 'guitar')).toMatchObject({ frets: [1, 3, 3, 2, 1, 1], baseFret: 1 });
    // Bm = A-form barre at fret 2.
    expect(getChordVoicing('Bm', 'guitar')).toMatchObject({ frets: [-1, 2, 4, 4, 3, 2], baseFret: 1 });
    // C#m7 = A-form barre at fret 4 → re-based window.
    expect(getChordVoicing('C#m7', 'guitar')).toMatchObject({ frets: [-1, 1, 3, 1, 2, 1], baseFret: 4 });
    // Enharmonic spellings share the pitch class → same shape.
    expect(getChordVoicing('Dbm7', 'guitar')).toEqual(getChordVoicing('C#m7', 'guitar'));
  });

  it('keeps symmetric chords (aug, dim7) near the nut', () => {
    // aug repeats every 4 frets, dim7 every 3 — the root fret drops toward
    // the nut instead of stranding D aug at fret 10.
    const daug = getChordVoicing('Daug', 'guitar');
    expect(Math.max(...daug.frets.filter((f) => f > 0)) + (daug.baseFret - 1)).toBeLessThanOrEqual(5);
    const gdim7 = getChordVoicing('Gdim7', 'guitar');
    expect(Math.max(...gdim7.frets.filter((f) => f > 0)) + (gdim7.baseFret - 1)).toBeLessThanOrEqual(6);
  });

  it('voices the base chord of a slash chord and reports the bass separately', () => {
    const v = getChordVoicing('G/B', 'guitar');
    expect(v.frets).toEqual([3, 2, 0, 0, 0, 3]);
    expect(v.bass).toBe('B');
  });
});

describe('getChordVoicing — ukulele', () => {
  it('finds the canonical first-position GCEA shapes', () => {
    expect(getChordVoicing('C', 'ukulele')).toMatchObject({ frets: [0, 0, 0, 3], baseFret: 1 });
    expect(getChordVoicing('Am', 'ukulele')).toMatchObject({ frets: [2, 0, 0, 0], baseFret: 1 });
    expect(getChordVoicing('F', 'ukulele')).toMatchObject({ frets: [2, 0, 1, 0], baseFret: 1 });
    expect(getChordVoicing('G', 'ukulele')).toMatchObject({ frets: [0, 2, 3, 2], baseFret: 1 });
    expect(getChordVoicing('G7', 'ukulele')).toMatchObject({ frets: [0, 2, 1, 2], baseFret: 1 });
    expect(getChordVoicing('C7', 'ukulele')).toMatchObject({ frets: [0, 0, 0, 1], baseFret: 1 });
    // Em: the search prefers the lower-sum 0402 alternate over the 0432 grip
    // — same pitch classes, both standard fingerings.
    expect(getChordVoicing('Em', 'ukulele')).toMatchObject({ frets: [0, 4, 0, 2], baseFret: 1 });
  });

  it('only sounds chord tones and covers the required ones', () => {
    const UKE_OPEN = [7, 0, 4, 9];
    for (const name of ['Bb', 'F#m', 'Ebmaj7', 'C#9', 'Gdim7', 'Aadd9']) {
      const v = getChordVoicing(name, 'ukulele');
      expect(v, name).not.toBeNull();
      const abs = v.frets.map((f) => (f > 0 ? f + v.baseFret - 1 : f));
      const sounded = abs.map((f, i) => (UKE_OPEN[i] + Math.max(f, 0)) % 12);
      // Chord-tone pitch classes via the piano voicing (same interval source).
      const { notes } = getChordVoicing(name, 'piano');
      const tonePcs = new Set(notes.map((n) => NOTE_TO_PC[n]));
      for (const pc of sounded) expect(tonePcs.has(pc), `${name}: pc ${pc}`).toBe(true);
      // All tones covered — except the droppable perfect 5th on >4-tone chords.
      const { rootPc } = parseChordName(name);
      const required = [...tonePcs].filter((pc) => tonePcs.size <= 4 || pc !== (rootPc + 7) % 12);
      for (const pc of required) expect(sounded.includes(pc), `${name}: missing pc ${pc}`).toBe(true);
    }
  });
});

describe('getChordVoicing — piano', () => {
  const notes = (name) => getChordVoicing(name, 'piano').notes;

  it('spells common chords in root position', () => {
    expect(notes('C')).toEqual(['C', 'E', 'G']);
    expect(notes('Am')).toEqual(['A', 'C', 'E']);
    expect(notes('Am7')).toEqual(['A', 'C', 'E', 'G']);
    expect(notes('G7')).toEqual(['G', 'B', 'D', 'F']);
    expect(notes('Cmaj7')).toEqual(['C', 'E', 'G', 'B']);
    expect(notes('Csus2')).toEqual(['C', 'D', 'G']);
    expect(notes('Gsus4')).toEqual(['G', 'C', 'D']);
    expect(notes('Cadd9')).toEqual(['C', 'E', 'G', 'D']);
    expect(notes('C6')).toEqual(['C', 'E', 'G', 'A']);
    expect(notes('D9')).toEqual(['D', 'F#', 'A', 'C', 'E']);
  });

  it('spells sharps and flats letter-accurately from the root', () => {
    expect(notes('E')).toEqual(['E', 'G#', 'B']); // never Ab
    expect(notes('Eb')).toEqual(['Eb', 'G', 'Bb']);
    expect(notes('F#m7b5')).toEqual(['F#', 'A', 'C', 'E']);
    expect(notes('Abm')).toEqual(['Ab', 'Cb', 'Eb']); // minor 3rd of Ab is Cb
    expect(notes('D#m')).toEqual(['D#', 'F#', 'A#']);
    expect(notes('Bb6')).toEqual(['Bb', 'D', 'F', 'G']);
    expect(notes('Caug')).toEqual(['C', 'E', 'G#']);
    expect(notes('Cdim')).toEqual(['C', 'Eb', 'Gb']);
  });

  it('simplifies would-be double accidentals to enharmonic names', () => {
    // Ebdim's diminished 5th is Bbb — rendered as the simple enharmonic A.
    expect(notes('Ebdim')).toEqual(['Eb', 'Gb', 'A']);
  });

  it('carries the slash bass for prepending', () => {
    expect(getChordVoicing('Am/G', 'piano')).toMatchObject({ notes: ['A', 'C', 'E'], bass: 'G' });
    expect(getChordVoicing('C', 'piano').bass).toBeNull();
  });
});

describe('getChordVoicing — coverage and degradation', () => {
  it('voices every curated quality for every root on all three instruments', () => {
    for (const root of ROOTS) {
      for (const quality of QUALITIES) {
        const name = root + QUALITY_SUFFIX[quality];
        for (const instrument of VOICING_INSTRUMENTS) {
          const v = getChordVoicing(name, instrument);
          expect(v, `${name} on ${instrument}`).not.toBeNull();
          if (instrument === 'piano') {
            expect(v.notes.length).toBeGreaterThanOrEqual(3);
          } else {
            expect(v.frets).toHaveLength(instrument === 'guitar' ? 6 : 4);
            expect(v.baseFret).toBeGreaterThanOrEqual(1);
            expect(v.frets.some((f) => f >= 0)).toBe(true);
          }
        }
      }
    }
  });

  it('degrades to null for unknown chords and instruments — never throws', () => {
    expect(getChordVoicing('xyz', 'guitar')).toBeNull();
    expect(getChordVoicing('N.C.', 'ukulele')).toBeNull();
    expect(getChordVoicing('Cmaj9', 'piano')).toBeNull();
    expect(getChordVoicing('C', 'banjo')).toBeNull();
    expect(getChordVoicing(null, 'guitar')).toBeNull();
    expect(getChordVoicing(undefined, 'piano')).toBeNull();
    expect(getChordVoicing('A'.repeat(40), 'guitar')).toBeNull();
  });

  it('follows transposed chord names (transpose → voicing round-trip)', () => {
    const transposed = transposeChordName('Am7', 2); // Bm7
    expect(transposed).toBe('Bm7');
    expect(getChordVoicing(transposed, 'guitar')).toMatchObject({ frets: [-1, 2, 4, 2, 3, 2], baseFret: 1 });
    expect(getChordVoicing(transposeChordName('C/G', 7), 'piano')).toMatchObject({ notes: ['G', 'B', 'D'], bass: 'D' });
  });
});
