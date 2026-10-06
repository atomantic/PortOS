import { describe, it, expect } from 'vitest';
import { DISTROKID_GENRES, suggestDistrokidGenres } from './distrokidGenres.js';

const song = (sunoStyle, musicalDescription) => ({ autonomousRun: { output: { sunoStyle, musicalDescription } } });

describe('suggestDistrokidGenres', () => {
  it('orders genres by where the style names them, and only suggests store genres', () => {
    expect(suggestDistrokidGenres(song('indie rock, shoegaze guitars, dreamy'))).toEqual({ primary: 'Alternative', secondary: 'Rock' });
    expect(suggestDistrokidGenres(song('trap beat', 'A hip hop track with soul samples'))).toEqual({ primary: 'Hip Hop/Rap', secondary: 'R&B/Soul' });
    const { primary, secondary } = suggestDistrokidGenres(song('cinematic orchestral score'));
    expect([primary, secondary].every((g) => DISTROKID_GENRES.includes(g))).toBe(true);
  });

  it('does not read k-pop as pop, and suggests nothing for a song with no style words', () => {
    expect(suggestDistrokidGenres(song('k-pop anthem'))).toEqual({ primary: 'K-Pop', secondary: null });
    // ...but a word that merely ends in k still says pop.
    expect(suggestDistrokidGenres(song('dark pop, female vocal'))).toEqual({ primary: 'Pop', secondary: null });
    expect(suggestDistrokidGenres(song('punk pop anthem'))).toEqual({ primary: 'Punk', secondary: 'Pop' });
    expect(suggestDistrokidGenres({})).toEqual({ primary: null, secondary: null });
    expect(suggestDistrokidGenres(song('slow, sad, whispered'))).toEqual({ primary: null, secondary: null });
  });
});
