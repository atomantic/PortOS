import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Post-merge gate audit (#12549) at the finalizer boundary: the forge, the
// run's recorded lease history and the task queue are injected; the audit,
// the watch sweep and the pure assessment run for real.
const f = vi.hoisted(() => ({
  agent: null, apps: new Map(), tasks: [], prs: [], checks: [], statuses: [], suites: [], held: null, addTaskFailures: 0,
}));

const execGhMock = vi.fn();
vi.mock('./github.js', () => ({ execGh: (...args) => execGhMock(...args) }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async (cwd) => ({ cwd, env: {} }) }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: async () => ({ host: 'github.com', fullName: 'example/repo' }) }));
vi.mock('./apps.js', () => ({
  getAppById: async (id) => f.apps.get(id) ?? null,
  getActiveApps: async () => [...f.apps.values()],
  updateApp: async (id, patch) => { const next = { ...f.apps.get(id), ...patch }; f.apps.set(id, next); return next; },
}));
vi.mock('./cosState.js', () => ({
  readMergeAdmissionStateForSafetyCheck: async () => ({
    trusted: true, agents: {}, mergeAdmissions: f.held ? { 'github.com/example/repo': f.held } : {},
  }),
}));
vi.mock('./cosMergeAdmission.js', () => ({ repositoryKey: (origin) => `${origin.host}/${origin.fullName}`.toLowerCase() }));
vi.mock('./cosAgentLifecycle.js', () => ({
  updateAgent: async (_id, patch) => { f.agent = { ...f.agent, metadata: { ...f.agent.metadata, ...patch.metadata } }; return f.agent; },
  getAgentRecord: async () => f.agent,
}));
// addTask's real dedupe is first-line + app against open tasks; mirror it.
const addTaskMock = vi.fn(async (data) => {
  if (f.addTaskFailures > 0) { f.addTaskFailures -= 1; throw new Error('queue unavailable'); }
  const open = f.tasks.find((task) => task.description.split('\n')[0] === data.description.split('\n')[0] && task.app === data.app);
  if (open) return { ...open, duplicate: true };
  const created = { id: `task-${f.tasks.length + 1}`, ...data };
  f.tasks.push(created);
  return created;
});
vi.mock('./cosTaskStore.js', () => ({ addTask: (...args) => addTaskMock(...args) }));
const notifyMock = vi.fn(async () => ({ id: 'notification-1' }));
vi.mock('./notifications.js', () => ({
  addNotification: (...args) => notifyMock(...args),
  NOTIFICATION_TYPES: { AGENT_WARNING: 'agent_warning' },
  PRIORITY_LEVELS: { HIGH: 'high' },
}));
const appendRunEventMock = vi.fn(async () => ({ appended: true }));
vi.mock('./agentRunEventLog.js', () => ({ appendRunEvent: (...args) => appendRunEventMock(...args) }));

import { auditClaimMergeGate, sweepMergeGateWatches, __cancelMergeGatePolls } from './mergeGateAudit.js';

const HEAD = 'a'.repeat(40);
const PR_URL = 'https://github.com/example/repo/pull/7';
const MERGED_AT = '2026-10-20T02:16:47Z';
const task = { id: 'task-agent-1', metadata: { app: 'app1' } };

const run = (agentId = 'agent-1') => auditClaimMergeGate({ agentId, task, agentState: { ...f.agent, id: agentId } });
const check = (overrides) => ({ name: 'build', status: 'completed', conclusion: 'success', suite: 1, completed_at: '2026-10-20T02:10:00Z', ...overrides });
const lease = (overrides) => ({ repository: 'github.com/example/repo', outcome: 'merged',
  acquiredAt: '2026-10-20T02:16:30Z', releasedAt: '2026-10-20T02:16:55Z', ...overrides });

beforeEach(() => {
  f.agent = {
    id: 'agent-1', taskId: 'task-agent-1', startedAt: '2026-10-20T02:00:00Z',
    metadata: { sourceWorkspace: '/repos/source', claimBranches: ['claim/issue-1'], runId: 'run-1' },
  };
  f.apps = new Map([['app1', { id: 'app1', name: 'Example App', repoPath: '/repos/source', forgeAccount: null }]]);
  f.tasks = [];
  f.held = null;
  f.prs = [{ number: 7, url: PR_URL, headRefOid: HEAD, mergedAt: MERGED_AT, baseRefName: 'main' }];
  f.checks = [check()];
  f.statuses = [];
  f.suites = [{ id: 1, created_at: '2026-10-20T02:09:00Z' }, { id: 2, created_at: '2026-10-20T02:30:00Z' }];
  f.addTaskFailures = 0;
  addTaskMock.mockClear();
  notifyMock.mockClear();
  appendRunEventMock.mockClear();
  execGhMock.mockReset().mockImplementation(async (args) => {
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(f.prs);
    if (args[0] === 'api') {
      const path = args.find((arg) => String(arg).startsWith('repos/'));
      const rows = path.includes('/check-suites') ? f.suites : path.includes('/status') ? f.statuses : f.checks;
      if (rows === null) throw new Error('forge down');
      return rows.map((c) => JSON.stringify(c)).join('\n');
    }
    throw new Error('unexpected forge read');
  });
});

afterEach(() => __cancelMergeGatePolls());

describe('post-merge gate audit', () => {
  it('flags a merge made without a lease before its checks were green and queues ONE recovery when they fail', async () => {
    // The #12549 incident: merged 25s after the build started, check failed minutes later.
    f.checks = [check({ name: 'build (22.x)', conclusion: 'failure', completed_at: '2026-10-20T02:20:00Z' })];

    expect(await run()).toMatchObject({ audited: 1, violations: 1 });
    expect(f.agent.metadata.mergeGateViolations).toEqual([expect.objectContaining({
      prUrl: PR_URL, prNumber: 7, headSha: HEAD, mergedAt: MERGED_AT,
      codes: ['no-admission-lease', 'checks-not-green-at-merge'], notGreenAtMerge: ['build (22.x)'],
    })]);
    expect(appendRunEventMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'run.merge-gate-violation', agentId: 'agent-1', runId: 'run-1',
    }));
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ priority: 'high', link: PR_URL }));
    expect(f.tasks).toHaveLength(1);
    expect(f.tasks[0]).toMatchObject({ app: 'app1', isRecovery: true, priority: 'HIGH' });
    expect(f.tasks[0].description).toContain(HEAD.slice(0, 12));

    // A concurrent run auditing the same merged head queues nothing more, and a
    // repeat finalize of the first run is a no-op.
    f.agent = { ...f.agent, id: 'agent-2' };
    await run('agent-2');
    await run('agent-2');
    expect(f.tasks).toHaveLength(1);
  });

  it('watches a flagged head whose checks are still running and queues the recovery when they finish red', async () => {
    f.checks = [check({ name: 'build', status: 'in_progress', conclusion: null, completed_at: null })];
    expect(await run()).toMatchObject({ violations: 1 });
    expect(f.tasks).toEqual([]);
    expect(f.apps.get('app1').mergeGateWatches).toEqual([expect.objectContaining({ headSha: HEAD, prNumber: 7 })]);

    f.checks = [check({ name: 'build', conclusion: 'failure', completed_at: '2026-10-20T02:20:00Z' })];
    expect(await sweepMergeGateWatches()).toMatchObject({ recovered: 1, remaining: 0 });
    expect(await sweepMergeGateWatches()).toMatchObject({ checked: 0 });
    expect(f.tasks).toHaveLength(1);
    expect(f.apps.get('app1').mergeGateWatches).toEqual([]);
  });

  it('records a lease-only violation but queues no recovery when the head settles green', async () => {
    f.checks = [check({ name: 'build', status: 'in_progress', conclusion: null, completed_at: null })];
    f.agent.metadata.mergeAdmissionHistory = [lease()];
    await run();
    expect(f.agent.metadata.mergeGateViolations[0].codes).toEqual(['checks-not-green-at-merge']);

    f.checks = [check({ name: 'build', completed_at: '2026-10-20T02:25:00Z' })];
    expect(await sweepMergeGateWatches()).toMatchObject({ recovered: 0, remaining: 0 });
    expect(f.tasks).toEqual([]);
  });

  it('never flags an admission-gated merge on green checks, a held-but-unreleased lease or a coordinator merge', async () => {
    // Held lease, green checks.
    f.agent.metadata.mergeAdmissionHistory = [lease()];
    expect(await run()).toMatchObject({ audited: 1, violations: 0 });

    // The run exited holding the lease it merged under.
    f.agent.metadata = { ...f.agent.metadata, mergeAdmissionHistory: [], mergeGateAudits: [] };
    f.held = { kind: 'agent', agentId: 'agent-1', startedAt: f.agent.startedAt, taskId: f.agent.taskId,
      repository: 'github.com/example/repo', acquiredAt: '2026-10-20T02:16:30Z' };
    expect(await run()).toMatchObject({ violations: 0 });

    // The coordinator merged the handed-off head under its own lease: no agent
    // lease on record and a check still reporting in progress must not flag it.
    f.held = null;
    f.agent.metadata = { ...f.agent.metadata, mergeGateAudits: [],
      mergeHandoffReceipts: [{ receiptId: 'receipt-1', prUrl: PR_URL, headSha: HEAD, acceptedAt: '2026-10-20T02:10:00Z',
        coordinatorMergedAt: MERGED_AT }] };
    f.checks = [check({ status: 'in_progress', conclusion: null, completed_at: null })];
    expect(await run()).toMatchObject({ violations: 0 });

    expect(f.agent.metadata.mergeGateViolations).toBeUndefined();
    expect(f.tasks).toEqual([]);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('still flags a run that merged around the queue after handing the head to the coordinator', async () => {
    // A bare handoff receipt (no coordinator merge recorded) proves nothing about who merged.
    f.agent.metadata.mergeHandoffReceipts = [{ receiptId: 'receipt-1', prUrl: PR_URL, headSha: HEAD, acceptedAt: '2026-10-20T02:10:00Z' }];
    expect(await run()).toMatchObject({ violations: 1 });
    expect(f.agent.metadata.mergeGateViolations[0].codes).toEqual(['no-admission-lease']);
  });

  it('does not let a coordinator receipt for one PR exempt another PR sharing its head', async () => {
    f.agent.metadata.mergeHandoffReceipts = [{ receiptId: 'receipt-1', prUrl: 'https://github.com/example/repo/pull/8', headSha: HEAD,
      acceptedAt: '2026-10-20T02:10:00Z', coordinatorMergedAt: MERGED_AT }];
    expect(await run()).toMatchObject({ violations: 1 });
  });

  it('flags a merge made on an expired lease and counts failing commit statuses and ignores post-merge runs', async () => {
    f.agent.metadata.mergeAdmissionHistory = [lease({ acquiredAt: '2026-10-20T02:05:00Z', releasedAt: '2026-10-20T02:17:00Z' })];
    f.checks = [
      check(),
      // A push workflow on the merge commit was never something the merge could wait for.
      check({ name: 'post-merge deploy', suite: 2, conclusion: 'failure', completed_at: '2026-10-20T02:31:00Z' }),
    ];
    f.statuses = [{ name: 'ci/legacy', status: 'completed', conclusion: 'failure', completed_at: '2026-10-20T02:20:00Z' }];
    await run();
    expect(f.agent.metadata.mergeGateViolations).toEqual([expect.objectContaining({
      codes: ['no-admission-lease', 'checks-not-green-at-merge'], notGreenAtMerge: ['ci/legacy'],
    })]);
    expect(f.tasks).toHaveLength(1);
    expect(f.tasks[0].context).toContain('ci/legacy');
    expect(f.tasks[0].context).not.toContain('post-merge deploy');
  });

  it('keeps an audit the forge could not answer and completes it from the durable sweep', async () => {
    f.statuses = null;
    expect(await run()).toMatchObject({ audited: 0, violations: 0, unresolved: true });
    expect(f.agent.metadata.mergeGateViolations).toBeUndefined();
    expect(f.apps.get('app1').mergeGateWatches).toEqual([expect.objectContaining({ kind: 'audit', agentId: 'agent-1' })]);

    f.statuses = [];
    expect(await sweepMergeGateWatches()).toMatchObject({ remaining: 0 });
    expect(f.agent.metadata.mergeGateViolations).toHaveLength(1);
    expect(f.apps.get('app1').mergeGateWatches).toEqual([]);
  });

  it('retries a recovery task the queue refused instead of dropping it', async () => {
    f.checks = [check({ conclusion: 'failure', completed_at: '2026-10-20T02:20:00Z' })];
    f.addTaskFailures = 1;
    await run();
    expect(f.tasks).toEqual([]);
    expect(f.apps.get('app1').mergeGateWatches).toEqual([expect.objectContaining({ headSha: HEAD })]);

    expect(await sweepMergeGateWatches()).toMatchObject({ recovered: 1, remaining: 0 });
    expect(f.tasks).toHaveLength(1);
  });

  it('skips a run that is not a claim', async () => {
    f.agent.metadata.claimBranches = [];
    expect(await run()).toMatchObject({ skipReason: 'not-a-claim-run' });
  });
});
