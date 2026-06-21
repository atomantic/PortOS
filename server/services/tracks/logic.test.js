import { describe, it, expect } from 'vitest';
import {
  sanitizeTrack, buildTrackRecord, applyTrackPatch, mergeTrackRecord, trackAudioFilename,
  TITLE_MAX, LYRICS_MAX, DURATION_MIN_SEC, DURATION_MAX_SEC,
} from './logic.js';

describe('tracks logic', () => {
  describe('sanitizeTrack', () => {
    it('drops records without an id or title', () => {
      expect(sanitizeTrack(null)).toBeNull();
      expect(sanitizeTrack({})).toBeNull();
      expect(sanitizeTrack({ id: 'track-1' })).toBeNull();
      expect(sanitizeTrack({ id: 'track-1', title: '  ' })).toBeNull();
    });

    it('trims fields and normalizes the shape', () => {
      const t = sanitizeTrack({
        id: 'track-1',
        title: `  ${'t'.repeat(TITLE_MAX + 50)}  `,
        albumId: '  album-9  ',
        artistId: '  artist-9  ',
        artist: '  Nova  ',
        lyrics: `  ${'l'.repeat(LYRICS_MAX + 10)}  `,
        prompt: '  warm folk  ',
        engine: '  acestep  ',
        modelId: '  ace-v1  ',
        durationSec: 180,
        audioFilename: '  music-abc.mp3  ',
      });
      expect(t.title.length).toBe(TITLE_MAX);
      expect(t.albumId).toBe('album-9');
      expect(t.artistId).toBe('artist-9');
      expect(t.artist).toBe('Nova');
      expect(t.lyrics.length).toBe(LYRICS_MAX);
      expect(t.engine).toBe('acestep');
      expect(t.modelId).toBe('ace-v1');
      expect(t.durationSec).toBe(180);
      expect(t.audioFilename).toBe('music-abc.mp3');
    });

    it('clamps a garbage duration to null', () => {
      expect(sanitizeTrack({ id: 'track-1', title: 'X', durationSec: 0 }).durationSec).toBeNull();
      expect(sanitizeTrack({ id: 'track-1', title: 'X', durationSec: DURATION_MAX_SEC + 1 }).durationSec).toBeNull();
      expect(sanitizeTrack({ id: 'track-1', title: 'X', durationSec: 'long' }).durationSec).toBeNull();
      expect(sanitizeTrack({ id: 'track-1', title: 'X', durationSec: DURATION_MIN_SEC }).durationSec).toBe(DURATION_MIN_SEC);
    });
  });

  describe('applyTrackPatch', () => {
    const base = buildTrackRecord({ title: 'Intro', lyrics: 'la la' }, { id: 'track-1', now: '2026-06-14T00:00:00.000Z' });
    it('overwrites present keys, preserves absent, applies clear', () => {
      const next = applyTrackPatch(base, { title: 'Intro (Reprise)', lyrics: '' });
      expect(next.title).toBe('Intro (Reprise)');
      expect(next.lyrics).toBe('');
    });
  });

  describe('mergeTrackRecord (LWW)', () => {
    const local = buildTrackRecord({ title: 'Local' }, { id: 'track-1', now: '2026-06-01T00:00:00.000Z' });
    it('inserts / newer-wins / older-loses', () => {
      expect(mergeTrackRecord(null, { ...local, title: 'R' }).inserted).toBe(true);
      expect(mergeTrackRecord(local, { ...local, title: 'New', updatedAt: '2099-01-01T00:00:00.000Z' }).remoteWins).toBe(true);
      expect(mergeTrackRecord(local, { ...local, title: 'Old', updatedAt: '2000-01-01T00:00:00.000Z' }).remoteWins).toBe(false);
    });
  });

  describe('trackAudioFilename', () => {
    it('returns a bare filename, null for blank or path-ish input', () => {
      expect(trackAudioFilename('music-abc.mp3')).toBe('music-abc.mp3');
      expect(trackAudioFilename('')).toBeNull();
      expect(trackAudioFilename('../escape.mp3')).toBeNull();
      expect(trackAudioFilename('sub/dir.mp3')).toBeNull();
    });
  });
});
