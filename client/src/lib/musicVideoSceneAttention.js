/**
 * Music Video per-scene "what is wrong with this shot" model (#10152).
 *
 * One pure answer shared by the collapsed scene row (chips), the Board filter
 * (counts and the `?scenes=` view) and the Produce status strip, so the three
 * never disagree about which shots need work. Each code names a condition the
 * expanded card already surfaced; this lifts them to where the director scans.
 */
import { shotActionContractProblem } from '../../../server/lib/musicVideoActionContract.js';
import { currentPlateEvidence } from '../../../server/lib/musicVideoPlateEvidence.js';
import { isEndFrameImageEffect } from './musicVideoImageEffects.js';
import { clipLoops, clipNeedsMoreFootage, isSelfDrawnLayer, sceneVisualLayer, sceneHasAuthoredSpan } from './musicVideoLayers.js';
import { performanceBlockedReason, performanceCapability, planPerformanceWindow, isPerformanceScene, selectedPerformanceInstruction } from './musicVideoShotTiming.js';
import { sceneHasPendingDecision, sceneTakeList } from './musicVideoTakes.js';

export { COVERAGE_TOLERANCE_SEC } from './musicVideoLayers.js';

export const SCENE_ATTENTION_LABELS = Object.freeze({
  'missing-frame': 'No frame',
  'missing-clip': 'No clip',
  'under-covered': 'Clip too short',
  'contract-problem': 'Shot intent problem',
  'perf-blocked': 'Performance blocked',
  'candidates-pending': 'Takes to review',
  'plate-unverified': 'Plate unverified',
  'no-span': 'No time span',
  'last-failure': 'Last render failed',
  'song-changed': 'Lyrics changed',
  'song-new': 'New lyrics',
  'song-cut': 'Lyrics cut',
});

// A revised song's verdict on a shot (server songRevision.js sceneReview) as its attention code.
const SONG_REVIEW_CODES = Object.freeze({ changed: 'song-changed', new: 'song-new', removed: 'song-cut' });

/** Codes that mean the shot still lacks material a render needs (the `missing` filter). */
export const SCENE_MISSING_CODES = Object.freeze(['missing-frame', 'missing-clip', 'no-span']);

export const SCENE_FILTERS = Object.freeze(['all', 'attention', 'missing']);

/**
 * The take slots a shot's picture uses: footage all of them, a still its frame
 * (and its end frame for an image effect that plays into it), a card or code
 * shot none. Takes left in a slot the shot does not use are not waiting on review.
 */
function takeKindsInUse(scene, layer) {
  if (layer === 'footage') return undefined;
  if (layer !== 'still') return [];
  return isEndFrameImageEffect(scene.imageEffect) ? ['image', 'endImage'] : ['image'];
}

/** The `?scenes=` value as a filter id; anything unknown is `all`. */
export const parseSceneFilter = (value) => (SCENE_FILTERS.includes(value) ? value : 'all');

function performanceBlocked(scene, { lipSyncBackend, songDurationSec, videoSettings }) {
  const capability = performanceCapability(lipSyncBackend, { scene, videoSettings });
  if (!capability) return performanceBlockedReason(lipSyncBackend);
  const plan = planPerformanceWindow({ startSec: scene.startSec, endSec: scene.endSec, songDurationSec: songDurationSec ?? Infinity, capability });
  return plan.ok ? null : plan.message;
}

/**
 * The attention codes for one scene, in display order (empty = nothing to do).
 * ctx: `layered`, `footageOptional` (a mode whose shots need no clip),
 * `lipSyncBackend`, `songDurationSec`, `clipSec` (the measured clip length as it plays, with any hand-set speed and offset —
 * only a mounted card knows it, so board-level counts omit `under-covered`),
 * and `failed: { frame: {sceneId: true}, video: {sceneId: true} }` for renders
 * that failed this session, and `songReview` (the project's revised-song
 * verdicts by sceneId) so a shot the new lyrics changed is flagged until acted on.
 * `locked`: the director locked this shot, so its other takes are not waiting on review.
 */
export function sceneAttention(scene, ctx = {}) {
  if (!scene) return [];
  const { layered = false, footageOptional = false, lipSyncBackend = '', songDurationSec = null, clipSec = null, failed = {}, songReview = null, videoSettings = null, locked = false } = ctx;
  const layer = sceneVisualLayer(scene, { layered });
  const codes = [];
  const songChange = songReview?.[scene.sceneId];
  if (songChange && !songChange.resolved && SONG_REVIEW_CODES[songChange.status]) codes.push(SONG_REVIEW_CODES[songChange.status]);
  // A code-rendered clip was made without a seed frame, so it needs none.
  const codeRendered = scene.codeClip && scene.videoHistoryId;
  if (!isSelfDrawnLayer(layer) && !scene.referenceImageId && !codeRendered) codes.push('missing-frame');
  if (layer === 'footage' && !footageOptional && !scene.videoHistoryId) codes.push('missing-clip');
  if (layer !== 'footage' && !sceneHasAuthoredSpan(scene)) codes.push('no-span');
  if (layer === 'footage' && scene.beatAligned && sceneHasAuthoredSpan(scene)
    && clipNeedsMoreFootage({ loop: clipLoops(scene, selectedPerformanceInstruction(scene)?.edit),
      holdLastFrame: scene.holdLastFrame, spanSec: scene.endSec - scene.startSec, clipSec })) codes.push('under-covered');
  const contract = scene.direction?.actionContract;
  if (contract && shotActionContractProblem(contract, scene)) codes.push('contract-problem');
  if (layer === 'footage' && isPerformanceScene(scene) && performanceBlocked(scene, { lipSyncBackend, songDurationSec, videoSettings })) codes.push('perf-blocked');
  if (!locked && sceneHasPendingDecision(scene, { kinds: takeKindsInUse(scene, layer) })) codes.push('candidates-pending');
  if (contract && scene.referenceImageId) {
    const selected = sceneTakeList(scene, 'image').find((take) => take.assetId === scene.referenceImageId);
    if (currentPlateEvidence(scene, selected)?.verdict !== 'pass') codes.push('plate-unverified');
  }
  if (failed.frame?.[scene.sceneId] || failed.video?.[scene.sceneId]) codes.push('last-failure');
  return codes;
}

/** Does `scene` belong in the given board filter? `codes` is its `sceneAttention` result. */
export function sceneMatchesFilter(codes, filter) {
  if (filter === 'attention') return codes.length > 0;
  if (filter === 'missing') return codes.some((code) => SCENE_MISSING_CODES.includes(code));
  return true;
}

export const SCENE_MEDIA_LABELS = Object.freeze({ clip: 'Clip', image: 'Image', code: 'Code', card: 'Card' });

/**
 * What a scene's selected media is, for the Board thumbnail badge: `clip` (a
 * rendered video is selected), `image` (only a still frame, whether the shot is
 * a still or footage still waiting on its clip), `code` / `card` (the
 * composition draws it, or the clip was rendered from code), or null when
 * nothing is selected yet.
 */
export function sceneMediaKind(scene, { layered = false } = {}) {
  if (!scene) return null;
  const layer = sceneVisualLayer(scene, { layered });
  if (isSelfDrawnLayer(layer)) return layer;
  // A clip rendered from code (`codeClip`) is still footage to the render, but it reads as Code.
  if (layer === 'footage' && scene.videoHistoryId) return scene.codeClip ? 'code' : 'clip';
  return scene.referenceImageId ? 'image' : null;
}
