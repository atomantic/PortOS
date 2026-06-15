import { describe, it, expect } from 'vitest';
import {
  sanitizeAuthor, buildAuthorRecord, applyAuthorPatch,
  mergeAuthorRecord, headshotImageFilename,
  NAME_MAX, WRITING_STYLE_MAX,
} from './logic.js';

describe('authors logic', () => {
  describe('sanitizeAuthor', () => {
    it('drops records without an id or name', () => {
      expect(sanitizeAuthor(null)).toBeNull();
      expect(sanitizeAuthor({})).toBeNull();
      expect(sanitizeAuthor({ id: 'auth-1' })).toBeNull();
      expect(sanitizeAuthor({ id: 'auth-1', name: '   ' })).toBeNull();
    });

    it('trims fields to their caps and normalizes the shape', () => {
      const a = sanitizeAuthor({
        id: 'auth-1',
        name: `  ${'n'.repeat(NAME_MAX + 50)}  `,
        writingStyle: `  ${'w'.repeat(WRITING_STYLE_MAX + 10)}  `,
        bio: '  blurb  ',
        physicalDescription: '  desc  ',
        headshotStyle: '  studio  ',
        headshotImageUrl: '  /img.png  ',
      });
      expect(a.id).toBe('auth-1');
      expect(a.name.length).toBe(NAME_MAX);
      expect(a.writingStyle.length).toBe(WRITING_STYLE_MAX);
      expect(a.bio).toBe('blurb');
      expect(a.physicalDescription).toBe('desc');
      expect(a.headshotStyle).toBe('studio');
      expect(a.headshotImageUrl).toBe('/img.png');
      expect(a.deleted).toBe(false);
      expect(a.deletedAt).toBeNull();
    });

    it('clears deletedAt when not deleted', () => {
      const a = sanitizeAuthor({ id: 'auth-1', name: 'X', deleted: false, deletedAt: '2020-01-01' });
      expect(a.deletedAt).toBeNull();
    });
  });

  describe('buildAuthorRecord', () => {
    it('builds a fresh record with timestamps', () => {
      const now = '2026-06-14T00:00:00.000Z';
      const a = buildAuthorRecord({ name: 'Jane' }, { id: 'auth-9', now });
      expect(a.id).toBe('auth-9');
      expect(a.name).toBe('Jane');
      expect(a.createdAt).toBe(now);
      expect(a.updatedAt).toBe(now);
      expect(a.writingStyle).toBe('');
    });
  });

  describe('applyAuthorPatch', () => {
    const base = buildAuthorRecord({ name: 'Jane', bio: 'old bio' }, { id: 'auth-1', now: '2026-06-14T00:00:00.000Z' });

    it('overwrites present keys and preserves absent ones', () => {
      const next = applyAuthorPatch(base, { name: 'Janet' });
      expect(next.name).toBe('Janet');
      expect(next.bio).toBe('old bio');
    });

    it('applies an intentional clear (present empty string)', () => {
      const next = applyAuthorPatch(base, { bio: '' });
      expect(next.bio).toBe('');
    });

    it('bumps updatedAt', () => {
      const next = applyAuthorPatch(base, { name: 'Janet' });
      expect(next.updatedAt >= base.updatedAt).toBe(true);
    });
  });

  describe('mergeAuthorRecord (federated LWW)', () => {
    const local = buildAuthorRecord({ name: 'Local' }, { id: 'auth-1', now: '2026-06-01T00:00:00.000Z' });

    it('inserts when there is no local counterpart', () => {
      const remote = { ...local, name: 'Remote' };
      const r = mergeAuthorRecord(null, remote);
      expect(r.inserted).toBe(true);
      expect(r.changed).toBe(true);
      expect(r.next.name).toBe('Remote');
    });

    it('drops a malformed remote (returns null next)', () => {
      const r = mergeAuthorRecord(local, { id: 'auth-1', name: '' });
      expect(r.next).toBeNull();
      expect(r.changed).toBe(false);
    });

    it('newer remote updatedAt wins', () => {
      const remote = { ...local, name: 'Fresh', updatedAt: '2099-01-01T00:00:00.000Z' };
      const r = mergeAuthorRecord(local, remote);
      expect(r.remoteWins).toBe(true);
      expect(r.changed).toBe(true);
      expect(r.next.name).toBe('Fresh');
    });

    it('older remote loses (local wins, no change)', () => {
      const remote = { ...local, name: 'Stale', updatedAt: '2000-01-01T00:00:00.000Z' };
      const r = mergeAuthorRecord(local, remote);
      expect(r.remoteWins).toBe(false);
      expect(r.changed).toBe(false);
      expect(r.next.name).toBe('Local');
    });

    it('equal updatedAt breaks to local (tie → no overwrite)', () => {
      const remote = { ...local, name: 'Tie' };
      const r = mergeAuthorRecord(local, remote);
      expect(r.remoteWins).toBe(false);
    });

    it('unparseable remote updatedAt never overrides a valid local', () => {
      // sanitizeAuthor KEEPS any string updatedAt verbatim (updatedAt =
      // isStr(raw.updatedAt) ? raw.updatedAt : createdAt), so 'not-a-date'
      // survives sanitization and compareNewerWins('not-a-date', <valid>)
      // returns false — a peer pushing a garbage timestamp can't clobber a
      // valid local record. This is the security-relevant contract.
      const remote = { ...local, name: 'Garbage', updatedAt: 'not-a-date' };
      const r = mergeAuthorRecord(local, remote);
      expect(r.remoteWins).toBe(false);
      expect(r.next.name).toBe('Local');
    });

    it('a newer remote tombstone overwrites a live local record', () => {
      const remote = { ...local, deleted: true, deletedAt: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z' };
      const r = mergeAuthorRecord(local, remote);
      expect(r.remoteWins).toBe(true);
      expect(r.next.deleted).toBe(true);
    });
  });

  describe('headshotImageFilename', () => {
    it('returns the basename for a gallery mount path', () => {
      expect(headshotImageFilename('/data/images/abc123.png')).toBe('abc123.png');
    });
    it('returns a bare filename unchanged', () => {
      expect(headshotImageFilename('abc123.png')).toBe('abc123.png');
    });
    it('strips a querystring/hash', () => {
      expect(headshotImageFilename('/data/images/abc.png?v=2')).toBe('abc.png');
    });
    it('returns null for external URLs (receiver fetches those itself)', () => {
      expect(headshotImageFilename('https://example.com/x.png')).toBeNull();
      expect(headshotImageFilename('data:image/png;base64,AAAA')).toBeNull();
    });
    it('returns null for a non-image absolute path', () => {
      expect(headshotImageFilename('/data/videos/x.mp4')).toBeNull();
    });
    it('returns null for empty / non-string input', () => {
      expect(headshotImageFilename('')).toBeNull();
      expect(headshotImageFilename('   ')).toBeNull();
      expect(headshotImageFilename(null)).toBeNull();
      expect(headshotImageFilename(undefined)).toBeNull();
    });
  });
});
