/**
 * Music Video scene takes (#8965) — client-side view helpers.
 *
 * A scene slot (`referenceImageId` / `videoHistoryId`) is the director's
 * selection among the scene's immutable `takes`. A pre-#8965 record has a
 * selection but no takes list yet (the server materializes it on the scene's
 * next take operation), so the board shows that selection as a read-only
 * `legacy` take rather than hiding it.
 */

export const TAKE_SLOT = Object.freeze({ image: 'referenceImageId', video: 'videoHistoryId' });

/** The takes of one kind for a scene, with an un-materialized selection appended. */
export function sceneTakeList(scene, kind) {
  const selected = scene?.[TAKE_SLOT[kind]] || null;
  const takes = (Array.isArray(scene?.takes) ? scene.takes : []).filter((t) => t?.kind === kind);
  if (selected && !takes.some((t) => t.assetId === selected)) {
    return [...takes, { takeId: null, kind, assetId: selected, source: 'legacy', status: 'candidate', note: null }];
  }
  return takes;
}

/** Preview/lightbox key for a take (`image:<filename>` / `video:<historyId>`). */
export const takePreviewKey = (take) => `${take.kind}:${take.assetId}`;

/** Thumbnail URL for a take: the gallery still, or the clip's generated poster. */
export const takeThumbUrl = (take) => (take.kind === 'image'
  ? `/data/images/${encodeURIComponent(take.assetId)}`
  : `/data/video-thumbnails/${encodeURIComponent(take.assetId)}.jpg`);

/** Short provenance label: the external provider for an import, else the source. */
export function takeProvenance(take) {
  if (take.source === 'imported') return take.provider ? `imported · ${take.provider}` : 'imported';
  if (take.source === 'generated') return 'generated';
  return take.source || 'take';
}
