/**
 * Music Video scene takes (#8965) — client-side view helpers.
 *
 * A scene slot (`referenceImageId` / `videoHistoryId`) is the director's
 * selection among the scene's immutable `takes`. A pre-#8965 record has a
 * selection but no takes list yet (the server materializes it on the scene's
 * next take operation), so the board shows that selection as a read-only
 * `legacy` take rather than hiding it.
 */

// `endImage` (#11173): the optional style-break end frame a fal clip ends on.
export const TAKE_SLOT = Object.freeze({ image: 'referenceImageId', video: 'videoHistoryId', endImage: 'endImageId' });

/** The takes of one kind for a scene, with an un-materialized selection appended. */
export function sceneTakeList(scene, kind) {
  const selected = scene?.[TAKE_SLOT[kind]] || null;
  const takes = (Array.isArray(scene?.takes) ? scene.takes : []).filter((t) => t?.kind === kind);
  if (selected && !takes.some((t) => t.assetId === selected)) {
    return [...takes, { takeId: null, kind, assetId: selected, source: 'legacy', status: 'candidate', note: null }];
  }
  return takes;
}

/** Preview/lightbox key for a take (`image:<filename>` / `video:<historyId>`); an end frame is a gallery image. */
export const takePreviewKey = (take) => `${take.kind === 'video' ? 'video' : 'image'}:${take.assetId}`;

/** Thumbnail URL for a take: the gallery still, or the clip's generated poster. */
export const takeThumbUrl = (take) => (take.kind !== 'video'
  ? `/data/images/${encodeURIComponent(take.assetId)}`
  : `/data/video-thumbnails/${encodeURIComponent(take.assetId)}.jpg`);

/** Playable clip URL for a video take (hover/focus preview). */
export const takeClipUrl = (take) => `/data/videos/${encodeURIComponent(take.assetId)}.mp4`;

/**
 * Scenes whose slot still has an undecided candidate (a candidate that is not
 * the selection). `kinds` limits it to the slots the shot uses.
 */
export function sceneHasPendingDecision(scene, { kinds = Object.keys(TAKE_SLOT) } = {}) {
  return kinds.some((kind) => {
    const selected = scene?.[TAKE_SLOT[kind]] || null;
    return sceneTakeList(scene, kind).some((t) => t.takeId && t.status === 'candidate' && t.assetId !== selected);
  });
}

/** Short provenance label: the external provider for an import, else the source. */
export function takeProvenance(take) {
  if (take.source === 'imported') return take.provider ? `imported · ${take.provider}` : 'imported';
  if (take.source === 'generated') return 'generated';
  return take.source || 'take';
}
