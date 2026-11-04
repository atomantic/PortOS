import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
// Git/filesystem are synthetic in this suite; real durable admission has its own boundary tests.
vi.mock('../lib/checkoutRetirementAdmission.js', () => ({ withCheckoutPublication: (_repo, work) => work() }));

const store = { state: null, stateGate: null, readGate: null, saveGate: null, unreadable: false, stale: false, outbox: null };
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
vi.mock('./cosState.js', () => ({
  withStateLock: vi.fn(async work => { if (store.stateGate) await store.stateGate; return work(); }),
  readAgentsStateForSafetyCheck: vi.fn(async () => {
    if (store.readGate) await store.readGate;
    return { trusted: !store.unreadable, agents: structuredClone(store.state.agents) };
  }),
  loadState: async () => store.stale ? { agents: {} } : store.state,
  saveState: vi.fn(async next => { if (store.saveGate) await store.saveGate; store.state = structuredClone(next); }),
}));
vi.mock('./cosEvents.js', () => ({ cosEvents: { emit: vi.fn() } }));
vi.mock('./releaseSynchronizationStore.js', () => ({ readReleaseSynchronizationOutbox: async () => store.outbox }));

const { updateClaimOwnership, updateReleaseCandidateOwnership, updateReleaseSynchronizationOwnership,
  checkReconcileOwnership, CLAIM_OWNERSHIP_QUEUE_TIMEOUT_MS } = await import('./cosClaimOwnership.js');
// Hold the same leaf fence cleanup uses while exercising binding through its public service.
const { withClaimOwnershipLock, reserveCheckoutRetirementFence } = await import('./cosClaimOwnershipState.js');
const { claimContinuationAdmission, claimBranchAdmission } = await import('../lib/claimContinuation.js');

const { withStateLock, readAgentsStateForSafetyCheck, saveState } = await import('./cosState.js');
const { cosEvents } = await import('./cosEvents.js');

const SOURCE = '/repos/app-x';
const CHILD = '/repos/app-x/data/cos/worktrees/claim-issue-101';

beforeEach(() => {
  store.stateGate = store.readGate = store.saveGate = null;
  store.unreadable = store.stale = false;
  store.outbox = null;
  vi.clearAllMocks();
  store.state = {
    agents: {
      'agent-epicrun': {
        id: 'agent-epicrun', status: 'running', workspacePath: SOURCE,
        metadata: { sourceWorkspace: SOURCE, claimBranch: 'claim/issue-100', claimPicksOwnBranch: false, claimSelectionPending: true },
      },
    },
  };
});

it('binds an inline synchronization checkout to the same release owner and captures its generation', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { materializeGitRepo } = await import('../lib/gitTestRepo.js');
  const { execGit } = await import('../lib/execGit.js');
  const { captureCompletedCheckouts } = await import('./completedCheckoutEvidence.js');
  const { claimCheckoutOwnerReason } = await import('../lib/claimContinuation.js');
  const scratch = await mkdtemp(join(tmpdir(), 'portos-inline-sync-'));
  try {
    const repo = join(scratch, 'repo'), candidate = join(scratch, 'candidate'), sync = join(scratch, 'sync');
    await materializeGitRepo(repo);
    const id = 'agent-epicrun', identity = 'a'.repeat(64), branch = `codex/release-sync-${identity}`;
    const agent = { id, taskId: 'release-task', status: 'running', startedAt: new Date().toISOString(),
      metadata: { taskAnalysisType: 'do-release', isWorktree: false, workspacePath: repo } };
    store.state.agents[id] = agent;
    expect(await updateReleaseCandidateOwnership(id, 'reserve')).toEqual({ reserved: true, branch: `codex/release-${id}` });
    await execGit(['worktree', 'add', '-b', `codex/release-${id}`, candidate, 'main'], repo);
    expect(await updateReleaseCandidateOwnership(id, 'capture')).toEqual({ captured: true, branch: `codex/release-${id}` });
    store.state.agents[id].metadata.releasePublication = { status: 'verified', synchronizationHandoffVersion: 2,
      identity, candidateBranch: `codex/release-${id}` };
    store.outbox = { publications: { [identity]: { version: 2, registeredAt: new Date().toISOString(),
      owner: { agentId: id, taskId: agent.taskId, startedAt: agent.startedAt } } } };
    expect(await updateReleaseSynchronizationOwnership(id, 'sync-capture'))
      .toEqual({ captured: false, reason: 'synchronization-reservation-missing' });
    expect(await updateReleaseSynchronizationOwnership(id, 'sync-reserve')).toEqual({ reserved: true, branch });
    expect(claimCheckoutOwnerReason({ branchName: branch, sourceWorkspace: repo, agents: Object.values(store.state.agents) }))
      .toBe('claim-owner-active');
    expect(await updateReleaseSynchronizationOwnership(id, 'sync-capture')).toEqual({ captured: false, reason: 'checkout-seed-unavailable' });
    await execGit(['worktree', 'add', '-b', branch, sync, 'main'], repo);
    expect(await updateReleaseSynchronizationOwnership(id, 'sync-capture')).toEqual({ captured: true, branch });
    const seeds = store.state.agents[id].metadata.checkoutSeeds;
    expect(seeds.map(seed => seed.branch)).toEqual([`codex/release-${id}`, branch]);
    expect((await captureCompletedCheckouts(store.state.agents[id], { success: true, strict: true })).map(row => row.branch))
      .toEqual([`codex/release-${id}`, branch]);
  } finally { await rm(scratch, { recursive: true, force: true, maxRetries: 3 }); }
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('updateClaimOwnership', () => {
  it('reserves before creation, seeds the exact physical checkout on rebind, and refuses a replacement generation', async () => {
    const { mkdtemp, readFile, writeFile, rename, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { materializeGitRepo } = await import('../lib/gitTestRepo.js');
    const { execGit } = await import('../lib/execGit.js');
    const scratch = await mkdtemp(join(tmpdir(), 'portos-claim-seed-'));
    try {
      const repo = join(scratch, 'repo');
      const checkout = join(scratch, 'claim');
      await materializeGitRepo(repo);
      store.state.agents['agent-epicrun'] = { id: 'agent-epicrun', status: 'running',
        startedAt: new Date().toISOString(), metadata: { sourceWorkspace: repo, workspacePath: repo,
          claimPicksOwnBranch: true, claimBranches: [] } };
      const bind = () => updateClaimOwnership({ agentId: 'agent-epicrun', action: 'bind', branch: 'claim/issue-101' });
      expect(await bind()).toEqual({ bound: true, branch: 'claim/issue-101' });
      expect(store.state.agents['agent-epicrun'].metadata.checkoutSeeds).toEqual([]);
      await execGit(['worktree', 'add', '-b', 'claim/issue-101', checkout, 'main'], repo);
      expect(await bind()).toEqual({ bound: true, branch: 'claim/issue-101' });
      const seed = store.state.agents['agent-epicrun'].metadata.checkoutSeeds[0];
      expect(seed).toMatchObject({ branch: 'claim/issue-101', incarnation: { pointer: { ino: expect.any(String) } } });
      await writeFile(join(checkout, 'wanted.txt'), 'wanted work');
      expect(await bind()).toEqual({ bound: true, branch: 'claim/issue-101' });
      expect(store.state.agents['agent-epicrun'].metadata.checkoutSeeds).toEqual([seed]);
      const pointer = join(checkout, '.git');
      const contents = await readFile(pointer);
      await rename(pointer, join(scratch, 'original-pointer'));
      await writeFile(pointer, contents);
      expect(await bind()).toEqual({ bound: false, reason: 'checkout-seed-unavailable' });
      expect(store.state.agents['agent-epicrun'].metadata.checkoutSeeds).toEqual([seed]);
      expect(await readFile(join(checkout, 'wanted.txt'), 'utf8')).toBe('wanted work');
    } finally { await rm(scratch, { recursive: true, force: true, maxRetries: 3 }); }
  });

  it('persists the bound child branch on the run record and settles its selection', async () => {
    expect(await updateClaimOwnership({ agentId: 'agent-epicrun', action: 'bind', branch: 'claim/issue-101' }))
      .toEqual({ bound: true, branch: 'claim/issue-101' });
    expect(await updateClaimOwnership({ agentId: 'agent-epicrun', action: 'bind', branch: 'claim/issue-101' }))
      .toEqual({ bound: true, branch: 'claim/issue-101' });
    expect(store.state.agents['agent-epicrun'].metadata).toMatchObject({
      claimBranch: 'claim/issue-100', claimBranches: ['claim/issue-101'], claimSelectionPending: false,
    });
    expect(await updateClaimOwnership({ agentId: 'agent-epicrun', action: 'release', branch: 'claim/issue-101' }))
      .toEqual({ released: true, branch: 'claim/issue-101' });
    expect(store.state.agents['agent-epicrun'].metadata).toMatchObject({ claimBranches: [], claimReleasedBranches: ['claim/issue-101'] });
    expect(cosEvents.emit).toHaveBeenCalledWith('claim:ownership-changed', { agentId: 'agent-epicrun', repository: SOURCE });
  });

  it('refuses an unknown or finished run without writing', async () => {
    const before = structuredClone(store.state);
    expect(await updateClaimOwnership({ agentId: 'agent-gone', action: 'bind', branch: 'claim/issue-101' }))
      .toEqual({ bound: false, reason: 'owner-unknown' });
    store.state.agents['agent-epicrun'].status = 'completed';
    expect(await updateClaimOwnership({ agentId: 'agent-epicrun', action: 'bind', branch: 'claim/issue-101' }))
      .toEqual({ bound: false, reason: 'owner-not-running' });
    expect(store.state.agents['agent-epicrun'].metadata).toEqual(before.agents['agent-epicrun'].metadata);
    expect(cosEvents.emit).not.toHaveBeenCalledWith('claim:ownership-changed', expect.anything());
  });
});

it('reserves a release branch before creation and captures its actual locked checkout generation', async () => {
  const { mkdtemp, readFile, writeFile, rename, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { materializeGitRepo } = await import('../lib/gitTestRepo.js');
  const { execGit } = await import('../lib/execGit.js');
  const { captureCompletedCheckouts } = await import('./completedCheckoutEvidence.js');
  const { claimCheckoutOwnerReason } = await import('../lib/claimContinuation.js');
  const scratch = await mkdtemp(join(tmpdir(), 'portos-release-seed-'));
  try {
    const repo = join(scratch, 'repo');
    const checkout = join(scratch, 'candidate');
    await materializeGitRepo(repo);
    const agentId = 'agent-epicrun';
    const branch = `codex/release-${agentId}`;
    store.state.agents[agentId] = { id: agentId, status: 'running', startedAt: new Date().toISOString(),
      metadata: { taskAnalysisType: 'do-release', isWorktree: false, workspacePath: repo } };
    const agent = store.state.agents[agentId];
    agent.taskId = 'release-task';
    agent.metadata.releaseCandidateLifecycle = { version: 1, agentId, taskId: agent.taskId, startedAt: agent.startedAt, stage: 'registered' };
    expect(await updateReleaseCandidateOwnership(agentId, 'capture')).toEqual({ captured: false, reason: 'candidate-reservation-missing' });
    expect(await updateReleaseCandidateOwnership(agentId, 'reserve')).toEqual({ reserved: true, branch });
    const reserved = store.state.agents[agentId].metadata.releaseCandidateLifecycle;
    expect(reserved).toMatchObject({ stage: 'reserved', branch, reservedAt: store.state.agents[agentId].metadata.releaseCandidate.reservedAt });
    expect(await updateReleaseCandidateOwnership(agentId, 'reserve')).toEqual({ reserved: true, branch });
    expect(store.state.agents[agentId].metadata.releaseCandidateLifecycle).toEqual(reserved);
    expect(claimCheckoutOwnerReason({ branchName: branch, sourceWorkspace: repo, agents: Object.values(store.state.agents) })).toBe('claim-owner-active');
    expect(await updateReleaseCandidateOwnership(agentId, 'capture')).toEqual({ captured: false, reason: 'checkout-seed-unavailable' });
    await execGit(['worktree', 'add', '-b', branch, checkout, 'main'], repo);
    await execGit(['worktree', 'lock', '--reason', 'Active release candidate', checkout], repo);
    store.state.agents[agentId].metadata.releaseCandidateLifecycle = { ...reserved, taskId: 'wrong-task' };
    expect(await updateReleaseCandidateOwnership(agentId, 'capture')).toEqual({ captured: false, reason: 'candidate-lifecycle-conflict' });
    expect(store.state.agents[agentId].metadata.checkoutSeeds).toBeUndefined();
    store.state.agents[agentId].metadata.releaseCandidateLifecycle = reserved;
    expect(await updateReleaseCandidateOwnership(agentId, 'capture')).toEqual({ captured: true, branch });
    const lifecycle = store.state.agents[agentId].metadata.releaseCandidateLifecycle;
    expect(lifecycle).toMatchObject({ ...reserved, stage: 'captured', capturedAt: expect.any(String) });
    expect(await updateReleaseCandidateOwnership(agentId, 'capture')).toEqual({ captured: true, branch });
    expect(store.state.agents[agentId].metadata.releaseCandidateLifecycle).toEqual(lifecycle);
    const seed = store.state.agents[agentId].metadata.checkoutSeeds[0];
    expect(seed).toMatchObject({ agentId, branch, path: await (await import('node:fs/promises')).realpath(checkout) });
    expect(await captureCompletedCheckouts(store.state.agents[agentId], { success: true, strict: true })).toMatchObject([{ branch, path: seed.path }]);
    const pointer = join(checkout, '.git');
    const contents = await readFile(pointer);
    await rename(pointer, join(scratch, 'original-pointer'));
    await writeFile(pointer, contents);
    expect(await updateReleaseCandidateOwnership(agentId, 'capture')).toEqual({ captured: false, reason: 'checkout-seed-unavailable' });
    expect(store.state.agents[agentId].metadata.checkoutSeeds).toEqual([seed]);
    await rm(pointer);
    await rename(join(scratch, 'original-pointer'), pointer);
    await execGit(['worktree', 'unlock', checkout], repo);
    await execGit(['worktree', 'remove', checkout], repo);
    expect(await updateReleaseCandidateOwnership(agentId, 'capture')).toEqual({ captured: false, reason: 'checkout-seed-unavailable' });
    expect(store.state.agents[agentId].metadata.checkoutSeeds).toEqual([seed]);
  } finally { await rm(scratch, { recursive: true, force: true, maxRetries: 3 }); }
});

it('does not adopt a release branch that already existed before reservation', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { materializeGitRepo } = await import('../lib/gitTestRepo.js');
  const { execGit } = await import('../lib/execGit.js');
  const scratch = await mkdtemp(join(tmpdir(), 'portos-release-collision-'));
  try {
    const repo = join(scratch, 'repo');
    await materializeGitRepo(repo);
    await execGit(['branch', 'codex/release-agent-epicrun', 'main'], repo);
    store.state.agents['agent-epicrun'] = { id: 'agent-epicrun', status: 'running', startedAt: new Date().toISOString(),
      metadata: { taskAnalysisType: 'do-release', isWorktree: false, workspacePath: repo } };
    expect(await updateReleaseCandidateOwnership('agent-epicrun', 'reserve')).toEqual({ reserved: false, reason: 'candidate-branch-not-available' });
    expect(store.state.agents['agent-epicrun'].metadata.releaseCandidate).toBeUndefined();
  } finally { await rm(scratch, { recursive: true, force: true, maxRetries: 3 }); }
});

it('treats a malformed release reservation as unreadable ownership', async () => {
  store.state.agents['agent-epicrun'].metadata.releaseCandidate = { branch: 'codex/release-agent-epicrun' };
  expect(await updateClaimOwnership({ agentId: 'agent-epicrun', action: 'bind', branch: 'claim/issue-101' }))
    .toEqual({ bound: false, reason: 'ownership-unreadable' });
});

describe('claim ownership queued transaction deadlines', () => {
  const update = action => updateClaimOwnership({ agentId: 'agent-epicrun', action, branch: 'claim/issue-101' });
  const tick = () => vi.advanceTimersByTimeAsync(0);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it.each(['bind', 'release'])('fences a timed-out %s at each queued boundary', async action => {
    store.state.agents['agent-epicrun'].metadata.claimBranches = action === 'release' ? ['claim/issue-101'] : [];
    const before = structuredClone(store.state);
    // A retirement can hold ownership while unrelated state writers hold state.
    // Neither resumed callback may mutate after the caller received a refusal.
    for (const queue of ['ownership', 'state']) {
      const gate = deferred();
      const held = queue === 'ownership' ? withClaimOwnershipLock(() => gate.promise) : null;
      if (queue === 'state') store.stateGate = gate.promise;
      const pending = update(action);
      await tick();
      await vi.advanceTimersByTimeAsync(CLAIM_OWNERSHIP_QUEUE_TIMEOUT_MS);
      expect(await pending).toEqual({ [action === 'bind' ? 'bound' : 'released']: false,
        reason: `${queue}-queue-timeout`, retryAfterMs: 5000 });
      expect(readAgentsStateForSafetyCheck).not.toHaveBeenCalled();
      gate.resolve();
      if (held) await held;
      await withClaimOwnershipLock(() => {});
      expect(store.state).toEqual(before);
      expect(saveState).not.toHaveBeenCalled();
      expect(cosEvents.emit).not.toHaveBeenCalled();
    }
    store.stateGate = null;
    expect(await update(action)).toEqual({ [action === 'bind' ? 'bound' : 'released']: true, branch: 'claim/issue-101' });
  });

  it('fences overdue callbacks even when the timer has not run, sharing the budget across queues', async () => {
    const ownership = deferred();
    const state = deferred();
    const held = withClaimOwnershipLock(() => ownership.promise);
    store.stateGate = state.promise;
    const pending = update('bind');
    await tick();
    await vi.advanceTimersByTimeAsync(CLAIM_OWNERSHIP_QUEUE_TIMEOUT_MS - 1);
    ownership.resolve();
    await held;
    await tick();
    expect(withStateLock).toHaveBeenCalledOnce();
    // Advance only the monotonic clock; leave the scheduled timer unfired.
    vi.spyOn(performance, 'now').mockReturnValue(CLAIM_OWNERSHIP_QUEUE_TIMEOUT_MS);
    state.resolve();
    expect(await pending).toEqual({ bound: false, reason: 'state-queue-timeout', retryAfterMs: 5000 });
    expect(readAgentsStateForSafetyCheck).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled();
    await withClaimOwnershipLock(() => {});
  });

  it('keeps a started save owned until durable settlement and reports redacted persistence evidence', async () => {
    const save = deferred();
    store.saveGate = save.promise;
    const before = structuredClone(store.state);
    let settled = false;
    const pending = update('bind').then(result => { settled = true; return result; });
    await tick();
    expect(saveState).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(CLAIM_OWNERSHIP_QUEUE_TIMEOUT_MS);
    expect(settled).toBe(false);
    expect(store.state).toEqual(before);
    expect(cosEvents.emit).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('status=pending phase=persistence'));
    let nextEntered = false;
    const following = withClaimOwnershipLock(() => { nextEntered = true; });
    await tick();
    expect(nextEntered).toBe(false);
    save.resolve();
    expect(await pending).toEqual({ bound: true, branch: 'claim/issue-101' });
    await following;
    expect(store.state.agents['agent-epicrun'].metadata.claimBranches).toEqual(['claim/issue-101']);
    expect(cosEvents.emit).toHaveBeenCalledWith('agent:updated', expect.objectContaining({ id: 'agent-epicrun' }));
    expect(cosEvents.emit).toHaveBeenCalledWith('claim:ownership-changed', { agentId: 'agent-epicrun', repository: SOURCE });
    const diagnostics = [...console.warn.mock.calls, ...console.log.mock.calls].flat().join(' ');
    expect(diagnostics).not.toMatch(/agent-epicrun|claim\/issue|repos/);
    expect(diagnostics).toMatch(/ownershipQueueMs=\d+ stateQueueMs=\d+ ownerReadMs=\d+ ownershipCheckMs=\d+ persistenceMs=\d+/);
  });

  it('diagnoses an in-flight trusted owner read and refuses unreadable or stale ownership without writes', async () => {
    const read = deferred();
    store.readGate = read.promise;
    store.unreadable = true;
    const pending = update('bind');
    await tick();
    await vi.advanceTimersByTimeAsync(CLAIM_OWNERSHIP_QUEUE_TIMEOUT_MS);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('status=pending phase=ownerRead'));
    read.resolve();
    expect(await pending).toEqual({ bound: false, reason: 'ownership-unreadable' });
    store.unreadable = false;
    store.stale = true;
    expect(await update('release')).toEqual({ released: false, reason: 'ownership-stale' });
    expect(saveState).not.toHaveBeenCalled();
  });

  it('propagates a started persistence failure and releases the queue only after rejection', async () => {
    const save = deferred();
    store.saveGate = save.promise;
    const before = structuredClone(store.state);
    const pending = update('bind');
    const failure = expect(pending).rejects.toThrow('synthetic write failure');
    await tick();
    await vi.advanceTimersByTimeAsync(CLAIM_OWNERSHIP_QUEUE_TIMEOUT_MS);
    save.reject(new Error('synthetic write failure'));
    await failure;
    await withClaimOwnershipLock(() => {});
    expect(store.state).toEqual(before);
    expect(cosEvents.emit).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('status=failed phase=persistence'));
  });
});

// The scan that dispatched a reconcile worker is stale by the time it mutates:
// ownership acquired in between must refuse at the worker's own recheck.
describe('checkReconcileOwnership', () => {
  const holder = { path: CHILD, branch: 'refs/heads/claim/issue-101' };
  const check = (agents, overrides = {}, input = {}) => checkReconcileOwnership(
    { appId: 'app-x', branch: 'claim/issue-101', worktreePath: CHILD, ...input },
    {
      getAppById: async (id) => (id === 'app-x' ? { id, repoPath: SOURCE } : null),
      listWorktrees: async () => [holder],
      getAgents: async () => agents,
      getActiveAgentIds: () => [],
      readCompletionHold: async () => null,
      ...overrides,
    },
  );

  it('admits a checkout no live run owns', async () => {
    expect(await check([])).toEqual({ admitted: true });
  });

  it('refuses once a claim run bound the branch after the scan', async () => {
    const owner = { id: 'agent-epicrun', status: 'running', workspacePath: SOURCE, metadata: { sourceWorkspace: SOURCE, claimBranches: ['claim/issue-101'] } };
    expect(await check([owner])).toEqual({ admitted: false, reason: 'claim-owner-active' });
    expect(await check([{ ...owner, status: 'completed' }])).toEqual({ admitted: true });
  });

  it('refuses when ownership is unreadable, the app is unknown, or the holder moved', async () => {
    expect(await check(null)).toEqual({ admitted: false, reason: 'ownership-unreadable' });
    expect(await check([], { listWorktrees: async () => { throw new Error('git failed'); } })).toEqual({ admitted: false, reason: 'ownership-unreadable' });
    expect(await check([], {}, { appId: 'app-missing' })).toEqual({ admitted: false, reason: 'app-unknown' });
    expect(await check([], { listWorktrees: async () => [] })).toEqual({ admitted: false, reason: 'holder-changed' });
    expect(await check([], { listWorktrees: async () => [{ ...holder, locked: true }] })).toEqual({ admitted: false, reason: 'worktree-locked' });
  });
});

// A successful check by a named coordinator is an acquire (#10096): the claim run
// that binds mid-mutation would otherwise be handed the same checkout.
describe('checkReconcileOwnership reservation', () => {
  const holder = { path: CHILD, branch: 'refs/heads/claim/issue-101' };
  const admit = (agentId, input = {}) => checkReconcileOwnership(
    { appId: 'app-x', branch: 'claim/issue-101', worktreePath: CHILD, agentId, ...input },
    {
      getAppById: async (id) => ({ id, repoPath: SOURCE }),
      listWorktrees: async () => [holder],
      getAgents: async () => Object.values(store.state.agents),
      getActiveAgentIds: () => [],
      readCompletionHold: async () => null,
    },
  );
  const bind = () => updateClaimOwnership({ agentId: 'agent-picker', action: 'bind', branch: 'claim/issue-101' });

  beforeEach(() => {
    store.state.agents['agent-recon'] = {
      id: 'agent-recon', status: 'running', workspacePath: SOURCE, metadata: { sourceWorkspace: SOURCE },
    };
    store.state.agents['agent-picker'] = {
      id: 'agent-picker', status: 'running', workspacePath: SOURCE,
      metadata: { sourceWorkspace: SOURCE, claimBranch: 'claim/issue-100', claimPicksOwnBranch: false },
    };
    delete store.state.agents['agent-epicrun'];
  });

  it('refuses a claim bind, continuation and adoption of an admitted branch until the coordinator ends', async () => {
    expect(await admit('agent-recon')).toEqual({ admitted: true });
    expect(store.state.agents['agent-recon'].metadata.claimBranches).toEqual(['claim/issue-101']);

    expect(await bind()).toEqual({ bound: false, reason: 'owner-active' });
    const agents = Object.values(store.state.agents);
    const metadata = { existingBranch: 'claim/issue-101', resumeWorktreePath: CHILD };
    expect(claimContinuationAdmission({ metadata, agentId: 'agent-picker', sourceWorkspace: SOURCE, worktrees: [holder], agents }))
      .toEqual({ admit: false, reason: 'owner-active' });
    expect(claimBranchAdmission({ branchName: 'claim/issue-101', preferredPath: CHILD, agentId: 'agent-picker', sourceWorkspace: SOURCE, worktrees: [holder], agents }))
      .toEqual({ admit: false, reason: 'owner-active' });

    store.state.agents['agent-recon'].status = 'completed';
    expect(await bind()).toEqual({ bound: true, branch: 'claim/issue-101' });
  });

  it('lets the coordinator re-admit its own branch and release it explicitly', async () => {
    expect(await admit('agent-recon')).toEqual({ admitted: true });
    expect(await admit('agent-recon')).toEqual({ admitted: true });
    expect(store.state.agents['agent-recon'].metadata.claimBranches).toEqual(['claim/issue-101']);

    expect(await updateClaimOwnership({ agentId: 'agent-recon', action: 'release', branch: 'claim/issue-101' }))
      .toEqual({ released: true, branch: 'claim/issue-101' });
    expect(await bind()).toEqual({ bound: true, branch: 'claim/issue-101' });
  });

  it('stays read-only without an agent id and writes nothing when refused', async () => {
    const before = structuredClone(store.state);
    expect(await admit(undefined)).toEqual({ admitted: true });
    expect(store.state).toEqual(before);

    expect(await admit('agent-gone')).toEqual({ admitted: false, reason: 'owner-unknown' });
    store.state.agents['agent-recon'].status = 'completed';
    expect(await admit('agent-recon')).toEqual({ admitted: false, reason: 'owner-not-running' });
    store.state.agents['agent-recon'].status = 'running';
    store.state.agents['agent-picker'].metadata.claimBranches = ['claim/issue-101'];
    expect(await admit('agent-recon')).toEqual({ admitted: false, reason: 'claim-owner-active' });
    expect(store.state.agents['agent-recon'].metadata.claimBranches).toBeUndefined();
  });

  // #12682: retirement archives with the ownership lock released, fenced per checkout.
  it('refuses binds and admissions for a checkout being archived, and only that checkout, until the fence lifts', async () => {
    const before = structuredClone(store.state);
    const releaseFence = await withClaimOwnershipLock(() => reserveCheckoutRetirementFence({ repoPath: SOURCE, path: CHILD, branch: 'refs/heads/claim/issue-101' }));
    expect(await withClaimOwnershipLock(() => reserveCheckoutRetirementFence({ repoPath: `${SOURCE}/`, path: CHILD }))).toBeNull();

    expect(await bind()).toEqual({ bound: false, reason: 'checkout-retirement-reserved' });
    expect(await admit('agent-recon')).toEqual({ admitted: false, reason: 'checkout-retirement-reserved' });
    expect(await admit(undefined)).toEqual({ admitted: false, reason: 'checkout-retirement-reserved' });
    expect(store.state).toEqual(before);
    // Releasing a branch and binding a different one are not fenced.
    expect(await updateClaimOwnership({ agentId: 'agent-picker', action: 'bind', branch: 'claim/issue-102' }))
      .toEqual({ bound: true, branch: 'claim/issue-102' });
    expect(await updateClaimOwnership({ agentId: 'agent-picker', action: 'release', branch: 'claim/issue-102' }))
      .toEqual({ released: true, branch: 'claim/issue-102' });

    await withClaimOwnershipLock(releaseFence);
    expect(await bind()).toEqual({ bound: true, branch: 'claim/issue-101' });
  });

  it('reserves nothing for a branch no claim run can bind', async () => {
    const before = structuredClone(store.state);
    const feature = { path: '/repos/app-x/other', branch: 'refs/heads/feature/x' };
    expect(await checkReconcileOwnership(
      { appId: 'app-x', branch: 'feature/x', worktreePath: feature.path, agentId: 'agent-recon' },
      { getAppById: async (id) => ({ id, repoPath: SOURCE }), listWorktrees: async () => [feature], getAgents: async () => [], getActiveAgentIds: () => [], readCompletionHold: async () => null },
    )).toEqual({ admitted: true });
    expect(store.state).toEqual(before);
  });
});
