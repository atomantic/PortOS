// Group a normalized image item with its cleaned siblings (or its original,
// if `item` itself is a cleaned copy). Returns `{ active, group }` where
// `group` is an ordered list of variants — original first, then cleaned
// copies sorted by clean level / creation order — and `active` is the entry
// in the group that matches `item`.
//
// Returns null when there's no toggle to render: either the items array
// doesn't contain a sibling, or the preview isn't an image. Both happen on
// pages where the user hasn't manually cleaned anything; this keeps the
// lightbox unchanged for the common case.
//
// Image variants are identified via the sidecar `cleanedFrom` field —
// stamped by `POST /api/image-gen/:filename/clean` on the cleaned copy.
// Auto-cleaned images replace the original in place (`autoCleaned: true`,
// no `cleanedFrom`) so they're treated as the original, not a sibling — the
// auto-clean toggle doesn't apply because there IS only one file.
export function computeImageVariantGroup(item, items) {
  if (!item || item.kind !== 'image') return null;
  if (!Array.isArray(items) || items.length === 0) return null;

  // Resolve the original filename: either `item` itself (if it's not a clean)
  // or its `cleanedFrom` target. We then collect everyone that points back to
  // that filename.
  const originalFilename = item.cleanedFrom || item.filename;
  if (!originalFilename) return null;

  const imageItems = items.filter((i) => i?.kind === 'image' && typeof i.filename === 'string');
  const original = imageItems.find((i) => i.filename === originalFilename && !i.cleanedFrom) || null;
  const cleaned = imageItems
    .filter((i) => i.cleanedFrom === originalFilename)
    .sort((a, b) => {
      // Deterministic order: aggressive after light if both exist (legacy on-disk
      // files may have `_clean-light.png` from before the simplification), then
      // by createdAt as the final tiebreaker.
      const levelOrder = { light: 0, aggressive: 1 };
      const al = levelOrder[a.cleanLevel] ?? 99;
      const bl = levelOrder[b.cleanLevel] ?? 99;
      if (al !== bl) return al - bl;
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });

  // No toggle to render unless we actually have at least two variants the
  // user can switch between.
  if ((original ? 1 : 0) + cleaned.length < 2) return null;

  const group = [];
  if (original) group.push({ label: 'Original', item: original });
  for (const c of cleaned) {
    const levelTag = c.cleanLevel ? ` (${c.cleanLevel})` : '';
    group.push({ label: `Cleaned${levelTag}`, item: c });
  }

  const active = group.find((entry) => entry.item.filename === item.filename) || null;
  if (!active) return null;
  return { active, group };
}
