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
 * Parse a timestamp (an ISO string after the markdown round-trip, or an epoch
 * number in-memory) to epoch ms, or null when absent/unparseable. Shared by the
 * lease-expiry reader here and the lease/edit-stamp readers in cosTaskMerge so
 * the three callers don't each re-implement the same absent/NaN guard.
 */
export function parseTimestampMs(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const ms = typeof raw === 'number' ? raw : Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Parse `leaseExpiresAt` to epoch ms, or null when absent/unparseable. A null
 * here means "no live lease" — never "lease in the past".
 */
function leaseExpiryMs(metadata) {
  return parseTimestampMs(metadata?.leaseExpiresAt);
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

// ── Targeted assignment (issue #4520) ────────────────────────────────────────
//
// The claim/lease above is OPPORTUNISTIC: whichever peer evaluates a shared task
// first takes it. `metadata.targetInstanceId` is the opt-in override — the user
// pins a task to ONE federated instance ("run this generation task on the GPU
// box, not the laptop") and every other peer passes over it on sight. Absent
// (the default) restores the opportunistic behavior exactly.
//
// This is a cheap read-only guard alongside the lease check, NOT a second
// locking primitive: it decides *eligibility*, the lease still decides *who is
// currently running it*. A task pinned to an instance that has left the
// federation stops being spawnable anywhere — deliberate, and recoverable by
// clearing the assignment from the task editor.
export const TARGET_INSTANCE_KEY = 'targetInstanceId';

/**
 * The instance this task is pinned to, or null when it is unpinned (runnable by
 * any peer). Trims so a whitespace-only value reads as unpinned rather than as
 * a target no instance can ever match.
 *
 * `source` is anything carrying the key: a task's `metadata` (every read path)
 * or an `addTask` payload, which passes it top-level alongside `app`/`model`
 * before the store folds it into metadata. One reader for both keeps the create
 * path's normalization identical to the guards'.
 */
export function getTargetInstance(source) {
  const target = source?.[TARGET_INSTANCE_KEY];
  if (typeof target !== 'string') return null;
  const trimmed = target.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Is this task pinned to a DIFFERENT instance than `instanceId`? An unpinned
 * task is never "elsewhere", so a non-federated install answers false for every
 * task and behaves exactly as it did before the field existed.
 */
export function isTargetedElsewhere(metadata, instanceId) {
  const target = getTargetInstance(metadata);
  return target !== null && target !== instanceId;
}

/**
 * Why should THIS instance pass over the task during candidate selection, as a
 * log-ready phrase — or null when the task is a candidate here.
 *
 * Both spawn engines (`dequeueNextTask` in cos.js, `evaluateTasks` in
 * cosTaskGenerator.js) ask this same two-part question at four call sites, so it
 * lives here rather than being re-expressed at each one. Order matters only for
 * the message: the pin is a standing decision, the lease is transient, so the
 * pin is reported first when both apply.
 */
export function getSkipReason(metadata, instanceId, now = Date.now()) {
  const target = getTargetInstance(metadata);
  if (target !== null && target !== instanceId) return `assigned to instance ${target}`;
  if (isHeldByOther(metadata, instanceId, now)) return `live lease held by peer instance ${getClaimOwner(metadata)}`;
  return null;
}
