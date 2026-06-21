import { describe, it, expect } from 'vitest';
import {
  sanitizeAlbum, buildAlbumRecord, applyAlbumPatch, mergeAlbumRecord, coverImageFilename,
  TITLE_MAX, DESCRIPTION_MAX, RELEASE_YEAR_MIN, RELEASE_YEAR_MAX, TRACK_IDS_MAX,
} from './logic.js';

describe('albums logic', () => {
  describe('sanitizeAlbum', () => {
    it('drops records without an id or title', () => {
      expect(sanitizeAlbum(null)).toBeNull();
      expect(sanitizeAlbum({})).toBeNull();
      expect(sanitizeAlbum({ id: 'album-1' })).toBeNull();
      expect(sanitizeAlbum({ id: 'album-1', title: '  ' })).toBeNull();
    });

    it('trims fields and normalizes the shape', () => {
      const a = sanitizeAlbum({
        id: 'album-1',
        title: `  ${'t'.repeat(TITLE_MAX + 50)}  `,
        artistId: '  artist-9  ',
        artist: '  Nova  ',
        description: `  ${'d'.repeat(DESCRIPTION_MAX + 10)}  `,
        genre: '  dream pop  ',
        releaseYear: 2025,
        coverImageUrl: '  /data/images/cover.png  ',
        trackIds: ['track-1', 'track-2'],
      });
      expect(a.title.length).toBe(TITLE_MAX);
      expect(a.artistId).toBe('artist-9');
      expect(a.artist).toBe('Nova');
      expect(a.description.length).toBe(DESCRIPTION_MAX);
      expect(a.genre).toBe('dream pop');
      expect(a.releaseYear).toBe(2025);
      expect(a.coverImageUrl).toBe('/data/images/cover.png');
      expect(a.trackIds).toEqual(['track-1', 'track-2']);
    });

    it('clamps a garbage release year to null', () => {
      expect(sanitizeAlbum({ id: 'album-1', title: 'X', releaseYear: 99999 }).releaseYear).toBeNull();
      expect(sanitizeAlbum({ id: 'album-1', title: 'X', releaseYear: RELEASE_YEAR_MIN - 1 }).releaseYear).toBeNull();
      expect(sanitizeAlbum({ id: 'album-1', title: 'X', releaseYear: 'soon' }).releaseYear).toBeNull();
      expect(sanitizeAlbum({ id: 'album-1', title: 'X', releaseYear: RELEASE_YEAR_MAX }).releaseYear).toBe(RELEASE_YEAR_MAX);
    });

    it('dedupes trackIds keeping first position, drops blanks, and bounds the length', () => {
      const a = sanitizeAlbum({
        id: 'album-1', title: 'X',
        trackIds: ['track-2', '', '  ', 'track-1', 'track-2', 42],
      });
      expect(a.trackIds).toEqual(['track-2', 'track-1']);
      const many = sanitizeAlbum({ id: 'album-1', title: 'X', trackIds: Array.from({ length: TRACK_IDS_MAX + 10 }, (_, i) => `track-${i}`) });
      expect(many.trackIds).toHaveLength(TRACK_IDS_MAX);
    });
  });

  describe('applyAlbumPatch', () => {
    const base = buildAlbumRecord({ title: 'Debut', genre: 'folk' }, { id: 'album-1', now: '2026-06-14T00:00:00.000Z' });

    it('overwrites present keys and preserves absent ones', () => {
      const next = applyAlbumPatch(base, { title: 'Debut (Remastered)' });
      expect(next.title).toBe('Debut (Remastered)');
      expect(next.genre).toBe('folk');
    });

    it('applies an intentional clear and reorders trackIds', () => {
      const next = applyAlbumPatch(base, { genre: '', trackIds: ['track-3', 'track-1'] });
      expect(next.genre).toBe('');
      expect(next.trackIds).toEqual(['track-3', 'track-1']);
    });
  });

  describe('mergeAlbumRecord (LWW)', () => {
    const local = buildAlbumRecord({ title: 'Local' }, { id: 'album-1', now: '2026-06-01T00:00:00.000Z' });
    it('inserts when no local counterpart', () => {
      const r = mergeAlbumRecord(null, { ...local, title: 'Remote' });
      expect(r.inserted).toBe(true);
      expect(r.next.title).toBe('Remote');
    });
    it('newer remote wins; older loses', () => {
      expect(mergeAlbumRecord(local, { ...local, title: 'New', updatedAt: '2099-01-01T00:00:00.000Z' }).remoteWins).toBe(true);
      expect(mergeAlbumRecord(local, { ...local, title: 'Old', updatedAt: '2000-01-01T00:00:00.000Z' }).remoteWins).toBe(false);
    });
  });

  describe('coverImageFilename', () => {
    it('returns the basename for a gallery path; null for external/non-image', () => {
      expect(coverImageFilename('/data/images/cover.png')).toBe('cover.png');
      expect(coverImageFilename('cover.png?v=2')).toBe('cover.png');
      expect(coverImageFilename('https://example.com/x.png')).toBeNull();
      expect(coverImageFilename('/data/videos/x.mp4')).toBeNull();
      expect(coverImageFilename('')).toBeNull();
    });
  });
});
