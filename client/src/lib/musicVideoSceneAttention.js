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
import { sceneVisualLayer, sceneHasAuthoredSpan } from './musicVideoLayers.js';
import { performanceBlockedReason, performanceCapability, planPerformanceWindow, isPerformanceScene } from './musicVideoShotTiming.js';
import { sceneHasPendingDecision, sceneTakeList } from './musicVideoTakes.js';

// Mirrors render.js COVERAGE_TOLERANCE_SEC (#8964): a non-looping shot may run this far past its clip.
export const COVERAGE_TOLERANCE_SEC = 0.25;

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
});

/** Codes that mean the shot still lacks material a render needs (the `missing` filter). */
export const SCENE_MISSING_CODES = Object.freeze(['missing-frame', 'missing-clip', 'no-span']);

export const SCENE_FILTERS = Object.freeze(['all', 'attention', 'missing']);

/** The `?scenes=` value as a filter id; anything unknown is `all`. */
export const parseSceneFilter = (value) => (SCENE_FILTERS.includes(value) ? value : 'all');

function performanceBlocked(scene, { lipSyncBackend, songDurationSec }) {
  const capability = performanceCapability(lipSyncBackend);
  if (!capability) return performanceBlockedReason(lipSyncBackend);
  const plan = planPerformanceWindow({ startSec: scene.startSec, endSec: scene.endSec, songDurationSec: songDurationSec ?? Infinity, capability });
  return plan.ok ? null : plan.message;
}

/**
 * The attention codes for one scene, in display order (empty = nothing to do).
 * ctx: `layered`, `footageOptional` (a mode whose shots need no clip),
 * `lipSyncBackend`, `songDurationSec`, `clipSec` (the measured clip length —
 * only a mounted card knows it, so board-level counts omit `under-covered`),
 * and `failed: { frame: {sceneId: true}, video: {sceneId: true} }` for renders
 * that failed this session.
 */
export function sceneAttention(scene, ctx = {}) {
  if (!scene) return [];
  const { layered = false, footageOptional = false, lipSyncBackend = '', songDurationSec = null, clipSec = null, failed = {} } = ctx;
  const layer = sceneVisualLayer(scene, { layered });
  const codes = [];
  if (layer !== 'card' && !scene.referenceImageId) codes.push('missing-frame');
  if (layer === 'footage' && !footageOptional && !scene.videoHistoryId) codes.push('missing-clip');
  if (layer !== 'footage' && !sceneHasAuthoredSpan(scene)) codes.push('no-span');
  if (layer === 'footage' && scene.loop === false && scene.beatAligned && clipSec != null
    && typeof scene.startSec === 'number' && typeof scene.endSec === 'number'
    && scene.endSec - scene.startSec - clipSec > COVERAGE_TOLERANCE_SEC) codes.push('under-covered');
  const contract = scene.direction?.actionContract;
  if (contract && shotActionContractProblem(contract, scene)) codes.push('contract-problem');
  if (layer === 'footage' && isPerformanceScene(scene) && performanceBlocked(scene, { lipSyncBackend, songDurationSec })) codes.push('perf-blocked');
  if (sceneHasPendingDecision(scene)) codes.push('candidates-pending');
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
