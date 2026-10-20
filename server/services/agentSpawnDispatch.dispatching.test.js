/** An agent's worktree exists before anything records its owner (#11775): the id
// Git/filesystem are synthetic in this suite; real durable admission has its own boundary tests.
vi.mock('../lib/checkoutRetirementAdmission.js', () => ({ withCheckoutPublication: (_repo, work) => work() }));
 * must read as active for the whole dispatch and be released on every exit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ registerGate: null, prep: null }));
vi.mock('./cos.js', () => ({ getConfig: async () => ({}), updateTask: async () => ({ ok: true }) }));
vi.mock('./cosAgentLifecycle.js', () => ({
  registerAgent: vi.fn(() => f.registerGate),
  updateAgent: vi.fn(),
}));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn(), cosEvents: { emit: vi.fn() } }));
vi.mock('./agentRunTracking.js', () => ({ createAgentRun: async () => ({ runId: 'run-example' }) }));
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
vi.mock('./agentWorkspacePrep.js', () => ({ prepareAgentWorkspace: async () => f.prep }));
vi.mock('./agentCliSpawning.js', () => ({
  buildCliSpawnConfig: () => ({ command: 'codex', args: [] }),
  isClaudeCliProvider: () => false,
  isTuiProvider: () => false,
  getClaudeSettingsEnv: async () => ({}),
  spawnDirectly: vi.fn(async () => 'agent-x'),
}));
vi.mock('./agentTuiSpawning.js', () => ({ buildTuiSpawnConfig: vi.fn(), spawnTuiAgent: vi.fn() }));

import { dispatchAgentRun } from './agentSpawnDispatch.js';
import { getActiveAgentIds, protectedAgentIds, setUseRunner } from './agentState.js';
import { spawnDirectly } from './agentCliSpawning.js';

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
  f.registerGate = Promise.resolve();
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
