import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ state: null, tasks: [], prs: [], backlog: [], peers: [], adds: [], save: vi.fn(), branch: '', account: 'atomantic', nextPrs: null, prReads: 0, dependencies: [], dependencyOpen: false, execGhFailureOn: null, invalidGhJsonOn: null, issueTruncated: false, readiness: { shouldRun: true }, requests: [], duplicate: false, prepare: vi.fn(), record: vi.fn(), execution: vi.fn(), metadata: vi.fn() }));
vi.mock('./cosState.js', () => ({ loadState: async () => m.state, saveState: m.save, withStateLock: async fn => fn(), isImprovementEnabled: state => state.config.improvementEnabled }));
vi.mock('./apps.js', () => ({ getActiveApps: async () => [{ id: 'app', name: 'Example', repoPath: '/example' }] }));
vi.mock('./cosTaskStore.js', () => ({ getAllTasks: async () => ({ user: { tasks: [] }, cos: { tasks: m.tasks } }), addTask: async task => { if (m.duplicate) return { id: 'existing', duplicate: true }; const result = { ...task, id: 'queued', status: 'pending' }; m.tasks.push(result); m.adds.push(result); return result; } }));
vi.mock('./instances.js', () => ({ getPeers: async () => m.peers }));
vi.mock('../lib/workTracker.js', () => ({ resolveAppForgeTarget: async () => ({ tracker: 'github', target: { fullName: 'atomantic/example', repoSpec: 'github.com/atomantic/example', apiHost: 'github.com' } }) }));
vi.mock('./appPullRequests.js', () => ({ listAppPullRequests: async () => ({ pullRequests: ++m.prReads > 1 && m.nextPrs ? m.nextPrs : m.prs, transient: false }) }));
vi.mock('./perpetualWork.js', async importOriginal => ({ ...(await importOriginal()), detectActionableWork: async () => ({ count: m.backlog.length, items: m.backlog }), listConfiguredForgeIssues: async () => ({ ok: true, truncated: m.issueTruncated, issues: m.backlog.map(i => ({ number: Number(i.ref), labels: [], assignees: [] })) }) }));
vi.mock('./cosTaskGenerator.js', () => ({
  resolveClaimWorkMetadata: (...args) => m.metadata(...args),
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
  if (args[0] === 'api') return m.account;
  if (args[0] === m.execGhFailureOn) throw new Error('forge unavailable');
  if (args[0] === m.invalidGhJsonOn) return 'not json';
  return JSON.stringify({ body: '', state: m.dependencyOpen ? 'OPEN' : 'CLOSED', labels: m.dependencyOpen ? [{ name: 'in-progress' }] : [] });
} }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async () => ({}) }));
vi.mock('./forgeActorTrust.js', () => ({ createGithubActorTrust: async () => ({ isTrusted: async () => true }) }));
vi.mock('../lib/execGit.js', () => ({ execGit: async () => ({ stdout: m.branch }) }));
vi.mock('../lib/peerHttpClient.js', () => ({ peerFetch: async () => { throw new Error('offline'); } }));
vi.mock('./blockedIssueReconcile.js', () => ({ parseBlockingIssueNumbers: () => m.dependencies }));
vi.mock('./codeReview.js', () => ({ resolveReviewLoopOptions: async () => ({ reviewers: ['codex'] }) }));
vi.mock('./agentState.js', () => ({ isTruthyMeta: value => value === true }));
vi.mock('./agentWorktreeCleanup.js', () => ({ spawnReviewLoopFollowUp: async options => { m.adds.push(options); return { id: 'resolution' }; } }));
vi.mock('./userActions.js', () => ({ listUserActions: async () => [] }));
vi.mock('./reviewQueue.js', () => ({ buildQueue: async () => ({ sources: {}, partial: false, nextCursor: null }) }));
vi.mock('./persistentMindVisibility.js', () => ({ readPersistentMindVisibility: async () => ({}) }));
vi.mock('./persistentMindProfile.js', () => ({ resolvePersistentMindProfile: async () => ({}) }));
import { runDevelopmentWatchdog, readDevelopmentWatchdogSnapshot } from './developmentWatchdog.js';
import { readPersistentMindMaintenanceContext } from './persistentMindMaintenanceContext.js';

beforeEach(() => {
  m.state = { config: { improvementEnabled: true, persistentMindMaintainer: { enabled: true, appIds: ['app'] }, persistentMindCapabilities: { readPortos: true, createTasks: true }, maxConcurrentAgents: 3 }, agents: {} };
  m.tasks = []; m.prs = []; m.backlog = []; m.peers = []; m.adds = []; m.branch = ''; m.account = 'atomantic'; m.save.mockClear(); m.nextPrs = null; m.prReads = 0; m.dependencies = []; m.dependencyOpen = false; m.execGhFailureOn = null; m.invalidGhJsonOn = null; m.issueTruncated = false;
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
it('keeps explicit live claim and open dependency evidence out of dispatch', async () => {
  m.prs = [orphan]; m.dependencyOpen = true;
  let receipt = await runDevelopmentWatchdog({ force: true });
  expect(receipt.apps[0].pullRequests[0]).toMatchObject({ disposition: 'unknown', reason: 'external-claim-owner-unverified' });
  expect(receipt.counts.ownedSkips).toBe(0);
  m.prs = [{ ...orphan, headBranch: 'fix' }]; m.dependencies = [10];
  receipt = await runDevelopmentWatchdog({ force: true });
  expect(receipt.decisions[0].reason).toBe('open-dependency'); expect(m.adds).toEqual([]);
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
  m.prepare.mockResolvedValue(null);
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
