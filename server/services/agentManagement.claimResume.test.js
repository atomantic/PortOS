/** Resume to real spawn dispatch, registration, completion and ownership gates.
 * Only provider/process, git discovery and persisted IO are doubled.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';

const f = vi.hoisted(() => ({ tasks: {}, state: null, disk: null, prompt: null }));
const persist = () => { f.disk = structuredClone(f.state); };
vi.mock('./cosState.js', () => ({
  withStateLock: createFileWriteQueue(),
  loadState: async () => f.state,
  saveState: async state => { f.state = state; f.disk = structuredClone(state); },
  readMergeAdmissionStateForSafetyCheck: async () => ({ trusted: true, ...structuredClone(f.disk) }),
}));
vi.mock('./cosAgentLifecycle.js', () => ({
  getAgentRecord: vi.fn(async id => f.state.agents[id]),
  readAgentRecordOrUnreadable: async id => f.state.agents[id],
  getAgents: async () => Object.values(f.state.agents),
  registerAgent: async (id, taskId, metadata) => {
    f.state.agents[id] = { id, taskId, status: 'running', startedAt: '2026-01-02T00:00:00Z', metadata };
    f.disk = structuredClone(f.state);
  },
  completeAgent: vi.fn(async id => { f.state.agents[id].status = 'completed'; f.disk = structuredClone(f.state); }),
  updateAgent: vi.fn(), isLiveAgentRecord: agent => agent?.status === 'running',
  AGENT_RECORD_UNREADABLE: Symbol('unreadable'),
}));
vi.mock('./cos.js', () => ({
  getConfig: async () => ({}),
  getTaskById: vi.fn(async id => f.tasks[id] || null),
  reviveBlockedTask: vi.fn(async (id, patch) => {
    f.tasks[id] = { ...f.tasks[id], status: 'pending', metadata: { ...f.tasks[id].metadata, ...patch.metadata } };
    return f.tasks[id];
  }),
  updateTask: async (id, patch) => Object.assign(f.tasks[id], patch),
  addTask: vi.fn(async ({ metadata, ...input }, taskType) => {
    f.tasks.replacement = { id: 'replacement', taskType, description: input.description,
      status: 'pending', metadata: { ...metadata, ...Object.fromEntries(Object.entries(input).filter(([k, v]) => k !== 'description' && v !== undefined)) } };
    return f.tasks.replacement;
  }),
  forceSpawnTask: vi.fn(), evaluateTasks: vi.fn(),
}));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn(), cosEvents: { emit: vi.fn() } }));
vi.mock('./agentRunEventLog.js', () => ({ appendRunEvent: vi.fn() }));
vi.mock('./agentRunTracking.js', () => ({ createAgentRun: async () => ({ runId: 'run-new' }), completeAgentRun: vi.fn() }));
vi.mock('../lib/fileUtils.js', async importOriginal => ({
  ...await importOriginal(), ensureDir: vi.fn(), writeFileGuarded: vi.fn(),
}));
vi.mock('../lib/backupSnapshotBoundary.js', () => ({ withBackupAssetPublication: work => work() }));
vi.mock('../lib/gitRemote.js', async importOriginal => ({ ...await importOriginal(),
  getOriginInfo: async () => ({ host: 'github.com', fullName: 'example/repo' }),
}));
vi.mock('../lib/workTracker.js', async importOriginal => ({ ...await importOriginal(),
  resolveRepoForgeTarget: async () => ({ forge: 'github', host: 'github.com', fullName: 'example/repo' }),
}));
vi.mock('./codeReview.js', () => ({ getCodeReviewDefaults: async () => ({ reviewers: [] }) }));
vi.mock('./promptSections/forge.js', async importOriginal => ({ ...await importOriginal(), resolveManualForgeCli: async () => 'gh' }));
vi.mock('./workspaceContext.js', () => ({ snapshotOnRepoSwitch: vi.fn() }));
vi.mock('./agentProviderResolution.js', () => ({ resolveAgentProviderAndModel: async () => ({
  ok: true, provider: { id: 'example-cli', type: 'cli', command: 'codex' }, selectedModel: 'example-model', modelSelection: {},
}) }));
vi.mock('./agentWorkspacePrep.js', () => ({ prepareAgentWorkspace: async () => ({
  workspacePath: '/repos/example', worktreeInfo: null,
}) }));
vi.mock('./agentCliSpawning.js', () => ({
  buildCliSpawnConfig: () => ({ command: 'codex' }), isClaudeCliProvider: () => false,
  isTuiProvider: () => false, getClaudeSettingsEnv: async () => ({}),
  spawnDirectly: vi.fn(async ({ prompt }) => { f.prompt = prompt; return 'replacement-agent'; }),
}));
vi.mock('./agentTuiSpawning.js', () => ({ buildTuiSpawnConfig: vi.fn(), spawnTuiAgent: vi.fn() }));
vi.mock('./cosRunnerClient.js', () => ({
  terminateAgentViaRunner: vi.fn(),
  killAgentViaRunner: vi.fn(),
  pauseAgentViaRunner: vi.fn(),
  getAgentStatsFromRunner: vi.fn(),
  getActiveAgentsFromRunner: vi.fn().mockResolvedValue([])
}));

vi.mock('./toolStateMachine.js', () => ({ completeExecution: vi.fn(), errorExecution: vi.fn() }));
vi.mock('./shell.js', () => ({ writeToSession: vi.fn(), killSession: vi.fn() }));
vi.mock('./agentWorktreeCleanup.js', () => ({
  cleanupAgentWorktree: vi.fn(),
  resolveTaskResumePatch: vi.fn().mockResolvedValue({})
}));
vi.mock('./agentFinalization.js', () => ({
  dispatchRecoveredTaskOutputHook: vi.fn().mockResolvedValue(undefined),
  retireDeadAgent: vi.fn().mockResolvedValue({ success: false }),
  stampLiExecutionVerdict: vi.fn(async (taskUpdate) => taskUpdate),
}));
// Only the two I/O functions are stubbed — HOST_SHUTDOWN_REASON stays real so
// the breadcrumb value the tests assert can't drift from the one production writes.
vi.mock('../lib/hostShutdown.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readHostShutdownMarker: vi.fn().mockResolvedValue(null),
  clearHostShutdownMarker: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./agentRunnerSync.js', () => ({ syncRunnerAgents: vi.fn().mockResolvedValue(0) }));
vi.mock('./agentRunnerOutputBatchers.js', () => ({ flushRunnerOutputBatcher: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./worktreeManager.js', () => ({ cleanupOrphanedWorktrees: vi.fn() }));
vi.mock('./creativeDirector/local.js', () => ({
  updateRun: vi.fn().mockResolvedValue(undefined),
  getProject: vi.fn().mockResolvedValue(null),
}));
vi.mock('./creativeDirector/planAdvance.js', () => ({ advanceAfterPlanStepSettled: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./creativeDirector/completionHook.js', () => ({ advanceAfterSceneSettled: vi.fn().mockResolvedValue(undefined) }));


import { resumeAgent } from './agentManagement.js';
import { dispatchAgentRun } from './agentSpawnDispatch.js';
import { forceSpawnTask, addTask, getTaskById } from './cos.js';
import { completeAgent } from './cosAgentLifecycle.js';
import { spawnDirectly } from './agentCliSpawning.js';
import { setUseRunner } from './agentState.js';
import { updateClaimOwnership } from './cosClaimOwnership.js';
import { claimMergeAdmission } from './cosMergeAdmission.js';

const CLAIM_PROSE = 'Resume the claim swarm, preserve the worktrees, and ship all issues.';
const reviewers = ['provider:antigravity-cli'];
const reviewConfig = { reviewers, optionalReviewers: reviewers, reviewerMaxRounds: { 'provider:antigravity-cli': 2 },
  reviewerModels: { 'provider:antigravity-cli': 'gemini-3.8-flash' }, reviewerEfforts: { 'provider:antigravity-cli': 'low' } };
beforeEach(() => {
  vi.clearAllMocks(); setUseRunner(false); f.prompt = null;
  f.tasks = { original: { id: 'original', taskType: 'user', status: 'blocked', description: CLAIM_PROSE,
    metadata: { claimFlow: true, swarmCount: 6, ...reviewConfig, reviewLoop: true, useWorktree: false, openPR: false,
      prompt: CLAIM_PROSE, blockedCategory: 'agent-paused', pausedAgentId: 'prior', app: 'example' } } };
  f.state = { agents: { prior: { id: 'prior', taskId: 'original', status: 'paused',
    metadata: { configClaimFlow: true, workspacePath: '/repos/example', taskType: 'user' } } }, mergeAdmissions: {} };
  persist();
  forceSpawnTask.mockImplementation(async taskId => {
    await dispatchAgentRun({ task: f.tasks[taskId], agentId: 'replacement-agent', instanceId: 'instance-example',
      toolExecution: { id: 'exec-example' }, laneName: 'standard',
      blockAndBail: message => { throw new Error(JSON.stringify(message)); },
      cleanupOnError: message => { throw new Error(message); },
    });
    return { success: true };
  });
});

describe('claim resume contract through spawn', () => {
  it.each(['blocked', 'completed', 'legacy'])('preserves an unpinned %s swarm through registration and admission', async kind => {
    if (kind === 'completed') f.tasks.original.status = 'completed';
    if (kind === 'legacy') {
      delete f.tasks.original.metadata.claimFlow;
      f.tasks.original.metadata.analysisType = 'claim-work';
    }
    const result = await resumeAgent('prior', { context: 'Keep the existing commits.' });
    expect(result.spawned).toBe(true);
    expect(f.tasks[result.taskId].metadata).toMatchObject({ claimFlow: true, swarmCount: 6, ...reviewConfig,
      useWorktree: false, openPR: false, prompt: CLAIM_PROSE });
    const registered = f.state.agents['replacement-agent'];
    expect(registered.metadata).toMatchObject({ configClaimFlow: true, claimPicksOwnBranch: true, configCodingOnMain: false });
    expect(registered.metadata.configReviewers).not.toHaveLength(0);
    expect(f.prompt).toContain('"agentId":"replacement-agent","action":"bind"');
    expect(f.prompt).toContain('"agentId":"replacement-agent","action":"acquire"');
    expect(f.prompt).toContain('antigravity-cli');
    expect(await updateClaimOwnership({ agentId: registered.id, action: 'bind', branch: 'claim/issue-42' })).toMatchObject({ bound: true });
    const lease = await claimMergeAdmission({ agentId: registered.id, action: 'acquire' });
    expect(lease.admitted).toBe(true);
    expect(await claimMergeAdmission({ agentId: registered.id, action: 'release', token: lease.token, outcome: 'leave-open' })).toMatchObject({ released: true });

    // A separate live owner remains protected even after the trusted replacement launches.
    f.state.agents.other = { ...registered, id: 'other', metadata: { ...registered.metadata, claimBranches: ['claim/issue-43'], claimSelectionPending: false } };
    persist();
    expect(await updateClaimOwnership({ agentId: registered.id, action: 'bind', branch: 'claim/issue-43' })).toEqual({ bound: false, reason: 'owner-active' });
    expect(f.state.agents.other.metadata.claimBranches).toEqual(['claim/issue-43']);
  });

  it('registers a legacy claim launch with the same authority its completion prompt declares', async () => {
    delete f.tasks.original.metadata.claimFlow;
    f.tasks.original.metadata.analysisType = 'claim-work';
    await forceSpawnTask('original');
    expect(f.prompt).toContain('"action":"acquire"');
    expect(await updateClaimOwnership({ agentId: 'replacement-agent', action: 'bind', branch: 'claim/issue-42' })).toMatchObject({ bound: true });
  });

  it('never turns copied claim prose or caller metadata into claim authority', async () => {
    f.tasks.original.metadata = { prompt: CLAIM_PROSE };
    f.state.agents.prior.metadata.configClaimFlow = false;
    persist();
    await resumeAgent('prior', { description: CLAIM_PROSE, metadata: { claimFlow: true }, claimFlow: true });
    expect(f.state.agents['replacement-agent'].metadata.configClaimFlow).toBe(false);
    expect(f.prompt).not.toContain('"action":"acquire"');
    expect(await updateClaimOwnership({ agentId: 'replacement-agent', action: 'bind', branch: 'claim/issue-42' })).toEqual({ bound: false, reason: 'claim-owner-unverified' });
    expect(await claimMergeAdmission({ agentId: 'replacement-agent', action: 'acquire' })).toMatchObject({ admitted: false, reason: 'claim-owner-unverified' });
  });

  it.each(['missing-task', 'legacy-missing-task', 'lost-contract', 'unreadable-task'])('blocks %s before retiring or spawning', async kind => {
    if (kind === 'lost-contract') f.tasks.original.metadata = { prompt: CLAIM_PROSE };
    else delete f.tasks.original;
    if (kind === 'legacy-missing-task') delete f.state.agents.prior.metadata.configClaimFlow;
    if (kind === 'unreadable-task') getTaskById.mockRejectedValueOnce(new Error('store unreadable'));
    const before = structuredClone(f.state);
    await expect(resumeAgent('prior', { description: CLAIM_PROSE, claimFlow: true })).rejects.toMatchObject({ code: 'AGENT_RESUME_CONTRACT_MISSING', status: 409 });
    expect(addTask).not.toHaveBeenCalled();
    expect(completeAgent).not.toHaveBeenCalled();
    expect(spawnDirectly).not.toHaveBeenCalled();
    expect(f.state).toEqual(before);
  });
});
