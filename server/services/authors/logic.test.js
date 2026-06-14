import { describe, it, expect } from 'vitest';
import {
  sanitizeAuthor, buildAuthorRecord, applyAuthorPatch,
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
});
