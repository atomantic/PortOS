const reportInfrastructureFailure = vi.hoisted(() => vi.fn(async () => null));
const persisted = vi.hoisted(() => ({ saved: null }));
vi.mock('../reviewInfrastructureFailure.js', () => ({ reportReviewInfrastructureFailure: reportInfrastructureFailure }));

/**
 * Every spawn-eligibility gate in `runAgentSpawn`, driven through the real
 * `spawnAgentForTask` boundary.
 *
 * These gates all end the same way — persist `status: 'blocked'`, release the
 * spawn-local state, announce the outcome — and until now nothing verified any
 * of that. What pinned them was source-text grep in `agentLifecycle.test.js`
 * (`/if \(scanBlock\) \{[\s\S]*?status: 'blocked'/` and friends). A regex over
 * the file cannot tell whether a given copy still releases the claim,
 * still emits `agent:error`, or still releases the synthetic app-review marker
 * — and two of the copies deliberately DIVERGE on the emit (the public-review
 * scan/eligibility gates warn-log instead, because a fail-closed safety outcome
 * must not create an automatic investigator) while two more diverge on the
 * marker release. Those divergences are load-bearing (#989: a stranded marker
 * leaves an app reading "in review" until the next daemon restart) and were
 * invisible to the suite.
 *
 * So each case here asserts the same observable triple at the spawn boundary:
 *
 *   1. the task's persisted `status` / `blockedReason` / `blockedCategory`,
 *   2. whether `cosEvents.emit('agent:error', …)` fired,
 *   3. that the app-review marker was released for a task carrying
 *      `metadata.app`.
 *
 * That triple is what a caller can actually see, so it survives the epilogues
 * being collapsed into one parameterized helper — which is the point: the
 * refactor is only safe because these pass before AND after it.
 *
 * Mirrors the mock set in agentLifecycle.postureGate.test.js — the leaves are
 * stubbed so the real orchestrator runs.
 */

import { afterAll, afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { rmSync } from 'fs';
import { join } from 'path';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

// A spawn that reaches the dispatch writes `prompt.txt` into `PATHS.cosAgents`.
// Re-rooted at a temp dir so this suite never writes into the developing
// install's agent archive. Allocated inside `vi.hoisted` because
// `agentLifecycle.js` reads `PATHS.cosAgents` at import time.
const { TEMP_ROOT } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join: joinPath } = await import('path');
  return { TEMP_ROOT: mkdtempSync(joinPath(tmpdir(), 'portos-block-and-bail-')) };
});

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: TEMP_ROOT });
});

vi.mock('../cos/cosRunnerClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawnAgentViaRunner: vi.fn(),
  getRunnerHealth: vi.fn().mockResolvedValue({ available: true, uptime: 3600 }),
}));
vi.mock('../cos/cosAgentLifecycle.js', () => ({
  registerAgent: vi.fn().mockResolvedValue(undefined),
  updateAgent: vi.fn().mockResolvedValue(undefined),
  completeAgent: vi.fn().mockResolvedValue(undefined),
  getAgentRecord: vi.fn().mockResolvedValue(null),
}));
vi.mock('./agentRunTracking.js', () => ({
  createAgentRun: vi.fn().mockResolvedValue(undefined),
  completeAgentRun: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./agentFinalization.js', () => ({
  finalizeAgent: vi.fn().mockResolvedValue(undefined),
  stampLiExecutionVerdict: vi.fn(async (update) => update),
}));
vi.mock('../cos/cosEvents.js', () => ({
  emitLog: vi.fn(),
  cosEvents: { emit: vi.fn(), on: vi.fn() },
}));
vi.mock('../cos/cosState.js', async importOriginal => ({
  ...(await importOriginal()),
  getConfig: vi.fn().mockResolvedValue({}),
  loadState: vi.fn().mockResolvedValue({ agents: [] }),
}));
vi.mock('../cos/cosTaskStore.js', () => ({
  updateTask: vi.fn().mockResolvedValue(undefined),
  getTaskById: vi.fn().mockResolvedValue(null),
}));
vi.mock('../forgeAuth.js', () => ({ resolveForgeTokenEnv: vi.fn().mockResolvedValue({}) }));
vi.mock('./agentCliSpawning.js', () => ({
  buildCliSpawnConfig: vi.fn(),
  isClaudeCliProvider: vi.fn().mockReturnValue(false),
  isTuiProvider: vi.fn().mockReturnValue(true),
  getClaudeSettingsEnv: vi.fn().mockResolvedValue({}),
  spawnDirectly: vi.fn(),
}));
vi.mock('./agentTuiSpawning.js', () => ({
  buildTuiSpawnConfig: vi.fn(),
  spawnTuiAgent: vi.fn(),
}));
vi.mock('./agentProviderResolution.js', () => ({ resolveAgentProviderAndModel: vi.fn() }));
// Stops the spawn immediately after the pre-prep gates. The two post-prep
// gates (input materialization / snapshot load) override it per test.
vi.mock('./agentWorkspacePrep.js', () => ({
  prepareAgentWorkspace: vi.fn(async ({ onPrepared }) => onPrepared({ outcome: 'blocked', reason: 'stop here' })),
}));
vi.mock('./agentWorktreeCleanup.js', () => ({
  cleanupAgentWorktree: vi.fn(),
  releaseRetryHold: vi.fn().mockResolvedValue({}),
}));
vi.mock('../worktreeManager.js', () => ({ removeWorktree: vi.fn().mockResolvedValue({ removed: true }) }));
vi.mock('./agentCompletionCleanup.js', () => ({ runAgentCompletionCleanup: vi.fn() }));
vi.mock('./agentSummaryExtraction.js', () => ({ extractFinalSummary: vi.fn() }));
vi.mock('./agentManagement.js', () => ({ handleOrphanedTask: vi.fn() }));
vi.mock('./agentRunEventLog.js', () => ({ appendRunEvent: vi.fn(async () => ({ appended: true })) }));
vi.mock('./agentPromptBuilder.js', () => ({
  buildAgentPrompt: vi.fn(),
  getAppWorkspace: vi.fn(),
  promptOpensOwnPr: vi.fn(() => 'portos'),
  isClaimFlowTask: vi.fn(() => false),
}));
vi.mock('../workspaceContext.js', () => ({ snapshotOnRepoSwitch: vi.fn().mockResolvedValue(null) }));
vi.mock('./agentErrorAnalysis.js', () => ({
  analyzeAgentFailure: vi.fn().mockReturnValue({ category: 'startup-failure', actionable: false }),
}));
vi.mock('../appActivity.js', () => ({ releaseAppReviewMarker: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../instanceIdentity.js', () => ({ ensureInstanceId: vi.fn().mockResolvedValue('instance-1') }));
vi.mock('../updateChecker.js', () => ({ isUpdateInProgress: vi.fn().mockReturnValue(false) }));
vi.mock('../modelAbuseGuard.js', () => ({
  materializePublicReviewInput: vi.fn(),
  materializePublicReviewPatches: vi.fn(),
  readPublicReviewInputSnapshot: vi.fn(),
  validatePublicReviewModel: vi.fn().mockResolvedValue({ ok: true }),
}));

import { maintenance } from '../../lib/maintenanceAdmission.js';
import { buildTuiSpawnConfig, spawnTuiAgent } from './agentTuiSpawning.js';
import { spawnAgentForTask as runSpawnAgentForTask } from './agentLifecycle.js';
import { prepareAgentWorkspace } from './agentWorkspacePrep.js';
import {
  materializePublicReviewInput,
  materializePublicReviewPatches,
  readPublicReviewInputSnapshot,
  validatePublicReviewModel,
} from '../modelAbuseGuard.js';
import { resolveAgentProviderAndModel } from './agentProviderResolution.js';
import { buildAgentPrompt } from './agentPromptBuilder.js';
import { registerAgent } from '../cos/cosAgentLifecycle.js';
import { createAgentRun } from './agentRunTracking.js';
import { buildCliSpawnConfig, isTuiProvider, spawnDirectly } from './agentCliSpawning.js';
import { spawnAgentViaRunner } from '../cos/cosRunnerClient.js';
import { getConfig, loadState } from '../cos/cosState.js';
import { getTaskById, updateTask } from '../cos/cosTaskStore.js';
import { cosEvents, emitLog } from '../cos/cosEvents.js';
import { isUpdateInProgress } from '../updateChecker.js';
import { releaseAppReviewMarker } from '../appActivity.js';
import { spawningTasks, runnerAgents, setUseRunner } from './agentState.js';
import { MAX_TOTAL_SPAWNS } from '../../lib/cos/cosTaskMetadata.js';
import { markHostShuttingDown, resetHostShutdownFlagForTests } from '../../lib/hostShutdown.js';
import { PROVIDER_CONFIG_BLOCKED_CATEGORY } from '../../lib/taskBlockCategories.js';
import {
  PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
  PUBLIC_REVIEW_GATE_EXECUTION_PROFILE,
} from '../../lib/agent/agentExecutionProfiles.js';

// The provider every install actually runs its CoS agents on — its vendor row
// declares recipes for both public-review postures.
const CLAUDE_TUI = { id: 'claude-code-tui', type: 'tui', command: 'claude', envVars: {} };
// A TUI record whose vendor declares no public-review recipe at all.
const OPENCODE_TUI = { id: 'opencode-tui', type: 'tui', command: 'opencode', envVars: {} };

// Every gate case carries `metadata.app`, because the marker release is only
// observable for a task that bound one (#989).
const APP = 'example-app';

// The real spawn gate re-reads the queued task before it reaches the provider
// gates covered below. Give each fixture the snapshot the queue would hold.
const spawnAgentForTask = task => {
  const saved = { ...task, taskType: task.taskType || 'user', status: 'pending' };
  persisted.saved = saved;
  vi.mocked(getTaskById).mockResolvedValue(saved);
  return runSpawnAgentForTask(task);
};

/** A cleared model-abuse scan, so a case can reach a gate PAST the scan gate. */
const CLEARED_SCAN = { completed: true, status: 'passed', safePrCount: 1 };

/**
 * A cleared eligibility gate, so an actions-stage case can reach a gate PAST
 * it. The gate demands COVERAGE — every PR the issue watcher saw must appear in
 * `eligibleNumbers` — so both halves have to name the same numbers.
 */
const CLEARED_ELIGIBILITY_PR = 7;
const clearedEligibilityMetadata = () => ({
  issueWatcher: { pullRequests: [{ number: CLEARED_ELIGIBILITY_PR }] },
  eligibility: { complete: true, eligibleNumbers: [CLEARED_ELIGIBILITY_PR] },
});

/** Every `updateTask` call that persisted a `blocked` status. */
const blockedWrites = () => vi.mocked(updateTask).mock.calls
  .filter(([, update]) => update?.status === 'blocked');

/** The single blocked write a gate case must produce, with its metadata. */
function soleBlockedWrite() {
  const writes = blockedWrites();
  expect(writes, 'exactly one blocked write').toHaveLength(1);
  const [taskId, update, taskType] = writes[0];
  return { taskId, update, taskType, metadata: update.metadata };
}

/** Every `cosEvents.emit('agent:error', …)` payload. */
const agentErrors = () => vi.mocked(cosEvents.emit).mock.calls
  .filter(([event]) => event === 'agent:error')
  .map(([, payload]) => payload);

/** Whether the synthetic app-review marker was released for this task's app. */
const markerReleasedFor = (app) => vi.mocked(releaseAppReviewMarker).mock.calls
  .some(([released]) => released === app);

/**
 * Carry a spawn PAST `prepareAgentWorkspace`, which the mock set stops every
 * other case at, so the two post-prep gates are actually reached.
 */
function reachPostPrepGates() {
  vi.mocked(prepareAgentWorkspace).mockImplementation(async ({ onPrepared }) => onPrepared({
    outcome: 'ready',
    workspacePath: join(TEMP_ROOT, 'workspace'),
    resolvedAppName: APP,
    worktreeInfo: null,
  }));
  vi.mocked(materializePublicReviewInput).mockResolvedValue(true);
  vi.mocked(materializePublicReviewPatches).mockResolvedValue(true);
  vi.mocked(readPublicReviewInputSnapshot).mockResolvedValue({ pullRequests: [] });
  vi.mocked(buildAgentPrompt).mockResolvedValue('review the cleared input');
  vi.mocked(createAgentRun).mockResolvedValue({ runId: 'run-1' });
  vi.mocked(buildCliSpawnConfig).mockReturnValue({ command: 'claude', args: [] });
}

beforeEach(() => {
  vi.clearAllMocks();
  spawningTasks.clear();
  runnerAgents.clear();
  setUseRunner(false);
  vi.mocked(isTuiProvider).mockReturnValue(true);
  vi.mocked(spawnAgentViaRunner).mockResolvedValue({ pid: 4242 });
  vi.mocked(validatePublicReviewModel).mockResolvedValue({ ok: true });
  // Truthy: a falsy in_progress write is read as "the claim did not land".
  vi.mocked(updateTask).mockImplementation(async (_id, patch) => ({ metadata: { ...persisted.saved?.metadata, ...patch.metadata } }));
  vi.mocked(getConfig).mockResolvedValue({});
  vi.mocked(resolveAgentProviderAndModel).mockResolvedValue({
    ok: true, provider: CLAUDE_TUI, selectedModel: 'sonnet', modelSelection: {},
  });
  vi.mocked(prepareAgentWorkspace).mockImplementation(async ({ onPrepared }) => onPrepared({ outcome: 'blocked', reason: 'stop here' }));
});

afterAll(() => rmSync(TEMP_ROOT, { recursive: true, force: true }));

describe('runAgentSpawn gates — max total spawns', () => {
  it('blocks the task, releases the app-review marker, and raises no investigator', async () => {
    const task = {
      id: 'task-max-spawns',
      taskType: 'user',
      metadata: { app: APP, totalSpawnCount: MAX_TOTAL_SPAWNS },
    };

    expect(await spawnAgentForTask(task)).toBeNull();

    const { taskId, update, taskType, metadata } = soleBlockedWrite();
    expect(taskId).toBe(task.id);
    expect(update.status).toBe('blocked');
    expect(metadata.blockedCategory).toBe('max-spawns');
    expect(metadata.blockedReason).toContain(`${MAX_TOTAL_SPAWNS}/${MAX_TOTAL_SPAWNS}`);
    expect(metadata.blockedAt).toEqual(expect.any(String));
    expect(taskType).toBe('user');
    // A runaway respawn is a standing decision, not an agent failure — an
    // agent:error here would spawn an investigator for it on every dispatch.
    expect(agentErrors()).toEqual([]);
    expect(markerReleasedFor(APP)).toBe(true);
    expect(registerAgent).not.toHaveBeenCalled();
    expect(spawningTasks.has(task.id)).toBe(false);
    expect(maintenance.operations().filter(op => op.kind === 'agent')).toEqual([]);
  });

  it('spawns normally one dispatch below the cap', async () => {
    await spawnAgentForTask({
      id: 'task-under-cap',
      metadata: { app: APP, totalSpawnCount: MAX_TOTAL_SPAWNS - 1 },
    });

    expect(blockedWrites()).toEqual([]);
  });
});

describe('runAgentSpawn gates — provider-config resolution failure', () => {
  it('blocks a PERMANENT failure and forwards the provider status to the investigator', async () => {
    vi.mocked(resolveAgentProviderAndModel).mockResolvedValue({
      ok: false,
      permanent: true,
      error: 'An api-only provider cannot run an agent task',
      providerId: 'openai-api',
      providerStatus: 'unavailable',
    });
    const task = { id: 'task-provider-config', taskType: 'internal', metadata: { app: APP } };

    expect(await spawnAgentForTask(task)).toBeNull();

    const { update, taskType, metadata } = soleBlockedWrite();
    expect(update.status).toBe('blocked');
    expect(metadata.blockedCategory).toBe(PROVIDER_CONFIG_BLOCKED_CATEGORY);
    expect(metadata.blockedReason).toBe('An api-only provider cannot run an agent task');
    expect(taskType).toBe('internal');
    expect(agentErrors()).toEqual([{
      taskId: task.id,
      error: 'An api-only provider cannot run an agent task',
      providerId: 'openai-api',
      providerStatus: 'unavailable',
    }]);
    expect(markerReleasedFor(APP)).toBe(true);
  });

  // A transient failure must stay pending so the next dispatch can retry it.
  it('leaves a TRANSIENT failure unblocked while still cleaning up', async () => {
    vi.mocked(resolveAgentProviderAndModel).mockResolvedValue({
      ok: false, permanent: false, error: 'provider is briefly unreachable',
    });

    expect(await spawnAgentForTask({ id: 'task-transient', metadata: { app: APP } })).toBeNull();

    expect(blockedWrites()).toEqual([]);
    expect(agentErrors()).toEqual([{ taskId: 'task-transient', error: 'provider is briefly unreachable' }]);
    expect(markerReleasedFor(APP)).toBe(true);
  });

  // The optional keys are spread conditionally; an absent provider id must not
  // land as `providerId: undefined` on the event.
  it('omits absent provider fields from the event payload', async () => {
    vi.mocked(resolveAgentProviderAndModel).mockResolvedValue({
      ok: false, permanent: false, error: 'no provider is enabled',
    });

    await spawnAgentForTask({ id: 'task-bare-error', metadata: { app: APP } });

    expect(Object.keys(agentErrors()[0])).toEqual(['taskId', 'error']);
  });
});

describe('runAgentSpawn gates — public-review model-abuse scan', () => {
  // A fail-closed safety outcome, NOT an agent/provider failure: emitting
  // agent:error would create an automatic investigator and could retry the same
  // unvalidated input.
  it('blocks an incomplete scan with a warn log rather than an agent:error', async () => {
    const task = {
      id: 'task-scan-incomplete',
      metadata: { app: APP, executionProfile: PUBLIC_REVIEW_GATE_EXECUTION_PROFILE, pipeline: {} },
    };

    expect(await spawnAgentForTask(task)).toBeNull();

    const { update, metadata } = soleBlockedWrite();
    expect(update.status).toBe('blocked');
    expect(metadata.blockedCategory).toBe('public-review-security-scan-incomplete');
    expect(metadata.blockedReason).toContain('the model-abuse scan is incomplete');
    expect(agentErrors()).toEqual([]);
    expect(vi.mocked(emitLog).mock.calls.some(
      ([level, message]) => level === 'warn'
        && message.includes(`Public review withheld for task ${task.id}`)
        && message.includes('public-review-security-scan-incomplete'),
    )).toBe(true);
    expect(markerReleasedFor(APP)).toBe(true);
  });

  it('blocks a completed scan that cleared no pull requests', async () => {
    await spawnAgentForTask({
      id: 'task-no-cleared-prs',
      metadata: {
        app: APP,
        executionProfile: PUBLIC_REVIEW_GATE_EXECUTION_PROFILE,
        pipeline: { securityScan: { completed: true, status: 'findings', safePrCount: 0 } },
      },
    });

    expect(soleBlockedWrite().metadata.blockedCategory).toBe('public-review-no-cleared-prs');
    expect(agentErrors()).toEqual([]);
    expect(markerReleasedFor(APP)).toBe(true);
  });
});

describe('runAgentSpawn gates — public-review actions eligibility', () => {
  it('blocks an incomplete eligibility gate with a warn log rather than an agent:error', async () => {
    const task = {
      id: 'task-eligibility-incomplete',
      metadata: {
        app: APP,
        executionProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
        pipeline: { securityScan: CLEARED_SCAN, eligibility: {} },
      },
    };

    expect(await spawnAgentForTask(task)).toBeNull();

    const { update, metadata } = soleBlockedWrite();
    expect(update.status).toBe('blocked');
    expect(metadata.blockedCategory).toBe('public-review-eligibility-incomplete');
    expect(agentErrors()).toEqual([]);
    expect(vi.mocked(emitLog).mock.calls.some(
      ([level, message]) => level === 'warn'
        && message.includes(`Public review withheld for task ${task.id}`)
        && message.includes('public-review-eligibility-incomplete'),
    )).toBe(true);
    expect(markerReleasedFor(APP)).toBe(true);
  });

  it('blocks a complete eligibility gate that cleared no pull requests', async () => {
    await spawnAgentForTask({
      id: 'task-no-eligible-prs',
      metadata: {
        app: APP,
        executionProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
        pipeline: { securityScan: CLEARED_SCAN, eligibility: { complete: true, eligibleNumbers: [] } },
      },
    });

    expect(soleBlockedWrite().metadata.blockedCategory).toBe('public-review-no-eligible-prs');
    expect(agentErrors()).toEqual([]);
  });
});

describe('runAgentSpawn gates — public-review provider posture', () => {
  // Unlike the two gates above, an unsupported provider IS an operator-visible
  // misconfiguration, so this one does raise an investigator.
  it('blocks an unsupported provider and queues only a trusted infrastructure diagnosis', async () => {
    vi.mocked(resolveAgentProviderAndModel).mockResolvedValue({
      ok: true, provider: OPENCODE_TUI, selectedModel: 'qwen', modelSelection: {},
    });
    const task = {
      id: 'task-posture',
      metadata: {
        app: APP,
        executionProfile: PUBLIC_REVIEW_GATE_EXECUTION_PROFILE,
        pipeline: { securityScan: CLEARED_SCAN },
      },
    };

    expect(await spawnAgentForTask(task)).toBeNull();

    const { update, metadata } = soleBlockedWrite();
    expect(update.status).toBe('blocked');
    expect(metadata.blockedCategory).toBe('public-review-provider-unsupported');
    expect(metadata.blockedReason).toContain("Provider 'opencode-tui'");
    expect(agentErrors()).toEqual([]);
    expect(reportInfrastructureFailure).toHaveBeenCalledWith({ code: metadata.blockedCategory, task });
    expect(markerReleasedFor(APP)).toBe(true);
  });
});

describe('runAgentSpawn gates — public-review model policy', () => {
  it('blocks a model that is not tool-free, stamping the policy code as the category', async () => {
    vi.mocked(validatePublicReviewModel).mockResolvedValue({
      ok: false, code: 'public-review-model-not-installed',
    });
    const task = {
      id: 'task-model-policy',
      metadata: {
        app: APP,
        executionProfile: PUBLIC_REVIEW_GATE_EXECUTION_PROFILE,
        pipeline: { securityScan: CLEARED_SCAN },
      },
    };

    expect(await spawnAgentForTask(task)).toBeNull();

    const { update, metadata } = soleBlockedWrite();
    expect(update.status).toBe('blocked');
    expect(metadata.blockedCategory).toBe('public-review-model-not-installed');
    expect(metadata.blockedReason).toContain('public-review-model-not-installed');
    expect(agentErrors()).toEqual([]);
    expect(reportInfrastructureFailure).toHaveBeenCalledWith({ code: metadata.blockedCategory, task });
    expect(markerReleasedFor(APP)).toBe(true);
  });

  // The category falls back when the policy result carries no code, so the
  // block is never stamped `undefined`.
  it('falls back to a generic category when the policy result carries no code', async () => {
    vi.mocked(validatePublicReviewModel).mockResolvedValue({ ok: false });

    await spawnAgentForTask({
      id: 'task-model-policy-codeless',
      metadata: {
        app: APP,
        executionProfile: PUBLIC_REVIEW_GATE_EXECUTION_PROFILE,
        pipeline: { securityScan: CLEARED_SCAN },
      },
    });

    expect(soleBlockedWrite().metadata.blockedCategory).toBe('public-review-model-unsupported');
  });
});

describe('runAgentSpawn gates — public-review input materialization', () => {
  it('blocks when the screened input cannot be materialized into the workspace', async () => {
    reachPostPrepGates();
    vi.mocked(materializePublicReviewInput).mockResolvedValue(false);
    const task = {
      id: 'task-input-missing',
      metadata: {
        app: APP,
        executionProfile: PUBLIC_REVIEW_GATE_EXECUTION_PROFILE,
        pipeline: { securityScan: CLEARED_SCAN, reviewInputKey: 'a'.repeat(64) },
      },
    };

    expect(await spawnAgentForTask(task)).toBeNull();

    const { update, metadata } = soleBlockedWrite();
    expect(update.status).toBe('blocked');
    expect(metadata.blockedCategory).toBe('public-review-input-missing');
    expect(metadata.blockedReason).toContain('unavailable or invalid');
    expect(agentErrors()).toEqual([{ taskId: task.id, error: metadata.blockedReason }]);
    expect(markerReleasedFor(APP)).toBe(true);
    expect(registerAgent).not.toHaveBeenCalled();
  });

  it('blocks the actions stage when its read-only patch files cannot be materialized', async () => {
    reachPostPrepGates();
    vi.mocked(materializePublicReviewPatches).mockResolvedValue(false);

    const { issueWatcher, eligibility } = clearedEligibilityMetadata();
    await spawnAgentForTask({
      id: 'task-patches-missing',
      metadata: {
        app: APP,
        executionProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
        issueWatcher,
        pipeline: { securityScan: CLEARED_SCAN, eligibility, reviewInputKey: 'b'.repeat(64) },
      },
    });

    expect(soleBlockedWrite().metadata.blockedCategory).toBe('public-review-input-missing');
    expect(agentErrors()).toHaveLength(1);
    expect(markerReleasedFor(APP)).toBe(true);
  });
});

describe('runAgentSpawn gates — public-review input snapshot', () => {
  it('blocks when the screened snapshot cannot be read back for the reviewer', async () => {
    reachPostPrepGates();
    vi.mocked(readPublicReviewInputSnapshot).mockResolvedValue(null);
    const task = {
      id: 'task-snapshot-missing',
      metadata: {
        app: APP,
        executionProfile: PUBLIC_REVIEW_GATE_EXECUTION_PROFILE,
        pipeline: { securityScan: CLEARED_SCAN, reviewInputKey: 'c'.repeat(64) },
      },
    };

    expect(await spawnAgentForTask(task)).toBeNull();

    const { update, metadata } = soleBlockedWrite();
    expect(update.status).toBe('blocked');
    expect(metadata.blockedCategory).toBe('public-review-input-missing');
    expect(metadata.blockedReason).toContain('no-tools reviewer');
    expect(agentErrors()).toEqual([{ taskId: task.id, error: metadata.blockedReason }]);
    expect(markerReleasedFor(APP)).toBe(true);
  });

  // Same category, different operator-facing reason: the actions stage names
  // the final reviewer instead.
  it('names the final reviewer when the actions stage cannot read its snapshot', async () => {
    reachPostPrepGates();
    vi.mocked(readPublicReviewInputSnapshot).mockResolvedValue(null);

    const { issueWatcher, eligibility } = clearedEligibilityMetadata();
    await spawnAgentForTask({
      id: 'task-snapshot-missing-actions',
      metadata: {
        app: APP,
        executionProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
        issueWatcher,
        pipeline: { securityScan: CLEARED_SCAN, eligibility, reviewInputKey: 'd'.repeat(64) },
      },
    });

    expect(soleBlockedWrite().metadata.blockedReason).toContain('final reviewer');
  });
});

describe('runAgentSpawn gates — spawn setup failure', () => {
  it('blocks a private-security setup failure without publishing the underlying error', async () => {
    vi.mocked(getConfig).mockRejectedValue(new Error('synthetic sensitive source details'));
    const task = {
      id: 'task-private-setup',
      taskType: 'internal',
      metadata: { app: APP, analysisType: 'private-security-assessment' },
    };

    expect(await spawnAgentForTask(task)).toBeNull();

    const { update, taskType, metadata } = soleBlockedWrite();
    expect(update.status).toBe('blocked');
    expect(metadata.blockedCategory).toBe('private-security-setup-failed');
    expect(metadata.blockedReason).toContain('Private assessment setup failed');
    expect(taskType).toBe('internal');
    expect(agentErrors()).toEqual([{ taskId: task.id, error: metadata.blockedReason }]);
    expect(markerReleasedFor(APP)).toBe(true);
    expect(JSON.stringify(vi.mocked(emitLog).mock.calls)).not.toContain('synthetic sensitive source details');
    expect(JSON.stringify(vi.mocked(cosEvents.emit).mock.calls)).not.toContain('synthetic sensitive source details');
  });

  it('persists an unsupported execution option as configuration without starting an investigation', async () => {
    vi.mocked(getConfig).mockRejectedValue(Object.assign(new Error('Execution speed is unsupported on this route.'), { code: 'EXECUTION_OPTIONS_UNSUPPORTED' }));
    const task = { id: 'task-speed-refused', metadata: { app: APP } };
    expect(await spawnAgentForTask(task)).toBeNull();
    const { update, metadata } = soleBlockedWrite();
    expect(update.status).toBe('blocked');
    expect(metadata).toMatchObject({ blockedCategory: 'provider-config', blockedReason: 'Execution speed is unsupported on this route.' });
    expect(agentErrors()).toEqual([]);
    expect(markerReleasedFor(APP)).toBe(true);
  });

  // An ordinary task's setup failure is transient — it must stay pending and
  // retry rather than being blocked out of the queue.
  it('leaves an ordinary task unblocked on a setup failure but still cleans up', async () => {
    vi.mocked(getConfig).mockRejectedValue(new Error('transient config read failure'));

    expect(await spawnAgentForTask({ id: 'task-ordinary-setup', metadata: { app: APP } })).toBeNull();

    expect(blockedWrites()).toEqual([]);
    expect(agentErrors()).toEqual([{ taskId: 'task-ordinary-setup', error: 'transient config read failure' }]);
    expect(markerReleasedFor(APP)).toBe(true);
  });

  // Pre-widening this was an uncaught throw the caller turned into
  // `job:spawn-failed`, which is how cos.js clears its job-level guard and
  // re-registers the cron schedule. Recovering here must still emit it.
  it('re-emits job:spawn-failed for an autonomous-job task', async () => {
    vi.mocked(getConfig).mockRejectedValue(new Error('setup blew up'));

    await spawnAgentForTask({ id: 'task-job', metadata: { app: APP, jobId: 'job-7' } });

    expect(vi.mocked(cosEvents.emit).mock.calls).toContainEqual(['job:spawn-failed', { jobId: 'job-7', reason: 'failed', error: 'setup blew up' }]);
  });
});

describe('agent maintenance reservation at handoff', () => {
  const agentReservations = () => maintenance.operations().filter(op => op.kind === 'agent');

  beforeEach(() => {
    reachPostPrepGates();
    vi.mocked(buildTuiSpawnConfig).mockReturnValue({ command: 'claude', args: [] });
  });

  afterEach(async () => {
    // A failing assertion must not leave this journal dirty for the next case.
    await Promise.all(agentReservations().map(op => maintenance.finishResource('agent', op.resource)));
  });

  it('transfers the reservation to the agent before launch and keeps it while the agent runs', async () => {
    const task = { id: 'task-maintenance-running', description: 'Example run', metadata: { app: APP } };
    vi.mocked(spawnTuiAgent).mockImplementationOnce(async ({ agentId }) => {
      expect(agentReservations()).toEqual([expect.objectContaining({ resource: agentId })]);
      return agentId;
    });

    const agentId = await spawnAgentForTask(task);

    expect(agentId).toEqual(expect.any(String));
    expect(agentId).not.toBe(task.id);
    expect(agentReservations()).toEqual([expect.objectContaining({ resource: agentId })]);
  });

  it('releases the reservation when a spawner returns no agent after handoff', async () => {
    vi.mocked(spawnTuiAgent).mockResolvedValueOnce(null);
    const task = { id: 'task-maintenance-no-agent', description: 'Example run', metadata: { app: APP } };

    await expect(spawnAgentForTask(task)).resolves.toBeNull();

    expect(spawnTuiAgent).toHaveBeenCalledOnce();
    expect(agentReservations()).toEqual([]);
  });

  it('leaves a post-handoff failure to the spawner without treating it as a setup refusal', async () => {
    const failure = new Error('post-launch failure');
    vi.mocked(spawnTuiAgent).mockRejectedValueOnce(failure);
    const task = { id: 'task-maintenance-post-launch', description: 'Example run', metadata: { app: APP } };

    await expect(spawnAgentForTask(task)).rejects.toBe(failure);

    const [{ agentId }] = vi.mocked(spawnTuiAgent).mock.calls[0];
    expect(agentReservations()).toEqual([expect.objectContaining({ resource: agentId })]);
    expect(blockedWrites()).toEqual([]);
    expect(agentErrors()).toEqual([]);
  });
});

describe('spawn admission', () => {
  it('holds a spawn during a self-update before reading or claiming the task', async () => {
    vi.mocked(isUpdateInProgress).mockReturnValueOnce(true);

    await expect(spawnAgentForTask({ id: 'task-self-update' })).resolves.toBeNull();

    expect(loadState).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(spawnTuiAgent).not.toHaveBeenCalled();
    expect(spawnAgentViaRunner).not.toHaveBeenCalled();
    expect(spawnDirectly).not.toHaveBeenCalled();
  });

  it('refuses another spawn for the same task while the first is awaiting preparation', async () => {
    const stateLoaded = Promise.withResolvers();
    const readingState = Promise.withResolvers();
    vi.mocked(loadState).mockImplementationOnce(() => {
      readingState.resolve();
      return stateLoaded.promise;
    });
    const task = { id: 'task-duplicate', metadata: { app: APP } };
    const firstSpawn = spawnAgentForTask(task);
    await readingState.promise;

    try {
      await expect(runSpawnAgentForTask({ ...task })).resolves.toBeNull();

      expect(loadState).toHaveBeenCalledOnce();
      expect(updateTask).not.toHaveBeenCalled();
      expect(prepareAgentWorkspace).not.toHaveBeenCalled();
    } finally {
      stateLoaded.resolve({ agents: [] });
      await firstSpawn;
    }
    expect(prepareAgentWorkspace).toHaveBeenCalledOnce();
  });

  it('propagates an early preparation failure without treating it as a setup refusal', async () => {
    const failure = new Error('agent state unavailable');
    vi.mocked(loadState).mockRejectedValueOnce(failure);
    const task = { id: 'task-early-prep', metadata: { app: APP } };

    await expect(spawnAgentForTask(task)).rejects.toBe(failure);

    expect(updateTask).not.toHaveBeenCalled();
    expect(agentErrors()).toEqual([]);
    expect(markerReleasedFor(APP)).toBe(false);
    expect(spawningTasks.has(task.id)).toBe(false);
  });
});

describe('host shutdown (#14170)', () => {
  // An owner registered after the shutdown marker snapshot is charged as a
  // genuine orphan on the next boot, so no spawn may reach registration.
  afterEach(() => resetHostShutdownFlagForTests());

  it('refuses before preparation reads or claims the task', async () => {
    markHostShuttingDown();
    expect(await runSpawnAgentForTask({ id: 'task-shutdown-early', metadata: { app: APP } })).toBeNull();
    expect(getTaskById).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('releases a preparation that straddled the signal without registering or marking it in_progress', async () => {
    reachPostPrepGates();
    vi.mocked(prepareAgentWorkspace).mockImplementation(async ({ onPrepared }) => {
      markHostShuttingDown();
      return onPrepared({ outcome: 'ready', workspacePath: join(TEMP_ROOT, 'workspace'), resolvedAppName: APP, worktreeInfo: null });
    });

    expect(await spawnAgentForTask({ id: 'task-shutdown-late', taskType: 'user', metadata: { app: APP } })).toBeNull();

    expect(registerAgent).not.toHaveBeenCalled();
    expect(createAgentRun).not.toHaveBeenCalled();
    expect(vi.mocked(updateTask).mock.calls.filter(([, patch]) => patch?.status)).toEqual([]);
    expect(agentErrors()).toEqual([]);
    expect(markerReleasedFor(APP)).toBe(true);
  });
});
