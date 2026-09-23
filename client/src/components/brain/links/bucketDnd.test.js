import { describe, it, expect } from 'vitest';
import { linksCollisionDetection, linksKeyboardCoordinates, BUCKET_KIND, LINK_KIND, LINK_SLOT_KIND } from './bucketDnd';

// Minimal fake droppable-container entries, shaped like the subset of
// dnd-kit's internal `DroppableContainer` this module actually reads
// (`id`, `data.current`, plus a `rect` for the keyboard coordinate math).
const rect = (top, left, width = 100, height = 30) => ({ top, left, width, height });

const bucketEntry = (id, bucketIndex, top) => ({
  id: `bucket-drop:${id}`,
  data: { current: { kind: BUCKET_KIND, bucketId: id, bucketName: id, bucketIndex } },
  rect: rect(top, 0),
});

const slotEntry = (bucketId, bucketIndex, index, top) => ({
  id: `chip-slot:${bucketId}:${index}`,
  data: { current: { kind: LINK_SLOT_KIND, bucketId, bucketName: bucketId, bucketIndex, index } },
  rect: rect(top, bucketIndex * 200),
});

function fakeContext(entries, overId, activeId) {
  const rectsById = new Map(entries.map((e) => [e.id, e.rect]));
  return {
    droppableContainers: { getEnabled: () => entries },
    droppableRects: rectsById,
    over: overId ? { id: overId, data: { current: entries.find((e) => e.id === overId)?.data.current } } : null,
    active: activeId ? { rect: { current: { initial: rect(0, 0, 40, 20) } } } : null,
  };
}

describe('linksKeyboardCoordinates', () => {
  it('steps a bucket drag to the next bucket in order', () => {
    const entries = [bucketEntry('b1', 0, 0), bucketEntry('b2', 1, 40), bucketEntry('b3', 2, 80)];
    const context = fakeContext(entries, 'bucket-drop:b1', 'bucket:b1');
    const active = { data: { current: { kind: BUCKET_KIND, bucket: { id: 'b1' }, bucketIndex: 0 } } };
    const coords = linksKeyboardCoordinates({ code: 'ArrowRight' }, { active, context });
    // Centered on b2's rect (left 0, width 100, active width 40 → x = 30;
    // top 40, height 30, active height 20 → y = 45).
    expect(coords).toEqual({ x: 30, y: 45 });
  });

  it('anchors on the dragged bucket\'s own position when nothing is currently over', () => {
    const entries = [bucketEntry('b1', 0, 0), bucketEntry('b2', 1, 40)];
    const context = fakeContext(entries, null, 'bucket:b1');
    const active = { data: { current: { kind: BUCKET_KIND, bucket: { id: 'b1' }, bucketIndex: 0 } } };
    // Falls back to the dragged bucket's own id (b1, index 0) rather than
    // resolving to nothing, then steps forward from there to b2.
    expect(linksKeyboardCoordinates({ code: 'ArrowRight' }, { active, context })).toEqual({ x: 30, y: 45 });
  });

  it('returns undefined for a key the getter does not handle', () => {
    const entries = [bucketEntry('b1', 0, 0)];
    const context = fakeContext(entries, 'bucket-drop:b1', 'bucket:b1');
    const active = { data: { current: { kind: BUCKET_KIND, bucket: { id: 'b1' }, bucketIndex: 0 } } };
    expect(linksKeyboardCoordinates({ code: 'Tab' }, { active, context })).toBeUndefined();
  });

  it('steps a link drag up/down within its current bucket by chip index', () => {
    const entries = [
      slotEntry('b1', 0, 0, 0), slotEntry('b1', 0, 1, 30), slotEntry('b1', 0, 2, 60),
    ];
    const context = fakeContext(entries, 'chip-slot:b1:0', 'link:l1');
    const active = { data: { current: { kind: LINK_KIND, link: { id: 'l1' }, bucketId: 'b1', index: 0 } } };
    const coords = linksKeyboardCoordinates({ code: 'ArrowDown' }, { active, context });
    expect(coords).toEqual({ x: 30, y: 35 });
  });

  it('steps a link drag left/right into the adjacent bucket at the closest equivalent index', () => {
    const entries = [
      slotEntry('b1', 0, 0, 0), slotEntry('b1', 0, 1, 30),
      slotEntry('b2', 1, 0, 0), slotEntry('b2', 1, 1, 30), slotEntry('b2', 1, 2, 60),
    ];
    // Currently over b1's index-1 slot; ArrowRight should land on b2's index-1
    // slot (same index carried across), not b2's first slot.
    const context = fakeContext(entries, 'chip-slot:b1:1', 'link:l1');
    const active = { data: { current: { kind: LINK_KIND, link: { id: 'l1' }, bucketId: 'b1', index: 1 } } };
    const coords = linksKeyboardCoordinates({ code: 'ArrowRight' }, { active, context });
    expect(coords).toEqual({ x: 230, y: 35 });
  });

  it('clamps the destination index when the adjacent bucket has fewer slots', () => {
    const entries = [
      slotEntry('b1', 0, 0, 0), slotEntry('b1', 0, 1, 30), slotEntry('b1', 0, 2, 60),
      slotEntry('b2', 1, 0, 0),
    ];
    const context = fakeContext(entries, 'chip-slot:b1:2', 'link:l1');
    const active = { data: { current: { kind: LINK_KIND, link: { id: 'l1' }, bucketId: 'b1', index: 2 } } };
    const coords = linksKeyboardCoordinates({ code: 'ArrowRight' }, { active, context });
    // Only one slot (index 0) exists in b2 — clamp rather than resolving to nothing.
    expect(coords).toEqual({ x: 230, y: 5 });
  });

  it('returns undefined when the dragged item has no recognized kind', () => {
    const entries = [bucketEntry('b1', 0, 0)];
    const context = fakeContext(entries, null, null);
    const active = { data: { current: { kind: 'mystery' } } };
    expect(linksKeyboardCoordinates({ code: 'ArrowRight' }, { active, context })).toBeUndefined();
  });
});

describe('linksCollisionDetection', () => {
  it('only matches droppables of the dragged item\'s own kind', () => {
    const bucketContainer = { id: 'bucket-drop:b1', data: { current: { kind: BUCKET_KIND, bucketId: 'b1' } }, rect: rect(0, 0) };
    const slotContainer = { id: 'chip-slot:b1:0', data: { current: { kind: LINK_SLOT_KIND, bucketId: 'b1', index: 0 } }, rect: rect(0, 0) };
    const args = {
      active: { id: 'bucket:b1', data: { current: { kind: BUCKET_KIND } }, rect: { current: { initial: rect(0, 0) } } },
      collisionRect: rect(0, 0),
      droppableRects: new Map([[bucketContainer.id, bucketContainer.rect], [slotContainer.id, slotContainer.rect]]),
      droppableContainers: [bucketContainer, slotContainer],
      pointerCoordinates: null,
    };
    const collisions = linksCollisionDetection(args);
    expect(collisions.every((c) => c.id === bucketContainer.id)).toBe(true);
    expect(collisions.some((c) => c.id === slotContainer.id)).toBe(false);
  });
});
