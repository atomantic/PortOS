/**
 * Music Video scene takes (#8965) — client-side view helpers.
 *
 * A scene slot (`referenceImageId` / `videoHistoryId`) is the director's
 * selection among the scene's immutable `takes`. A pre-#8965 record has a
 * selection but no takes list yet (the server materializes it on the scene's
 * next take operation), so the board shows that selection as a read-only
 * `legacy` take rather than hiding it.
 */

import { TAKE_SLOT } from '../../../server/lib/musicVideo/musicVideoLayers.js';
import { sequenceTakeSelectionPatch } from '../../../server/lib/musicVideo/musicVideoSequenceTake.js';

export { TAKE_SLOT };

/** The takes of one kind for a scene, with an un-materialized selection appended. */
export function sceneTakeList(scene, kind) {
  const selected = scene?.[TAKE_SLOT[kind]] || null;
  const takes = (Array.isArray(scene?.takes) ? scene.takes : []).filter((t) => t?.kind === kind);
  if (selected && !takes.some((t) => t.assetId === selected)) {
    return [...takes, { takeId: null, kind, assetId: selected, source: 'legacy', status: 'candidate', note: null }];
  }
  return takes;
}

/** Merge a color measurement without replacing newer take decisions or newly added takes. */
export function mergeTakeColorMatch(scene, measuredTakes) {
  const takes = (scene.takes || []).map((take) => {
    const measured = measuredTakes.find((entry) => entry.takeId === take.takeId
      || (entry.kind === take.kind && entry.assetId === take.assetId));
    return measured && Object.hasOwn(measured, 'colorMatch') ? { ...take, colorMatch: measured.colorMatch } : take;
  });
  // Measurement materializes legacy selected assets; retain those rows only
  // while they still belong to the current selection.
  for (const take of measuredTakes) {
    if (scene[TAKE_SLOT[take.kind]] === take.assetId && !takes.some((entry) => entry.kind === take.kind && entry.assetId === take.assetId)) takes.push(take);
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

// Optimistic take decisions: the scene fields the server's take transforms
// (server/services/musicVideo/takes.js) will write, applied before the reply so
// the buttons answer at once. The reply replaces them with the saved scene.

/**
 * Scene patch for Use: the take fills its slot, a rejected take comes back as a
 * candidate, and a sequence take brings its in-point (the server's own rule).
 */
export function selectTakePatch(scene, take) {
  const takes = Array.isArray(scene?.takes) ? scene.takes : [];
  return {
    ...sequenceTakeSelectionPatch(scene, take),
    [TAKE_SLOT[take.kind]]: take.assetId,
    takes: takes.map((t) => (t.takeId === take.takeId && t.status === 'rejected' ? { ...t, status: 'candidate' } : t)),
  };
}

/** Scene patch for Reject/Restore and notes; rejecting the selected take clears its slot. */
export function reviewTakePatch(scene, take, { status, note } = {}) {
  const takes = Array.isArray(scene?.takes) ? scene.takes : [];
  const field = TAKE_SLOT[take.kind];
  const updated = {
    ...take,
    ...(status !== undefined ? { status } : {}),
    ...(note !== undefined ? { note: note && note.trim() ? note.trim().slice(0, 1000) : null } : {}),
  };
  return {
    takes: takes.map((t) => (t.takeId === take.takeId ? updated : t)),
    ...(updated.status === 'rejected' && field && scene?.[field] === take.assetId ? { [field]: null } : {}),
  };
}

/** The project's `assetMarks` with one take's file marked (`'bad'`, `'ingredient'`) or cleared (null). */
export function markTakeAssetMarks(assetMarks, take, mark) {
  const key = takePreviewKey(take);
  const next = { ...(assetMarks || {}) };
  if (mark) next[key] = mark;
  else delete next[key];
  return next;
}

/**
 * The control a take decision waits on, the key of useMusicVideoTakes `pending` (#16306): pressing it again
 * before its reply sends nothing. Use and Reject of one take stay separate controls, so a Reject right after
 * Use still queues behind it. A note is not a control: it follows its Reject on the chain and is always sent.
 */
export const takeControl = {
  select: (scene, take) => `select:${scene.sceneId}:${take.takeId}`,
  status: (scene, take, status) => `status:${status}:${scene.sceneId}:${take.takeId}`,
  acknowledge: (scene, take) => `acknowledge:${scene.sceneId}:${take.takeId}`,
  confirm: (scene, take) => `confirm:${scene.sceneId}:${take.takeId}`,
  acceptCharacters: (scene, take) => `accept-characters:${scene.sceneId}:${take.takeId}`,
  mark: (take) => `mark:${take.kind === 'video' ? 'video' : 'image'}:${take.assetId}`,
  rejectUnused: (scene) => `reject-unused:${scene.sceneId}`,
  move: (scene, take) => `move:${scene.sceneId}:${take.takeId}`,
};
/** The control a review waits on, or null for a note alone. */
export const reviewTakeControl = (scene, take, review) => (review.acknowledgeRenderQuality ? takeControl.acknowledge(scene, take)
  : review.confirmFrame ? takeControl.confirm(scene, take)
    : review.acceptCharacterReferences ? takeControl.acceptCharacters(scene, take)
    : review.status ? takeControl.status(scene, take, review.status) : null);
