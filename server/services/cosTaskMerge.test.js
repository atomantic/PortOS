import { describe, it, expect } from 'vitest';
import { mergeTaskLists } from './cosTaskMerge.js';
import { LEASE_DURATION_MS } from './cosTaskClaim.js';

const NOW = Date.parse('2026-06-25T12:00:00.000Z');
const future = (ms) => new Date(NOW + ms).toISOString();
const past = (ms) => new Date(NOW - ms).toISOString();

// Minimal parsed-task factory (taskParser shape).
function task(id, status = 'pending', overrides = {}) {
  return {
    id,
    status,
    priority: overrides.priority || 'MEDIUM',
    priorityValue: 2,
    description: overrides.description || `desc ${id}`,
    metadata: overrides.metadata || {},
    ...overrides,
  };
}

// A live claim by `owner` (lease in the future).
const liveClaim = (owner, leaseMs = LEASE_DURATION_MS) => ({
  claimedBy: owner,
  claimedAt: past(1000),
  leaseExpiresAt: future(leaseMs),
});

describe('mergeTaskLists', () => {
  it('unions: keeps local-only and adopts remote-only tasks', () => {
    const local = [task('task-a')];
    const remote = [task('task-b')];
    const merged = mergeTaskLists(local, remote, { now: NOW });
    expect(merged.map((t) => t.id).sort()).toEqual(['task-a', 'task-b']);
  });

  it('adopts a remote-only task and re-derives priorityValue from its priority', () => {
    const remote = [task('task-x', 'pending', { priority: 'CRITICAL', priorityValue: 999 })];
    const [merged] = mergeTaskLists([], remote, { now: NOW });
    expect(merged.id).toBe('task-x');
    expect(merged.priorityValue).toBe(4); // CRITICAL
  });

  it('higher lifecycle status wins for a shared task with no live claims', () => {
    const local = [task('task-1', 'in_progress')];
    const remote = [task('task-1', 'completed')];
    const [merged] = mergeTaskLists(local, remote, { now: NOW });
    expect(merged.status).toBe('completed');
  });

  it('keeps the higher local status over a lower remote status', () => {
    const local = [task('task-1', 'completed')];
    const remote = [task('task-1', 'pending')];
    const [merged] = mergeTaskLists(local, remote, { now: NOW });
    expect(merged.status).toBe('completed');
  });

  it("propagates a remote peer's live claim onto a locally-unclaimed task (gates cross-machine spawn)", () => {
    const local = [task('task-1', 'pending')];
    const remote = [task('task-1', 'in_progress', { metadata: liveClaim('instance-B') })];
    const [merged] = mergeTaskLists(local, remote, { now: NOW });
    expect(merged.status).toBe('in_progress');
    expect(merged.metadata.claimedBy).toBe('instance-B');
    expect(merged.metadata.leaseExpiresAt).toBe(remote[0].metadata.leaseExpiresAt);
  });

  it("never clobbers the local peer's own live claim with a remote pending copy", () => {
    const local = [task('task-1', 'in_progress', { metadata: liveClaim('instance-A') })];
    const remote = [task('task-1', 'pending')]; // peer hasn't seen the claim yet
    const [merged] = mergeTaskLists(local, remote, { now: NOW });
    expect(merged.status).toBe('in_progress');
    expect(merged.metadata.claimedBy).toBe('instance-A');
  });

  it('both-claimed race converges to the later-lease owner', () => {
    const local = [task('task-1', 'in_progress', { metadata: liveClaim('instance-A', LEASE_DURATION_MS) })];
    const remote = [task('task-1', 'in_progress', { metadata: liveClaim('instance-B', LEASE_DURATION_MS * 2) })];
    // Run BOTH directions — the winner must be identical regardless of initiator.
    const [fromA] = mergeTaskLists(local, remote, { now: NOW });
    const [fromB] = mergeTaskLists(remote, local, { now: NOW });
    expect(fromA.metadata.claimedBy).toBe('instance-B');
    expect(fromB.metadata.claimedBy).toBe('instance-B');
  });

  it('both-claimed equal-lease race breaks the tie deterministically by smaller claimedBy', () => {
    const lease = future(LEASE_DURATION_MS);
    const a = { claimedBy: 'instance-A', claimedAt: past(1000), leaseExpiresAt: lease };
    const b = { claimedBy: 'instance-B', claimedAt: past(1000), leaseExpiresAt: lease };
    const local = [task('task-1', 'in_progress', { metadata: a })];
    const remote = [task('task-1', 'in_progress', { metadata: b })];
    const [fromA] = mergeTaskLists(local, remote, { now: NOW });
    const [fromB] = mergeTaskLists(remote, local, { now: NOW });
    expect(fromA.metadata.claimedBy).toBe('instance-A');
    expect(fromB.metadata.claimedBy).toBe('instance-A');
  });

  it('drops claim metadata when the merged status is terminal', () => {
    // Remote completed (claim already released); local still in_progress with a
    // stale live claim. Completed wins, and a terminal task carries no claim.
    const local = [task('task-1', 'in_progress', { metadata: liveClaim('instance-A') })];
    const remote = [task('task-1', 'completed')];
    const [merged] = mergeTaskLists(local, remote, { now: NOW });
    expect(merged.status).toBe('completed');
    expect(merged.metadata.claimedBy).toBeUndefined();
    expect(merged.metadata.leaseExpiresAt).toBeUndefined();
  });

  it('treats an expired remote lease as not-claimed (re-claimable)', () => {
    const expired = { claimedBy: 'instance-B', claimedAt: past(LEASE_DURATION_MS * 2), leaseExpiresAt: past(1000) };
    const local = [task('task-1', 'pending')];
    const remote = [task('task-1', 'pending', { metadata: expired })];
    const [merged] = mergeTaskLists(local, remote, { now: NOW });
    // No live lease either side → no live claim applied.
    expect(merged.metadata.claimedBy).toBeUndefined();
  });

  it('preserves non-claim metadata of the winning content side', () => {
    const local = [task('task-1', 'pending', { metadata: { context: 'local ctx' } })];
    const remote = [task('task-1', 'in_progress', { metadata: { context: 'remote ctx', ...liveClaim('instance-B') } })];
    const [merged] = mergeTaskLists(local, remote, { now: NOW });
    expect(merged.metadata.context).toBe('remote ctx');
    expect(merged.metadata.claimedBy).toBe('instance-B');
  });

  it('does not mutate the input arrays/objects', () => {
    const localMeta = { context: 'x' };
    const local = [task('task-1', 'pending', { metadata: localMeta })];
    const remote = [task('task-1', 'in_progress', { metadata: liveClaim('instance-B') })];
    mergeTaskLists(local, remote, { now: NOW });
    expect(localMeta).toEqual({ context: 'x' });
    expect(local[0].status).toBe('pending');
  });

  it('tolerates non-array / malformed inputs', () => {
    expect(mergeTaskLists(null, null, { now: NOW })).toEqual([]);
    expect(mergeTaskLists([task('a')], undefined, { now: NOW }).map((t) => t.id)).toEqual(['a']);
    // Entries missing an id are skipped, not adopted.
    expect(mergeTaskLists([{ status: 'pending' }], [], { now: NOW })).toEqual([]);
  });
});
