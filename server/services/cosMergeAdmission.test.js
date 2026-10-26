import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';

const fixture = vi.hoisted(() => ({ state: null, disk: null, trusted: true, archived: null, failSave: false }));
vi.mock('./cosState.js', () => ({
  withStateLock: createFileWriteQueue(),
  loadState: async () => fixture.state,
  readMergeAdmissionStateForSafetyCheck: async () => ({ trusted: fixture.trusted, ...structuredClone(fixture.disk) }),
  saveState: async (state) => { if (fixture.failSave) throw new Error('write failed'); fixture.disk = structuredClone(state); fixture.state = state; },
}));
vi.mock('../lib/gitRemote.js', () => ({
  getOriginInfo: async (path) => ({ host: path === '/repos/alias' ? 'ssh.github.com' : 'github.com',
    fullName: path === '/repos/other' ? 'example/other' : 'Example/Repo' }),
}));
vi.mock('./cosAgentLifecycle.js', () => ({ readAgentRecordOrUnreadable: async () => fixture.archived }));
import { AGENT_LEASE_MAX_HOLD_MS, MERGE_PREPARATION_MAX_HOLD_MS, claimMergeAdmission, preparePendingMergeAdmission, withPendingMergeAdmission } from './cosMergeAdmission.js';
const origin = { host: 'github.com', fullName: 'example/repo' };
const parent = (id, sourceWorkspace = '/repos/example') => ({ id, taskId: `task-${id}`, status: 'running',
  startedAt: '2026-01-01T00:00:00Z', metadata: { sourceWorkspace, claimPicksOwnBranch: true } });
const acquire = (agentId) => claimMergeAdmission({ agentId, action: 'acquire' });
const release = (agentId, token, outcome = 'merged') => claimMergeAdmission({ agentId, token, action: 'release', outcome });
const persist = () => { fixture.disk = structuredClone(fixture.state); };
beforeEach(() => {
  fixture.trusted = true;
  fixture.failSave = false;
  fixture.archived = null;
  fixture.state = { agents: { a: parent('a'), b: parent('b', '/repos/alias'), c: parent('c', '/repos/other') }, mergeAdmissions: {} };
  persist();
});

describe('repository final merge workflow', () => {
  it('validates two parents concurrently and serializes only the pinned merge instant', async () => {
    // Synthetic forge: a pinned merge refuses any head but the verified one.
    const forge = { base: 1, prs: {} };
    const validate = (id) => { forge.prs[id] = { head: `${id}-head-on-${forge.base}`, state: 'CLEAN' }; return forge.prs[id].head; };
    const merge = (id, sha) => {
      if (forge.prs[id].head !== sha) return false;
      forge.base++;
      return true;
    };
    // Sync/pregate/CI never needs the lease, so both parents validate at once.
    const [aHead, bHead] = [validate('a'), validate('b')];
    expect(fixture.state.mergeAdmissions).toEqual({});

    const [a, b] = await Promise.all([acquire('a'), acquire('b')]);
    expect(a.admitted).toBe(true);
    expect(b).toMatchObject({ admitted: false, retryAfterMs: 5000 });
    const sweep = vi.fn();
    expect(await withPendingMergeAdmission(origin, sweep)).toMatchObject({ admitted: false });
    expect(sweep).not.toHaveBeenCalled();
    expect(await claimMergeAdmission({ agentId: 'a', action: 'check', token: a.token })).toMatchObject({ admitted: true });
    expect(merge('a', aHead)).toBe(true);
    expect(await release('a', a.token)).toMatchObject({ released: true });

    // The base moved but B stays CLEAN: it merges its CI-verified head as is.
    const b2 = await acquire('b');
    expect(forge.prs.b.state).toBe('CLEAN');
    expect(merge('b', bHead)).toBe(true);
    expect(await release('b', b2.token)).toMatchObject({ released: true });

    // A DIRTY PR releases with resync and re-validates outside the lease.
    validate('a'); forge.prs.a.state = 'DIRTY';
    const a2 = await acquire('a');
    expect(await release('a', a2.token, 'resync')).toMatchObject({ released: true, outcome: 'resync' });
    expect(fixture.state.agents.a.metadata.lastMergeAdmission.outcome).toBe('resync');
    expect(fixture.state.mergeAdmissions).toEqual({});
    const revalidated = validate('a');
    const a3 = await acquire('a');
    expect(merge('a', revalidated)).toBe(true);
    expect(await release('a', a3.token)).toMatchObject({ released: true });
  });

  it('lets another participant reclaim a running holder past the hold deadline', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-01-01T00:00:00Z') });
    try {
      const stale = await acquire('a');
      vi.advanceTimersByTime(AGENT_LEASE_MAX_HOLD_MS - 1);
      expect((await acquire('b')).admitted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(await claimMergeAdmission({ agentId: 'a', action: 'check', token: stale.token })).toMatchObject({ admitted: false, reason: 'lease-expired' });
      expect(fixture.state.agents.a.status).toBe('running');
      const reclaimed = await acquire('b');
      expect(reclaimed.admitted).toBe(true);
      // The stale token is void; the holder's head-pinned merge (prompt
      // contract) is what keeps a late merge from landing an unverified head.
      expect(await claimMergeAdmission({ agentId: 'a', action: 'check', token: stale.token })).toMatchObject({ admitted: false, reason: 'lease-owner-mismatch' });
      expect((await release('a', stale.token)).released).not.toBe(true);
      // A holder re-acquiring its own expired lease gets a fresh token.
      vi.advanceTimersByTime(AGENT_LEASE_MAX_HOLD_MS);
      const renewed = await acquire('b');
      expect(renewed.token).not.toBe(reclaimed.token);
      expect(await claimMergeAdmission({ agentId: 'b', action: 'check', token: renewed.token })).toMatchObject({ admitted: true });
    } finally { vi.useRealTimers(); }
  });

  it('holds the sweep through async merge and permits another repository concurrently', async () => {
    let finish;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const done = new Promise(resolve => { finish = resolve; });
    const sweep = withPendingMergeAdmission(origin, async () => { entered(); await done; return 'merged'; });
    await started;
    expect((await acquire('a')).admitted).toBe(false);
    expect((await acquire('c')).admitted).toBe(true);
    finish();
    expect(await sweep).toEqual({ admitted: true, result: 'merged' });
    expect((await acquire('a')).admitted).toBe(true);
  });

  it('recovers only a matching finalized parent and preserves all authored metadata', async () => {
    await acquire('a');
    fixture.state.agents.a.status = 'paused'; persist();
    expect((await acquire('b')).admitted).toBe(false);
    fixture.archived = { ...fixture.state.agents.a, status: 'completed', completedAt: '2026-01-02T00:00:00Z' };
    delete fixture.state.agents.a; persist();
    expect((await acquire('b')).admitted).toBe(true);
    expect(fixture.archived.metadata.sourceWorkspace).toBe('/repos/example');
  });

  it.each(['unreadable', 'stale', 'missing-owner', 'mismatched-owner', 'malformed-lease'])('fails closed on %s without invoking merge', async (mode) => {
    await acquire('a');
    if (mode === 'unreadable') fixture.trusted = false;
    if (mode === 'stale') fixture.disk.agents.a.status = 'completed';
    if (mode === 'missing-owner') { delete fixture.state.agents.a; persist(); }
    if (mode === 'mismatched-owner') { fixture.state.agents.a.startedAt = '2026-02-01T00:00:00Z'; persist(); }
    if (mode === 'malformed-lease') { fixture.state.mergeAdmissions['github.com/example/repo'] = null; persist(); }
    const work = vi.fn();
    expect((await withPendingMergeAdmission(origin, work)).admitted).toBe(false);
    expect(work).not.toHaveBeenCalled();
  });

  it('refuses a changed parent repository and foreign/stale release tokens', async () => {
    const a = await acquire('a');
    expect((await acquire('a')).token).toBe(a.token);
    expect((await release('b', a.token)).released).not.toBe(true);
    expect((await release('a', 'wrong-token')).released).not.toBe(true);
    fixture.state.agents.a.metadata.sourceWorkspace = '/repos/other'; persist();
    expect((await acquire('a')).admitted).toBe(false);
    fixture.state.agents.a.metadata.sourceWorkspace = '/repos/example'; persist();
    expect(await release('a', a.token, 'leave-open')).toMatchObject({ released: true });
    const next = await acquire('a');
    expect((await release('a', a.token)).released).not.toBe(true);
    expect(await release('a', next.token)).toMatchObject({ released: true });
    expect(fixture.state.agents.a.metadata.lastMergeAdmission.outcome).toBe('merged');
    // The merge-gate audit (#12549) needs the held interval, not just the last release time.
    expect(fixture.state.agents.a.metadata.mergeAdmissionHistory.at(-1)).toMatchObject({
      repository: 'github.com/example/repo', outcome: 'merged', acquiredAt: expect.any(String), releasedAt: expect.any(String),
    });
    const last = await acquire('a');
    expect(await release('a', last.token, 'abandoned')).toMatchObject({ admitted: false, reason: 'outcome-required' });
    expect(fixture.state.mergeAdmissions['github.com/example/repo'].token).toBe(last.token);
  });

  it('recovers a crashed sweep only when its process is proven absent', async () => {
    fixture.state.mergeAdmissions['github.com/example/repo'] = {
      kind: 'sweep', serverOwner: 'previous-server', pid: 123456,
      repository: 'github.com/example/repo', token: 'previous-token', acquiredAt: '2020-01-01',
    };
    persist();
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    try {
      expect((await acquire('a')).admitted).toBe(false);
      probe.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
      expect((await acquire('a')).admitted).toBe(true);
    } finally { probe.mockRestore(); }
  });

  it.each(['refused', 'write-failed'])('recovers a finished sweep after its release is %s', async (failure) => {
    const run = withPendingMergeAdmission(origin, async () => {
      if (failure === 'refused') fixture.trusted = false;
      else fixture.failSave = true;
      return 'merged';
    });
    if (failure === 'write-failed') await expect(run).rejects.toThrow('write failed');
    else expect(await run).toMatchObject({ admitted: true, result: 'merged' });
    expect(fixture.disk.mergeAdmissions[origin.host + '/' + origin.fullName]).toBeDefined();
    fixture.trusted = true; fixture.failSave = false;
    expect((await acquire('a')).admitted).toBe(true);
  });

  it('releases a failed sweep without swallowing its error', async () => {
    await expect(withPendingMergeAdmission(origin, async () => { throw new Error('forge unavailable'); })).rejects.toThrow('forge unavailable');
    expect((await acquire('a')).admitted).toBe(true);
  });
});


describe('ready merge preparation ordering', () => {
  const prepare = agentId => claimMergeAdmission({ agentId, action: 'prepare' });
  const yieldTurn = agentId => claimMergeAdmission({ agentId, action: 'yield' });

  it('orders guard preparation before admission across parents, pending receipts and legacy acquires', async () => {
    const a = await prepare('a');
    expect(a.prepared).toBe(true);
    expect(fixture.state.mergeAdmissions).toEqual({});
    expect(await preparePendingMergeAdmission(origin, 'receipt:1')).toMatchObject({ prepared: false });
    expect(await acquire('b')).toMatchObject({ admitted: false, reason: 'preparation-waiting' });
    expect((await prepare('a')).preparationToken).toBe(a.preparationToken);
    expect((await acquire('c')).admitted).toBe(true); // Another repository progresses.
    expect(await yieldTurn('a')).toEqual({ yielded: true });
    expect((await acquire('b')).admitted).toBe(false); // Cannot overtake the receipt.
    expect((await preparePendingMergeAdmission(origin, 'receipt:1')).prepared).toBe(true);
    const merge = vi.fn(async () => 'merged');
    expect(await withPendingMergeAdmission(origin, merge, 'receipt:1')).toMatchObject({ admitted: true });
    expect(merge).toHaveBeenCalledOnce();
    expect((await acquire('b')).admitted).toBe(true);
  });

  it('retains a nonrenewable position through repeated base refreshes and yields for substantive work', async () => {
    const a = await prepare('a');
    await prepare('b');
    for (let base = 0; base < 4; base++) {
      const lease = await acquire('a');
      expect(lease.admitted).toBe(true);
      await release('a', lease.token, 'resync');
      expect(await prepare('a')).toEqual(a);
      expect(fixture.state.mergeAdmissions).toEqual({});
      expect((await prepare('b')).prepared).toBe(false);
    }
    await yieldTurn('a');
    expect((await prepare('b')).prepared).toBe(true);
    expect((await prepare('a')).prepared).toBe(false);
  });

  it('moves an expired holder behind live waiters without renewing its turn', async () => {
    vi.useFakeTimers();
    try {
      const a = await prepare('a');
      await prepare('b');
      for (let elapsed = 60_000; elapsed < MERGE_PREPARATION_MAX_HOLD_MS; elapsed += 60_000) {
        vi.advanceTimersByTime(60_000);
        expect((await prepare('b')).prepared).toBe(false);
      }
      vi.advanceTimersByTime(59_999);
      expect(await prepare('a')).toEqual(a);
      vi.advanceTimersByTime(1);
      expect((await prepare('a')).prepared).toBe(false);
      expect((await prepare('b')).prepared).toBe(true);
      await yieldTurn('b');
      expect((await prepare('a')).preparationToken).not.toBe(a.preparationToken);
    } finally { vi.useRealTimers(); }
  });

  it('prunes a completed preparation owner and refuses malformed or unpersisted scheduling', async () => {
    await prepare('a');
    fixture.state.agents.a.status = 'completed';
    fixture.state.agents.a.completedAt = new Date().toISOString(); persist();
    expect((await prepare('b')).prepared).toBe(true);
    fixture.state.mergePreparations = null; persist();
    expect(await prepare('b')).toMatchObject({ admitted: false, reason: 'ownership-unreadable' });
    fixture.state.mergePreparations = {}; persist();
    fixture.failSave = true;
    await expect(prepare('b')).rejects.toThrow('write failed');
    expect(fixture.state.mergePreparations).toEqual({});
  });
});
