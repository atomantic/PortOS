import { describe, it, expect } from 'vitest';
import {
  INSTRUMENTS, SONG_FORMATS, DRUM_FORMAT, DRUM_INSTRUMENT, SONG_STAGES,
  SONG_PRACTICE_RATINGS, instrumentLabel, withStoredOption,
  isSongDue, songNextReviewAt, songPracticeSessions,
} from './constants.js';

describe('SongBook constants', () => {
  it('mirrors the server songInstrumentEnum (server/lib/brainValidation.js)', () => {
    expect(INSTRUMENTS.map((i) => i.id)).toEqual([
      'guitar', 'piano', 'ukulele', 'bass', 'voice', 'drums', 'other',
    ]);
  });

  it('mirrors the server songContentFormatEnum', () => {
    expect(SONG_FORMATS).toEqual(['chordpro', 'tab', 'plain', 'drum']);
  });

  it('names the drum format/instrument ids so callers don\'t hardcode strings', () => {
    expect(DRUM_FORMAT).toBe('drum');
    expect(DRUM_INSTRUMENT).toBe('drums');
    expect(SONG_FORMATS).toContain(DRUM_FORMAT);
    expect(INSTRUMENTS.map((i) => i.id)).toContain(DRUM_INSTRUMENT);
  });

  it('labels drums and falls through to the raw id for an unknown instrument', () => {
    expect(instrumentLabel('drums')).toBe('Drums');
    expect(instrumentLabel('hurdy-gurdy')).toBe('hurdy-gurdy');
  });
});

describe('practice grades (#4102)', () => {
  it('mirrors the server songStageEnum ladder order (server/lib/songPractice.js)', () => {
    expect(SONG_STAGES.map((s) => s.id)).toEqual(['new', 'learning', 'learned', 'memorized']);
  });

  it('offers grades inside the server-accepted 0..5 range, ascending', () => {
    const grades = SONG_PRACTICE_RATINGS.map((r) => r.quality);
    expect(grades).toEqual([...grades].sort((a, b) => a - b));
    for (const quality of grades) {
      expect(Number.isInteger(quality)).toBe(true);
      expect(quality).toBeGreaterThanOrEqual(0);
      expect(quality).toBeLessThanOrEqual(5);
    }
  });

  it('covers every outcome the server ladder can produce', () => {
    const grades = SONG_PRACTICE_RATINGS.map((r) => r.quality);
    // SONG_REGRESS_MAX_QUALITY = 2, SONG_PROMOTE_MIN_QUALITY = 4 — a grade set
    // that can't reach one of the three outcomes leaves it unreachable in the UI.
    expect(grades.some((q) => q <= 2)).toBe(true);
    expect(grades.some((q) => q === 3)).toBe(true);
    expect(grades.some((q) => q >= 4)).toBe(true);
    expect(SONG_PRACTICE_RATINGS.every((r) => r.label && r.hint)).toBe(true);
  });
});

describe('songNextReviewAt / isSongDue / songPracticeSessions', () => {
  const NOW = Date.parse('2026-03-10T12:00:00.000Z');

  it('reads the stored schedule when there is one', () => {
    const song = { practice: { nextReview: '2026-03-20T00:00:00.000Z' }, updatedAt: '2026-01-01T00:00:00.000Z' };
    expect(songNextReviewAt(song)).toBe('2026-03-20T00:00:00.000Z');
    expect(isSongDue(song, NOW)).toBe(false);
  });

  it('anchors a song predating the feature to its own timestamps → due now', () => {
    // Mirrors songPracticeOrDefault server-side: NOT "due at this instant", so
    // two renders a millisecond apart agree.
    expect(songNextReviewAt({ updatedAt: '2026-02-01T00:00:00.000Z' })).toBe('2026-02-01T00:00:00.000Z');
    expect(songNextReviewAt({ createdAt: '2026-01-01T00:00:00.000Z' })).toBe('2026-01-01T00:00:00.000Z');
    expect(isSongDue({ updatedAt: '2026-02-01T00:00:00.000Z' }, NOW)).toBe(true);
  });

  it('surfaces a song it cannot schedule rather than hiding it forever', () => {
    expect(songNextReviewAt({})).toBe(null);
    expect(isSongDue({}, NOW)).toBe(true);
    expect(isSongDue({ practice: { nextReview: 'whenever' } }, NOW)).toBe(true);
  });

  it('distinguishes "never practiced" from a real zero without producing NaN', () => {
    expect(songPracticeSessions({})).toBe(0);
    expect(songPracticeSessions({ practice: { sessions: 4 } })).toBe(4);
    expect(songPracticeSessions({ practice: { sessions: 'many' } })).toBe(0);
  });
});

describe('withStoredOption', () => {
  it('returns the known list unchanged for a known value', () => {
    expect(withStoredOption(INSTRUMENTS, 'drums')).toEqual(INSTRUMENTS);
    expect(withStoredOption(SONG_FORMATS, 'drum').map((o) => o.id)).toEqual(SONG_FORMATS);
  });

  it('normalizes a string list into { id, label } pairs', () => {
    expect(withStoredOption(SONG_FORMATS, 'tab')).toEqual(
      SONG_FORMATS.map((f) => ({ id: f, label: f })),
    );
  });

  it('appends an UNKNOWN stored value so a save round-trips it (no silent coercion)', () => {
    // The failure this guards: a song synced from a newer peer carries a value
    // this client's enum doesn't list; dropping it from the <select> would make
    // the select resolve to its first option and rewrite the record on save.
    const instruments = withStoredOption(INSTRUMENTS, 'hurdy-gurdy');
    expect(instruments).toHaveLength(INSTRUMENTS.length + 1);
    expect(instruments.at(-1)).toEqual({ id: 'hurdy-gurdy', label: 'hurdy-gurdy' });

    const formats = withStoredOption(SONG_FORMATS, 'futureformat');
    expect(formats.at(-1)).toEqual({ id: 'futureformat', label: 'futureformat' });
  });

  it('appends nothing for an absent / empty stored value', () => {
    for (const stored of [undefined, null, '']) {
      expect(withStoredOption(INSTRUMENTS, stored)).toHaveLength(INSTRUMENTS.length);
    }
  });
});
