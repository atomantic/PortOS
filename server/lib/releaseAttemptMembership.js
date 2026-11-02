/** Store-owned membership of every dispatched release attempt on one task.
 * Unlike the spawn-budget episode, retry resets never clear it. Entries are only
 * appended by a verified dispatch and never removed, rewritten or reordered.
 * `complete: false` means an attempt may predate the record, so recovery holds. */
import { isDeepStrictEqual } from 'node:util';

export const RELEASE_ATTEMPTS_KEY = 'releaseAttempts';
const MAX_ATTEMPTS = 256;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 200;

const validAttempt = entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
  && Object.keys(entry).length === 3 && text(entry.agentId) && text(entry.startedAt) && text(entry.instanceId);

/** The validated membership, or null when absent/malformed. */
export function parseReleaseAttempts(value) {
  if (value?.version !== 1 || typeof value.complete !== 'boolean' || !Array.isArray(value.attempts)
    || Object.keys(value).length !== 3 || value.attempts.length > MAX_ATTEMPTS || !value.attempts.every(validAttempt)) return null;
  return value;
}

/** Membership after one verified dispatch, or null when it cannot be recorded
 * (the store then refuses the dispatch, so no attempt runs unrecorded).
 * `pristine` says no earlier dispatch left accounting on the task, so a newly
 * created record can be complete. Malformed history stays an incomplete hold. */
export function appendReleaseAttempt(current, attempt, { pristine }) {
  const entry = { agentId: attempt.agentId, startedAt: attempt.startedAt, instanceId: attempt.instanceId };
  const base = parseReleaseAttempts(current) || { version: 1, complete: current === undefined && pristine === true, attempts: [] };
  if (base.attempts.some(row => isDeepStrictEqual(row, entry))) return base;
  if (!validAttempt(entry) || base.attempts.length >= MAX_ATTEMPTS) return null;
  return { ...base, attempts: [...base.attempts, entry] };
}

/** Peer/local union. Neither side can drop the other's entries or certify them
 * complete; malformed input collapses to an incomplete record that holds.
 * `localHistory`/`remoteHistory` mark a side whose copy shows dispatch history
 * but carries no record (it predates membership or an older peer dispatched
 * it): the other side's record cannot prove those unrecorded attempts. */
export function mergeReleaseAttempts(local, remote, { localHistory = false, remoteHistory = false } = {}) {
  if (local === undefined || remote === undefined) {
    const present = local ?? remote;
    if (present === undefined) return undefined;
    const adopted = parseReleaseAttempts(present) || { version: 1, complete: false, attempts: [] };
    const unrecorded = local === undefined ? localHistory : remoteHistory;
    if (unrecorded && adopted.complete) return { ...adopted, complete: false };
    return local === undefined ? adopted : local;
  }
  if (isDeepStrictEqual(local, remote)) return local;
  const left = parseReleaseAttempts(local);
  const right = parseReleaseAttempts(remote);
  const attempts = [...(left?.attempts || [])];
  for (const entry of right?.attempts || []) if (!attempts.some(row => isDeepStrictEqual(row, entry))) attempts.push(entry);
  // Local entries (already within the cap) always survive. A union beyond the
  // cap is not representable, so it is recorded as an incomplete hold.
  const bounded = attempts.slice(0, MAX_ATTEMPTS);
  return { version: 1, complete: Boolean(left?.complete && right?.complete && bounded.length === attempts.length), attempts: bounded };
}
