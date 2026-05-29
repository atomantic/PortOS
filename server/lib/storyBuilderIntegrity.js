/**
 * Unified Story Builder — integrity / staleness hashing.
 *
 * Pure, side-effect-free. When a Story Builder step is locked we snapshot a
 * hash of its *upstream inputs* (the whitelisted universe/series fields the
 * step's content was derived from). If those inputs later change — because the
 * user unlocked an earlier step and revised it — the locked downstream step is
 * "stale" and must be re-reviewed before the wizard advances. Content is never
 * destroyed; only the lock's trust is invalidated.
 *
 * The comparison is computed on read (in the route handler), never persisted:
 * the stored `upstreamHash` is frozen at lock time, and the current hash is
 * recomputed from live records each time the session is fetched.
 */

import { createHash } from 'crypto';

// Canonical, sorted-key projection so key-order churn (or a re-serialized
// record) doesn't change the hash. Recurses arrays + plain objects; leaves
// primitives untouched. Mirrors the canonical-stringify intent of
// `contentHashForRecord` in conflictJournal.js.
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

/**
 * Hash a step's upstream inputs. `stepId` is folded into the payload so two
 * steps that happen to share identical inputs still get distinct hashes (the
 * comparison is per-step anyway, but this keeps the helper collision-proof).
 * Only ever pass whitelisted SEMANTIC fields here — never `updatedAt` or other
 * churn, or every save would false-positive a staleness flag.
 */
export function hashUpstream(stepId, inputs) {
  const payload = JSON.stringify({ stepId, inputs: canonical(inputs ?? null) });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Given a session and a map of current upstream hashes (`{ [stepId]: hash }`),
 * return the ids of locked steps whose frozen `upstreamHash` no longer matches.
 * Unlocked steps are never flagged. A step with no current hash available is
 * skipped (we can't compare what we couldn't compute).
 */
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
