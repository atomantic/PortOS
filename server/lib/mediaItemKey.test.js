import { describe, it, expect } from 'vitest';
import {
  ITEM_KINDS,
  ITEM_KIND,
  REF_MAX_LENGTH,
  itemKey,
  parseKey,
  isValidKey
} from './mediaItemKey.js';

describe('mediaItemKey', () => {
  describe('exports', () => {
    it('exposes the same kinds in both array and set forms', () => {
      expect(ITEM_KINDS).toEqual(['image', 'video']);
      for (const k of ITEM_KINDS) expect(ITEM_KIND.has(k)).toBe(true);
      expect(ITEM_KIND.size).toBe(ITEM_KINDS.length);
    });

    it('caps refs at 256 chars', () => {
      expect(REF_MAX_LENGTH).toBe(256);
    });
  });

  describe('itemKey', () => {
    it('joins kind and ref with a colon', () => {
      expect(itemKey({ kind: 'image', ref: 'cover.png' })).toBe('image:cover.png');
      expect(itemKey({ kind: 'video', ref: 'abc123' })).toBe('video:abc123');
    });
  });

  describe('parseKey', () => {
    it('parses valid image keys', () => {
      expect(parseKey('image:cover.png')).toEqual({ kind: 'image', ref: 'cover.png' });
    });

    it('parses valid video keys', () => {
      expect(parseKey('video:abc123')).toEqual({ kind: 'video', ref: 'abc123' });
    });

    it('preserves dot-extensions and dashes in refs', () => {
      expect(parseKey('image:my-cover-v2.png')).toEqual({ kind: 'image', ref: 'my-cover-v2.png' });
    });

    it('rejects non-string inputs', () => {
      expect(parseKey(null)).toBeNull();
      expect(parseKey(undefined)).toBeNull();
      expect(parseKey(42)).toBeNull();
      expect(parseKey({})).toBeNull();
    });

    it('rejects keys missing a colon', () => {
      expect(parseKey('imageNoColon')).toBeNull();
    });

    it('rejects keys with an empty kind (leading colon)', () => {
      expect(parseKey(':orphan-ref')).toBeNull();
    });

    it('rejects unknown kinds', () => {
      expect(parseKey('audio:foo.wav')).toBeNull();
      expect(parseKey('Image:cover.png')).toBeNull(); // case-sensitive
    });

    it('rejects refs that contain a colon (ambiguous in REST surface)', () => {
      expect(parseKey('image:foo:bar')).toBeNull();
    });

    it('rejects empty refs', () => {
      expect(parseKey('image:')).toBeNull();
    });

    it('accepts refs at the max length', () => {
      const ref = 'a'.repeat(REF_MAX_LENGTH);
      expect(parseKey(`image:${ref}`)).toEqual({ kind: 'image', ref });
    });

    it('rejects refs over the max length', () => {
      const ref = 'a'.repeat(REF_MAX_LENGTH + 1);
      expect(parseKey(`image:${ref}`)).toBeNull();
    });
  });

  describe('isValidKey', () => {
    it('returns true for valid keys', () => {
      expect(isValidKey('image:cover.png')).toBe(true);
      expect(isValidKey('video:xyz')).toBe(true);
    });

    it('returns false for invalid keys', () => {
      expect(isValidKey('audio:bar')).toBe(false);
      expect(isValidKey('image:')).toBe(false);
      expect(isValidKey(null)).toBe(false);
    });

    it('round-trips through itemKey', () => {
      const mediaItem = { kind: 'video', ref: 'abc' };
      const key = itemKey(mediaItem);
      expect(isValidKey(key)).toBe(true);
      expect(parseKey(key)).toEqual(mediaItem);
    });
  });
});
