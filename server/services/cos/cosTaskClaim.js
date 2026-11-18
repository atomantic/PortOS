/**
 * CoS Task Claim + Lease: federated single-claim execution.
 *
 * Federated peers sharing a task backlog would each spawn an agent for the same
 * `pending` task. A task carries `claimedBy` (federation id), `claimedAt` and a
 * `leaseExpiresAt`; a peer spawns only a task whose lease is unset/expired or owned
 * by itself. The lease is time-bounded so a crashed claimant can't block its peer:
 * the owner renews it on the health-check sweep and the claim is released when the
 * task leaves `in_progress`.
 *
 * Pure: every function takes a plain task-metadata object and returns a boolean or
 * a patch to merge via `cosTaskStore.updateTask`.
 */

// Sized well above the 15 min health-check renewal cadence so a running agent's
// lease never lapses, while a crashed instance's claim frees within one window.
export const LEASE_DURATION_MS = 30 * 60 * 1000; // 30 minutes

// Exported so the store strips them in one place on release-on-transition.
export const CLAIM_METADATA_KEYS = Object.freeze(['claimedBy', 'claimedAt', 'leaseExpiresAt']);

/** Parse an ISO string or epoch number to epoch ms, or null when absent/unparseable. Shared with cosTaskMerge. */
export function parseTimestampMs(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const ms = typeof raw === 'number' ? raw : Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** Null means "no live lease", never "lease in the past". */
function leaseExpiryMs(metadata) {
  return parseTimestampMs(metadata?.leaseExpiresAt);
}

/** Is there a live (unexpired) lease on this task right now? */
export function isLeaseLive(metadata, now = Date.now()) {
  const expiry = leaseExpiryMs(metadata);
  return expiry !== null && expiry > now;
}

/** Recorded `claimedBy` or null; reflects an expired lease too, so pair with `isLeaseLive`. */
export function getClaimOwner(metadata) {
  const owner = metadata?.claimedBy;
  return owner === undefined || owner === null || owner === '' ? null : owner;
}

/** May `instanceId` spawn this task? True unless a DIFFERENT instance holds a live lease. */
export function isClaimableBy(metadata, instanceId, now = Date.now()) {
  if (!isLeaseLive(metadata, now)) return true;
  return getClaimOwner(metadata) === instanceId;
}

/** Held by another instance (live lease, different owner)? Orphan-reset uses this to leave a peer's work alone. */
export function isHeldByOther(metadata, instanceId, now = Date.now()) {
  if (!isLeaseLive(metadata, now)) return false;
  const owner = getClaimOwner(metadata);
  return owner !== null && owner !== instanceId;
}

/** Claim patch for a FRESH claim by `instanceId`. */
export function buildClaim(instanceId, { now = Date.now(), leaseMs = LEASE_DURATION_MS } = {}) {
  return {
    claimedBy: instanceId,
    claimedAt: new Date(now).toISOString(),
    leaseExpiresAt: new Date(now + leaseMs).toISOString()
  };
}

/**
 * Heartbeat patch: extends `leaseExpiresAt`, preserves `claimedAt`. Returns null
 * when not owned by `instanceId`; renewing a peer's lease would steal its claim.
 */
export function buildRenewal(metadata, instanceId, { now = Date.now(), leaseMs = LEASE_DURATION_MS } = {}) {
  if (getClaimOwner(metadata) !== instanceId) return null;
  return {
    claimedBy: instanceId,
    claimedAt: metadata?.claimedAt || new Date(now).toISOString(),
    leaseExpiresAt: new Date(now + leaseMs).toISOString()
  };
}

/** Release patch: `undefined` values are stripped by `cosTaskStore.updateTask`. */
export function buildRelease() {
  return Object.fromEntries(CLAIM_METADATA_KEYS.map((k) => [k, undefined]));
}

// Targeted assignment: `metadata.targetInstanceId` pins a task to ONE federated
// instance and every other peer passes over it. It decides *eligibility*; the lease
// still decides who is running it. A task pinned to an instance that left the
// federation is unspawnable until the assignment is cleared in the task editor.
export const TARGET_INSTANCE_KEY = 'targetInstanceId';

/**
 * The pinned instance, or null when unpinned. A whitespace-only value reads as
 * unpinned. `source` is a task's `metadata` or an `addTask` payload (top-level key),
 * so create and guard paths normalize identically.
 */
export function getTargetInstance(source) {
  const target = source?.[TARGET_INSTANCE_KEY];
  if (typeof target !== 'string') return null;
  const trimmed = target.trim();
  return trimmed === '' ? null : trimmed;
}

/** Pinned to a DIFFERENT instance? An unpinned task is never "elsewhere". */
export function isTargetedElsewhere(metadata, instanceId) {
  const target = getTargetInstance(metadata);
  return target !== null && target !== instanceId;
}

/**
 * Why THIS instance should pass over the task, as a log-ready phrase, or null when
 * it is a candidate. The pin (standing) is reported before the lease (transient).
 */
export function getSkipReason(metadata, instanceId, now = Date.now()) {
  const target = getTargetInstance(metadata);
  if (target !== null && target !== instanceId) return `assigned to instance ${target}`;
  if (isHeldByOther(metadata, instanceId, now)) return `live lease held by peer instance ${getClaimOwner(metadata)}`;
  return null;
}
