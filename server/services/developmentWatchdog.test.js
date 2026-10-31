import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ state: null, tasks: [], prs: [], backlog: [], peers: [], adds: [], updates: [], save: vi.fn(), branch: '', account: 'atomantic', fullName: 'atomantic/example', execOptions: [], nextPrs: null, prReads: 0, prStates: {}, dependencies: [], dependencyOpen: false, execGhFailureOn: null, invalidGhJsonOn: null, issueTruncated: false, readiness: { shouldRun: true }, requests: [], duplicate: false, prepare: vi.fn(), record: vi.fn(), execution: vi.fn(), metadata: vi.fn() }));
vi.mock('./cosState.js', () => ({ loadState: async () => m.state, saveState: m.save, withStateLock: async fn => fn(), isImprovementEnabled: state => state.config.improvementEnabled }));
vi.mock('./apps.js', () => ({ getActiveApps: async () => [{ id: 'app', name: 'Example', repoPath: '/example' }] }));
vi.mock('./cosTaskStore.js', () => ({ getAllTasks: async () => ({ user: { tasks: [] }, cos: { tasks: m.tasks } }), updateTask: async (id, updates, type, options) => {
  m.updates.push({ id, updates, type, options });
  const task = m.tasks.find(item => item.id === id);
  if (!task) return { error: 'Task not found' };
  if (options?.expectedStatus && task.status !== options.expectedStatus) return { statusChanged: true, task };
  Object.assign(task, updates, { metadata: { ...task.metadata, ...updates.metadata } });
  return task;
}, addTask: async task => { if (m.duplicate) return { id: 'existing', duplicate: true }; const result = { ...task, id: 'queued', status: 'pending' }; m.tasks.push(result); m.adds.push(result); return result; } }));
vi.mock('./instances.js', () => ({ getPeers: async () => m.peers }));
vi.mock('../lib/workTracker.js', () => ({ resolveAppForgeTarget: async () => ({ tracker: 'github', target: { fullName: m.fullName, repoSpec: `github.com/${m.fullName}`, apiHost: 'github.com' } }) }));
vi.mock('./appPullRequests.js', () => ({ listAppPullRequests: async () => ({ pullRequests: ++m.prReads > 1 && m.nextPrs ? m.nextPrs : m.prs, transient: false }) }));
vi.mock('./perpetualWork.js', async importOriginal => ({ ...(await importOriginal()), detectActionableWork: async () => ({ count: m.backlog.length, items: m.backlog }), listConfiguredForgeIssues: async () => ({ ok: true, truncated: m.issueTruncated, issues: m.backlog.map(i => ({ number: Number(i.ref), labels: [], assignees: [] })) }) }));
vi.mock('./cosTaskClaimWork.js', () => ({
  resolveClaimWorkMetadata: (...args) => m.metadata(...args),
}));
vi.mock('./cosTaskGenerator.js', () => ({
  resolveAutonomyBudget: async () => ({ cosAutonomyMode: 'execute', autonomousActionsRemaining: 10 }),
  prepareManagedAppImprovementTask: (...args) => m.prepare(...args),
  recordDeferredPerpetualDispatch: (...args) => m.record(...args),
}));
vi.mock('./taskSchedule.js', () => ({
  shouldContinuePerpetualDrain: async () => m.readiness,
  getOnDemandRequests: async () => m.requests,
  recordExecution: (...args) => m.execution(...args),
}));
vi.mock('./github.js', () => ({ execGh: async args => {
  if (args[0] === 'api') { if (m.accountFailure) throw new Error(m.accountFailure); return m.account; }
  if (args[0] === m.execGhFailureOn) throw new Error('forge unavailable');
  if (args[0] === m.invalidGhJsonOn) return 'not json';
  return JSON.stringify({ body: '', state: m.dependencyOpen ? 'OPEN' : 'CLOSED', labels: m.dependencyOpen ? [{ name: 'in-progress' }] : [] });
}, getPullRequestState: async number => m.prStates[String(number)] || { status: 'unavailable', state: null } }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async (_path, options) => { m.execOptions.push(options); return {}; } }));
vi.mock('./forgeActorTrust.js', () => ({ createGithubActorTrust: async () => ({ isTrusted: async () => true }) }));
vi.mock('../lib/execGit.js', () => ({ execGit: async () => ({ stdout: m.branch }) }));
vi.mock('../lib/peerHttpClient.js', () => ({ peerFetch: async () => { throw new Error('offline'); } }));
vi.mock('./blockedIssueReconcile.js', () => ({ parseBlockingIssueNumbers: () => m.dependencies }));
vi.mock('./codeReview.js', () => ({ resolveReviewLoopOptions: async () => ({ reviewers: ['codex'] }) }));
vi.mock('./agentWorktreeCleanup.js', () => ({ spawnReviewLoopFollowUp: async options => { m.adds.push(options); return { id: 'resolution' }; } }));
vi.mock('./userActions.js', () => ({ listUserActions: async () => [] }));
vi.mock('./reviewQueue.js', () => ({ buildQueue: async () => ({ sources: {}, partial: false, nextCursor: null }) }));
vi.mock('./persistentMindVisibility.js', () => ({ readPersistentMindVisibility: async () => ({}) }));
vi.mock('./persistentMindProfile.js', () => ({ resolvePersistentMindProfile: async () => ({}) }));
import { runDevelopmentWatchdog, readDevelopmentWatchdogSnapshot } from './developmentWatchdog.js';
import { readPersistentMindMaintenanceContext } from './persistentMindMaintenanceContext.js';

beforeEach(() => {
  m.state = { config: { improvementEnabled: true, persistentMindMaintainer: { enabled: true, appIds: ['app'] }, persistentMindCapabilities: { readPortos: true, createTasks: true }, maxConcurrentAgents: 3 }, agents: {} };
  m.tasks = []; m.prs = []; m.backlog = []; m.peers = []; m.adds = []; m.updates = []; m.branch = ''; m.account = 'atomantic'; m.fullName = 'atomantic/example'; m.execOptions = []; m.save.mockClear(); m.nextPrs = null; m.prReads = 0; m.prStates = {}; m.dependencies = []; m.dependencyOpen = false; m.execGhFailureOn = null; m.accountFailure = null; m.invalidGhJsonOn = null; m.issueTruncated = false;
  m.readiness = { shouldRun: true }; m.requests = []; m.duplicate = false;
  m.metadata.mockReset().mockResolvedValue({ metadata: {} });
  m.prepare.mockReset().mockResolvedValue({
    task: { description: 'Scheduled batch', metadata: { app: 'app', analysisType: 'claim-issue', claimFlow: true, swarmCount: 6, perpetual: true, provider: 'example-cli', model: 'example-model', effort: 'high' } },
    pendingPerpetualDispatch: { taskType: 'claim-issue', appId: 'app', signature: 'backlog' },
  });
  m.record.mockReset(); m.execution.mockReset();
});
describe('development watchdog scan to dispatch', () => {
  it('a mind refresh racing the hourly scan shares admission and does not duplicate a claim', async () => {
    m.backlog = [{ ref: '42' }];
    const [scheduled, wake] = await Promise.all([runDevelopmentWatchdog(), readPersistentMindMaintenanceContext()]);
    expect(m.adds).toHaveLength(1);
    expect(wake.sources.watchdog.receiptId).toBe(scheduled.id);
    expect(wake.sources.watchdog.counts.dispatched).toBe(1);
  });
  it('records empty scans without an agent or inference', async () => {
    const receipt = await runDevelopmentWatchdog({ force: true });
    expect(receipt.complete).toBe(true); expect(receipt.counts).toMatchObject({ dispatched: 0, modelCalls: 0 });
    expect(m.adds).toEqual([]); expect(await readDevelopmentWatchdogSnapshot()).toEqual(receipt);
  });
  it('serializes competing scans and resumes from persisted task ownership', async () => {
    m.backlog = [{ ref: '42' }];
    const results = await Promise.all([runDevelopmentWatchdog({ force: true }), runDevelopmentWatchdog({ force: true })]);
    expect(m.adds).toHaveLength(1); expect(results[1].apps[0].issues[0].disposition).toBe('actively-owned');
    m.state.developmentWatchdog = null;
    await runDevelopmentWatchdog({ force: true }); expect(m.adds).toHaveLength(1);
  });
  it('dry-run is nonmutating even after real scan and external claims do not become agents', async () => {
    await runDevelopmentWatchdog({ force: true }); m.save.mockClear();
    m.backlog = [{ ref: '42' }];
    const preview = await runDevelopmentWatchdog({ dryRun: true });
    expect(preview.decisions[0].outcome).toBe('would-queue'); expect(m.save).not.toHaveBeenCalled();
    m.branch = 'abcdef\trefs/heads/claim/issue-42';
    const receipt = await runDevelopmentWatchdog({ force: true });
    expect(receipt.apps[0].issues[0].disposition).toBe('external-claim'); expect(m.adds).toEqual([]);
  });
  it('pending CI and blocked owners need no resolution agent', async () => {
    m.prs = [{ number: 5, url: 'https://github.com/atomantic/example/pull/5', headSha: 'abc', labels: [], checks: [{ status: 'PENDING' }], author: 'atomantic', headBranch: 'fix' }];
    let receipt = await runDevelopmentWatchdog({ force: true }); expect(receipt.apps[0].pullRequests[0].disposition).toBe('waiting-for-ci-review');
    m.tasks = [{ id: 'held', status: 'blocked', metadata: { app: 'app', reviewLoopPRUrl: m.prs[0].url, blockedCategory: 'max-spawns' } }];
    receipt = await runDevelopmentWatchdog({ force: true }); expect(receipt.apps[0].pullRequests[0].disposition).toBe('blocked'); expect(m.adds).toEqual([]);
  });
  it('an uninspectable app is logged and its receipt row carries a redacted detail', async () => {
    m.accountFailure = 'HTTP 401 bad credentials ghp_abcdefghijklmnopqrstuvwxyz0123456789\nsecond line';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const receipt = await runDevelopmentWatchdog({ force: true });
    const row = receipt.apps[0]; const logged = spy.mock.calls.map(c => c[0]).join('\n'); spy.mockRestore();
    expect(row).toMatchObject({ complete: false, blockers: ['source-unavailable'] });
    expect(row.detail).toContain('HTTP 401'); expect(row.detail).not.toContain('ghp_abcdef'); expect(row.detail).not.toContain('second line');
    expect(logged).toContain('could not inspect app app: HTTP 401'); expect(logged).not.toContain('ghp_abcdef');
  });
  it('unknown participating peer and wrong account defer work', async () => {
    m.backlog = [{ ref: '42' }]; m.peers = [{ id: 'peer', fullSync: true }];
    let receipt = await runDevelopmentWatchdog({ force: true }); expect(receipt.complete).toBe(false); expect(m.adds).toEqual([]);
    m.peers = []; m.account = 'other'; receipt = await runDevelopmentWatchdog({ force: true });
    expect(receipt.apps[0].blockers).toContain('required-forge-account-unavailable'); expect(m.adds).toEqual([]);
  });
  it('invalidates cadence after revoked scope and disable; pause defers writes', async () => {
    m.backlog = [{ ref: '42' }]; m.state.paused = true;
    expect((await runDevelopmentWatchdog({ force: true })).decisions[0].reason).toBe('authority-changed');
    m.state.config.persistentMindCapabilities.allowedAppIds = [];
    expect((await runDevelopmentWatchdog()).apps[0].complete).toBe(false);
    m.state.config.persistentMindMaintainer.enabled = false;
    expect((await runDevelopmentWatchdog()).blockers).toContain('maintainer-disabled'); expect(m.adds).toEqual([]);
  });
});

const orphan = { number: 5, url: 'https://github.com/atomantic/example/pull/5', headSha: 'abc', labels: [], checks: [], author: 'atomantic', headBranch: 'claim/issue-5' };
it('queues abandoned claim PRs through review-then-merge and withholds changed heads', async () => {
  m.prs = [orphan];
  expect((await runDevelopmentWatchdog({ force: true })).counts.dispatched).toBe(1);
  expect(m.adds[0]).toMatchObject({ prCompletion: 'review-then-merge', dispatch: 'queue', reviewers: ['codex'] });
  m.adds = []; m.state.developmentWatchdog = null; m.prReads = 0; m.nextPrs = [{ ...orphan, headSha: 'changed' }];
  expect((await runDevelopmentWatchdog({ force: true })).decisions[0].reason).toBe('evidence-changed'); expect(m.adds).toEqual([]);
});

it('retires a pending review follow-up when the forge confirms its PR is already merged', async () => {
  const task = {
    id: 'sys-rl-merged', status: 'pending',
    metadata: {
      app: 'app', reviewLoopFollowUp: true, reviewLoopPRNumber: '5', reviewLoopPRHost: 'github.com',
      reviewLoopPROwner: 'atomantic', reviewLoopPRRepo: 'example',
      reviewLoopPRUrl: 'https://github.com/atomantic/example/pull/5',
    },
  };
  m.tasks = [task];
  m.prStates['5'] = { status: 'known', state: 'MERGED' };

  const receipt = await runDevelopmentWatchdog({ force: true });

  expect(m.updates).toEqual([expect.objectContaining({
    id: task.id,
    updates: { status: 'completed', metadata: { reviewLoopRetiredReason: 'pull-request-merged-before-follow-up' } },
    type: 'internal', options: { expectedStatus: 'pending', suppressDequeue: true },
  })]);
  expect(task.status).toBe('completed');
  expect(receipt.apps[0].retiredReviewFollowUps).toEqual([{
    taskId: task.id, prNumber: 5, prState: 'MERGED', reason: 'pull-request-merged-before-follow-up',
  }]);
});

it('retires a blocked review follow-up when the forge confirms its PR is already terminal', async () => {
  const task = {
    id: 'sys-rl-blocked', status: 'blocked',
    metadata: {
      app: 'app', reviewLoopFollowUp: true, reviewLoopPRNumber: '7', reviewLoopPRHost: 'github.com',
      reviewLoopPROwner: 'atomantic', reviewLoopPRRepo: 'example',
      reviewLoopPRUrl: 'https://github.com/atomantic/example/pull/7',
    },
  };
  m.tasks = [task];
  m.prStates['7'] = { status: 'known', state: 'MERGED' };

  const receipt = await runDevelopmentWatchdog({ force: true });

  expect(m.updates).toEqual([expect.objectContaining({
    id: task.id,
    updates: { status: 'completed', metadata: { reviewLoopRetiredReason: 'pull-request-merged-before-follow-up' } },
    type: 'internal', options: { expectedStatus: 'blocked', suppressDequeue: true },
  })]);
  expect(task.status).toBe('completed');
  expect(receipt.apps[0].retiredReviewFollowUps).toEqual([{
    taskId: task.id, prNumber: 7, prState: 'MERGED', reason: 'pull-request-merged-before-follow-up',
  }]);
});

it('keeps a blocked follow-up when its PR is still open', async () => {
  const task = {
    id: 'sys-rl-still-open', status: 'blocked',
    metadata: {
      app: 'app', reviewLoopFollowUp: true, reviewLoopPRNumber: '8', reviewLoopPRHost: 'github.com',
      reviewLoopPROwner: 'atomantic', reviewLoopPRRepo: 'example',
      reviewLoopPRUrl: 'https://github.com/atomantic/example/pull/8',
    },
  };
  m.tasks = [task];
  m.prStates['8'] = { status: 'known', state: 'OPEN' };

  const receipt = await runDevelopmentWatchdog({ force: true });

  expect(task.status).toBe('blocked');
  expect(m.updates).toEqual([]);
  expect(receipt.apps[0].retiredReviewFollowUps).toEqual([]);
});

it('keeps a pending review follow-up when the PR state is unavailable', async () => {
  const task = {
    id: 'sys-rl-unavailable', status: 'pending',
    metadata: {
      app: 'app', reviewLoopFollowUp: true, reviewLoopPRNumber: 6, reviewLoopPRHost: 'github.com',
      reviewLoopPROwner: 'atomantic', reviewLoopPRRepo: 'example',
      reviewLoopPRUrl: 'https://github.com/atomantic/example/pull/6',
    },
  };
  m.tasks = [task];

  const receipt = await runDevelopmentWatchdog({ force: true });

  expect(task.status).toBe('pending');
  expect(m.updates).toEqual([]);
  expect(receipt.apps[0].retiredReviewFollowUps).toEqual([]);
});
it('keeps explicit live claim and open dependency evidence out of dispatch', async () => {
  m.prs = [orphan]; m.dependencyOpen = true;
  let receipt = await runDevelopmentWatchdog({ force: true });
  expect(receipt.apps[0].pullRequests[0]).toMatchObject({ disposition: 'unknown', reason: 'external-claim-owner-unverified' });
  expect(receipt.counts.ownedSkips).toBe(0);
  m.prs = [{ ...orphan, headBranch: 'fix' }]; m.dependencies = [10];
  receipt = await runDevelopmentWatchdog({ force: true });
  expect(receipt.decisions[0].reason).toBe('open-dependency'); expect(m.adds).toEqual([]);
});

it.each(['atomantic/PortOS', 'Atomantic/PortOS'])('pins both watchdog forge lookups to upstream for %s', async fullName => {
  m.fullName = fullName;
  m.prs = [{ ...orphan, headBranch: 'fix' }];
  m.dependencies = [10];

  await runDevelopmentWatchdog({ force: true });

  expect(m.execOptions.slice(0, 2).map(options => options?.forgeAccount)).toEqual(['atomantic', 'atomantic']);
});

it('treats a slashdo /do:next branch (next/issue-<num>) as a live external claim, not an orphan (#8161)', async () => {
  // Before #8161, issueNumberFromRef (perpetualWork.js, via planIds.extractSlugFromRef)
  // only recognized claim/ and cos/.../ prefixes, so a next/issue-<num> PR fell through
  // every branch of the disposition chain and read as 'eligible' — dispatching a
  // coordinator onto a branch a live /do:next run was still pushing to.
  m.prs = [{ ...orphan, headBranch: 'next/issue-5' }]; m.dependencyOpen = true;
  const receipt = await runDevelopmentWatchdog({ force: true });
  expect(receipt.apps[0].pullRequests[0]).toMatchObject({ disposition: 'unknown', reason: 'external-claim-owner-unverified' });
  expect(m.adds).toEqual([]);
});

it('turns failed or malformed claim reads into unknown evidence instead of aborting the scan', async () => {
  m.prs = [orphan]; m.execGhFailureOn = 'issue';
  let receipt = await runDevelopmentWatchdog({ force: true });
  expect(receipt.apps[0].pullRequests[0]).toMatchObject({ disposition: 'unknown', reason: 'external-claim-owner-unverified' });
  m.prs = [orphan]; m.execGhFailureOn = null; m.invalidGhJsonOn = 'issue';
  receipt = await runDevelopmentWatchdog({ force: true });
  expect(receipt.apps[0].pullRequests[0]).toMatchObject({ disposition: 'unknown', reason: 'external-claim-owner-unverified' });
  expect(m.adds).toEqual([]);
});

it('withholds dispatch when PR or dependency evidence cannot be read', async () => {
  m.prs = [{ ...orphan, headBranch: 'fix' }]; m.dependencies = [10]; m.execGhFailureOn = 'pr';
  let receipt = await runDevelopmentWatchdog({ force: true });
  expect(receipt.decisions[0].reason).toBe('forge-read-failed'); expect(m.adds).toEqual([]);
  m.execGhFailureOn = 'issue';
  receipt = await runDevelopmentWatchdog({ force: true });
  expect(receipt.decisions[0].reason).toBe('dependency-read-failed'); expect(m.adds).toEqual([]);
});

it('does not repeatedly resolve unchanged PR evidence after its task completes', async () => {
  m.prs = [orphan];
  await runDevelopmentWatchdog({ force: true });
  const again = await runDevelopmentWatchdog({ force: true });
  expect(m.adds).toHaveLength(1);
  expect(again.apps[0].pullRequests[0]).toMatchObject({ disposition: 'blocked', reason: 'unchanged-after-dispatch' });
});

it('reconsiders completed resolution only when review evidence changes', async () => {
  m.prs = [{ ...orphan, reviewDecision: 'REVIEW_REQUIRED' }];
  await runDevelopmentWatchdog({ force: true });
  m.prs = [{ ...orphan, reviewDecision: 'APPROVED' }];
  expect((await runDevelopmentWatchdog({ force: true })).counts.dispatched).toBe(1);
  expect(m.adds).toHaveLength(2);
});

it('uses complete PR and remote branch ownership rather than the legacy first page', async () => {
  m.backlog = [{ ref: '42' }];
  m.prs = [{ ...orphan, number: 99, headBranch: 'cos/work/issue-42/agent', isDraft: true }];
  expect((await runDevelopmentWatchdog({ force: true })).apps[0].issues[0].disposition).toBe('external-claim');
  m.prs = []; m.branch = 'abcdef\trefs/heads/cos/work/issue-42/agent';
  expect((await runDevelopmentWatchdog({ force: true })).apps[0].issues[0].disposition).toBe('external-claim');
  expect(m.adds).toEqual([]);
});
it('partial issue pagination remains unknown and cannot dispatch', async () => {
  m.backlog = [{ ref: '42' }]; m.issueTruncated = true;
  const receipt = await runDevelopmentWatchdog({ force: true });
  expect(receipt.complete).toBe(false); expect(receipt.apps[0].blockers).toContain('issue-source-incomplete');
  expect(m.adds).toEqual([]);
});

// Regression: pinned manual claims disabled the swarm and lost the scheduled drain.
it('hands a backlog to one unpinned scheduled batch and records only its admission', async () => {
  m.backlog = [{ ref: '42' }, { ref: '43' }, { ref: '44' }];
  const receipt = await runDevelopmentWatchdog({ force: true });
  expect(m.adds).toHaveLength(1);
  expect(m.adds[0].metadata).toMatchObject({ app: 'app', analysisType: 'claim-issue', swarmCount: 6,
    perpetual: true, provider: 'example-cli', model: 'example-model', effort: 'high', developmentWatchdog: true });
  expect(m.adds[0].metadata.claimTarget).toBeUndefined();
  expect(m.prepare).toHaveBeenCalledWith('claim-issue', expect.objectContaining({ id: 'app' }), expect.any(Object));
  expect(m.metadata).toHaveBeenCalledWith(expect.objectContaining({ id: 'app' }), 'claim-issue');
  expect(receipt.decisions).toEqual([expect.objectContaining({ kind: 'issue', number: null, outcome: 'queued' })]);
  expect(receipt.apps[0].issues.every(issue => issue.taskId === null)).toBe(true);
  expect(m.record).toHaveBeenCalledWith({ taskType: 'claim-issue', appId: 'app', signature: 'backlog' }, expect.any(Object));
  expect(m.execution).toHaveBeenCalledWith('task:claim-issue', 'app');
});

it('leaves scheduled brakes intact and does not spend dispatches on rejected work', async () => {
  m.backlog = [{ ref: '42' }];
  m.readiness = { shouldRun: false, reason: 'perpetual-parked' };
  expect((await runDevelopmentWatchdog({ force: true })).decisions[0].reason).toBe('perpetual-parked');
  expect(m.prepare).not.toHaveBeenCalled();
  m.readiness = { shouldRun: true };
  m.duplicate = true;
  expect((await runDevelopmentWatchdog({ force: true })).decisions[0].outcome).toBe('already-owned');
  expect(m.record).not.toHaveBeenCalled(); expect(m.execution).not.toHaveBeenCalled();
  m.duplicate = false;
  m.prepare.mockResolvedValue({ task: null, pendingPerpetualDispatch: null, skip: { gate: 'perpetual-work', reason: null, cli: null, remedy: null, detail: null } });
  expect((await runDevelopmentWatchdog({ force: true })).decisions[0].reason).toBe('claim-schedule-no-work');
  expect(m.adds).toEqual([]); expect(m.record).not.toHaveBeenCalled();
});

it('defers to a queued schedule request or an existing pinned claim', async () => {
  m.backlog = [{ ref: '42' }, { ref: '43' }];
  m.requests = [{ appId: 'app', taskType: 'claim-issue' }];
  expect((await runDevelopmentWatchdog({ force: true })).decisions[0].reason).toBe('claim-already-requested');
  m.requests = [];
  m.tasks = [{ id: 'pinned', status: 'in_progress', metadata: { app: 'app', claimFlow: true, claimTarget: '42' } }];
  expect((await runDevelopmentWatchdog({ force: true })).decisions[0]).toMatchObject({ outcome: 'already-owned', taskId: 'pinned' });
  expect(m.prepare).not.toHaveBeenCalled(); expect(m.adds).toEqual([]);
});

it('withholds batches after Improve is disabled or grants are revoked during preparation', async () => {
  m.backlog = [{ ref: '42' }];
  m.state.config.improvementEnabled = false;
  expect((await runDevelopmentWatchdog({ force: true })).decisions[0].reason).toBe('improvement-disabled');
  m.state.config.improvementEnabled = true;
  m.prepare.mockImplementation(async () => {
    m.state.config.persistentMindCapabilities.createTasks = false;
    return { task: { metadata: { app: 'app', claimFlow: true } } };
  });
  expect((await runDevelopmentWatchdog({ force: true })).decisions[0].reason).toBe('authority-changed');
  expect(m.adds).toEqual([]); expect(m.record).not.toHaveBeenCalled();
});

describe('development watchdog authorization grants', () => {
  it.each([
    ['all granted', {}, {}, { read: true, create: true }],
    ['role disabled', { enabled: false }, {}, { read: false, create: false }],
    ['readPortos false', {}, { readPortos: false }, { read: false, create: false }],
    ['createTasks false (read only)', {}, { createTasks: false }, { read: true, create: false }],
    ['app outside role.appIds', { appIds: ['other'] }, {}, { read: false, create: false }],
    ['app outside allowedAppIds', {}, { allowedAppIds: ['other'] }, { read: false, create: false }],
  ])('%s', async (_name, role, caps, want) => {
    m.backlog = [{ ref: '42' }];
    Object.assign(m.state.config.persistentMindMaintainer, role);
    Object.assign(m.state.config.persistentMindCapabilities, caps);
    const receipt = await runDevelopmentWatchdog({ force: true });
    // read grant: the app is scanned; create grant: work is queued
    expect(Boolean(receipt.apps?.length && receipt.apps[0].complete)).toBe(want.read);
    expect(m.adds).toHaveLength(want.create ? 1 : 0);
  });
});

describe('development watchdog scan bookkeeping', () => {
  const mergedFollowUp = () => ({
    id: 'sys-rl-merged', status: 'pending',
    metadata: {
      app: 'app', reviewLoopFollowUp: true, reviewLoopPRNumber: '5', reviewLoopPRHost: 'github.com',
      reviewLoopPROwner: 'atomantic', reviewLoopPRRepo: 'example', reviewLoopPRUrl: 'https://github.com/atomantic/example/pull/5',
    },
  });

  it('counts paused agents and pending tasks against free slots before dispatching', async () => {
    m.backlog = [{ ref: '42' }];
    m.state.agents = { a: { status: 'paused', taskId: 'x' }, b: { status: 'running', taskId: 'y' } };
    m.tasks = [{ id: 'p', status: 'pending', metadata: { app: 'other' } }];
    const receipt = await runDevelopmentWatchdog({ force: true });
    expect(receipt.availableSlots).toBe(0);
    expect(receipt.decisions).toEqual([expect.objectContaining({ kind: 'issue', outcome: 'capacity-full' })]);
    expect(receipt.counts.deferred).toBe(1);
    expect(m.adds).toEqual([]);
  });

  it('caps dispatch at the per-project limit and spends one global slot per queued item', async () => {
    m.backlog = [{ ref: '42' }];
    Object.assign(m.state.config, { maxConcurrentAgents: 5, maxConcurrentAgentsPerProject: 1 });
    m.tasks = [{ id: 'p', status: 'pending', metadata: { app: 'app' } }];
    let receipt = await runDevelopmentWatchdog({ force: true });
    expect(receipt.availableSlots).toBe(4);
    expect(receipt.decisions[0].outcome).toBe('capacity-full');
    m.tasks = []; delete m.state.config.maxConcurrentAgentsPerProject; m.state.config.maxConcurrentAgents = 3;
    receipt = await runDevelopmentWatchdog({ force: true });
    expect(receipt.decisions[0].outcome).toBe('queued');
    expect(receipt.availableSlots).toBe(2);
  });

  it('a dry run spends a slot per would-queue item while a deferred dispatch spends none', async () => {
    m.state.config.maxConcurrentAgents = 1;
    m.prs = [orphan]; m.backlog = [{ ref: '42' }];
    let receipt = await runDevelopmentWatchdog({ dryRun: true });
    expect(receipt.decisions.map(d => [d.kind, d.outcome])).toEqual([['pr', 'would-queue'], ['issue', 'capacity-full']]);
    m.prs = [{ ...orphan, headBranch: 'fix' }]; m.dependencies = [10]; m.dependencyOpen = true;
    receipt = await runDevelopmentWatchdog({ force: true });
    expect(receipt.decisions.map(d => [d.kind, d.outcome, d.reason])).toEqual([['pr', 'deferred', 'open-dependency'], ['issue', 'queued', undefined]]);
  });

  it('records a dispatch that throws as a deferred, source-unavailable decision', async () => {
    m.backlog = [{ ref: '42' }];
    m.prepare.mockRejectedValue(new Error('boom'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const receipt = await runDevelopmentWatchdog({ force: true });
    spy.mockRestore();
    expect(receipt.decisions[0]).toMatchObject({ outcome: 'deferred', reason: 'dispatch-source-unavailable' });
  });

  it('marks a queued PR for resolution and keeps that task id while its evidence is unchanged', async () => {
    m.prs = [orphan];
    let receipt = await runDevelopmentWatchdog({ force: true });
    expect(receipt.apps[0].pullRequests[0]).toMatchObject({ disposition: 'queued-for-resolution', taskId: 'resolution' });
    receipt = await runDevelopmentWatchdog({ force: true });
    expect(receipt.apps[0].pullRequests[0]).toMatchObject({ disposition: 'blocked', reason: 'unchanged-after-dispatch', taskId: 'resolution' });
  });

  it('an active agent owns its PR even when its task record is gone or already terminal', async () => {
    m.prs = [orphan];
    m.state.agents = { a: { status: 'running', taskId: 'done' } };
    m.tasks = [{ id: 'done', status: 'completed', metadata: { app: 'app', reviewLoopPRUrl: orphan.url } }];
    let receipt = await runDevelopmentWatchdog({ force: true });
    expect(receipt.apps[0].pullRequests[0].disposition).toBe('actively-owned');
    m.tasks = [];
    m.state.agents = { a: { status: 'running', taskId: 'gone', metadata: { app: 'app', reviewLoopPRUrl: orphan.url } } };
    receipt = await runDevelopmentWatchdog({ force: true });
    expect(receipt.apps[0].pullRequests[0].disposition).toBe('actively-owned');
    expect(m.adds).toEqual([]);
  });

  it('lists readable recovery work by kind', async () => {
    m.tasks = [
      { id: 'r1', status: 'pending', metadata: { app: 'app', reviewLoopFollowUp: true, sourceAgentId: 'agent-1', sourceTaskId: 'task-1' } },
      { id: 'i1', status: 'completed', metadata: { app: 'app', isInvestigation: true } },
      { id: 'd1', status: 'blocked', metadata: { taskApp: 'app', diagnostics: { exitCode: 1 }, blockedCategory: 'max-spawns' } },
      { id: 'o1', status: 'pending', metadata: { app: 'elsewhere', sourceAgentId: 'agent-2' } },
      { id: 'n1', status: 'pending', metadata: { app: 'app' } },
    ];
    const receipt = await runDevelopmentWatchdog({ force: true });
    expect(receipt.recovery).toEqual([
      { taskId: 'r1', status: 'pending', sourceAgentId: 'agent-1', sourceTaskId: 'task-1', kind: 'review-follow-up', blockedReason: null },
      { taskId: 'i1', status: 'completed', sourceAgentId: null, sourceTaskId: null, kind: 'investigation', blockedReason: null },
      { taskId: 'd1', status: 'blocked', sourceAgentId: null, sourceTaskId: null, kind: 'recovery', blockedReason: 'max-spawns' },
    ]);
  });

  it('retires terminal follow-ups only on a mutating scan with complete peer ownership', async () => {
    m.prStates['5'] = { status: 'known', state: 'MERGED' };
    m.tasks = [mergedFollowUp()];
    await runDevelopmentWatchdog({ dryRun: true });
    m.peers = [{ id: 'peer', fullSync: true }];
    await runDevelopmentWatchdog({ force: true });
    expect(m.updates).toEqual([]);
    expect(m.tasks[0].status).toBe('pending');
  });

  it('records no decisions while participating peer ownership is unknown', async () => {
    m.backlog = [{ ref: '42' }]; m.peers = [{ id: 'peer', fullSync: true }];
    const receipt = await runDevelopmentWatchdog({ force: true });
    expect(receipt.decisions).toEqual([]);
    expect(receipt.apps[0].complete).toBe(true);
  });

  it('keeps when a PR was first observed across scans', async () => {
    m.prs = [{ ...orphan, headBranch: 'fix', checks: [{ status: 'PENDING' }] }];
    const first = await runDevelopmentWatchdog({ force: true });
    first.apps[0].pullRequests[0].firstObservedAt = '2020-01-01T00:00:00.000Z';
    expect((await runDevelopmentWatchdog({ force: true })).apps[0].pullRequests[0].firstObservedAt).toBe('2020-01-01T00:00:00.000Z');
    const prior = m.state.developmentWatchdog.latest;
    delete prior.apps[0].pullRequests[0].firstObservedAt; prior.checkedAt = '2019-01-01T00:00:00.000Z';
    expect((await runDevelopmentWatchdog({ force: true })).apps[0].pullRequests[0].firstObservedAt).toBe('2019-01-01T00:00:00.000Z');
  });

  it('counts owned skips and prevented duplicate admissions', async () => {
    m.backlog = [{ ref: '42' }]; m.branch = 'abcdef\trefs/heads/claim/issue-42';
    expect((await runDevelopmentWatchdog({ force: true })).counts.ownedSkips).toBe(1);
    m.branch = ''; m.duplicate = true;
    expect((await runDevelopmentWatchdog({ force: true })).counts.duplicateAdmissionsPrevented).toBe(1);
  });

  it('marks an unreadable scope incomplete and still persists a disabled scan over a prior receipt', async () => {
    m.state.config.persistentMindCapabilities.allowedAppIds = [];
    const scoped = await runDevelopmentWatchdog({ force: true });
    expect(scoped).toMatchObject({ complete: false, blockers: ['no-readable-maintainer-scope'] });
    m.state.config.persistentMindMaintainer.enabled = false;
    const disabled = await runDevelopmentWatchdog({ force: true });
    expect(await readDevelopmentWatchdogSnapshot()).toBe(disabled);
  });

  it('reports a granted-out app in a partly readable scope without inspecting it', async () => {
    m.backlog = [{ ref: '42' }];
    m.state.config.persistentMindMaintainer.appIds = ['app', 'other'];
    m.state.config.persistentMindCapabilities.allowedAppIds = ['other'];
    const receipt = await runDevelopmentWatchdog({ force: true });
    expect(receipt.apps.find(app => app.appId === 'app')).toMatchObject({ complete: false, blockers: ['app-unavailable-or-not-granted'] });
    expect(receipt.decisions).toEqual([]);
  });

  it('prunes the dispatch ledger only for PRs a complete scan no longer sees', async () => {
    m.prs = [orphan];
    await runDevelopmentWatchdog({ force: true });
    expect(Object.keys(m.state.developmentWatchdog.dispatches)).toEqual(['app:pr:5']);
    m.prs = []; m.issueTruncated = true;
    await runDevelopmentWatchdog({ force: true });
    expect(Object.keys(m.state.developmentWatchdog.dispatches)).toEqual(['app:pr:5']);
    m.issueTruncated = false;
    await runDevelopmentWatchdog({ force: true });
    expect(m.state.developmentWatchdog.dispatches).toEqual({});
  });

  it('leaves a terminal follow-up alone when an agent picks it up after the scan began', async () => {
    m.tasks = [mergedFollowUp()];
    m.prStates = { get 5() {
      m.state.agents = { a: { status: 'running', taskId: 'sys-rl-merged' } };
      return { status: 'known', state: 'MERGED' };
    } };
    const receipt = await runDevelopmentWatchdog({ force: true });
    expect(m.updates).toEqual([]);
    expect(receipt.apps[0].retiredReviewFollowUps).toEqual([]);
  });

  it('defers a dispatch when agents fill the slots after the scan measured capacity', async () => {
    m.backlog = [{ ref: '42' }];
    m.metadata.mockImplementation(async () => {
      m.state.agents = { a: { status: 'running' }, b: { status: 'running' }, c: { status: 'queued' } };
      return { metadata: {} };
    });
    const receipt = await runDevelopmentWatchdog({ force: true });
    expect(receipt.decisions[0]).toMatchObject({ outcome: 'deferred', reason: 'capacity-changed' });
    expect(m.adds).toEqual([]);
  });

  it('bounds receipt history to the latest 24 scans', async () => {
    for (let i = 0; i < 26; i++) await runDevelopmentWatchdog({ force: true });
    expect(m.state.developmentWatchdog.history).toHaveLength(24);
    expect(m.state.developmentWatchdog.history.at(-1)).toBe(m.state.developmentWatchdog.latest);
  });
});
