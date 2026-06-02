import { describe, it, expect } from 'vitest';
import { reorderLinksInBucket, chipInsertIndex } from './bucketReorder';

const mk = (id, bucketId, bucketOrder) => ({ id, bucketId, bucketOrder });

describe('chipInsertIndex', () => {
  const rect = { left: 100, width: 40 }; // midpoint at 120

  it('inserts before the chip when the pointer is in its left half', () => {
    expect(chipInsertIndex(rect, 110, 3)).toBe(3);
  });

  it('inserts after the chip when the pointer is in its right half', () => {
    expect(chipInsertIndex(rect, 130, 3)).toBe(4);
  });

  it('treats the exact midpoint as "before" (not strictly greater)', () => {
    expect(chipInsertIndex(rect, 120, 3)).toBe(3);
  });
});

describe('reorderLinksInBucket', () => {
  it('moves a chip later within its bucket, accounting for its own removal', () => {
    const links = [mk('a', 'b1', 0), mk('b', 'b1', 1), mk('c', 'b1', 2), mk('d', 'b1', 3)];
    // Drag A to "after C" — drop index 3 in the current array [A,B,C,D].
    const { renumbered, changed } = reorderLinksInBucket(links, links[0], 'b1', 3);
    expect(renumbered.map(r => r.id)).toEqual(['b', 'c', 'a', 'd']);
    // a, b, c all shifted; d kept order 3.
    expect(changed.map(c => c.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('moves a chip earlier within its bucket', () => {
    const links = [mk('a', 'b1', 0), mk('b', 'b1', 1), mk('c', 'b1', 2), mk('d', 'b1', 3)];
    // Drag D to before B — drop index 1.
    const { renumbered } = reorderLinksInBucket(links, links[3], 'b1', 1);
    expect(renumbered.map(r => r.id)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('is a no-op when the chip lands back in its current slot', () => {
    const links = [mk('a', 'b1', 0), mk('b', 'b1', 1), mk('c', 'b1', 2)];
    // Drag B to "after A" (index 1) — its existing position.
    const { changed } = reorderLinksInBucket(links, links[1], 'b1', 1);
    expect(changed).toEqual([]);
  });

  it('inserts a chip dragged in from another bucket at the target index', () => {
    const links = [mk('a', 'b1', 0), mk('b', 'b1', 1), mk('x', 'b2', 0)];
    // Drag X (from b2) into b1 at index 1 — between A and B.
    const { renumbered, changed } = reorderLinksInBucket(links, links[2], 'b1', 1);
    expect(renumbered).toEqual([
      { id: 'a', bucketId: 'b1', bucketOrder: 0 },
      { id: 'x', bucketId: 'b1', bucketOrder: 1 },
      { id: 'b', bucketId: 'b1', bucketOrder: 2 }
    ]);
    // X changes bucket + order; B shifts to 2. A is unchanged.
    expect(changed.map(c => c.id).sort()).toEqual(['b', 'x']);
  });

  it('clamps an out-of-range target index to the end', () => {
    const links = [mk('a', 'b1', 0), mk('b', 'b1', 1)];
    const { renumbered } = reorderLinksInBucket(links, links[0], 'b1', 99);
    expect(renumbered.map(r => r.id)).toEqual(['b', 'a']);
  });

  it('treats a missing bucketOrder as 0 when sorting', () => {
    const links = [{ id: 'a', bucketId: 'b1' }, mk('b', 'b1', 1)];
    const { renumbered } = reorderLinksInBucket(links, links[1], 'b1', 0);
    expect(renumbered.map(r => r.id)).toEqual(['b', 'a']);
  });
});
