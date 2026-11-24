/**
 * Per-model in-flight guard shared by the rig and retarget lanes.
 *
 * A rig and a retarget both open the same record's mesh in Blender and rewrite its
 * `rig`/`retarget` fields, so they must never overlap on one model. One map keyed by
 * modelId (value = the lane holding it) covers both. A re-entrancy guard against one
 * human's double-click, not a multi-actor lock (AGENTS.md single-user trust model).
 */
import { ServerError } from '../../lib/errorHandler.js';

const held = new Map();

const BUSY_MESSAGES = {
  rig: 'This model is already being rigged.',
  retarget: 'This model is already being animated.',
};

/** Claim the model for `lane` and return its cancel signal, or throw 409 RIGGING_IN_FLIGHT naming who holds it. */
export function acquireRigLane(modelId, lane) {
  const holder = held.get(modelId)?.lane;
  if (holder) {
    throw new ServerError(BUSY_MESSAGES[holder] || BUSY_MESSAGES[lane], { status: 409, code: 'RIGGING_IN_FLIGHT' });
  }
  const controller = new AbortController();
  held.set(modelId, { lane, controller });
  return controller.signal;
}

export function releaseRigLane(modelId, lane) {
  if (held.get(modelId)?.lane === lane) held.delete(modelId);
}

/**
 * Abort the rig/retarget worker holding `modelId` (model deletion). Returns whether a
 * lane was held; the lane's own `finally` releases it once the worker settles.
 */
export function cancelRiggingForModel(modelId) {
  const entry = held.get(modelId);
  if (!entry) return false;
  entry.controller.abort();
  return true;
}

/** Throw 409 RIGGING_CANCELLED when the lane was aborted (the model was deleted mid-run). */
export function throwIfCancelled(signal) {
  if (signal?.aborted) {
    throw new ServerError('Rigging was cancelled because the model was deleted.', { status: 409, code: 'RIGGING_CANCELLED' });
  }
}
