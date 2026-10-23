/** An agent's worktree exists before anything records its owner (#11775): the id
 * must read as active for the whole dispatch and be released on every exit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ registerGate: null, prep: null, publicationActive: false, refusePublication: false, updateResult: { ok: true } }));
vi.mock('../lib/checkoutRetirementAdmission.js', () => ({ withCheckoutPublication: vi.fn(async (_repo, work) => {
  if (f.refusePublication) throw new Error('checkout-retirement-reserved');
  f.publicationActive = true;
  try { return await work(); } finally { f.publicationActive = false; }
}) }));
vi.mock('./cos.js', () => ({}));
vi.mock('./cosState.js', () => ({ getConfig: async () => ({}) }));
vi.mock('./cosTaskStore.js', () => ({ updateTask: vi.fn(async () => f.updateResult) }));
vi.mock('./cosAgentLifecycle.js', () => ({
  registerAgent: vi.fn(() => f.registerGate),
  updateAgent: vi.fn(),
}));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn(), cosEvents: { emit: vi.fn() } }));
vi.mock('./agentRunTracking.js', () => ({ createAgentRun: vi.fn(async () => ({ runId: 'run-example' })) }));
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
    ok: true, provider: { id: 'example-cli', type: 'cli', command: 'codex' }, selectedModel: 'example-model', modelSelection: {},
  }),
}));
vi.mock('./agentWorkspacePrep.js', () => ({ prepareAgentWorkspace: vi.fn(async ({ onPrepared }) => {
  const { withCheckoutPublication } = await import('../lib/checkoutRetirementAdmission.js');
  return withCheckoutPublication('/repos/example', () => onPrepared(f.prep));
}) }));
vi.mock('./agentCliSpawning.js', () => ({
  buildCliSpawnConfig: () => ({ command: 'codex', args: [] }),
  isClaudeCliProvider: () => false,
  isTuiProvider: vi.fn(() => false),
  getClaudeSettingsEnv: async () => ({}),
  spawnDirectly: vi.fn(async () => 'agent-x'),
}));
vi.mock('./agentTuiSpawning.js', () => ({ buildTuiSpawnConfig: vi.fn(() => ({ command: 'codex', args: [] })), spawnTuiAgent: vi.fn() }));

vi.mock('./forgeAuth.js', () => ({ resolveForgeTokenEnv: vi.fn() }));

import { dispatchAgentRun } from './agentSpawnDispatch.js';
import { getActiveAgentIds, protectedAgentIds, setUseRunner } from './agentState.js';
import { spawnDirectly, isTuiProvider } from './agentCliSpawning.js';
import { spawnTuiAgent } from './agentTuiSpawning.js';
import { createAgentRun } from './agentRunTracking.js';
import { resolveForgeTokenEnv } from './forgeAuth.js';
import { prepareAgentWorkspace } from './agentWorkspacePrep.js';
import { updateTask } from './cosTaskStore.js';
import { registerAgent } from './cosAgentLifecycle.js';
import { withCheckoutPublication } from '../lib/checkoutRetirementAdmission.js';

const task = { id: 'task-example', taskType: 'user', description: 'example', metadata: {} };
const newContext = () => ({
  task, agentId: 'agent-x', instanceId: 'instance-example', toolExecution: { id: 'exec-example' }, laneName: 'standard',
  blockAndBail: vi.fn(async () => null),
  cleanupOnError: vi.fn(async () => null),
});
const isProtected = () => getActiveAgentIds().includes('agent-x') && protectedAgentIds([]).has('agent-x');

beforeEach(() => {
  vi.clearAllMocks();
  setUseRunner(false);
  isTuiProvider.mockReturnValue(false);
  f.publicationActive = f.refusePublication = false;
  f.registerGate = Promise.resolve();
  f.updateResult = { ok: true };
  f.prep = { outcome: 'ready', workspacePath: '/repos/example', worktreeInfo: null };
});

describe('dispatchAgentRun ownership window', () => {
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
    context.task = { ...task, metadata: { cleanupReviewTarget: undefined, cleanupReviewLaunchEvidence: { headSha: 'a'.repeat(40) }, totalSpawnCount: '2' } };
    expect(await dispatchAgentRun(context)).toBeNull();
    expect(registerAgent).toHaveBeenCalledOnce();
    expect(updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({ metadata: expect.objectContaining({ totalSpawnCount: 3, cleanupReviewTarget: undefined }) }), 'user');
    expect(spawnDirectly).not.toHaveBeenCalled();
    expect(context.cleanupOnError).toHaveBeenCalledWith(expect.stringContaining('Failed to persist reviewed-head launch admission'));
    expect(f.publicationActive).toBe(false);
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


describe('notification account at the agent dispatch boundary', () => {
  it.each(['direct', 'runner', 'tui'])('pins the selected account for %s without persisting credentials', async mode => {
    const selected = { id: 'account-example', host: 'ghe.example.com', login: 'example-reviewer' };
    resolveForgeTokenEnv.mockResolvedValue({ GH_HOST: selected.host, GH_ENTERPRISE_TOKEN: 'synthetic-selected-token' });
    isTuiProvider.mockReturnValue(mode === 'tui');
    setUseRunner(mode === 'runner');
    const viaRunner = vi.fn(async () => 'agent-x');
    const context = { ...newContext(), task: { ...task, metadata: { githubAccount: selected } } };
    await dispatchAgentRun(context, { spawnViaRunner: viaRunner });
    const provider = mode === 'runner' ? viaRunner.mock.calls[0][2].provider
      : (mode === 'tui' ? spawnTuiAgent : spawnDirectly).mock.calls[0][0].provider;
    expect(resolveForgeTokenEnv).toHaveBeenCalledWith('/repos/example', { githubAccount: selected });
    expect(provider.envVars).toMatchObject({ GH_HOST: selected.host, GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: 'synthetic-selected-token', GITHUB_ENTERPRISE_TOKEN: '' });
    expect(JSON.stringify(createAgentRun.mock.calls)).not.toContain('synthetic-selected-token');
    expect(JSON.stringify(registerAgent.mock.calls)).not.toContain('synthetic-selected-token');
    expect(context.task.metadata).toEqual({ githubAccount: selected });
  });

  it('does not start a process or persist an agent when the selected credential is unavailable', async () => {
    resolveForgeTokenEnv.mockRejectedValue(new Error('Selected account unavailable'));
    const context = { ...newContext(), task: { ...task, metadata: { githubAccount: { id: 'missing-account' } } } };
    await expect(dispatchAgentRun(context)).rejects.toThrow('Selected account unavailable');
    expect(spawnDirectly).not.toHaveBeenCalled();
    expect(spawnTuiAgent).not.toHaveBeenCalled();
    expect(registerAgent).not.toHaveBeenCalled();
  });
});
