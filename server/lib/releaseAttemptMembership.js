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

/** Membership after one verified dispatch. `pristine` says no earlier dispatch
 * left accounting on the task, so a newly created record can be complete. */
export function appendReleaseAttempt(current, attempt, { pristine }) {
  const entry = { agentId: attempt.agentId, startedAt: attempt.startedAt, instanceId: attempt.instanceId };
  const base = parseReleaseAttempts(current) || { version: 1, complete: current === undefined && pristine === true, attempts: [] };
  const recorded = base.attempts.some(row => isDeepStrictEqual(row, entry));
  // An unrecordable entry or malformed history cannot be repaired here; keep the hold explicit.
  const fits = validAttempt(entry) && (recorded || base.attempts.length < MAX_ATTEMPTS);
  return { version: 1, complete: base.complete && fits, attempts: fits && !recorded ? [...base.attempts, entry] : base.attempts };
}

/** Peer/local union. Neither side can drop the other's entries or certify them
 * complete; malformed input collapses to an incomplete record that holds.
 * `localHistory` marks an existing local task that dispatched before it kept a
 * record: a peer's record cannot prove those unrecorded local attempts. */
export function mergeReleaseAttempts(local, remote, { localHistory = false } = {}) {
  if (local === undefined) {
    if (remote === undefined) return undefined;
    const adopted = parseReleaseAttempts(remote) || { version: 1, complete: false, attempts: [] };
    return localHistory ? { ...adopted, complete: false } : adopted;
  }
  if (remote === undefined || isDeepStrictEqual(local, remote)) return local;
  const left = parseReleaseAttempts(local);
  const right = parseReleaseAttempts(remote);
  const attempts = [...(left?.attempts || [])];
  for (const entry of right?.attempts || []) if (!attempts.some(row => isDeepStrictEqual(row, entry))) attempts.push(entry);
  const bounded = attempts.slice(0, MAX_ATTEMPTS);
  return { version: 1, complete: Boolean(left?.complete && right?.complete && bounded.length === attempts.length), attempts: bounded };
}
