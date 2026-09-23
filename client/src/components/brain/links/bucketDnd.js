/**
 * dnd-kit wiring for the Links board: keyboard coordinates + collision
 * detection shared by bucket reordering and chip (link) reordering, which
 * both live in ONE `DndContext` (LinksTab.jsx) so a link dragged from the
 * flat list can land inside any bucket at a specific position.
 *
 * Two drag "kinds" share the context, distinguished by `data.current.kind`:
 *   - 'bucket'    — a bucket header handle, dropped onto another bucket's
 *                    card to reorder the board.
 *   - 'link'      — a link (from the flat list or a bucket chip), dropped
 *                    onto a 'link-slot' droppable to file/reorder it.
 *
 * A 'link-slot' droppable is registered once BEFORE every chip in a bucket
 * (data.index = that chip's index — "insert before this chip") plus one more
 * covering the bucket's chip area as a whole (data.index = links.length —
 * "append to the end"). The trailing slot's rect ENCLOSES the per-chip slots,
 * so `rectIntersection` (dnd-kit's pointer default) would usually prefer the
 * larger container over the chip actually under the pointer. `closestCenter`
 * doesn't have that problem — a chip's center is far closer to the pointer
 * than the container's overall center whenever the pointer is actually near
 * that chip — so it is used for both pointer and keyboard drags here, unlike
 * the free-droppable/kanban helpers elsewhere in this tree.
 */

import { closestCenter } from '@dnd-kit/core';

export const BUCKET_KIND = 'bucket';
export const LINK_KIND = 'link';
export const LINK_SLOT_KIND = 'link-slot';

export const bucketDropId = (bucketId) => `bucket-drop:${bucketId}`;
export const chipSlotId = (bucketId, index) => `chip-slot:${bucketId}:${index}`;

const DIRECTIONS = {
  ArrowDown: 1,
  ArrowRight: 1,
  ArrowUp: -1,
  ArrowLeft: -1,
};

/**
 * Collision detection for the combined bucket/link `DndContext`: only
 * droppables whose `kind` matches the item being dragged are candidates, so a
 * bucket drag never resolves onto a chip slot (or vice versa).
 */
export function linksCollisionDetection(args) {
  const activeKind = args.active?.data?.current?.kind;
  const targetKind = activeKind === LINK_KIND ? LINK_SLOT_KIND : activeKind;
  const droppableContainers = args.droppableContainers.filter(
    (container) => container.data?.current?.kind === targetKind,
  );
  return closestCenter({ ...args, droppableContainers });
}

function centerOf(target, activeRect) {
  return {
    x: target.rect.left + (target.rect.width - (activeRect?.width || 0)) / 2,
    y: target.rect.top + (target.rect.height - (activeRect?.height || 0)) / 2,
  };
}

function activeRectOf(active, context) {
  return context?.active?.rect?.current?.translated
    || context?.active?.rect?.current?.initial
    || active?.rect?.current?.translated
    || active?.rect?.current?.initial;
}

function enabledEntries(context) {
  return (context?.droppableContainers?.getEnabled?.() || [])
    .map((entry) => ({ entry, data: entry.data?.current || {}, rect: context.droppableRects?.get(entry.id) }))
    .filter(({ rect }) => rect);
}

function bucketKeyboardCoordinates(direction, activeData, context) {
  const buckets = enabledEntries(context)
    .filter(({ data }) => data.kind === BUCKET_KIND)
    .sort((a, b) => a.data.bucketIndex - b.data.bucketIndex);
  if (buckets.length === 0) return undefined;

  const overData = context?.over?.data?.current || {};
  const currentBucketId = overData.bucketId ?? activeData.bucket?.id;
  const currentIndex = buckets.findIndex(({ data }) => data.bucketId === currentBucketId);
  const nextIndex = currentIndex === -1 ? (direction > 0 ? 0 : buckets.length - 1) : currentIndex + direction;
  const target = buckets[nextIndex];
  return target ? { entry: target } : undefined;
}

function linkKeyboardCoordinates(event, activeData, context) {
  const slots = enabledEntries(context).filter(({ data }) => data.kind === LINK_SLOT_KIND);
  if (slots.length === 0) return undefined;

  const overData = context?.over?.data?.current || {};
  const currentBucketId = overData.bucketId ?? activeData.bucketId ?? null;
  const currentIndex = overData.kind === LINK_SLOT_KIND ? overData.index : (activeData.index ?? null);

  if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
    const direction = DIRECTIONS[event.code];
    const withinBucket = slots
      .filter(({ data }) => data.bucketId === currentBucketId)
      .sort((a, b) => a.data.index - b.data.index);
    if (withinBucket.length === 0) return undefined;
    const idx = withinBucket.findIndex(({ data }) => data.index === currentIndex);
    const nextIdx = idx === -1 ? (direction > 0 ? 0 : withinBucket.length - 1) : idx + direction;
    const target = withinBucket[nextIdx];
    return target ? { entry: target } : undefined;
  }

  if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
    const direction = DIRECTIONS[event.code];
    const bucketOrder = [];
    const seen = new Set();
    for (const { data } of slots) {
      if (seen.has(data.bucketId)) continue;
      seen.add(data.bucketId);
      bucketOrder.push({ bucketId: data.bucketId, bucketIndex: data.bucketIndex });
    }
    bucketOrder.sort((a, b) => a.bucketIndex - b.bucketIndex);
    if (bucketOrder.length === 0) return undefined;
    const curPos = bucketOrder.findIndex((b) => b.bucketId === currentBucketId);
    const nextPos = curPos === -1 ? (direction > 0 ? 0 : bucketOrder.length - 1) : curPos + direction;
    const nextBucket = bucketOrder[nextPos];
    if (!nextBucket) return undefined;
    const destSlots = slots
      .filter(({ data }) => data.bucketId === nextBucket.bucketId)
      .sort((a, b) => a.data.index - b.data.index);
    if (destSlots.length === 0) return undefined;
    const clampedIndex = Math.min(Math.max(currentIndex ?? 0, 0), destSlots.length - 1);
    const target = destSlots[clampedIndex];
    return target ? { entry: target } : undefined;
  }

  return undefined;
}

/**
 * `coordinateGetter` for the combined bucket/link `KeyboardSensor`. Branches
 * on the dragged item's `kind`: a bucket steps left/right (and up/down, since
 * the board wraps into a responsive grid) through the other bucket cards; a
 * link steps up/down within its current bucket's chip order and left/right
 * into the adjacent bucket at the nearest equivalent position.
 */
export function linksKeyboardCoordinates(event, { active, context }) {
  const direction = DIRECTIONS[event.code];
  if (!direction) return undefined;

  const activeData = context?.active?.data?.current || active?.data?.current || {};
  const result = activeData.kind === BUCKET_KIND
    ? bucketKeyboardCoordinates(direction, activeData, context)
    : activeData.kind === LINK_KIND
      ? linkKeyboardCoordinates(event, activeData, context)
      : undefined;
  if (!result) return undefined;

  const activeRect = activeRectOf(active, context);
  return centerOf(result.entry, activeRect);
}
