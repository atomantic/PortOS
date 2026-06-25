/**
 * CoS Task Claim + Lease — federated single-claim execution (issue #1563)
 *
 * When two federated peers share the same task backlog (see #1561 full-sync
 * peer mode), both would otherwise parse the same `pending` task and each spawn
 * an agent for it — creating conflicting worktrees/branches on the same repo and
 * racing the orphan-reset. This module is the safety primitive that prevents
 * that: a task carries claim metadata (`claimedBy` = the producing instance's
 * federation id, `claimedAt`, and a `leaseExpiresAt` lease), and a peer only
 * spawns a task whose lease is unset/expired or already owned by itself.
 *
 * The lease is time-bounded so a crashed claimant can't block its peer forever:
 * the owning instance renews the lease on a heartbeat (folded into the periodic
 * health-check sweep) while its agent runs, and the claim is released when the
 * task leaves `in_progress`. A peer treats a task whose lease has expired as
 * free to claim.
 *
 * Pure + side-effect-free: every function operates on a plain task-metadata
 * object and returns either a boolean or a partial-metadata patch to merge via
 * `cosTaskStore.updateTask`. Persistence, sync, and scheduling live in the
 * callers (agentLifecycle.js spawn guard, cos.js orphan-reset + heartbeat,
 * cosTaskStore.js release-on-transition).
 */

// Lease duration. A claim stays "live" for this long after it was last set or
// renewed. Sized well above the health-check renewal cadence (15 min) so a
// long-running agent's lease never lapses mid-run, while a crashed instance's
// stale claim frees up for its peer within one lease window.
export const LEASE_DURATION_MS = 30 * 60 * 1000; // 30 minutes

// The metadata keys this module owns on a task. Exported so the store can strip
// them in one place when a task leaves `in_progress` (release-on-transition).
export const CLAIM_METADATA_KEYS = Object.freeze(['claimedBy', 'claimedAt', 'leaseExpiresAt']);

/**
 * Parse `leaseExpiresAt` (an ISO string after the markdown round-trip, or a
 * Date/number in-memory) to epoch ms, or null when absent/unparseable. A null
 * here means "no live lease" — never "lease in the past".
 */
function leaseExpiryMs(metadata) {
  const raw = metadata?.leaseExpiresAt;
  if (raw === undefined || raw === null || raw === '') return null;
  const ms = typeof raw === 'number' ? raw : Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Is there a live (unexpired) lease on this task right now?
 */
export function isLeaseLive(metadata, now = Date.now()) {
  const expiry = leaseExpiryMs(metadata);
  return expiry !== null && expiry > now;
}

/**
 * The instance currently holding the task's claim, or null. Note this reflects
 * the recorded `claimedBy` even if the lease has since expired — pair with
 * `isLeaseLive` when you need "actively held".
 */
export function getClaimOwner(metadata) {
  const owner = metadata?.claimedBy;
  return owner === undefined || owner === null || owner === '' ? null : owner;
}

/**
 * May `instanceId` spawn this task? True unless a DIFFERENT instance holds a
 * live lease. An unset/expired lease, or a live lease this instance already
 * owns (re-claim on retry / resume-after-restart), are both claimable.
 */
export function isClaimableBy(metadata, instanceId, now = Date.now()) {
  if (!isLeaseLive(metadata, now)) return true;
  return getClaimOwner(metadata) === instanceId;
}

/**
 * Is the task actively held by some OTHER instance (live lease, different
 * owner)? The orphan-reset uses this to leave a peer's in-flight work alone
 * rather than resetting it to pending and racing a second agent onto it.
 */
export function isHeldByOther(metadata, instanceId, now = Date.now()) {
  if (!isLeaseLive(metadata, now)) return false;
  const owner = getClaimOwner(metadata);
  return owner !== null && owner !== instanceId;
}

/**
 * Build the claim patch for a FRESH claim by `instanceId`. Stamps `claimedBy`,
 * a fresh `claimedAt`, and a lease `leaseMs` into the future. Merge the result
 * into the task's metadata.
 */
export function buildClaim(instanceId, { now = Date.now(), leaseMs = LEASE_DURATION_MS } = {}) {
  return {
    claimedBy: instanceId,
    claimedAt: new Date(now).toISOString(),
    leaseExpiresAt: new Date(now + leaseMs).toISOString()
  };
}

/**
 * Build the lease-renewal patch (heartbeat) for a task already owned by
 * `instanceId`. Extends `leaseExpiresAt` but preserves the original
 * `claimedAt`. Returns null when the task is NOT owned by this instance — a
 * peer must never renew another instance's lease (that would silently steal a
 * live claim); the caller should skip such tasks.
 */
export function buildRenewal(metadata, instanceId, { now = Date.now(), leaseMs = LEASE_DURATION_MS } = {}) {
  if (getClaimOwner(metadata) !== instanceId) return null;
  return {
    claimedBy: instanceId,
    claimedAt: metadata?.claimedAt || new Date(now).toISOString(),
    leaseExpiresAt: new Date(now + leaseMs).toISOString()
  };
}

/**
 * Build the release patch. Sets every claim key to `undefined` so
 * `cosTaskStore.updateTask`'s undefined-stripping drops them from the persisted
 * metadata, leaving the task freely claimable by either instance.
 */
export function buildRelease() {
  return Object.fromEntries(CLAIM_METADATA_KEYS.map((k) => [k, undefined]));
}
