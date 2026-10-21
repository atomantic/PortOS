import { describe, it, expect } from 'vitest';
import {
  MAX_CAST_GUIDES, eraForAge, normalizeLibrary, filterLibraryMedia, pickGuideMedia,
  parseLibraryMediaKey, inferAgeFromText,
} from './catalogMediaLibrary.js';

const row = (mediaKey, kind, library = {}, createdAt = '2026-01-01T00:00:00.000Z') => ({ mediaKey, kind, library, createdAt });

describe('catalogMediaLibrary', () => {
  it('derives eras from ages', () => {
    expect(eraForAge(7)).toBe('child');
    expect(eraForAge(17)).toBe('teen');
    expect(eraForAge(27)).toBe('adult');
    expect(eraForAge(70)).toBe('elder');
    expect(eraForAge(undefined)).toBeUndefined();
  });

  it('normalizes library values and drops junk', () => {
    expect(normalizeLibrary(null)).toEqual({});
    expect(normalizeLibrary({ variant: { age: 7.5, era: 'nope', label: '  age 7 ' }, tags: ['VHS', 'vhs', ' ', 3], guide: 'yes' }))
      .toEqual({ variant: { label: 'age 7' }, tags: ['vhs'] });
    expect(normalizeLibrary({ variant: { age: 17, era: 'teen', wardrobeId: 'w1' }, guide: true }))
      .toEqual({ variant: { age: 17, era: 'teen', wardrobeId: 'w1' }, guide: true });
  });

  it('filters by age, era (derived), tag, kind and guide', () => {
    const media = [
      row('a.png', 'reference', { variant: { age: 7 }, tags: ['vhs'] }),
      row('b.png', 'reference', { variant: { era: 'adult' }, guide: true }),
      row('c.mp4', 'video', { variant: { age: 17 } }),
      { ...row('d.png', 'reference', { variant: { age: 7 } }), deleted: true },
    ];
    expect(filterLibraryMedia(media, { age: 7 }).map((m) => m.mediaKey)).toEqual(['a.png']);
    expect(filterLibraryMedia(media, { era: 'teen' }).map((m) => m.mediaKey)).toEqual(['c.mp4']);
    expect(filterLibraryMedia(media, { tag: 'VHS' }).map((m) => m.mediaKey)).toEqual(['a.png']);
    expect(filterLibraryMedia(media, { kind: 'video' }).map((m) => m.mediaKey)).toEqual(['c.mp4']);
    expect(filterLibraryMedia(media, { guide: true }).map((m) => m.mediaKey)).toEqual(['b.png']);
  });

  it('prefers guides matching the requested age, never videos, capped at 4', () => {
    const media = [
      row('adult.png', 'reference', { variant: { age: 27 }, guide: true }),
      row('child.png', 'reference', { variant: { age: 7 }, guide: true }),
      row('teen.png', 'reference', { variant: { age: 17 }, guide: true }),
      row('unflagged-child.png', 'reference', { variant: { age: 7 } }),
      row('clip.mp4', 'video', { variant: { age: 7 }, guide: true }),
    ];
    expect(pickGuideMedia(media, { age: 7 }).map((m) => m.mediaKey)).toEqual(['child.png', 'teen.png', 'adult.png']);
    expect(pickGuideMedia(media, { age: 27 }, 1).map((m) => m.mediaKey)).toEqual(['adult.png']);
    expect(pickGuideMedia(media, {}, 99)).toHaveLength(3);
    expect(MAX_CAST_GUIDES).toBe(4);
  });

  it('falls back to portrait then newest when nothing is a guide', () => {
    const media = [
      row('old.png', 'reference', {}, '2026-01-01T00:00:00.000Z'),
      row('new.png', 'reference', {}, '2026-02-01T00:00:00.000Z'),
      row('face.png', 'portrait', {}, '2025-01-01T00:00:00.000Z'),
    ];
    expect(pickGuideMedia(media).map((m) => m.mediaKey)).toEqual(['face.png', 'new.png', 'old.png']);
  });

  it('parses typed media keys safely', () => {
    expect(parseLibraryMediaKey('image:a.png')).toEqual({ kind: 'reference', mediaKey: 'a.png' });
    expect(parseLibraryMediaKey('video:b.mp4')).toEqual({ kind: 'video', mediaKey: 'b.mp4' });
    expect(parseLibraryMediaKey('image:../x.png')).toBeNull();
    expect(parseLibraryMediaKey('a.png')).toBeNull();
  });

  it('infers ages from captions', () => {
    expect(inferAgeFromText('Experiment ages: Nora at 17, VHS')).toBe(17);
    expect(inferAgeFromText('reference sheet, age 7')).toBe(7);
    expect(inferAgeFromText('no age here')).toBeUndefined();
  });
});
