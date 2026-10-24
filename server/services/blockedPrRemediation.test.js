import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./notifications.js', () => ({
  addNotification: vi.fn().mockResolvedValue({}),
  exists: vi.fn().mockResolvedValue(false),
  NOTIFICATION_TYPES: { AGENT_WARNING: 'agent_warning' },
  PRIORITY_LEVELS: { HIGH: 'high' },
}));
vi.mock('./brainTaskThreads.js', () => ({ ensureTaskThread: vi.fn().mockResolvedValue({}) }));

vi.mock('./cosTaskStore.js', () => ({ addTask: vi.fn(), getTaskById: vi.fn(), updateTask: vi.fn() }));
vi.mock('./github.js', () => ({ execGh: vi.fn().mockImplementation(async (args) => args[0] === 'api' ? 'maintainer' : 'false') }));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn() }));
vi.mock('./forgeAuth.js', () => ({ resolveForgeForRepo: vi.fn().mockResolvedValue({ cli: 'gh', env: {} }) }));
vi.mock('./apps.js', () => ({ getAppById: vi.fn().mockResolvedValue({ repoPath: '/repos/example' }) }));

import { getTaskById, updateTask } from './cosTaskStore.js';
import { execGh } from './github.js';
import { handBackBlockedPrRemediation } from './blockedPrRemediation.js';
import { addNotification } from './notifications.js';
import { ensureTaskThread } from './brainTaskThreads.js';

const PR_URL = 'https://github.com/example-org/example-repo/pull/9';

const followUp = (metadata = {}) => ({
  id: 'sys-rl-1',
  status: 'blocked',
  metadata: {
    reviewLoopFollowUp: true,
    reviewLoopPRUrl: PR_URL,
    reviewLoopPRBranch: 'cos/task-1/agent-1',
    blockedReason: "App 'null' didn't resolve to a repository directory.",
    blockedCategory: 'app-unresolved',
    ...metadata,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('automated merge follow-ups', () => {
  it.each(['app-unresolved', 'max-retries', 'worktree-failed', 'worktree-busy'])(
    'keeps a %s block out of human notifications and Brain commitments', async blockedCategory => {
      expect(await handBackBlockedPrRemediation({ task: followUp({ blockedCategory }), previousStatus: 'pending' })).toBe(false);
      expect(addNotification).not.toHaveBeenCalled();
      expect(ensureTaskThread).not.toHaveBeenCalled();
      expect(execGh).not.toHaveBeenCalled();
    },
  );
});

// Exercises the same entrypoint the tasks:changed listener invokes, through the
// real hand-back service to the forge adapter.
describe('blocked PR remediation hand-back', () => {
  const remediation = (blockedCategory) => ({
    id: 'sys-remediation-1', app: 'app-1', status: 'blocked',
    metadata: {
      prRemediationFollowUp: true, blockedCategory,
      prRemediationNumber: 9, prRemediationRepoFullName: 'example-org/example-repo',
      prRemediationUrl: PR_URL, prRemediationAuthorLogin: 'contributor',
      prRemediationHeadSha: 'a'.repeat(40),
    },
  });

  it.each(['worktree-failed', 'max-retries'])('hands back %s once across concurrent events and later re-blocks', async (category) => {
    const task = remediation(category);
    getTaskById.mockImplementation(async () => structuredClone(task));
    updateTask.mockImplementation(async (_id, { metadata }) => {
      Object.assign(task.metadata, metadata);
      return structuredClone(task);
    });
    const change = { task: structuredClone(task), previousStatus: 'pending' };
    expect(await Promise.all([handBackBlockedPrRemediation(change), handBackBlockedPrRemediation(change)])).toEqual([true, false]);
    const writes = execGh.mock.calls.filter(([args]) => ['comment', 'edit'].includes(args[1]));
    expect(writes.map(([args]) => args.slice(0, 3))).toEqual([
      ['pr', 'comment', PR_URL], ['pr', 'edit', PR_URL],
    ]);
    expect(writes[0][0].at(-1)).toContain('remediation task is now blocked');
    expect(writes[0][0].at(-1)).not.toContain('it did not run');
    expect(writes[1][0]).toContain('contributor');
    expect(task.metadata.prRemediationHandedBackAt).toEqual(expect.any(String));
    expect(updateTask).toHaveBeenCalledWith(task.id, { metadata: { prRemediationHandedBackAt: expect.any(String) } }, 'internal');
    expect(await handBackBlockedPrRemediation(change)).toBe(false);
    expect(execGh).toHaveBeenCalledTimes(4);
    expect(addNotification).not.toHaveBeenCalled();
  });

  it.each(['worktree-busy', 'pr-head-moved'])('does not hand back a %s block', async (category) => {
    expect(await handBackBlockedPrRemediation({ task: remediation(category), previousStatus: 'pending' })).toBe(false);
    expect(execGh).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('ignores empty payloads and events without a block transition', async () => {
    expect(await handBackBlockedPrRemediation()).toBe(false);
    expect(await handBackBlockedPrRemediation({})).toBe(false);
    const task = remediation('max-retries');
    expect(await handBackBlockedPrRemediation({ task, previousStatus: 'blocked' })).toBe(false);
    expect(await handBackBlockedPrRemediation({ task: { ...task, status: 'pending' }, previousStatus: 'blocked' })).toBe(false);
    expect(execGh).not.toHaveBeenCalled();
  });

  it('does not hand back a task revived before its event was processed', async () => {
    const task = remediation('max-retries');
    getTaskById.mockResolvedValue({ ...task, status: 'pending' });
    expect(await handBackBlockedPrRemediation({ task, previousStatus: 'in_progress' })).toBe(false);
    expect(execGh).not.toHaveBeenCalled();
  });
});
