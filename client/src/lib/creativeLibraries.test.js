import { describe, it, expect } from 'vitest';
import {
  isGoodReference, isSheetMedia, isPlateMedia, isReferenceTabMedia, lookIdOf,
} from './creativeLibraries.js';

describe('creativeLibraries', () => {
  describe('isGoodReference', () => {
    it('returns true when media.library.review.status is good', () => {
      expect(isGoodReference({ library: { review: { status: 'good' } } })).toBe(true);
    });

    it('returns true when media.review.status is good', () => {
      expect(isGoodReference({ review: { status: 'good' } })).toBe(true);
    });

    it('returns false for bad, rejected, or unreviewed status', () => {
      expect(isGoodReference({ library: { review: { status: 'bad' } } })).toBe(false);
      expect(isGoodReference({ library: { review: { status: 'rejected' } } })).toBe(false);
      expect(isGoodReference({ library: { review: { status: 'unreviewed' } } })).toBe(false);
    });

    it('returns false for objects without review status or null', () => {
      expect(isGoodReference({})).toBe(false);
      expect(isGoodReference(null)).toBe(false);
      expect(isGoodReference(undefined)).toBe(false);
    });
  });

  describe('media roles', () => {
    it('identifies sheet and plate media', () => {
      expect(isSheetMedia({ role: 'sheet:standard' })).toBe(true);
      expect(isSheetMedia({ role: 'plate' })).toBe(false);
      expect(isPlateMedia({ role: 'plate' })).toBe(true);
      expect(isPlateMedia({ role: 'reference' })).toBe(false);
    });

    it('extracts lookId from look role', () => {
      expect(lookIdOf({ role: 'look:wardrobe-1' })).toBe('wardrobe-1');
      expect(lookIdOf({ role: 'sheet:standard' })).toBeNull();
      expect(lookIdOf({})).toBeNull();
    });

    it('checks whether an image belongs on the references tab', () => {
      expect(isReferenceTabMedia({ role: null })).toBe(true);
      expect(isReferenceTabMedia({ role: 'sheet:standard' })).toBe(false);
      expect(isReferenceTabMedia({ role: 'plate' })).toBe(false);
      expect(isReferenceTabMedia({ role: 'look:w1' }, new Set(['w1']))).toBe(false);
      expect(isReferenceTabMedia({ role: 'look:w1' }, new Set(['w2']))).toBe(true);
      // A Design take stays on the Design tab until it is made an anchor.
      expect(isReferenceTabMedia({ role: 'design:r1:0', library: { likeness: false } })).toBe(false);
      expect(isReferenceTabMedia({ role: 'design:r1:0', library: { guide: true } })).toBe(true);
    });
  });
});
