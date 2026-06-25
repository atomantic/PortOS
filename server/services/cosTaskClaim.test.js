import { describe, it, expect } from 'vitest';
import {
  LEASE_DURATION_MS,
  CLAIM_METADATA_KEYS,
  isLeaseLive,
  getClaimOwner,
  isClaimableBy,
  isHeldByOther,
  buildClaim,
  buildRenewal,
  buildRelease
} from './cosTaskClaim.js';

const A = 'instance-aaaa';
const B = 'instance-bbbb';
const T0 = 1_700_000_000_000; // fixed epoch for deterministic lease math

describe('isLeaseLive', () => {
  it('false when no lease present', () => {
    expect(isLeaseLive({}, T0)).toBe(false);
    expect(isLeaseLive({ leaseExpiresAt: null }, T0)).toBe(false);
    expect(isLeaseLive({ leaseExpiresAt: '' }, T0)).toBe(false);
  });
  it('true when lease is in the future, false when in the past', () => {
    const future = { leaseExpiresAt: new Date(T0 + 1000).toISOString() };
    const past = { leaseExpiresAt: new Date(T0 - 1000).toISOString() };
    expect(isLeaseLive(future, T0)).toBe(true);
    expect(isLeaseLive(past, T0)).toBe(false);
  });
  it('accepts a numeric (in-memory) lease as well as an ISO string', () => {
    expect(isLeaseLive({ leaseExpiresAt: T0 + 1000 }, T0)).toBe(true);
  });
  it('false for an unparseable lease value (never throws)', () => {
    expect(isLeaseLive({ leaseExpiresAt: 'not-a-date' }, T0)).toBe(false);
  });
});

describe('getClaimOwner', () => {
  it('returns the owner or null', () => {
    expect(getClaimOwner({ claimedBy: A })).toBe(A);
    expect(getClaimOwner({})).toBeNull();
    expect(getClaimOwner({ claimedBy: '' })).toBeNull();
  });
});

describe('isClaimableBy', () => {
  it('claimable when no live lease', () => {
    expect(isClaimableBy({}, A, T0)).toBe(true);
  });
  it('claimable by the lease owner (re-claim on retry/resume)', () => {
    const mine = buildClaim(A, { now: T0 });
    expect(isClaimableBy(mine, A, T0)).toBe(true);
  });
  it('NOT claimable by a different instance while the lease is live', () => {
    const held = buildClaim(A, { now: T0 });
    expect(isClaimableBy(held, B, T0)).toBe(false);
  });
  it('claimable by anyone once the lease has expired', () => {
    const expired = buildClaim(A, { now: T0, leaseMs: 1000 });
    expect(isClaimableBy(expired, B, T0 + 2000)).toBe(true);
  });
});

describe('isHeldByOther', () => {
  it('true only for a live lease owned by a different instance', () => {
    const held = buildClaim(A, { now: T0 });
    expect(isHeldByOther(held, B, T0)).toBe(true);   // B sees A's live claim
    expect(isHeldByOther(held, A, T0)).toBe(false);  // A owns it
  });
  it('false when no lease or lease expired', () => {
    expect(isHeldByOther({}, B, T0)).toBe(false);
    const expired = buildClaim(A, { now: T0, leaseMs: 1000 });
    expect(isHeldByOther(expired, B, T0 + 2000)).toBe(false);
  });
});

describe('buildClaim', () => {
  it('stamps owner, claimedAt, and a lease LEASE_DURATION_MS in the future', () => {
    const patch = buildClaim(A, { now: T0 });
    expect(patch.claimedBy).toBe(A);
    expect(Date.parse(patch.claimedAt)).toBe(T0);
    expect(Date.parse(patch.leaseExpiresAt)).toBe(T0 + LEASE_DURATION_MS);
  });
});

describe('buildRenewal', () => {
  it('extends the lease but preserves the original claimedAt', () => {
    const claim = buildClaim(A, { now: T0 });
    const renewal = buildRenewal(claim, A, { now: T0 + 60_000 });
    expect(renewal.claimedAt).toBe(claim.claimedAt); // unchanged
    expect(Date.parse(renewal.leaseExpiresAt)).toBe(T0 + 60_000 + LEASE_DURATION_MS);
  });
  it('refuses to renew a lease owned by another instance', () => {
    const claim = buildClaim(A, { now: T0 });
    expect(buildRenewal(claim, B, { now: T0 + 60_000 })).toBeNull();
  });
});

describe('buildRelease', () => {
  it('sets every claim key to undefined so the store strips them', () => {
    const patch = buildRelease();
    for (const key of CLAIM_METADATA_KEYS) {
      expect(key in patch).toBe(true);
      expect(patch[key]).toBeUndefined();
    }
  });
});

// Criterion 5: two peers sharing one task list provably never both spawn the
// same task. This simulates the spawn-time decision each instance makes against
// the shared (synced) task record, applying claim patches as the store would.
describe('two-instance claim simulation (#1563 acceptance criterion 5)', () => {
  // mimic cosTaskStore.updateTask's metadata merge + undefined-stripping
  const applyPatch = (metadata, patch) => {
    const merged = { ...metadata, ...patch };
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
    return merged;
  };

  it('only one instance claims a free task; the other backs off', () => {
    let task = { id: 'task-1', metadata: {} };
    // Both peers evaluate the task at the same instant against the same record.
    const aCanClaim = isClaimableBy(task.metadata, A, T0);
    const bCanClaim = isClaimableBy(task.metadata, B, T0);
    expect(aCanClaim).toBe(true);
    expect(bCanClaim).toBe(true); // both *see* it free before either writes

    // A wins the write race (its claim syncs first). B re-reads the synced
    // record before spawning — the real guard is the re-check against the
    // freshest record, exactly as spawnAgentForTask does.
    task.metadata = applyPatch(task.metadata, buildClaim(A, { now: T0 }));
    expect(isClaimableBy(task.metadata, A, T0)).toBe(true);  // A proceeds
    expect(isClaimableBy(task.metadata, B, T0)).toBe(false); // B must back off
  });

  it('the lease holder keeps the task across a long run via heartbeat renewal', () => {
    let task = { id: 'task-1', metadata: buildClaim(A, { now: T0 }) };
    // Half an hour later, without renewal the lease would have lapsed and B
    // could steal the task. A renews on the health-check heartbeat first.
    const renewAt = T0 + LEASE_DURATION_MS - 60_000; // renew 1 min before expiry
    const renewal = buildRenewal(task.metadata, A, { now: renewAt });
    task.metadata = applyPatch(task.metadata, renewal);
    // Well past the ORIGINAL expiry, B still cannot claim — the lease moved.
    const afterOriginalExpiry = T0 + LEASE_DURATION_MS + 1000;
    expect(isHeldByOther(task.metadata, B, afterOriginalExpiry)).toBe(true);
    expect(isClaimableBy(task.metadata, B, afterOriginalExpiry)).toBe(false);
  });

  it('a crashed claimant (no renewal) frees the task for its peer after the lease window', () => {
    let task = { id: 'task-1', metadata: buildClaim(A, { now: T0 }) };
    // A crashes; no renewal happens. After the lease window B may take over.
    const afterExpiry = T0 + LEASE_DURATION_MS + 1;
    expect(isHeldByOther(task.metadata, B, afterExpiry)).toBe(false);
    expect(isClaimableBy(task.metadata, B, afterExpiry)).toBe(true);
    task.metadata = applyPatch(task.metadata, buildClaim(B, { now: afterExpiry }));
    expect(getClaimOwner(task.metadata)).toBe(B);
  });

  it('release frees the task immediately for either instance', () => {
    let task = { id: 'task-1', metadata: buildClaim(A, { now: T0 }) };
    task.metadata = applyPatch(task.metadata, buildRelease());
    for (const key of CLAIM_METADATA_KEYS) expect(key in task.metadata).toBe(false);
    expect(isClaimableBy(task.metadata, B, T0)).toBe(true);
  });
});
