import { describe, it, expect } from 'vitest';
import { BIBLE_LIMITS, appendImageRefById, capImageRefs } from './bibleLimits.js';

describe('capImageRefs', () => {
  it('returns the list unchanged when at or under the cap', () => {
    const refs = ['a.png', 'b.png'];
    expect(capImageRefs(refs)).toBe(refs); // same reference — no copy
  });

  it('keeps only the most recent N when over the cap', () => {
    const max = BIBLE_LIMITS.IMAGE_REFS_PER_ENTRY_MAX;
    const refs = Array.from({ length: max + 3 }, (_, i) => `r${i}.png`);
    const capped = capImageRefs(refs);
    expect(capped).toHaveLength(max);
    expect(capped[0]).toBe('r3.png'); // dropped the 3 oldest
    expect(capped[capped.length - 1]).toBe(`r${max + 2}.png`);
  });
});

describe('appendImageRefById', () => {
  it('appends the filename to the id-matched entry only', () => {
    const entries = [{ id: 'a', imageRefs: ['old.png'] }, { id: 'b' }];
    const next = appendImageRefById(entries, 'b', 'new.png');
    expect(next).toEqual([{ id: 'a', imageRefs: ['old.png'] }, { id: 'b', imageRefs: ['new.png'] }]);
    expect(next[0]).toBe(entries[0]); // untouched entries keep their reference
  });

  it('caps the appended list to the per-entry maximum', () => {
    const max = BIBLE_LIMITS.IMAGE_REFS_PER_ENTRY_MAX;
    const imageRefs = Array.from({ length: max }, (_, i) => `r${i}.png`);
    const [entry] = appendImageRefById([{ id: 'a', imageRefs }], 'a', 'new.png');
    expect(entry.imageRefs).toHaveLength(max);
    expect(entry.imageRefs[max - 1]).toBe('new.png');
    expect(entry.imageRefs).not.toContain('r0.png');
  });

  // The same array back is the caller's signal that no re-render is needed —
  // the completion bridge can fire more than once for one job, and the server's
  // durable append may already be reflected in a refetched draft.
  it('returns the same array when the ref is already present or the id is unknown', () => {
    const entries = [{ id: 'a', imageRefs: ['dup.png'] }];
    expect(appendImageRefById(entries, 'a', 'dup.png')).toBe(entries);
    expect(appendImageRefById(entries, 'nope', 'new.png')).toBe(entries);
  });

  it('returns null when there is no list, id, or filename to work with', () => {
    expect(appendImageRefById(undefined, 'a', 'new.png')).toBeNull();
    expect(appendImageRefById([{ id: 'a' }], null, 'new.png')).toBeNull();
    expect(appendImageRefById([{ id: 'a' }], 'a', null)).toBeNull();
  });
});
// @vitest-environment node
