import { formatUsd } from '../utils/formatters.js';
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
export function buildSceneTimingPresentation({
  scene, layer, lipSyncBackend, songDurationSec, falVideoSettings,
  nextEndSec, isLast, documentComposition, hasMergeNext, lineCues = null,
  prevStartSec = null, isFirst = true, hasMergePrevious = false,
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
  const grokPlan = !performance && lipSyncBackend === 'grok' && timedSpan != null ? grokCoverage(timedSpan) : null;
  // The priced take on a paid lane (fal.ai or Runway); `falTake` keeps its name for the fal-shaped consumers.
  const falTake = layer === 'footage'
    ? meteredSceneTake(lipSyncBackend, { scene, videoSettings: falVideoSettings || {}, songDurationSec, lineCues })
    : null;
  const falCost = falEstimate(falTake);
  const performanceCost = falTake?.performance ? (falCost || capability?.costLabel) : capability?.costLabel;
  const splitLimit = layer === 'footage' ? shotSplitLimit(scene, lipSyncBackend, falVideoSettings) : null;
  const canSplit = splitLimit != null && timedSpan != null && timedSpan > splitLimit + 1e-6;
  const mergedSpan = typeof scene.startSec === 'number' && typeof nextEndSec === 'number' ? nextEndSec - scene.startSec : null;
  const canMerge = hasMergeNext && !isLast && !documentComposition
    && (splitLimit == null || (mergedSpan != null && mergedSpan <= splitLimit + 1e-6));
  // Merge over previous keeps this shot and starts it where the previous one did.
  const mergedPreviousSpan = typeof prevStartSec === 'number' && typeof scene.endSec === 'number' ? scene.endSec - prevStartSec : null;
  const canMergePrevious = hasMergePrevious && !isFirst && !documentComposition
    && (splitLimit == null || (mergedPreviousSpan != null && mergedPreviousSpan <= splitLimit + 1e-6));
  return {
    performance, capability, timedSpan, plan, performanceBlocked, grokPlan,
    falTake, falCost, performanceCost, splitLimit, canSplit, mergedSpan, canMerge, canMergePrevious,
  };
}
