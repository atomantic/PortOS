import { afterAll, expect, it, vi } from 'vitest';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { mockPathsDataRoot, mockTestIdentity } from '../lib/mockPathsDataRoot.js';
import { destroyGitSandbox, makeGitSandbox, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';

const f = vi.hoisted(() => ({ state: { agents: {} }, disk: null, task: null, pr: null }));
const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-detached-admission-' });
vi.mock('../lib/fileUtils.js', async importOriginal => makeProxy(await importOriginal()));
vi.mock('./instanceIdentity.js', () => mockTestIdentity());
vi.mock('./cosState.js', () => ({
  withStateLock: createFileWriteQueue(), loadState: async () => f.state,
  saveState: async state => { f.state = state; f.disk = structuredClone(state); },
  readMergeAdmissionStateForSafetyCheck: async () => ({ trusted: true, ...structuredClone(f.disk) }),
}));
vi.mock('../lib/gitRemote.js', async importOriginal => ({ ...(await importOriginal()),
  getOriginInfo: async () => ({ host: 'github.com', fullName: 'example/repo' }),
}));
vi.mock('./github.js', () => ({ execGh: async () => JSON.stringify(f.pr) }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async cwd => ({ cwd, env: {} }) }));
vi.mock('./cosTaskStore.js', () => ({ getTaskById: async () => f.task }));
const { createWorktree } = await import('./worktreeManager.js');
const { resolveMergeHandoffOwner } = await import('./mergeHandoffOwner.js');
const { buildAgentRegistration } = await import('../lib/agentRegistrationRecord.js');
afterAll(cleanup);

it.skipIf(SKIP_HEAVY_INTEGRATION)('resolves a real detached default-head checkout as handoff owner without switching the primary branch, and refuses a moved head', async () => {
  const sandbox = await makeGitSandbox({ origin: true, prefix: 'portos-detached-merge-' });
  try {
    await execGit(['push', 'origin', 'main'], sandbox.repo);
    const head = (await execGit(['rev-parse', 'HEAD'], sandbox.repo)).stdout.trim();
    const info = await createWorktree('agent-review', sandbox.repo, 'task-review', { existingBranch: 'main' });
    expect(info).toMatchObject({ detached: true, headIsDefaultBranch: true, headSha: head });
    f.task = { id: 'task-review', taskType: 'internal', status: 'in_progress', metadata: {
      reviewLoopFollowUp: true, reviewLoopPRUrl: 'https://github.com/example/repo/pull/42',
      reviewLoopPRBranch: 'main', reviewLoopPRNumber: 42, reviewLoopPRHost: 'github.com',
      reviewLoopPROwner: 'example', reviewLoopPRRepo: 'repo', prCompletion: 'review-then-merge',
    } };
    const metadata = buildAgentRegistration({ task: f.task, provider: { id: 'test' }, modelSelection: {},
      sourceWorkspace: sandbox.repo, workspacePath: info.worktreePath, worktreeInfo: info });
    f.state.agents['agent-review'] = { id: 'agent-review', taskId: f.task.id, status: 'running',
      startedAt: new Date().toISOString(), metadata };
    f.disk = structuredClone(f.state);
    f.pr = { url: f.task.metadata.reviewLoopPRUrl, number: 42, state: 'OPEN', headRefName: 'main',
      headRefOid: head, isCrossRepository: false };
    const owner = await resolveMergeHandoffOwner('agent-review');
    expect(owner).toMatchObject({ repository: 'github.com/example/repo' });
    expect(owner.owns('main')).toBe(true);
    await execGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'Moved head'], info.worktreePath);
    expect(await resolveMergeHandoffOwner('agent-review')).toEqual({ refused: 'handoff-owner-unverified' });
    expect((await execGit(['symbolic-ref', '--short', 'HEAD'], sandbox.repo)).stdout.trim()).toBe('main');
    expect((await execGit(['rev-parse', 'HEAD'], sandbox.repo)).stdout.trim()).toBe(head);
  } finally {
    await destroyGitSandbox(sandbox.scratch);
  }
});
