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
import { claimMergeAdmission, withPendingMergeAdmission } from './cosMergeAdmission.js';
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
  it('serializes two live parents and a sweep, avoiding an extra base sync during CI', async () => {
    let base = 1;
    let validations = 0;
    const syncAndValidate = () => { validations++; return base; };
    // The uncoordinated failure: another merge invalidates A's validated base.
    const uncoordinatedHead = syncAndValidate();
    base++;
    expect(uncoordinatedHead).not.toBe(base);
    syncAndValidate();
    expect(validations).toBe(2);
    base = 1; validations = 0;

    const [a, b] = await Promise.all([acquire('a'), acquire('b')]);
    expect(a.admitted).toBe(true);
    expect(b.admitted).toBe(false);
    const validatedBase = syncAndValidate();
    fixture.state.agents.child = { ...parent('child'), status: 'completed', completedAt: '2026-01-01T01:00:00Z' };
    persist();
    const sweep = vi.fn(() => { base++; });
    expect(await withPendingMergeAdmission(origin, sweep)).toMatchObject({ admitted: false });
    expect(sweep).not.toHaveBeenCalled();
    expect(await acquire('b')).toMatchObject({ admitted: false, retryAfterMs: 15000 });
    expect(await claimMergeAdmission({ agentId: 'a', action: 'check', token: a.token })).toMatchObject({ admitted: true });
    expect(validatedBase).toBe(base);
    expect(validations).toBe(1);
    expect(await release('a', a.token)).toMatchObject({ released: true });
    expect((await acquire('b')).admitted).toBe(true);
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
