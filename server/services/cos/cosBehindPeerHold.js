/**
 * CoS behind-peer hold: the tasks this install leaves to a full-sync peer that is
 * on an older `cosTasks` schema (#16871).
 *
 * The task sync gate is one-directional on purpose: a receiver skips a payload
 * whose schema is ahead of its own, because it cannot read that shape, and merges
 * one at or below it. While two installs differ, the newer one therefore still
 * sees the older peer's claims, but the older peer sees none of the newer one's.
 * A pending task both hold would run on each. The older peer cannot be changed,
 * so the newer install yields: it does not dispatch a task that peer also holds,
 * and the peer's claim and completion arrive through the payloads it still merges.
 *
 * In memory only, because every sweep of a behind peer rebuilds that peer's
 * entry. The first sweep that finds the peer at or past the local schema drops
 * it, and an entry whose peer has not answered for one lease stops holding, the
 * way a crashed claimant's lease frees its task.
 *
 * A fresh process knows nothing until its first sweep, and the restart that
 * installs a newer schema is exactly what opens the window. So the spawn guard
 * waits for that first sweep once (`behindPeersKnown`) before its first dispatch.
 *
 * A leaf over the pure claim module, so the spawn guard and the dequeue passes do
 * not load the peer-sync graph to ask; peerCosSync hands its sweep over instead.
 */

import { LEASE_DURATION_MS, getSkipReason, getTargetInstance } from './cosTaskClaim.js';

const behindPeers = new Map(); // peerInstanceId → { sweptAt: epoch ms, taskIds: Set<string> }

let trackedSweep = null; // peerCosSync's all-peers sweep, wrapped when that module loads
let firstSweep = null; // settles when this process has asked its peers once

/**
 * Wrap the all-peers task sweep so its first pass is the one a dispatch waits
 * on, whether the timer or a dispatch starts it. peerCosSync exports the wrapper
 * as its sweep. Without one (a suite, a process with no peer sync) nothing waits.
 */
export function trackBehindPeerSweep(sweep) {
  trackedSweep = () => {
    const pass = Promise.resolve().then(sweep);
    firstSweep ??= pass.then(() => {}, () => {});
    return pass;
  };
  return trackedSweep;
}

/**
 * Settles once this process has asked every full-sync peer what it holds,
 * starting that sweep if the timer has not yet. A failed or unreachable peer
 * still settles it: a peer that does not answer is not relied on.
 */
export function behindPeersKnown() {
  if (firstSweep === null && trackedSweep !== null) trackedSweep();
  return firstSweep ?? Promise.resolve();
}

/**
 * Record what a behind-schema peer holds, from the payload a sweep just read.
 * `completed` entries are left out: the peer will not run those again, and the
 * merge settles them here. Returns true when this sweep starts the hold, so the
 * caller reports the window once and not on every sweep.
 */
export function recordBehindPeerSweep(peerInstanceId, tasks, now = Date.now()) {
  const taskIds = new Set();
  for (const task of tasks) {
    if (task.status !== 'completed') taskIds.add(task.id);
  }
  const started = !behindPeers.has(peerInstanceId);
  behindPeers.set(peerInstanceId, { sweptAt: now, taskIds });
  return started;
}

/**
 * The peer is no longer behind (its payload carries the local schema, or a newer
 * one). Returns true when that ends a hold.
 */
export function clearBehindPeer(peerInstanceId) {
  return behindPeers.delete(peerInstanceId);
}

/**
 * The behind-schema peer this install leaves the task to, or null when it may
 * run here. A task pinned to this install is never left to a peer: a pin the
 * peer already holds keeps it off the task there, and one set during the window
 * is how the user runs a held task here without waiting for the peer to update.
 */
export function getBehindPeerHolder(task, instanceId, now = Date.now()) {
  if (getTargetInstance(task.metadata) === instanceId) return null;
  for (const [peerInstanceId, { sweptAt, taskIds }] of behindPeers) {
    if (now - sweptAt > LEASE_DURATION_MS) {
      // Unreachable for a whole lease: it cannot be relied on to run anything.
      behindPeers.delete(peerInstanceId);
      continue;
    }
    if (taskIds.has(task.id)) return peerInstanceId;
  }
  return null;
}

/** Log-ready phrase for a behind-peer hold, shared by the spawn guard and the dequeue passes. */
export function behindPeerHoldReason(peerInstanceId) {
  return `left to peer instance ${peerInstanceId}, which is on an older task schema and cannot see a claim made here`;
}

/**
 * Why this install should pass over the task during candidate selection, as a
 * log-ready phrase, or null when it is a candidate: the pin and the live lease
 * (`getSkipReason`), then a behind-schema peer's hold.
 */
export function getDispatchSkipReason(task, instanceId, now = Date.now()) {
  const reason = getSkipReason(task.metadata, instanceId, now);
  if (reason) return reason;
  const holder = getBehindPeerHolder(task, instanceId, now);
  return holder === null ? null : behindPeerHoldReason(holder);
}
