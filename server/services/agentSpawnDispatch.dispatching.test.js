/** An agent's worktree exists before anything records its owner (#11775): the id
 * must read as active for the whole dispatch and be released on every exit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ registerGate: null, prep: null, publicationActive: false, refusePublication: false, updateResult: { ok: true }, provider: null, tui: false }));
const releaseDisposition = vi.hoisted(() => vi.fn(async () => null));
vi.mock('./releaseSynchronization.js', () => ({ releaseTaskDispatchDisposition: releaseDisposition }));
vi.mock('../lib/checkoutRetirementAdmission.js', () => ({ withCheckoutPublication: vi.fn(async (_repo, work) => {
  if (f.refusePublication) throw new Error('checkout-retirement-reserved');
  f.publicationActive = true;
  try { return await work(); } finally { f.publicationActive = false; }
}) }));
vi.mock('./cos.js', () => ({}));
vi.mock('./cosState.js', () => ({ getConfig: async () => ({}) }));
vi.mock('./cosTaskStore.js', () => ({ updateTask: vi.fn(async () => f.updateResult) }));
vi.mock('./cosAgentLifecycle.js', () => ({
  registerAgent: vi.fn(async () => { await f.registerGate; return { startedAt: '2026-01-01T00:00:00.000Z' }; }),
  updateAgent: vi.fn(),
}));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn(), cosEvents: { emit: vi.fn() } }));
vi.mock('./agentRunTracking.js', () => ({ createAgentRun: vi.fn(async () => ({ runId: 'run-example' })) }));
vi.mock('./githubAccounts.js', () => ({ getAccount: vi.fn(), resolveGitHubAccountEnv: vi.fn() }));
vi.mock('./github.js', () => ({ execGh: vi.fn() }));
vi.mock('../lib/fileUtils.js', async (importOriginal) => ({
  ...await importOriginal(), ensureDir: vi.fn(), writeFileGuarded: vi.fn(),
}));
vi.mock('../lib/backupSnapshotBoundary.js', () => ({ withBackupAssetPublication: (work) => work() }));
vi.mock('../lib/workTracker.js', async (importOriginal) => ({
  ...await importOriginal(),
  resolveRepoForgeTarget: async () => null,
  repoIssueUrlBase: () => null,
}));
vi.mock('../lib/primaryCheckoutGuard.js', () => ({ capturePrimaryCheckoutState: async () => null }));
vi.mock('./agentPromptBuilder.js', () => ({
  buildAgentPrompt: async () => 'example prompt',
  getAppWorkspace: async () => '/repos/example',
  isClaimFlowTask: () => false,
  promptOpensOwnPr: () => false,
}));
vi.mock('./workspaceContext.js', () => ({ snapshotOnRepoSwitch: vi.fn() }));
vi.mock('./agentProviderResolution.js', () => ({
  resolveAgentProviderAndModel: async () => ({
    ok: true, provider: f.provider, selectedModel: 'example-model', modelSelection: {},
  }),
}));
vi.mock('./agentWorkspacePrep.js', () => ({ prepareAgentWorkspace: vi.fn(async ({ onPrepared }) => {
  const { withCheckoutPublication } = await import('../lib/checkoutRetirementAdmission.js');
  return withCheckoutPublication('/repos/example', () => onPrepared(f.prep));
}) }));
vi.mock('./agentCliSpawning.js', () => ({
  buildCliSpawnConfig: () => ({ command: 'codex', args: [] }),
  isClaudeCliProvider: () => false,
  isTuiProvider: () => f.tui,
  getClaudeSettingsEnv: async () => ({}),
  spawnDirectly: vi.fn(async () => 'agent-x'),
}));
vi.mock('./agentTuiSpawning.js', () => ({ buildTuiSpawnConfig: () => ({ command: 'codex', args: [] }), spawnTuiAgent: vi.fn(async () => 'agent-x') }));

import { dispatchAgentRun } from './agentSpawnDispatch.js';
import { getActiveAgentIds, protectedAgentIds, setUseRunner } from './agentState.js';
import { spawnDirectly } from './agentCliSpawning.js';
import { spawnTuiAgent } from './agentTuiSpawning.js';
import { getAccount, resolveGitHubAccountEnv } from './githubAccounts.js';
import { execGh } from './github.js';
import { createAgentRun } from './agentRunTracking.js';
import { prepareAgentWorkspace } from './agentWorkspacePrep.js';
import { updateTask } from './cosTaskStore.js';
import { registerAgent } from './cosAgentLifecycle.js';
import { withCheckoutPublication } from '../lib/checkoutRetirementAdmission.js';
import { markHostShuttingDown, resetHostShutdownFlagForTests } from '../lib/hostShutdown.js';

const task = { id: 'task-example', taskType: 'user', description: 'example', metadata: {} };
const newContext = () => ({
  task, agentId: 'agent-x', instanceId: 'instance-example', toolExecution: { id: 'exec-example' }, laneName: 'standard',
  blockAndBail: vi.fn(async () => null),
  cleanupOnError: vi.fn(async () => null),
});
const isProtected = () => getActiveAgentIds().includes('agent-x') && protectedAgentIds([]).has('agent-x');

beforeEach(() => {
  vi.clearAllMocks();
  releaseDisposition.mockResolvedValue(null);
  setUseRunner(false);
  f.publicationActive = f.refusePublication = false;
  f.registerGate = Promise.resolve();
  f.updateResult = { ok: true };
  f.prep = { outcome: 'ready', workspacePath: '/repos/example', worktreeInfo: null };
  f.provider = { id: 'example-cli', type: 'cli', command: 'codex' };
  f.tui = false;
});

describe('dispatchAgentRun ownership window', () => {
  it('does not spawn a release continuation retired after queue admission', async () => {
    const context = newContext();
    context.task = { ...task, metadata: { analysisType: 'release-sync' } };
    releaseDisposition.mockResolvedValue('retired-continuation');
    expect(await dispatchAgentRun(context)).toBeNull();
    expect(context.blockAndBail).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('retired') }));
    expect(registerAgent).not.toHaveBeenCalled();
    expect(spawnDirectly).not.toHaveBeenCalled();
    expect(getActiveAgentIds()).not.toContain('agent-x');
  });
  it('does not dispatch a continuation whose frozen review policy is unknown', async () => {
    const context = newContext();
    context.task = { ...task, metadata: { analysisType: 'release-sync' } };
    releaseDisposition.mockResolvedValue('review-policy-unverified');
    expect(await dispatchAgentRun(context)).toBeNull();
    expect(context.blockAndBail).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('review policy') }));
    expect(registerAgent).not.toHaveBeenCalled();
    expect(spawnDirectly).not.toHaveBeenCalled();
  });
  it.each(['direct', 'tui', 'runner'])('uses the persisted dispatch for %s completion and its spawn limit', async mode => {
    const context = newContext();
    context.task = { ...task, privateSecurityScope: { localOnly: true }, metadata: { totalSpawnCount: '4', failureCount: '0' } };
    const claimed = { ...task, status: 'in_progress', metadata: { ...context.task.metadata,
      totalSpawnCount: 5, lastSpawnedAt: '2026-01-01T00:00:00.000Z', claimedBy: 'instance-example' } };
    f.updateResult = claimed;
    f.tui = mode === 'tui';
    setUseRunner(mode === 'runner');
    const runner = vi.fn(async () => 'agent-x');

    await dispatchAgentRun(context, { spawnViaRunner: runner });
    const launchedTask = mode === 'runner' ? runner.mock.calls[0][1]
      : (mode === 'tui' ? spawnTuiAgent : spawnDirectly).mock.calls[0][0].task;
    expect(launchedTask).toMatchObject({ status: 'in_progress', metadata: {
      totalSpawnCount: 5, failureCount: '0', lastSpawnedAt: claimed.metadata.lastSpawnedAt, claimedBy: 'instance-example',
    }, privateSecurityScope: { localOnly: true } });
  });

  it('still launches an unpersisted scheduled job with its original task', async () => {
    const context = newContext();
    context.task = { ...task, id: 'job-example-123', metadata: { autonomousJob: true, jobId: 'job-example' } };
    f.updateResult = { error: 'Task not found' };
    await dispatchAgentRun(context);
    expect(spawnDirectly.mock.calls[0][0].task).toBe(context.task);
  });

  it('protects the agent while registration is pending and releases once handed off', async () => {
    let finishRegistration;
    f.registerGate = new Promise((resolve) => { finishRegistration = resolve; });
    const dispatched = dispatchAgentRun(newContext());
    await vi.waitFor(() => expect(isProtected()).toBe(true));

    finishRegistration();
    await dispatched;
    expect(spawnDirectly).toHaveBeenCalled();
    expect(getActiveAgentIds()).not.toContain('agent-x');
  });

  it.each([{}, { claimResumeInPlace: true }, { existingBranch: 'feature/existing', useWorktree: true }])('holds workspace publication through pending registration and spawn: %j', async metadata => {
    let finishRegistration;
    f.registerGate = new Promise(resolve => { finishRegistration = resolve; });
    const context = newContext();
    context.task = { ...task, metadata: { ...metadata, app: 'example-app' } };
    const dispatched = dispatchAgentRun(context);
    await vi.waitFor(() => expect(registerAgent).toHaveBeenCalled());
    expect(withCheckoutPublication).toHaveBeenCalledWith('/repos/example', expect.any(Function));
    expect(f.publicationActive).toBe(true);
    expect(spawnDirectly).not.toHaveBeenCalled();
    spawnDirectly.mockImplementationOnce(async () => { expect(f.publicationActive).toBe(true); return 'agent-x'; });
    finishRegistration(); await dispatched;
    expect(f.publicationActive).toBe(false);
  });

  it('refuses a resumed claim before workspace preparation when retirement owns the cut', async () => {
    f.refusePublication = true;
    const context = newContext();
    context.task = { ...task, metadata: { claimResumeInPlace: 'true', app: 'example-app' } };
    await expect(dispatchAgentRun(context)).rejects.toThrow('checkout-retirement-reserved');
    expect(prepareAgentWorkspace).toHaveBeenCalledOnce();
    expect(registerAgent).not.toHaveBeenCalled();
    expect(spawnDirectly).not.toHaveBeenCalled();
    expect(getActiveAgentIds()).not.toContain('agent-x');
  });

  it.each([{ error: 'write refused' }, { statusChanged: true }])('never starts a recovered reviewer when its initial pin consumption was not persisted: %j', async result => {
    f.updateResult = result;
    f.prep.cleanupReviewPinConsumed = true;
    const context = newContext();
    context.claimAcquired = true;
    context.spawnWorktree = { branchName: 'preserved-branch' };
    context.task = { ...task, metadata: { cleanupReviewTarget: undefined, cleanupReviewLaunchEvidence: { headSha: 'a'.repeat(40) }, totalSpawnCount: '2' } };
    expect(await dispatchAgentRun(context)).toBeNull();
    expect(registerAgent).toHaveBeenCalledOnce();
    expect(updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({ metadata: expect.objectContaining({ totalSpawnCount: 3, cleanupReviewTarget: undefined }) }), 'user',
      expect.objectContaining({ expectedTask: { metadata: context.task.metadata }, spawnBudgetOperation: { kind: 'dispatch', agentId: 'agent-x', startedAt: '2026-01-01T00:00:00.000Z' } }));
    expect(spawnDirectly).not.toHaveBeenCalled();
    expect(context.cleanupOnError).toHaveBeenCalledWith(expect.stringContaining('Failed to persist reviewed-head launch admission'));
    expect(context.claimAcquired).toBe(false);
    expect(context.spawnWorktree).toBeNull();
    expect(f.publicationActive).toBe(false);
  });

  it('refuses before registration and the in_progress claim when host shutdown lands during preparation (#14170)', async () => {
    prepareAgentWorkspace.mockImplementationOnce(async ({ onPrepared }) => {
      markHostShuttingDown();
      return onPrepared(f.prep);
    });
    const context = newContext();
    try {
      expect(await dispatchAgentRun(context)).toBeNull();
    } finally { resetHostShutdownFlagForTests(); }
    expect(context.cleanupOnError).toHaveBeenCalledWith('PortOS is shutting down');
    expect(createAgentRun).not.toHaveBeenCalled();
    expect(registerAgent).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(spawnDirectly).not.toHaveBeenCalled();
    expect(getActiveAgentIds()).not.toContain('agent-x');
  });

  it('releases the agent when workspace prep blocks the dispatch', async () => {
    f.prep = { outcome: 'blocked', reason: 'no workspace' };
    const context = newContext();
    context.cleanupOnError.mockImplementation(async () => {
      expect(isProtected()).toBe(true);
    });
    expect(await dispatchAgentRun(context)).toBeNull();
    expect(context.cleanupOnError).toHaveBeenCalledWith('no workspace');
    expect(getActiveAgentIds()).not.toContain('agent-x');
  });

  it('releases the agent when dispatch throws', async () => {
    f.registerGate = Promise.reject(new Error('state write failed'));
    await expect(dispatchAgentRun(newContext())).rejects.toThrow('state write failed');
    expect(getActiveAgentIds()).not.toContain('agent-x');
  });
});

describe('dispatchAgentRun GitHub inbox account binding', () => {
  const account = { id: 'inbox-b', label: 'Inbox B', host: 'github.com', login: 'inbox-user', enabled: true, trust: 'public' };
  const binding = { accountId: account.id, host: account.host, login: account.login };
  const inboxContext = (metadata = {}) => ({ ...newContext(), task: { ...task, metadata: {
    githubNotificationAccount: binding,
    githubNotificationResolve: { accountId: account.id, host: account.host },
    ...metadata,
  } } });

  beforeEach(() => {
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) vi.stubEnv(key, '');
    getAccount.mockReset().mockResolvedValue(account);
    resolveGitHubAccountEnv.mockReset().mockResolvedValue({ env: { GH_TOKEN: 'inbox-b-token', GH_HOST: account.host } });
    execGh.mockReset().mockResolvedValue(JSON.stringify({ id: 42, login: account.login, name: 'Inbox User', email: null }));
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(['direct', 'tui', 'runner'].flatMap(mode => ['config-binding', 'viewer-selector'].map(bindingType => [mode, bindingType])))('launches %s from %s, overriding unrelated provider credentials without persisting them', async (mode, bindingType) => {
    f.provider.envVars = { GH_TOKEN: 'portos-a-token', GITHUB_TOKEN: 'provider-a-token', EXAMPLE_FLAG: 'kept' };
    const original = structuredClone(f.provider);
    f.tui = mode === 'tui';
    setUseRunner(mode === 'runner');
    const runner = vi.fn(async () => 'agent-x');
    const context = bindingType === 'viewer-selector'
      ? inboxContext({ githubNotificationAccount: undefined, githubNotificationResolve: undefined,
        githubAccount: { id: account.id, host: account.host, login: account.login } })
      : inboxContext();
    const originalMetadata = structuredClone(context.task.metadata);
    await dispatchAgentRun(context, { spawnViaRunner: runner });
    const launched = mode === 'runner' ? runner.mock.calls[0][2] : (mode === 'tui' ? spawnTuiAgent : spawnDirectly).mock.calls[0][0];
    expect(launched.provider.envVars).toMatchObject({
      GH_HOST: 'github.com', GH_TOKEN: 'inbox-b-token', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '',
      GIT_AUTHOR_NAME: 'Inbox User', GIT_AUTHOR_EMAIL: '42+inbox-user@users.noreply.github.com', EXAMPLE_FLAG: 'kept',
    });
    expect(f.provider).toEqual(original);
    expect(context.task.metadata).toEqual(originalMetadata);
    expect(registerAgent.mock.calls[0][2]).not.toHaveProperty('githubNotificationAccount');
    expect(JSON.stringify(registerAgent.mock.calls)).not.toContain('inbox-b-token');
    expect(createAgentRun.mock.calls[0][0].provider).toEqual(original);
    expect(resolveGitHubAccountEnv.mock.calls[0][1].baseEnv.GH_TOKEN).toBeUndefined();
    expect(execGh).toHaveBeenCalledWith(expect.arrayContaining(['--hostname', 'github.com']), 10_000,
      expect.objectContaining({ env: expect.objectContaining({ GH_TOKEN: 'inbox-b-token', GITHUB_TOKEN: '' }) }));
  });

  it.each([
    null,
    { ...account, host: 'ghe.example.com' },
    { ...account, login: 'another-user' },
    { ...account, enabled: false },
    { ...account, trust: 'private', allowAgents: false },
  ])('refuses an unavailable, changed, or disallowed saved account before preparing the checkout: %j', async current => {
    getAccount.mockResolvedValue(current);
    const context = inboxContext();
    expect(await dispatchAgentRun(context)).toBeNull();
    expect(context.blockAndBail).toHaveBeenCalledWith(expect.objectContaining({ category: 'github-inbox-account-unavailable' }));
    expect(prepareAgentWorkspace).not.toHaveBeenCalled();
    expect(registerAgent).not.toHaveBeenCalled();
    expect(spawnDirectly).not.toHaveBeenCalled();
  });

  it('refuses a missing credential or a token that answers as another login', async () => {
    const context = inboxContext();
    resolveGitHubAccountEnv.mockResolvedValueOnce({ status: 'not-authenticated' });
    expect(await dispatchAgentRun(context)).toBeNull();
    expect(execGh).not.toHaveBeenCalled();
    execGh.mockResolvedValueOnce(JSON.stringify({ id: 99, login: 'wrong-user' }));
    expect(await dispatchAgentRun(context)).toBeNull();
    expect(registerAgent).not.toHaveBeenCalled();
    expect(spawnDirectly).not.toHaveBeenCalled();
  });

  it('rechecks that the account still allows the launch after resolving its credential', async () => {
    getAccount.mockResolvedValueOnce(account).mockResolvedValueOnce({ ...account, enabled: false });
    expect(await dispatchAgentRun(inboxContext())).toBeNull();
    expect(registerAgent).not.toHaveBeenCalled();
    expect(spawnDirectly).not.toHaveBeenCalled();
  });

  it.each([
    { id: 'another-account', host: 'github.com', login: account.login },
    { id: account.id, host: 'ghe.example.com', login: account.login },
    { id: account.id, host: 'github.com', login: 'another-viewer' },
  ])('refuses conflicting config and concrete-viewer identities before credential lookup: %j', async githubAccount => {
    expect(await dispatchAgentRun(inboxContext({ githubAccount }))).toBeNull();
    expect(resolveGitHubAccountEnv).not.toHaveBeenCalled();
    expect(prepareAgentWorkspace).not.toHaveBeenCalled();
    expect(spawnDirectly).not.toHaveBeenCalled();
  });

  it('pins an implicit configured account to the review\'s queued viewer and accepts normalized hosts', async () => {
    getAccount.mockResolvedValue({ ...account, login: null });
    execGh.mockResolvedValue(JSON.stringify({ id: 42, login: 'queued-viewer' }));
    const context = inboxContext({ githubNotificationAccount: { ...binding, login: null },
      githubAccount: { id: account.id, host: 'GITHUB.COM', login: 'queued-viewer' } });
    await dispatchAgentRun(context);
    expect(resolveGitHubAccountEnv.mock.calls[0][0]).toMatchObject({ login: 'queued-viewer', host: 'github.com' });
    expect(spawnDirectly.mock.calls[0][0].provider.envVars.GH_TOKEN).toBe('inbox-b-token');
    spawnDirectly.mockClear();
    execGh.mockResolvedValue(JSON.stringify({ id: 99, login: 'changed-viewer' }));
    expect(await dispatchAgentRun(context)).toBeNull();
    expect(spawnDirectly).not.toHaveBeenCalled();
  });

  it('preserves an explicit operator review account independently of inbox automation modes and grants', async () => {
    getAccount.mockResolvedValue({ ...account, mode: 'disabled', trust: 'private', allowAgents: false });
    await dispatchAgentRun(inboxContext({ githubNotificationAccount: undefined, githubNotificationResolve: undefined,
      githubAccount: { id: account.id, host: account.host, login: account.login } }));
    expect(spawnDirectly).toHaveBeenCalledOnce();
    spawnDirectly.mockClear();
    expect(await dispatchAgentRun(inboxContext({ githubNotificationAccount: { ...binding, origin: 'user' },
      githubAccount: { id: account.id, host: account.host, login: account.login } }))).toBeNull();
    expect(spawnDirectly).not.toHaveBeenCalled();
  });

  it('honors Disabled mode for queued automation while preserving an explicit manual action in any mode', async () => {
    getAccount.mockResolvedValue({ ...account, mode: 'disabled' });
    expect(await dispatchAgentRun(inboxContext({ githubNotificationAccount: { ...binding, origin: 'github-notification' } }))).toBeNull();
    expect(spawnDirectly).not.toHaveBeenCalled();
    await dispatchAgentRun(inboxContext({ githubNotificationAccount: { ...binding, origin: 'user' } }));
    expect(spawnDirectly).toHaveBeenCalledOnce();
  });

  it.each(['ghe.example.com', 'example.ghe.com'])('pins the correct token family and host for %s', async host => {
    const enterprise = { ...account, host };
    getAccount.mockResolvedValue(enterprise);
    resolveGitHubAccountEnv.mockResolvedValue({ env: { GH_HOST: host, GH_ENTERPRISE_TOKEN: 'enterprise-b-token' } });
    await dispatchAgentRun(inboxContext({ githubNotificationAccount: { ...binding, host } }));
    const env = spawnDirectly.mock.calls[0][0].provider.envVars;
    expect(env.GH_HOST).toBe(host);
    expect(env[host.endsWith('.ghe.com') ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN']).toBe('enterprise-b-token');
  });

  it('keeps legacy generic tasks bound to their saved account and rejects unbound legacy security tasks', async () => {
    const legacy = inboxContext({ githubNotificationAccount: undefined });
    await dispatchAgentRun(legacy);
    expect(spawnDirectly.mock.calls[0][0].provider.envVars.GH_TOKEN).toBe('inbox-b-token');
    spawnDirectly.mockClear();
    const unbound = inboxContext({ githubNotificationAccount: undefined, githubNotificationResolve: undefined, githubSecurityFix: { host: 'github.com', repo: 'inbox-user/repo' } });
    expect(await dispatchAgentRun(unbound)).toBeNull();
    expect(unbound.blockAndBail).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('queue this action again') }));
    expect(spawnDirectly).not.toHaveBeenCalled();
  });

  it('pins an unnamed account to its active keyring token for the whole launch', async () => {
    const implicit = { ...account, login: null };
    getAccount.mockResolvedValue(implicit);
    resolveGitHubAccountEnv.mockResolvedValue({ env: { GH_HOST: 'github.com' } });
    execGh.mockResolvedValueOnce('active-b-token').mockResolvedValueOnce(JSON.stringify({ id: 42, login: 'active-user' }));
    await dispatchAgentRun(inboxContext({ githubNotificationAccount: { ...binding, login: null } }));
    expect(execGh.mock.calls[0][0]).toEqual(['auth', 'token', '--hostname', 'github.com']);
    expect(spawnDirectly.mock.calls[0][0].provider.envVars.GH_TOKEN).toBe('active-b-token');
  });

  it('preserves an unnamed account\'s ambient auth from its own host family', async () => {
    vi.stubEnv('GH_TOKEN', 'public-a-token');
    vi.stubEnv('GH_ENTERPRISE_TOKEN', 'enterprise-b-token');
    const implicit = { ...account, host: 'ghe.example.com', login: null };
    getAccount.mockResolvedValue(implicit);
    resolveGitHubAccountEnv.mockResolvedValue({ env: { GH_HOST: implicit.host } });
    await dispatchAgentRun(inboxContext({ githubNotificationAccount: { ...binding, host: implicit.host, login: null } }));
    expect(execGh).toHaveBeenCalledOnce();
    expect(spawnDirectly.mock.calls[0][0].provider.envVars).toMatchObject({ GH_HOST: implicit.host, GH_TOKEN: '', GH_ENTERPRISE_TOKEN: 'enterprise-b-token' });
  });

  it('preserves the existing credential path for non-inbox tasks', async () => {
    await dispatchAgentRun(newContext());
    expect(getAccount).not.toHaveBeenCalled();
    expect(resolveGitHubAccountEnv).not.toHaveBeenCalled();
    expect(spawnDirectly.mock.calls[0][0].provider.envVars).toBeUndefined();
  });
});
