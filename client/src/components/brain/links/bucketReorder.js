/**
 * Map a pointer position over a chip to an insertion index: before the chip
 * (its own index) when the pointer is in its left half, after it (index + 1)
 * when in the right half. Pure so the before/after boundary is unit-testable
 * (jsdom can't supply a real rect or clientX to a drag event).
 */
export function chipInsertIndex(rect, clientX, i) {
  return clientX > rect.left + rect.width / 2 ? i + 1 : i;
}

/**
 * Pure helper for intra-bucket (and cross-bucket) positioned chip drops.
 *
 * Given the full link list, the dragged link, the destination bucket, and the
 * insertion index (computed from the drop location — relative to the bucket's
 * CURRENT chip order, counting the dragged chip if it already lives there),
 * returns a dense renumbering of the destination bucket plus the subset of
 * links whose `{ bucketId, bucketOrder }` actually changed (so the caller only
 * PATCHes what moved).
 */
export function reorderLinksInBucket(links, link, bucketId, targetIndex) {
  const ordered = links
    .filter(l => l.bucketId === bucketId)
    .sort((a, b) => (a.bucketOrder ?? 0) - (b.bucketOrder ?? 0));
  const fromIndex = ordered.findIndex(l => l.id === link.id);
  const without = ordered.filter(l => l.id !== link.id);

  // The drop index includes the dragged chip when it already lives in this
  // bucket; removing it shifts every later position down one, so the insertion
  // point must decrement when the chip moved rightward within its own bucket.
  let insertAt = fromIndex !== -1 && fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
  insertAt = Math.max(0, Math.min(insertAt, without.length));
  without.splice(insertAt, 0, link);

  const renumbered = without.map((l, i) => ({ id: l.id, bucketId, bucketOrder: i }));
  const changed = renumbered.filter(r => {
    const cur = links.find(l => l.id === r.id);
    return !cur || cur.bucketId !== bucketId || (cur.bucketOrder ?? 0) !== r.bucketOrder;
  });
  return { renumbered, changed };
}
