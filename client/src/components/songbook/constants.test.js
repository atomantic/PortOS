import { describe, it, expect } from 'vitest';
import {
  INSTRUMENTS, SONG_FORMATS, DRUM_FORMAT, DRUM_INSTRUMENT,
  instrumentLabel, withStoredOption,
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
