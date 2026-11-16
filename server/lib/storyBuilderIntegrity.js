/**
 * Unified Story Builder integrity / staleness hashing (`hashUpstream`, `computeStaleSteps`, `computeSyncDrift`). Pure.
 *
 * When a step is locked we snapshot a hash of its *upstream inputs* (the whitelisted universe/series fields its content derived from); if they later change (the user unlocked and revised an earlier step) the locked downstream step is "stale" and must be re-reviewed before the wizard advances (content is never destroyed; only the lock's trust). The comparison is computed on read in the route handler, never persisted: the stored `upstreamHash` is frozen at lock time, the current hash recomputed from live records on each fetch.
 */

import { createHash } from 'crypto';

// Canonical sorted-key projection so key-order churn (or a re-serialized record) doesn't change the hash; mirrors `contentHashForRecord` in conflictJournal.js.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        acc[k] = canonical(value[k]);
        return acc;
      }, {});
  }
  return value;
}

/** Hash a step's upstream inputs; `stepId` is folded in so steps with identical inputs still hash distinctly. Pass only whitelisted SEMANTIC fields (never `updatedAt` or other churn, or every save false-positives staleness). */
export function hashUpstream(stepId, inputs) {
  const payload = JSON.stringify({ stepId, inputs: canonical(inputs ?? null) });
  return createHash('sha256').update(payload).digest('hex');
}

/** The ids of locked steps whose frozen `upstreamHash` no longer matches the current hashes (`{ [stepId]: hash }`); unlocked steps are never flagged and a step with no current hash is skipped (can't compare what couldn't be computed). */
export function computeStaleSteps(session, currentHashes = {}) {
  const steps = session?.steps || {};
  const stale = [];
  for (const [stepId, state] of Object.entries(steps)) {
    if (!state || state.locked !== true) continue;
    const current = currentHashes[stepId];
    if (current == null) continue;
    if (state.upstreamHash !== current) stale.push(stepId);
  }
  return stale;
}

/**
 * For a sync-enabled session, whether THIS machine's live upstream records drifted from the session-carried `syncedHashes` baseline (#730): the "reconcile would change something" signal. A synced session keys staleness off `syncedHashes` (a peer's edit can't false-positive it) but the user may adopt this machine's records as the new baseline,
 * needed only when a locked step's live hash no longer matches. A locked step missing from the baseline counts as drift; one with no live hash is skipped; false with no locked steps or all matching.
 */
export function computeSyncDrift(session, currentHashes = {}, syncedHashes = {}) {
  const steps = session?.steps || {};
  for (const [stepId, state] of Object.entries(steps)) {
    if (!state || state.locked !== true) continue;
    const current = currentHashes[stepId];
    if (current == null) continue;
    if ((syncedHashes?.[stepId] ?? null) !== current) return true;
  }
  return false;
}
