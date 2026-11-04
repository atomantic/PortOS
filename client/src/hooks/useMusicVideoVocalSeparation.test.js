/**
 * A finished separation replaces the board's stem together with its
 * provenance, so the Song step's "earlier version of the song" notice reads
 * the fresh stem rather than the one it replaced.
 */
import { describe, it, expect } from 'vitest';
import { separatedStemPatch } from './useMusicVideoVocalSeparation.js';

describe('separatedStemPatch', () => {
  it('carries the new stem, the master it was split from, and the conditioning source', () => {
    const board = { id: 'mv-1', vocalStemFilename: 'old.wav', vocalStemMasterFilename: 'song-take-1.wav', vocalStemDerived: true, performanceConditioningSource: 'master' };
    const separated = { id: 'mv-1', vocalStemFilename: 'new.wav', vocalStemMasterFilename: 'song-take-2.wav', vocalStemDerived: true, performanceConditioningSource: 'vocal-stem', updatedAt: 't2' };
    expect({ ...board, ...separatedStemPatch(separated) }).toEqual({
      id: 'mv-1', vocalStemFilename: 'new.wav', vocalStemMasterFilename: 'song-take-2.wav', vocalStemDerived: true,
      performanceConditioningSource: 'vocal-stem', updatedAt: 't2',
    });
  });
});
