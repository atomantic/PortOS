import { formatUsd } from '../utils/formatters.js';
import { planProjectSequenceCoverage } from '../../../server/lib/musicVideoSequenceCoverage.js';
import { resolveSourceTake } from '../../../server/lib/musicVideoSourceTake.js';
import {
  grokCoverage, isPerformanceScene, meteredSceneTake, performanceBlockedReason, performanceCapability, planPerformanceWindow, shotSplitLimit,
} from './musicVideoShotTiming.js';

// "est. $0.81 (5.05s at 1080P)" — or null when the take cannot be priced.
const falEstimate = (take) => (take?.costUsd == null ? null
  : `est. ${formatUsd(take.costUsd)} (${take.seconds}s${take.resolution ? ` at ${take.resolution}` : ''})`);

/**
 * Provider timing and cost presentation for one scene. Domain policy remains
 * in the canonical shot-timing helpers shared with media submission.
 */
function sharedCoverage({ scene, project, layer, lipSyncBackend, songDurationSec, falVideoSettings, lineCues }) {
  if (!project || layer !== 'footage') return null;
  const scenes = project.scenes || [];
  const resolved = resolveSourceTake(scene, scenes);
  if (resolved) {
    return {
      grokPlan: null, falTake: null, coverageSpan: null, coverageNoun: null,
      sharedNotice: `Plays ${resolved.source?.label || 'the source shot'}'s take from ${resolved.offsetSec.toFixed(2)}s`,
    };
  }
  if (scene?.coverage !== 'sequence') return null;
  const group = planProjectSequenceCoverage(project).groups.find((item) => item.sceneIds.includes(scene.sceneId));
  if (!group) return null;
  const seconds = group.requestSec ?? group.durationSec;
  if (group.sceneIds.indexOf(scene.sceneId) > 0) {
    return {
      grokPlan: null, falTake: null, coverageSpan: null, coverageNoun: null,
      sharedNotice: `Included in one ${seconds}s sequence request`,
    };
  }
  const synthetic = { ...scene, startSec: 0, endSec: group.durationSec, clipLengthSec: group.durationSec };
  return {
    coverageSpan: group.durationSec,
    coverageNoun: 'run',
    grokPlan: lipSyncBackend === 'grok' ? grokCoverage(group.durationSec) : null,
    falTake: meteredSceneTake(lipSyncBackend, {
      scene: synthetic, scenes, videoSettings: falVideoSettings || {}, songDurationSec, lineCues,
    }),
    sharedNotice: null,
  };
}

export function buildSceneTimingPresentation({
  scene, layer, lipSyncBackend, songDurationSec, falVideoSettings,
  nextEndSec, isLast, manifestOwnsShots, hasMergeNext, lineCues = null,
  prevStartSec = null, isFirst = true, hasMergePrevious = false, project = null,
}) {
  const performance = isPerformanceScene(scene);
  const capability = performance ? performanceCapability(lipSyncBackend, { scene, videoSettings: falVideoSettings }) : null;
  const timedSpan = typeof scene.startSec === 'number' && typeof scene.endSec === 'number' && scene.endSec > scene.startSec
    ? scene.endSec - scene.startSec
    : null;
  const plan = capability
    ? planPerformanceWindow({ startSec: scene.startSec, endSec: scene.endSec, songDurationSec: songDurationSec ?? Infinity, capability, lineCues })
    : null;
  const performanceBlocked = performance
    ? (capability ? (plan.ok ? null : plan.message) : performanceBlockedReason(lipSyncBackend))
    : null;
  const shared = sharedCoverage({ scene, project, layer, lipSyncBackend, songDurationSec, falVideoSettings, lineCues });
  const grokPlan = shared ? shared.grokPlan : (!performance && lipSyncBackend === 'grok' && timedSpan != null ? grokCoverage(timedSpan) : null);
  // The priced take on a paid lane (fal.ai or Runway); `falTake` keeps its name for the fal-shaped consumers.
  const falTake = shared ? shared.falTake : (layer === 'footage'
    ? meteredSceneTake(lipSyncBackend, { scene, scenes: project?.scenes, videoSettings: falVideoSettings || {}, songDurationSec, lineCues })
    : null);
  const falCost = falEstimate(falTake);
  const performanceCost = falTake?.performance ? (falCost || capability?.costLabel) : capability?.costLabel;
  const splitLimit = layer === 'footage' ? shotSplitLimit(scene, lipSyncBackend, falVideoSettings) : null;
  const canSplit = splitLimit != null && timedSpan != null && timedSpan > splitLimit + 1e-6;
  const mergedSpan = typeof scene.startSec === 'number' && typeof nextEndSec === 'number' ? nextEndSec - scene.startSec : null;
  const canMerge = hasMergeNext && !isLast && !manifestOwnsShots
    && (splitLimit == null || (mergedSpan != null && mergedSpan <= splitLimit + 1e-6));
  // A merge one take can't hold stays visible, disabled, so the control never just vanishes.
  const tooLongToMerge = (span) => (splitLimit != null && (span == null || span > splitLimit + 1e-6)
    ? (span == null ? 'Give both shots a start and end first.' : `The merged shot would run ${span.toFixed(2)}s; this renderer's longest take is ${splitLimit.toFixed(2)}s. Pick another renderer to merge them.`)
    : null);
  const mergeBlocked = hasMergeNext && !isLast && !manifestOwnsShots ? tooLongToMerge(mergedSpan) : null;
  // Merge over previous keeps this shot and starts it where the previous one did.
  const mergedPreviousSpan = typeof prevStartSec === 'number' && typeof scene.endSec === 'number' ? scene.endSec - prevStartSec : null;
  const canMergePrevious = hasMergePrevious && !isFirst && !manifestOwnsShots
    && (splitLimit == null || (mergedPreviousSpan != null && mergedPreviousSpan <= splitLimit + 1e-6));
  const mergePreviousBlocked = hasMergePrevious && !isFirst && !manifestOwnsShots ? tooLongToMerge(mergedPreviousSpan) : null;
  return {
    mergeBlocked, mergePreviousBlocked,
    performance, capability, timedSpan, plan, performanceBlocked, grokPlan,
    falTake, falCost, performanceCost, splitLimit, canSplit, mergedSpan, canMerge, canMergePrevious,
    coverageSpan: shared?.coverageSpan ?? null, coverageNoun: shared?.coverageNoun ?? null, sharedNotice: shared?.sharedNotice ?? null,
  };
}
