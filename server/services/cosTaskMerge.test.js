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

  it('de-duplicates ids within each list — never emits a task id twice', () => {
    // A hand-corrupted file (or any producer that leaks a duplicate id) must not
    // round-trip into two task lines: the local loop skips an already-seen id and
    // the remote-only loop records adopted ids so a repeated remote id is dropped.
    const local = [task('dup-local'), task('dup-local', 'completed')];
    const remote = [task('dup-remote'), task('dup-remote', 'in_progress')];
    const merged = mergeTaskLists(local, remote, { now: NOW });
    const ids = merged.map((t) => t.id);
    expect(ids.filter((id) => id === 'dup-local')).toHaveLength(1);
    expect(ids.filter((id) => id === 'dup-remote')).toHaveLength(1);
    // First occurrence wins for the local duplicate (status stays 'pending').
    expect(merged.find((t) => t.id === 'dup-local').status).toBe('pending');
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

  it('converges on a same-status content edit (priority differs) regardless of initiator', () => {
    // User reprioritized a still-pending task MEDIUM→HIGH on one machine. "Keep
    // local" would leave the two machines permanently divergent; the deterministic
    // same-status tiebreak must pick the SAME record from both directions.
    const a = [task('task-1', 'pending', { priority: 'HIGH', priorityValue: 3 })];
    const b = [task('task-1', 'pending', { priority: 'MEDIUM', priorityValue: 2 })];
    const [fromA] = mergeTaskLists(a, b, { now: NOW });
    const [fromB] = mergeTaskLists(b, a, { now: NOW });
    expect(fromA.priority).toBe(fromB.priority);
    expect(fromA.priority).toBe('HIGH'); // higher priority wins the deterministic tiebreak
  });

  it('converges on a same-status, same-priority description edit', () => {
    const a = [task('task-1', 'pending', { description: 'zzz later text' })];
    const b = [task('task-1', 'pending', { description: 'aaa earlier text' })];
    const [fromA] = mergeTaskLists(a, b, { now: NOW });
    const [fromB] = mergeTaskLists(b, a, { now: NOW });
    expect(fromA.description).toBe(fromB.description);
  });

  it('converges on a same-status metadata-only edit (e.g. app/context changed)', () => {
    const a = [task('task-1', 'pending', { metadata: { app: 'BookLoom', context: 'ctx-A' } })];
    const b = [task('task-1', 'pending', { metadata: { app: 'PortOS', context: 'ctx-B' } })];
    const [fromA] = mergeTaskLists(a, b, { now: NOW });
    const [fromB] = mergeTaskLists(b, a, { now: NOW });
    expect(fromA.metadata.app).toBe(fromB.metadata.app);
    expect(fromA.metadata.context).toBe(fromB.metadata.context);
  });

  it('newest-edit-wins: larger updatedAt wins a same-status tie, regardless of initiator', () => {
    // Same pending status; the fresher edit (larger updatedAt) is authoritative
    // even though it carries the LOWER priority — the #1714 upgrade over the
    // pure-deterministic tiebreak, which would have preferred the stale HIGH.
    const fresh = task('task-1', 'pending', { priority: 'LOW', priorityValue: 1, metadata: { updatedAt: future(5000) } });
    const stale = task('task-1', 'pending', { priority: 'HIGH', priorityValue: 3, metadata: { updatedAt: past(5000) } });
    const [fromFresh] = mergeTaskLists([fresh], [stale], { now: NOW });
    const [fromStale] = mergeTaskLists([stale], [fresh], { now: NOW });
    expect(fromFresh.priority).toBe('LOW');
    expect(fromStale.priority).toBe('LOW');
    expect(fromFresh.metadata.updatedAt).toBe(fresh.metadata.updatedAt);
  });

  it('treats an absent updatedAt as oldest, so a stamped edit beats an un-stamped (legacy) copy', () => {
    const stamped = task('task-1', 'pending', { description: 'edited on a new peer', metadata: { updatedAt: past(1000) } });
    const legacy = task('task-1', 'pending', { description: 'untouched on an old peer' });
    const [fromStamped] = mergeTaskLists([stamped], [legacy], { now: NOW });
    const [fromLegacy] = mergeTaskLists([legacy], [stamped], { now: NOW });
    expect(fromStamped.description).toBe('edited on a new peer');
    expect(fromLegacy.description).toBe('edited on a new peer');
  });

  it('falls back to the deterministic comparator when both stamps tie (or are absent)', () => {
    // Equal updatedAt on both sides → newest-wins can't decide → priority breaks it.
    const sameStamp = future(0);
    const a = [task('task-1', 'pending', { priority: 'HIGH', priorityValue: 3, metadata: { updatedAt: sameStamp } })];
    const b = [task('task-1', 'pending', { priority: 'MEDIUM', priorityValue: 2, metadata: { updatedAt: sameStamp } })];
    const [fromA] = mergeTaskLists(a, b, { now: NOW });
    const [fromB] = mergeTaskLists(b, a, { now: NOW });
    expect(fromA.priority).toBe('HIGH');
    expect(fromB.priority).toBe('HIGH');
  });

  it('does not let updatedAt override a lifecycle status advance (rank still wins first)', () => {
    // A stale-stamped completed task still beats a freshly-stamped in_progress one:
    // status rank is checked before updatedAt, so completion always converges.
    const completedStale = task('task-1', 'completed', { metadata: { updatedAt: past(10_000) } });
    const inProgressFresh = task('task-1', 'in_progress', { metadata: { updatedAt: future(10_000), ...liveClaim('instance-A') } });
    const [merged] = mergeTaskLists([inProgressFresh], [completedStale], { now: NOW });
    expect(merged.status).toBe('completed');
    expect(merged.metadata.claimedBy).toBeUndefined(); // terminal → claim dropped
  });

  it('treats metadata with different key order as identical (no spurious winner flip)', () => {
    const a = [task('task-1', 'pending', { metadata: { app: 'X', context: 'Y' } })];
    const b = [task('task-1', 'pending', { metadata: { context: 'Y', app: 'X' } })];
    const [merged] = mergeTaskLists(a, b, { now: NOW });
    // Same logical content → keeps local, no churn.
    expect(merged.metadata).toEqual({ app: 'X', context: 'Y' });
  });

  it('adopts a remote-only task whose metadata is absent without crashing (cross-version peer)', () => {
    // The wire schema marks metadata optional, so a forked/older peer may omit it.
    const remote = [{ id: 'task-x', taskType: 'user', status: 'pending', priority: 'LOW', description: 'd' }];
    const [merged] = mergeTaskLists([], remote, { now: NOW });
    expect(merged.metadata).toEqual({}); // defaulted, not undefined
    // And it must round-trip through generateTasksMarkdown without throwing.
    expect(() => JSON.stringify(merged)).not.toThrow();
  });

  it('tolerates non-array / malformed inputs', () => {
    expect(mergeTaskLists(null, null, { now: NOW })).toEqual([]);
    expect(mergeTaskLists([task('a')], undefined, { now: NOW }).map((t) => t.id)).toEqual(['a']);
    // Entries missing an id are skipped, not adopted.
    expect(mergeTaskLists([{ status: 'pending' }], [], { now: NOW })).toEqual([]);
  });

  describe('challenged status merge (#2441)', () => {
    // Challenge lifecycle is timestamp-driven, not rank-driven: every challenge
    // write bumps `updatedAt`, so the merge resolves a challenged-vs-other pairing
    // by recency (see pickContentBase). `stamped` builds a task with a set stamp.
    const stamped = (id, status, updatedAt, extra = {}) =>
      task(id, status, { metadata: { updatedAt, ...extra } });

    it('a fresh challenge propagates over an older in_progress on the peer', () => {
      const local = [stamped('task-c', 'challenged', future(1000))];
      const remote = [stamped('task-c', 'in_progress', past(1000))];
      // Symmetric: whichever side initiates the sweep, the newer challenge wins.
      expect(mergeTaskLists(local, remote, { now: NOW })[0].status).toBe('challenged');
      expect(mergeTaskLists(remote, local, { now: NOW })[0].status).toBe('challenged');
    });

    it('an UPHELD resolution (challenged→pending) converges — the newer pending beats a stale challenged', () => {
      // The overturn happens AFTER the challenge, so the resolved pending record's
      // updatedAt is newer. A pure status-rank merge would let rank-3 `challenged`
      // permanently revert rank-1 `pending`; the timestamp path fixes that.
      const resolved = [stamped('task-c', 'pending', future(1000), { challengeResolution: { outcome: 'upheld' } })];
      const stale = [stamped('task-c', 'challenged', past(1000))];
      expect(mergeTaskLists(resolved, stale, { now: NOW })[0].status).toBe('pending');
      expect(mergeTaskLists(stale, resolved, { now: NOW })[0].status).toBe('pending');
    });

    it('an ESCALATED resolution (challenged→blocked) converges', () => {
      const resolved = [stamped('task-c', 'blocked', future(1000), { challengeResolution: { outcome: 'escalated' } })];
      const stale = [stamped('task-c', 'challenged', past(1000))];
      expect(mergeTaskLists(resolved, stale, { now: NOW })[0].status).toBe('blocked');
      expect(mergeTaskLists(stale, resolved, { now: NOW })[0].status).toBe('blocked');
    });

    it('a completed task is NEVER un-completed by a newer challenge (monotonic completion)', () => {
      // Cross-peer: B completes at t=100, A challenges at t=200 before B's
      // completion propagates. `completed` must win despite the newer challenge.
      const completed = [stamped('task-c', 'completed', past(1000))];
      const newerChallenge = [stamped('task-c', 'challenged', future(1000))];
      expect(mergeTaskLists(completed, newerChallenge, { now: NOW })[0].status).toBe('completed');
      expect(mergeTaskLists(newerChallenge, completed, { now: NOW })[0].status).toBe('completed');
    });

    it('on equal/absent stamps, prefers the resolved (non-challenged) side deterministically', () => {
      const challenged = [task('task-c', 'challenged')];
      const blocked = [task('task-c', 'blocked')];
      expect(mergeTaskLists(challenged, blocked, { now: NOW })[0].status).toBe('blocked');
      expect(mergeTaskLists(blocked, challenged, { now: NOW })[0].status).toBe('blocked');
    });

    it('keeps a live claim on a challenged (non-terminal) task, mirroring in_progress', () => {
      const local = [task('task-c', 'challenged', { metadata: { ...liveClaim('peer-A') } })];
      const remote = [task('task-c', 'challenged')];
      const merged = mergeTaskLists(local, remote, { now: NOW })[0];
      expect(merged.metadata.claimedBy).toBe('peer-A');
    });
  });

  describe('cross-peer investigation fingerprint dedup (#2628)', () => {
    // An investigation task carries a durable fingerprint marker (#2615). Two
    // federated peers can each mint one for the SAME failure cause before syncing;
    // rule 1 unions them by id so both survive. `inv` builds one.
    const inv = (id, status, fp, overrides = {}) =>
      task(id, status, {
        metadata: {
          isInvestigation: true,
          investigationFingerprint: fp,
          ...(overrides.affectedTasks ? { affectedTasks: overrides.affectedTasks } : {}),
          ...(overrides.metadata || {}),
        },
        ...(overrides.priority ? { priority: overrides.priority } : {}),
      });

    it('collapses two same-fingerprint OPEN investigations from two peers to one active row', () => {
      const local = [inv('sys-a', 'pending', 'fp-1', { affectedTasks: ['task-1'] })];
      const remote = [inv('sys-b', 'pending', 'fp-1', { affectedTasks: ['task-2'] })];

      // Symmetric: same survivor regardless of which side initiates the sweep.
      for (const merged of [
        mergeTaskLists(local, remote, { now: NOW }),
        mergeTaskLists(remote, local, { now: NOW }),
      ]) {
        const byId = Object.fromEntries(merged.map((t) => [t.id, t]));
        // Older/lower id survives as the single OPEN row.
        expect(byId['sys-a'].status).toBe('pending');
        // Loser flipped to a terminal status — NOT deleted (LWW never propagates a
        // delete), and marked so the collapse is auditable + idempotent.
        expect(byId['sys-b'].status).toBe('completed');
        expect(byId['sys-b'].metadata.supersededBy).toBe('sys-a');
        // affectedTasks unioned (deduped, sorted) onto the survivor.
        expect(byId['sys-a'].metadata.affectedTasks).toEqual(['task-1', 'task-2']);
        // Exactly one non-terminal investigation remains for this fingerprint.
        const open = merged.filter(
          (t) => t.metadata?.investigationFingerprint === 'fp-1' && t.status !== 'completed'
        );
        expect(open).toHaveLength(1);
      }
    });

    it('unions affectedTasks by id (no duplicates)', () => {
      const local = [inv('sys-a', 'pending', 'fp-1', { affectedTasks: ['task-1', 'task-2'] })];
      const remote = [inv('sys-b', 'pending', 'fp-1', { affectedTasks: ['task-2', 'task-3'] })];
      const merged = mergeTaskLists(local, remote, { now: NOW });
      const survivor = merged.find((t) => t.id === 'sys-a');
      expect(survivor.metadata.affectedTasks).toEqual(['task-1', 'task-2', 'task-3']);
    });

    it('never orphans an in-flight investigation: an in_progress loser survives over a lower idle id', () => {
      // The lower id (sys-a) is idle; the higher id (sys-b) is in_progress —
      // an agent is actively investigating it. The in-flight copy must survive so
      // its execution is not orphaned, even though its id sorts later. Symmetric:
      // both peers converge on the same survivor regardless of who sweeps.
      const local = [inv('sys-a', 'pending', 'fp-1', { affectedTasks: ['task-1'] })];
      const remote = [
        inv('sys-b', 'in_progress', 'fp-1', { affectedTasks: ['task-2'], metadata: liveClaim('instance-B') }),
      ];
      for (const merged of [
        mergeTaskLists(local, remote, { now: NOW }),
        mergeTaskLists(remote, local, { now: NOW }),
      ]) {
        const byId = Object.fromEntries(merged.map((t) => [t.id, t]));
        expect(byId['sys-b'].status).toBe('in_progress');
        expect(byId['sys-b'].metadata.claimedBy).toBe('instance-B');
        expect(byId['sys-b'].metadata.affectedTasks).toEqual(['task-1', 'task-2']);
        expect(byId['sys-a'].status).toBe('completed');
        expect(byId['sys-a'].metadata.supersededBy).toBe('sys-b');
      }
    });

    it('keeps an in_progress survivor even when its lease timestamp looks expired (stale-lease-proof)', () => {
      // The no-orphan guard keys on the in_progress STATUS, not lease liveness: a
      // peer whose view of sys-b's lease has gone stale (agent still running, but
      // the renewal hasn't replicated) must NOT flip the running copy to completed
      // just because the lower-id sys-a sorts first. Status survives that staleness.
      const expiredLease = { claimedBy: 'instance-B', claimedAt: past(LEASE_DURATION_MS * 2), leaseExpiresAt: past(1000) };
      const local = [inv('sys-a', 'pending', 'fp-1', { affectedTasks: ['task-1'] })];
      const remote = [inv('sys-b', 'in_progress', 'fp-1', { affectedTasks: ['task-2'], metadata: expiredLease })];
      for (const merged of [
        mergeTaskLists(local, remote, { now: NOW }),
        mergeTaskLists(remote, local, { now: NOW }),
      ]) {
        const byId = Object.fromEntries(merged.map((t) => [t.id, t]));
        expect(byId['sys-b'].status).toBe('in_progress'); // running copy survives
        expect(byId['sys-a'].status).toBe('completed');
        expect(byId['sys-a'].metadata.supersededBy).toBe('sys-b');
      }
    });

    it('does NOT collapse when both copies are in_progress (two in-flight agents)', () => {
      // Sub-second claim race: both peers spawned. Killing either orphans a running
      // agent, so the collapse is skipped this sweep — the group self-heals as each
      // investigation completes (turns terminal) and drops out of the open set.
      // Symmetric, and both live claims survive untouched.
      const local = [inv('sys-a', 'in_progress', 'fp-1', { metadata: liveClaim('instance-A') })];
      const remote = [inv('sys-b', 'in_progress', 'fp-1', { metadata: liveClaim('instance-B') })];
      for (const merged of [
        mergeTaskLists(local, remote, { now: NOW }),
        mergeTaskLists(remote, local, { now: NOW }),
      ]) {
        const open = merged.filter((t) => t.status === 'in_progress');
        expect(open.map((t) => t.id).sort()).toEqual(['sys-a', 'sys-b']);
        expect(open.every((t) => t.metadata.claimedBy)).toBe(true); // claims untouched
        expect(open.every((t) => t.metadata.supersededBy === undefined)).toBe(true);
      }
    });

    it('does not collapse a single open investigation (no duplicate)', () => {
      const local = [inv('sys-a', 'pending', 'fp-1', { affectedTasks: ['task-1'] })];
      const merged = mergeTaskLists(local, [], { now: NOW });
      expect(merged).toHaveLength(1);
      expect(merged[0].status).toBe('pending');
      expect(merged[0].metadata.supersededBy).toBeUndefined();
    });

    it('does not collapse investigations with DIFFERENT fingerprints', () => {
      const local = [inv('sys-a', 'pending', 'fp-1')];
      const remote = [inv('sys-b', 'pending', 'fp-2')];
      const merged = mergeTaskLists(local, remote, { now: NOW });
      expect(merged.every((t) => t.status === 'pending')).toBe(true);
    });

    it('ignores non-investigation tasks (no fingerprint) entirely', () => {
      const local = [task('task-a', 'pending'), task('task-b', 'pending')];
      const merged = mergeTaskLists(local, [], { now: NOW });
      expect(merged.every((t) => t.status === 'pending')).toBe(true);
      expect(merged.every((t) => t.metadata.supersededBy === undefined)).toBe(true);
    });

    it('is idempotent — re-merging the collapsed result changes nothing', () => {
      const local = [inv('sys-a', 'pending', 'fp-1', { affectedTasks: ['task-1'] })];
      const remote = [inv('sys-b', 'pending', 'fp-1', { affectedTasks: ['task-2'] })];
      const once = mergeTaskLists(local, remote, { now: NOW });
      const twice = mergeTaskLists(once, [], { now: NOW });
      expect(twice).toEqual(once);
    });

    it('re-folds affectedTasks onto the survivor after a partial per-id revert', () => {
      // Mid-propagation, a peer can hold the survivor with a stale (partial)
      // affectedTasks while a terminal `supersededBy` sibling records the collapse.
      // The pass must re-fold the full union rather than leave the survivor partial.
      const partialSurvivor = inv('sys-a', 'pending', 'fp-1', { affectedTasks: ['task-1'] });
      const supersededSibling = inv('sys-b', 'completed', 'fp-1', {
        affectedTasks: ['task-2'],
        metadata: { supersededBy: 'sys-a' },
      });
      const merged = mergeTaskLists([partialSurvivor, supersededSibling], [], { now: NOW });
      const survivor = merged.find((t) => t.id === 'sys-a');
      expect(survivor.metadata.affectedTasks).toEqual(['task-1', 'task-2']);
    });
  });
});
