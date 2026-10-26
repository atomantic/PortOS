import { continuationContract, MAX_CONTEXT_FRAMES } from './videoContinuity.js';

// Queue/history projections carry contract evidence, never worker-owned paths.
export const sanitizeContinuation = (value) => {
  if (!value || typeof value !== 'object'
    || !['auto', 'frame', 'window'].includes(value.requestedStrategy)
    || !['frame', 'window'].includes(value.effectiveStrategy)
    || typeof value.runtime !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value.runtime)
    || typeof value.capability !== 'boolean'
    || !Number.isInteger(value.contextFrames) || value.contextFrames < 0 || value.contextFrames > MAX_CONTEXT_FRAMES
    || !(value.actualHistoryFrames === null || (Number.isInteger(value.actualHistoryFrames)
      && value.actualHistoryFrames >= 0 && value.actualHistoryFrames <= MAX_CONTEXT_FRAMES))) return undefined;
  const canonicalReason = continuationContract(value.runtime).unavailableReason;
  const pin = typeof value.backendPin === 'string'
    && /^(?:[a-f0-9]{40}|diffusers==[0-9]+\.[0-9]+\.[0-9]+)$/.test(value.backendPin)
    ? value.backendPin : null;
  const reason = typeof value.unavailableReason === 'string' && value.unavailableReason.length <= 300
    && !/[\x00-\x1f\x7f]/.test(value.unavailableReason)
    && (value.unavailableReason === canonicalReason
      || !/(?:\/(?:Users|home|tmp|private|var)\/|[a-z]:[\\/]|\\)/i.test(value.unavailableReason))
    ? value.unavailableReason : null;
  const hops = Array.isArray(value.hops) ? value.hops.slice(0, 100).flatMap(hop => {
    if (!hop || !Number.isSafeInteger(hop.startFrame) || hop.startFrame < 0
      || !Number.isSafeInteger(hop.endFrameExclusive) || hop.endFrameExclusive <= hop.startFrame
      || !Number.isInteger(hop.actualHistoryFrames) || hop.actualHistoryFrames <= 0
      || hop.actualHistoryFrames > MAX_CONTEXT_FRAMES
      || hop.endFrameExclusive - hop.startFrame !== hop.actualHistoryFrames
      || !Number.isFinite(hop.audioStartSec) || hop.audioStartSec < 0
      || !Number.isFinite(hop.audioEndSec) || hop.audioEndSec <= hop.audioStartSec) return [];
    return [{ startFrame: hop.startFrame, endFrameExclusive: hop.endFrameExclusive,
      actualHistoryFrames: hop.actualHistoryFrames, audioStartSec: hop.audioStartSec, audioEndSec: hop.audioEndSec }];
  }) : [];
  return {
    ...(hops.length ? { hops } : {}),
    requestedStrategy: value.requestedStrategy,
    effectiveStrategy: value.effectiveStrategy,
    contextFrames: value.contextFrames,
    actualHistoryFrames: value.actualHistoryFrames,
    runtime: value.runtime,
    capability: value.capability,
    backendPin: pin,
    unavailableReason: reason,
  };
};
