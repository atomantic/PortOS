// Map a linked universe's canon (characters/places/objects) onto a music
// video project's visual-spec references (#8978 "Pull from universe"). Pure
// and read-only: the caller owns persisting the result via the ordinary
// visualSpec PATCH (see VisualSpecPanel.jsx).
//
// Mirrors the server's 24-reference cap
// (server/lib/musicVideoValidation.js musicVideoVisualSpecSchema) so a pull
// can never produce a spec the server would reject.

export const MUSIC_VIDEO_MAX_REFERENCES = 24;

// Canon kind → visual-spec reference role (server/lib/musicVideoValidation.js
// MUSIC_VIDEO_REFERENCE_ROLES). Characters are the obvious "character" role;
// places and props are the closest existing roles, since the visual spec has
// no dedicated "place"/"object" bucket.
const KIND_ROLE = Object.freeze({
  characters: 'character',
  places: 'set',
  objects: 'prop',
});

// The best available reference image for a canon entry: the pinned primary,
// else the first rendered ref. An entry with neither has nothing to pull.
function entryImage(entry) {
  if (entry?.primaryImageRef) return entry.primaryImageRef;
  const refs = Array.isArray(entry?.imageRefs) ? entry.imageRefs : [];
  return refs[0] || null;
}

/**
 * Build the visual-spec `references` array that results from pulling a
 * universe's canon images into `existingReferences`. Idempotent: an image
 * already present (by `imageId`) is skipped, so calling this again with the
 * same universe/references adds nothing new. Respects the 24-reference cap —
 * additions beyond it are counted in `skipped` rather than added.
 *
 * Returns `{ next, added, skipped }`. `next` is the full array to persist
 * (unchanged, by reference-equal content, when `added === 0` — but a caller
 * that wants to avoid a no-op save should check `added` itself).
 */
export function pullUniverseCanonReferences(universe, existingReferences = []) {
  const existingIds = new Set(existingReferences.map((ref) => ref.imageId));
  const candidates = [];
  let skippedNoImage = 0;
  let skippedDuplicate = 0;
  for (const [field, role] of Object.entries(KIND_ROLE)) {
    const list = Array.isArray(universe?.[field]) ? universe[field] : [];
    for (const entry of list) {
      const imageId = entryImage(entry);
      if (!imageId) { skippedNoImage += 1; continue; }
      if (existingIds.has(imageId)) { skippedDuplicate += 1; continue; }
      existingIds.add(imageId); // two canon entries sharing one image only add it once
      candidates.push({ imageId, role, label: (entry.name || '').slice(0, 120), condition: false });
    }
  }
  const room = Math.max(0, MUSIC_VIDEO_MAX_REFERENCES - existingReferences.length);
  const additions = candidates.slice(0, room);
  const skippedCap = candidates.length - additions.length;
  return {
    next: additions.length ? [...existingReferences, ...additions] : existingReferences,
    added: additions.length,
    skipped: skippedNoImage + skippedDuplicate + skippedCap,
  };
}
