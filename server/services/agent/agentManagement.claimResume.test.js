/** Resume to real spawn dispatch, registration, completion and ownership gates.
 * Only provider/process, git discovery and persisted IO are doubled.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const f = vi.hoisted(() => ({ workspacePath: null, prompt: null, cliConfig: null }));
vi.mock('../cos/cosAgentLifecycle.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, completeAgent: vi.fn(actual.completeAgent), updateAgent: vi.fn(actual.updateAgent) };
});
vi.mock('../cos/cosTaskStore.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, addTask: vi.fn(actual.addTask), getTaskById: vi.fn(actual.getTaskById) };
});
vi.mock('../cos/cos.js', () => ({
  forceSpawnTask: vi.fn(),
}));
vi.mock('../cos/cosTaskGenerator.js', () => ({ evaluateTasks: vi.fn() }));
vi.mock('../cos/cosEvents.js', () => ({ emitLog: vi.fn(), cosEvents: { emit: vi.fn() } }));
vi.mock('./agentRunTracking.js', () => ({ createAgentRun: async () => ({ runId: 'run-new' }), completeAgentRun: vi.fn() }));
vi.mock('../../lib/paths.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-claim-resume-'),
}));
afterAll(cleanupTempDataRoots);
vi.mock('../../lib/gitRemote.js', async importOriginal => ({ ...await importOriginal(),
  getOriginInfo: async () => ({ host: 'github.com', fullName: 'example/repo' }),
}));
vi.mock('../codeReview.js', () => ({ getCodeReviewDefaults: async () => ({ reviewers: [] }) }));
vi.mock('./agentProviderResolution.js', () => ({ resolveAgentProviderAndModel: async () => ({
  ok: true, provider: { id: 'example-cli', type: 'cli', command: 'codex' }, selectedModel: 'example-model', modelSelection: {},
}) }));
vi.mock('./agentWorkspacePrep.js', () => ({ prepareAgentWorkspace: async ({ onPrepared }) => onPrepared({
  workspacePath: f.workspacePath, worktreeInfo: null,
}) }));
vi.mock('./agentCliSpawning.js', () => ({
  buildCliSpawnConfig: () => f.cliConfig || ({ command: 'codex' }), isClaudeCliProvider: () => false,
  isTuiProvider: () => false, getClaudeSettingsEnv: async () => ({}),
  spawnDirectly: vi.fn(async ({ prompt }) => { f.prompt = prompt; return 'replacement-agent'; }),
}));
vi.mock('../cos/cosRunnerClient.js', () => ({
  terminateAgentViaRunner: vi.fn(),
  killAgentViaRunner: vi.fn(),
  pauseAgentViaRunner: vi.fn(),
  getAgentStatsFromRunner: vi.fn(),
  getActiveAgentsFromRunner: vi.fn().mockResolvedValue([])
}));

vi.mock('../shell.js', () => ({ writeToSession: vi.fn(), killSession: vi.fn() }));
// Only the two I/O functions are stubbed — HOST_SHUTDOWN_REASON stays real so
// the breadcrumb value the tests assert can't drift from the one production writes.
vi.mock('../../lib/hostShutdown.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readHostShutdownMarker: vi.fn().mockResolvedValue(null),
  clearHostShutdownMarker: vi.fn().mockResolvedValue(undefined),
}));


import { resumeAgent } from './agentManagement.js';
import { dispatchAgentRun } from './agentSpawnDispatch.js';
import { forceSpawnTask } from '../cos/cos.js';
import { addTask, getTaskById } from '../cos/cosTaskStore.js';
import { storedForm } from '../../lib/cos/cosTaskRows.js';
import { __resetCosTaskRepository, applyTaskListSave, deleteStoredTask, readTaskListVersion } from '../cos/cosTaskRepository.js';
import { __resetTaskCache } from '../cos/cosTaskStore.js';
import { loadState, saveState } from '../cos/cosState.js';
import { PATHS } from '../../lib/paths.js';
import { completeAgent, updateAgent, getAgentRecord } from '../cos/cosAgentLifecycle.js';
import { spawnDirectly } from './agentCliSpawning.js';
import { setUseRunner } from './agentState.js';
import { updateClaimOwnership } from '../cos/cosClaimOwnership.js';
import { resolveMergeHandoffOwner } from '../mergeHandoffOwner.js';

const CLAIM_PROSE = 'Resume the claim swarm, preserve the worktrees, and ship all issues.';
const reviewers = ['provider:antigravity-cli'];
const reviewConfig = { reviewers, optionalReviewers: reviewers, reviewerMaxRounds: { 'provider:antigravity-cli': 2 },
  reviewerModels: { 'provider:antigravity-cli': 'gemini-3.8-flash' }, reviewerEfforts: { 'provider:antigravity-cli': 'low' } };
const originalTask = () => ({
  id: 'task-original', taskType: 'user', status: 'blocked', priority: 'MEDIUM', description: CLAIM_PROSE,
  metadata: { claimFlow: true, swarmCount: 6, ...reviewConfig, reviewLoop: true, useWorktree: false, openPR: false,
    prompt: CLAIM_PROSE, blockedCategory: 'agent-paused', pausedAgentId: 'prior', app: 'example' },
});
const saveTask = async task => applyTaskListSave(task.taskType, {
  upserts: [{ task: storedForm(task, task.taskType), position: 0 }],
  deletes: [],
  expectedVersions: { [task.taskType]: await readTaskListVersion(task.taskType) },
});

beforeEach(async () => {
  vi.clearAllMocks(); setUseRunner(false); f.prompt = null; f.cliConfig = null;
  __resetTaskCache();
  __resetCosTaskRepository();
  await saveTask(originalTask());
  f.workspacePath = join(PATHS.data, 'workspace');
  await mkdir(f.workspacePath, { recursive: true });
  const state = await loadState();
  state.agents = { prior: { id: 'prior', taskId: 'task-original', status: 'paused', startedAt: '2026-01-02T00:00:00Z',
    metadata: { configClaimFlow: true, workspacePath: f.workspacePath, taskType: 'user' } } };
  await saveState(state);
  forceSpawnTask.mockImplementation(async taskId => {
    await dispatchAgentRun({ task: await getTaskById(taskId), agentId: 'replacement-agent', instanceId: 'instance-example',
      blockAndBail: message => { throw new Error(JSON.stringify(message)); },
      cleanupOnError: message => { throw new Error(message); },
    });
    return { success: true };
  });
});

describe('claim resume contract through spawn', () => {
  it.each(['blocked', 'completed', 'legacy'])('preserves an unpinned %s swarm through registration and handoff ownership', async kind => {
    const task = originalTask();
    if (kind === 'completed') task.status = 'completed';
    if (kind === 'legacy') {
      delete task.metadata.claimFlow;
      task.metadata.analysisType = 'claim-work';
    }
    await saveTask(task);
    const result = await resumeAgent('prior', { context: 'Keep the existing commits.' });
    expect(result.spawned).toBe(true);
    expect((await getTaskById(result.taskId)).metadata).toMatchObject({ claimFlow: true, swarmCount: 6, ...reviewConfig,
      useWorktree: false, openPR: false, prompt: CLAIM_PROSE });
    const registered = await getAgentRecord('replacement-agent');
    expect(registered.metadata).toMatchObject({ configClaimFlow: true, claimPicksOwnBranch: true, configCodingOnMain: false });
    expect(registered.metadata.configReviewers).not.toHaveLength(0);
    expect(f.prompt).toContain('"agentId":"replacement-agent","action":"bind"');
    expect(f.prompt).toContain('This run is replacement-agent');
    expect(f.prompt).not.toContain('/api/cos/merge-admission');
    expect(f.prompt).toContain('antigravity');
    expect(await updateClaimOwnership({ agentId: registered.id, action: 'bind', branch: 'claim/issue-42' })).toMatchObject({ bound: true });
    expect((await resolveMergeHandoffOwner(registered.id)).owns('claim/issue-42')).toBe(true);

    // A separate live owner remains protected even after the trusted replacement launches.
    const state = await loadState();
    state.agents.other = { ...registered, id: 'other', metadata: { ...registered.metadata, claimBranches: ['claim/issue-43'], claimSelectionPending: false } };
    await saveState(state);
    expect(await updateClaimOwnership({ agentId: registered.id, action: 'bind', branch: 'claim/issue-43' })).toEqual({ bound: false, reason: 'owner-active' });
    expect((await getAgentRecord('other')).metadata.claimBranches).toEqual(['claim/issue-43']);
  });

  it('registers a legacy claim launch with the same authority its completion prompt declares', async () => {
    const task = originalTask();
    delete task.metadata.claimFlow;
    task.metadata.analysisType = 'claim-work';
    await saveTask(task);
    await forceSpawnTask('task-original');
    expect(f.prompt).toContain('GitHub/GitLab repository rules decide merge eligibility');
    expect(await updateClaimOwnership({ agentId: 'replacement-agent', action: 'bind', branch: 'claim/issue-42' })).toMatchObject({ bound: true });
  });

  it('never turns copied claim prose or caller metadata into claim authority', async () => {
    await saveTask({ ...originalTask(), metadata: { prompt: CLAIM_PROSE } });
    await updateAgent('prior', { metadata: { configClaimFlow: false } });
    await resumeAgent('prior', { description: CLAIM_PROSE, metadata: { claimFlow: true }, claimFlow: true });
    expect((await getAgentRecord('replacement-agent')).metadata.configClaimFlow).toBe(false);
    expect(f.prompt).not.toContain('"action":"acquire"');
    expect(await updateClaimOwnership({ agentId: 'replacement-agent', action: 'bind', branch: 'claim/issue-42' })).toEqual({ bound: false, reason: 'claim-owner-unverified' });
    expect(await resolveMergeHandoffOwner('replacement-agent')).toEqual({ refused: 'handoff-owner-unverified' });
  });

  it.each(['missing-task', 'legacy-missing-task', 'lost-contract', 'unreadable-task'])('blocks %s before retiring or spawning', async kind => {
    if (kind === 'lost-contract') await saveTask({ ...originalTask(), metadata: { prompt: CLAIM_PROSE } });
    else await deleteStoredTask('task-original', 'user');
    if (kind === 'legacy-missing-task') {
      const state = await loadState();
      delete state.agents.prior.metadata.configClaimFlow;
      await saveState(state);
    }
    if (kind === 'unreadable-task') getTaskById.mockRejectedValueOnce(new Error('store unreadable'));
    const before = structuredClone(await loadState());
    await expect(resumeAgent('prior', { description: CLAIM_PROSE, claimFlow: true })).rejects.toMatchObject({ code: 'AGENT_RESUME_CONTRACT_MISSING', status: 409 });
    expect(addTask).not.toHaveBeenCalled();
    expect(completeAgent).not.toHaveBeenCalled();
    expect(spawnDirectly).not.toHaveBeenCalled();
    expect(structuredClone(await loadState())).toEqual(before);
  });
});

it('pins a security scanner grant to effective CLI settings and registers aliased task eligibility', async () => {
  setUseRunner(true);
  f.cliConfig = { command: 'codex', args: ['--model', 'saved-model', '-c', 'model_reasoning_effort=high'] };
  const scan = { id: 'sys-example-security', taskType: 'internal', status: 'pending', priority: 'MEDIUM', description: 'Synthetic source audit',
    metadata: { taskAnalysisType: 'security', useWorktree: false, openPR: false, effort: 'medium' } };
  await saveTask(scan);
  const task = await getTaskById(scan.id);
  const spawnViaRunner = vi.fn();
  await dispatchAgentRun({ task, agentId: 'agent-scanner', instanceId: 'instance-example',
    blockAndBail: message => { throw new Error(JSON.stringify(message)); }, cleanupOnError: message => { throw new Error(message); },
  }, { spawnViaRunner });
  const persisted = await getTaskById(task.id);
  expect(spawnViaRunner).toHaveBeenCalledWith('agent-scanner', {
    ...task, status: 'in_progress', metadata: persisted.metadata,
  }, expect.objectContaining({
    securityScanGrant: { model: 'saved-model', effort: 'high', auth: 'chatgpt', maxCostUsd: 'unlimited', timeLimitSeconds: 'unlimited' },
  }));
  expect(updateAgent).toHaveBeenCalledWith('agent-scanner', { metadata: expect.objectContaining({ taskAnalysisType: 'security', securityScanGrant: expect.any(Object) }) });
});
