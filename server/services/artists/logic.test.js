import { describe, it, expect } from 'vitest';
import {
  sanitizeArtist, buildArtistRecord, applyArtistPatch,
  mergeArtistRecord, portraitImageFilename,
  NAME_MAX, MUSICAL_STYLE_MAX,
} from './logic.js';

describe('artists logic', () => {
  describe('sanitizeArtist', () => {
    it('drops records without an id or name', () => {
      expect(sanitizeArtist(null)).toBeNull();
      expect(sanitizeArtist({})).toBeNull();
      expect(sanitizeArtist({ id: 'artist-1' })).toBeNull();
      expect(sanitizeArtist({ id: 'artist-1', name: '   ' })).toBeNull();
    });

    it('trims fields to their caps and normalizes the shape', () => {
      const a = sanitizeArtist({
        id: 'artist-1',
        name: `  ${'n'.repeat(NAME_MAX + 50)}  `,
        musicalStyle: `  ${'w'.repeat(MUSICAL_STYLE_MAX + 10)}  `,
        genre: '  indie folk  ',
        bio: '  blurb  ',
        physicalDescription: '  desc  ',
        portraitStyle: '  studio  ',
        portraitImageUrl: '  /img.png  ',
      });
      expect(a.id).toBe('artist-1');
      expect(a.name.length).toBe(NAME_MAX);
      expect(a.musicalStyle.length).toBe(MUSICAL_STYLE_MAX);
      expect(a.genre).toBe('indie folk');
      expect(a.bio).toBe('blurb');
      expect(a.physicalDescription).toBe('desc');
      expect(a.portraitStyle).toBe('studio');
      expect(a.portraitImageUrl).toBe('/img.png');
      expect(a.deleted).toBe(false);
      expect(a.deletedAt).toBeNull();
    });

    it('clears deletedAt when not deleted', () => {
      const a = sanitizeArtist({ id: 'artist-1', name: 'X', deleted: false, deletedAt: '2020-01-01' });
      expect(a.deletedAt).toBeNull();
    });
  });

  describe('buildArtistRecord', () => {
    it('builds a fresh record with timestamps', () => {
      const now = '2026-06-14T00:00:00.000Z';
      const a = buildArtistRecord({ name: 'Nova' }, { id: 'artist-9', now });
      expect(a.id).toBe('artist-9');
      expect(a.name).toBe('Nova');
      expect(a.createdAt).toBe(now);
      expect(a.updatedAt).toBe(now);
      expect(a.musicalStyle).toBe('');
    });
  });

  describe('applyArtistPatch', () => {
    const base = buildArtistRecord({ name: 'Nova', bio: 'old bio' }, { id: 'artist-1', now: '2026-06-14T00:00:00.000Z' });

    it('overwrites present keys and preserves absent ones', () => {
      const next = applyArtistPatch(base, { name: 'Nova Star' });
      expect(next.name).toBe('Nova Star');
      expect(next.bio).toBe('old bio');
    });

    it('applies an intentional clear (present empty string)', () => {
      const next = applyArtistPatch(base, { bio: '' });
      expect(next.bio).toBe('');
    });

    it('bumps updatedAt', () => {
      const next = applyArtistPatch(base, { name: 'Nova Star' });
      expect(next.updatedAt >= base.updatedAt).toBe(true);
    });
  });

  describe('mergeArtistRecord (federation-ready LWW)', () => {
    const local = buildArtistRecord({ name: 'Local' }, { id: 'artist-1', now: '2026-06-01T00:00:00.000Z' });

    it('inserts when there is no local counterpart', () => {
      const remote = { ...local, name: 'Remote' };
      const r = mergeArtistRecord(null, remote);
      expect(r.inserted).toBe(true);
      expect(r.changed).toBe(true);
      expect(r.next.name).toBe('Remote');
    });

    it('drops a malformed remote (returns null next)', () => {
      const r = mergeArtistRecord(local, { id: 'artist-1', name: '' });
      expect(r.next).toBeNull();
      expect(r.changed).toBe(false);
    });

    it('newer remote updatedAt wins', () => {
      const remote = { ...local, name: 'Fresh', updatedAt: '2099-01-01T00:00:00.000Z' };
      const r = mergeArtistRecord(local, remote);
      expect(r.remoteWins).toBe(true);
      expect(r.next.name).toBe('Fresh');
    });

    it('older remote loses (local wins, no change)', () => {
      const remote = { ...local, name: 'Stale', updatedAt: '2000-01-01T00:00:00.000Z' };
      const r = mergeArtistRecord(local, remote);
      expect(r.remoteWins).toBe(false);
      expect(r.changed).toBe(false);
      expect(r.next.name).toBe('Local');
    });

    it('unparseable remote updatedAt never overrides a valid local', () => {
      const remote = { ...local, name: 'Garbage', updatedAt: 'not-a-date' };
      const r = mergeArtistRecord(local, remote);
      expect(r.remoteWins).toBe(false);
      expect(r.next.name).toBe('Local');
    });

    it('a newer remote tombstone overwrites a live local record', () => {
      const remote = { ...local, deleted: true, deletedAt: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z' };
      const r = mergeArtistRecord(local, remote);
      expect(r.remoteWins).toBe(true);
      expect(r.next.deleted).toBe(true);
    });
  });

  describe('portraitImageFilename', () => {
    it('returns the basename for a gallery mount path', () => {
      expect(portraitImageFilename('/data/images/abc123.png')).toBe('abc123.png');
    });
    it('returns a bare filename unchanged', () => {
      expect(portraitImageFilename('abc123.png')).toBe('abc123.png');
    });
    it('strips a querystring/hash', () => {
      expect(portraitImageFilename('/data/images/abc.png?v=2')).toBe('abc.png');
    });
    it('returns null for external URLs (receiver fetches those itself)', () => {
      expect(portraitImageFilename('https://example.com/x.png')).toBeNull();
      expect(portraitImageFilename('data:image/png;base64,AAAA')).toBeNull();
    });
    it('returns null for a non-image absolute path', () => {
      expect(portraitImageFilename('/data/videos/x.mp4')).toBeNull();
    });
    it('returns null for empty / non-string input', () => {
      expect(portraitImageFilename('')).toBeNull();
      expect(portraitImageFilename(null)).toBeNull();
      expect(portraitImageFilename(undefined)).toBeNull();
    });
  });
});
