import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ app: null, tasks: new Map(), agents: [], pr: null }));
const forge = vi.hoisted(() => vi.fn());
const checkout = vi.hoisted(() => vi.fn());
vi.mock('./apps.js', () => ({ getAppById: async () => state.app }));
vi.mock('./cosTaskStore.js', () => ({ getTaskById: async id => state.tasks.get(id) }));
vi.mock('./cosClaimOwnershipState.js', () => ({ readClaimOwnershipAgents: async () => state.agents }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async () => ({ env: { GH_TOKEN: 'fixture-account' } }) }));
vi.mock('./github.js', () => ({ execGh: (...args) => forge(...args) }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: async () => ({ host: 'github.com', fullName: 'owner/repo' }) }));
vi.mock('./pendingMergeCheckout.js', () => ({ verifyPendingMergeCheckout: (...args) => checkout(...args) }));
import { preparePendingMergeRecovery, validatePendingMergeRecovery } from './pendingMergeRecovery.js';

const headSha = 'a'.repeat(40);
const entry = { prUrl: 'https://github.com/owner/repo/pull/88', prBranch: 'claim/issue-1',
  sourceAgentId: 'owner', sourceTask: { id: 'source-task' } };
beforeEach(() => {
  state.app = { id: 'app1', repoPath: '/repo', forgeAccount: 'configured-account' };
  state.agents = [];
  state.tasks = new Map([['source-task', { id: 'source-task', status: 'completed', metadata: { app: 'app1', prCompletion: 'merge-on-green' } }]]);
  state.pr = { state: 'OPEN', isDraft: false, isCrossRepository: false, headRefName: entry.prBranch, headRefOid: headSha };
  forge.mockReset().mockImplementation(async () => JSON.stringify(state.pr));
  checkout.mockReset().mockResolvedValue(true);
});

describe('pending merge recovery admission', () => {
  it('binds dispatch and checkout launch to the same published head and persisted target', async () => {
    const { target } = await preparePendingMergeRecovery({ app: state.app, entry, headSha });
    expect(await validatePendingMergeRecovery({ target, workspacePath: '/repo' })).toBeNull();
    state.tasks.set('recovery-task', { id: 'recovery-task', status: 'pending', metadata: {
      prCompletion: target.prCompletion, pendingMergeGuardTarget: target,
      reviewLoopPRUrl: target.prUrl, reviewLoopPRBranch: target.branch,
    } });
    const launch = { target, workspacePath: '/worktree', requireCheckout: true, launchTaskId: 'recovery-task' };
    expect(await validatePendingMergeRecovery(launch)).toBeNull();
    expect(checkout).toHaveBeenCalledWith('/repo', '/worktree', target.branch, headSha);
    state.pr.headRefOid = 'b'.repeat(40);
    expect(await validatePendingMergeRecovery(launch)).toBe('recovery-head-moved');
    state.pr.headRefOid = headSha;
    state.tasks.get('recovery-task').metadata.pendingMergeGuardTarget = { ...target, headSha: 'b'.repeat(40) };
    expect(await validatePendingMergeRecovery(launch)).toBe('recovery-launch-task-changed');
  });

  it('withholds launch if the source policy changes during remote evidence reads', async () => {
    const { target } = await preparePendingMergeRecovery({ app: state.app, entry, headSha });
    forge.mockImplementation(async () => {
      state.tasks.get('source-task').metadata.prCompletion = 'leave-open';
      return JSON.stringify(state.pr);
    });
    expect(await validatePendingMergeRecovery({ target, workspacePath: '/repo' })).toBe('recovery-owner-policy-held');
  });

  it('recognizes only the scheduled snapshot producer as an ownerless source', async () => {
    const snapshot = { ...entry, sourceAgentId: null, sourceTask: { id: 'quality-snapshot-app1' }, prBranch: 'portos/quality-snapshot' };
    state.pr.headRefName = snapshot.prBranch;
    const { target } = await preparePendingMergeRecovery({ app: state.app, entry: snapshot, headSha });
    expect(target).toMatchObject({ sourceAgentId: null, sourceTaskId: 'quality-snapshot-app1', headSha });
    expect(await validatePendingMergeRecovery({ target, workspacePath: '/repo' })).toBeNull();
    expect(await preparePendingMergeRecovery({ app: state.app, entry: { ...snapshot, prBranch: 'other' }, headSha }))
      .toEqual({ blocked: 'recovery-owner-unreadable' });
  });
});
