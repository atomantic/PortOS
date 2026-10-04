import { describe, expect, it, vi, beforeEach } from 'vitest';

const store = { state: null };
vi.mock('./cosState.js', () => ({
  withStateLock: (work) => work(),
  loadState: async () => structuredClone(store.state),
  saveState: async (next) => { store.state = structuredClone(next); },
}));
vi.mock('./cosEvents.js', () => ({ cosEvents: { emit: vi.fn() } }));

const { updateClaimOwnership, checkReconcileOwnership } = await import('./cosClaimOwnership.js');
const { claimContinuationAdmission, claimBranchAdmission } = await import('../lib/claimContinuation.js');

const SOURCE = '/repos/app-x';
const CHILD = '/repos/app-x/data/cos/worktrees/claim-issue-101';

beforeEach(() => {
  store.state = {
    agents: {
      'agent-epicrun': {
        id: 'agent-epicrun', status: 'running', workspacePath: SOURCE,
        metadata: { sourceWorkspace: SOURCE, claimBranch: 'claim/issue-100', claimPicksOwnBranch: false, claimSelectionPending: true },
      },
    },
  };
});

describe('updateClaimOwnership', () => {
  it('persists the bound child branch on the run record and settles its selection', async () => {
    expect(await updateClaimOwnership({ agentId: 'agent-epicrun', action: 'bind', branch: 'claim/issue-101' }))
      .toEqual({ bound: true, branch: 'claim/issue-101' });
    expect(store.state.agents['agent-epicrun'].metadata).toMatchObject({
      claimBranch: 'claim/issue-100', claimBranches: ['claim/issue-101'], claimSelectionPending: false,
    });
    expect(await updateClaimOwnership({ agentId: 'agent-epicrun', action: 'release', branch: 'claim/issue-101' }))
      .toEqual({ released: true, branch: 'claim/issue-101' });
    expect(store.state.agents['agent-epicrun'].metadata).toMatchObject({ claimBranches: [], claimReleasedBranches: ['claim/issue-101'] });
  });

  it('refuses an unknown or finished run without writing', async () => {
    const before = structuredClone(store.state);
    expect(await updateClaimOwnership({ agentId: 'agent-gone', action: 'bind', branch: 'claim/issue-101' }))
      .toEqual({ bound: false, reason: 'owner-unknown' });
    store.state.agents['agent-epicrun'].status = 'completed';
    expect(await updateClaimOwnership({ agentId: 'agent-epicrun', action: 'bind', branch: 'claim/issue-101' }))
      .toEqual({ bound: false, reason: 'owner-not-running' });
    expect(store.state.agents['agent-epicrun'].metadata).toEqual(before.agents['agent-epicrun'].metadata);
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

  it('reserves nothing for a branch no claim run can bind', async () => {
    const before = structuredClone(store.state);
    const feature = { path: '/repos/app-x/other', branch: 'refs/heads/feature/x' };
    expect(await checkReconcileOwnership(
      { appId: 'app-x', branch: 'feature/x', worktreePath: feature.path, agentId: 'agent-recon' },
      { getAppById: async (id) => ({ id, repoPath: SOURCE }), listWorktrees: async () => [feature], getAgents: async () => [], getActiveAgentIds: () => [] },
    )).toEqual({ admitted: true });
    expect(store.state).toEqual(before);
  });
});
