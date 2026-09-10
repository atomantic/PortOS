/**
 * Every spawn-eligibility gate in `runAgentSpawn`, driven through the real
 * `spawnAgentForTask` boundary.
 *
 * These gates all end the same way — persist `status: 'blocked'`, release the
 * spawn-local state, announce the outcome — and until now nothing verified any
 * of that. What pinned them was source-text grep in `agentLifecycle.test.js`
 * (`/if \(scanBlock\) \{[\s\S]*?status: 'blocked'/` and friends). A regex over
 * the file cannot tell whether a given copy still releases the execution lane,
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

import { afterAll, describe, it, expect, vi, beforeEach } from 'vitest';
import { rmSync } from 'fs';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

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

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: TEMP_ROOT });
});

vi.mock('./cosRunnerClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawnAgentViaRunner: vi.fn(),
  getRunnerHealth: vi.fn().mockResolvedValue({ available: true, uptime: 3600 }),
}));
vi.mock('./cosAgentLifecycle.js', () => ({
  registerAgent: vi.fn().mockResolvedValue(undefined),
  updateAgent: vi.fn().mockResolvedValue(undefined),
  completeAgent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./agentRunTracking.js', () => ({
  createAgentRun: vi.fn().mockResolvedValue(undefined),
  completeAgentRun: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./agentFinalization.js', () => ({
  dispatchRecoveredTaskOutputHook: vi.fn().mockResolvedValue(undefined),
  finalizeAgent: vi.fn().mockResolvedValue(undefined),
  releaseAgentLane: vi.fn(),
  stampLiExecutionVerdict: vi.fn(async (update) => update),
}));
vi.mock('./cosEvents.js', () => ({
  emitLog: vi.fn(),
  cosEvents: { emit: vi.fn(), on: vi.fn() },
}));
vi.mock('./cos.js', () => ({
  getConfig: vi.fn().mockResolvedValue({}),
  updateTask: vi.fn().mockResolvedValue(undefined),
  getTaskById: vi.fn().mockResolvedValue(null),
  getAgentRecord: vi.fn().mockResolvedValue(null),
}));
vi.mock('./forgeAuth.js', () => ({ resolveForgeTokenEnv: vi.fn().mockResolvedValue({}) }));
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
  prepareAgentWorkspace: vi.fn().mockResolvedValue({ outcome: 'blocked', reason: 'stop here' }),
}));
vi.mock('./agentWorktreeCleanup.js', () => ({
  cleanupAgentWorktree: vi.fn(),
  releaseRetryHold: vi.fn().mockResolvedValue({}),
}));
vi.mock('./worktreeManager.js', () => ({ removeWorktree: vi.fn().mockResolvedValue({ removed: true }) }));
vi.mock('./agentCompletionCleanup.js', () => ({ runAgentCompletionCleanup: vi.fn() }));
vi.mock('./agentSummaryExtraction.js', () => ({ extractFinalSummary: vi.fn() }));
vi.mock('./agentManagement.js', () => ({ handleOrphanedTask: vi.fn() }));
vi.mock('./agentRunEventLog.js', () => ({ appendRunEvent: vi.fn(async () => ({ appended: true })) }));
vi.mock('./agentPromptBuilder.js', () => ({
  buildAgentPrompt: vi.fn(),
  getAppWorkspace: vi.fn(),
  inlinePrLifecycleSection: vi.fn(() => null),
  isClaimFlowTask: vi.fn(() => false),
}));
vi.mock('./workspaceContext.js', () => ({ snapshotOnRepoSwitch: vi.fn().mockResolvedValue(null) }));
vi.mock('./agentErrorAnalysis.js', () => ({
  analyzeAgentFailure: vi.fn().mockReturnValue({ category: 'startup-failure', actionable: false }),
}));
vi.mock('./appActivity.js', () => ({ releaseAppReviewMarker: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./instanceIdentity.js', () => ({ ensureInstanceId: vi.fn().mockResolvedValue('instance-1') }));
vi.mock('./toolStateMachine.js', () => ({
  createToolExecution: vi.fn(() => ({ id: 'exec-1' })),
  startExecution: vi.fn(),
  completeExecution: vi.fn(),
  errorExecution: vi.fn(),
}));
vi.mock('./executionLanes.js', () => ({
  determineLane: vi.fn(() => 'standard'),
  acquire: vi.fn(() => ({ success: true })),
  release: vi.fn(),
}));
vi.mock('./updateChecker.js', () => ({ isUpdateInProgress: vi.fn().mockReturnValue(false) }));
vi.mock('./modelAbuseGuard.js', () => ({
  materializePublicReviewInput: vi.fn(),
  materializePublicReviewPatches: vi.fn(),
  readPublicReviewInputSnapshot: vi.fn(),
  validatePublicReviewModel: vi.fn().mockResolvedValue({ ok: true }),
}));

import { spawnAgentForTask } from './agentLifecycle.js';
import { prepareAgentWorkspace } from './agentWorkspacePrep.js';
import {
  materializePublicReviewInput,
  materializePublicReviewPatches,
  readPublicReviewInputSnapshot,
  validatePublicReviewModel,
} from './modelAbuseGuard.js';
import { resolveAgentProviderAndModel } from './agentProviderResolution.js';
import { buildAgentPrompt } from './agentPromptBuilder.js';
import { registerAgent } from './cosAgentLifecycle.js';
import { createAgentRun } from './agentRunTracking.js';
import { buildCliSpawnConfig, isTuiProvider } from './agentCliSpawning.js';
import { spawnAgentViaRunner } from './cosRunnerClient.js';
import { getConfig, updateTask } from './cos.js';
import { cosEvents, emitLog } from './cosEvents.js';
import { releaseAppReviewMarker } from './appActivity.js';
import { acquire, release } from './executionLanes.js';
import { spawningTasks, runnerAgents, setUseRunner } from './agentState.js';
import { MAX_TOTAL_SPAWNS } from '../lib/cosValidation.js';
import { PROVIDER_CONFIG_BLOCKED_CATEGORY } from '../lib/taskBlockCategories.js';
import {
  PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
  PUBLIC_REVIEW_GATE_EXECUTION_PROFILE,
} from '../lib/agentExecutionProfiles.js';

// The provider every install actually runs its CoS agents on — its vendor row
// declares recipes for both public-review postures.
const CLAUDE_TUI = { id: 'claude-code-tui', type: 'tui', command: 'claude', envVars: {} };
// A TUI record whose vendor declares no public-review recipe at all.
const OPENCODE_TUI = { id: 'opencode-tui', type: 'tui', command: 'opencode', envVars: {} };

// Every gate case carries `metadata.app`, because the marker release is only
// observable for a task that bound one (#989).
const APP = 'example-app';

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
  vi.mocked(prepareAgentWorkspace).mockResolvedValue({
    outcome: 'ready',
    workspacePath: join(TEMP_ROOT, 'workspace'),
    resolvedAppName: APP,
    worktreeInfo: null,
  });
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
  vi.mocked(acquire).mockReturnValue({ success: true });
  vi.mocked(spawnAgentViaRunner).mockResolvedValue({ pid: 4242 });
  vi.mocked(validatePublicReviewModel).mockResolvedValue({ ok: true });
  // Truthy: a falsy in_progress write is read as "the claim did not land".
  vi.mocked(updateTask).mockResolvedValue({ metadata: {} });
  vi.mocked(getConfig).mockResolvedValue({});
  vi.mocked(resolveAgentProviderAndModel).mockResolvedValue({
    ok: true, provider: CLAUDE_TUI, selectedModel: 'sonnet', modelSelection: {},
  });
  vi.mocked(prepareAgentWorkspace).mockResolvedValue({ outcome: 'blocked', reason: 'stop here' });
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
  });

  // The gate runs before an agent id is minted, so there is no lane and no
  // tool-execution to release. It must not invent one.
  it('releases no execution lane, because none was ever acquired', async () => {
    await spawnAgentForTask({
      id: 'task-max-spawns-no-lane',
      metadata: { app: APP, totalSpawnCount: MAX_TOTAL_SPAWNS + 1 },
    });

    expect(acquire).not.toHaveBeenCalled();
    expect(vi.mocked(release).mock.calls).toEqual([]);
  });

  it('spawns normally one dispatch below the cap', async () => {
    await spawnAgentForTask({
      id: 'task-under-cap',
      metadata: { app: APP, totalSpawnCount: MAX_TOTAL_SPAWNS - 1 },
    });

    expect(blockedWrites()).toEqual([]);
  });
});

describe('runAgentSpawn gates — execution-lane acquire failure', () => {
  // Not a block: the lane is a transient resource, so the task stays pending
  // and retries. But the marker MUST still be released, or the app reads "in
  // review" forever while the task waits.
  it('releases the app-review marker without blocking the task', async () => {
    vi.mocked(acquire).mockReturnValue({ success: false, error: 'lane is full' });

    expect(await spawnAgentForTask({ id: 'task-lane-full', metadata: { app: APP } })).toBeNull();

    expect(blockedWrites()).toEqual([]);
    expect(agentErrors()).toEqual([]);
    expect(markerReleasedFor(APP)).toBe(true);
    expect(vi.mocked(emitLog).mock.calls.some(
      ([level, message]) => level === 'warn' && message.includes('Failed to tag lane'),
    )).toBe(true);
    expect(registerAgent).not.toHaveBeenCalled();
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
    expect(release).toHaveBeenCalled();
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
  it('blocks an unsupported provider AND emits agent:error', async () => {
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
    expect(agentErrors()).toEqual([{ taskId: task.id, error: metadata.blockedReason }]);
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
    expect(agentErrors()).toEqual([{ taskId: task.id, error: metadata.blockedReason }]);
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

  // An ordinary task's setup failure is transient — it must stay pending and
  // retry rather than being blocked out of the queue.
  it('leaves an ordinary task unblocked on a setup failure but still cleans up', async () => {
    vi.mocked(getConfig).mockRejectedValue(new Error('transient config read failure'));

    expect(await spawnAgentForTask({ id: 'task-ordinary-setup', metadata: { app: APP } })).toBeNull();

    expect(blockedWrites()).toEqual([]);
    expect(agentErrors()).toEqual([{ taskId: 'task-ordinary-setup', error: 'transient config read failure' }]);
    expect(markerReleasedFor(APP)).toBe(true);
    expect(release).toHaveBeenCalled();
  });

  // Pre-widening this was an uncaught throw the caller turned into
  // `job:spawn-failed`, which is how cos.js clears its job-level guard and
  // re-registers the cron schedule. Recovering here must still emit it.
  it('re-emits job:spawn-failed for an autonomous-job task', async () => {
    vi.mocked(getConfig).mockRejectedValue(new Error('setup blew up'));

    await spawnAgentForTask({ id: 'task-job', metadata: { app: APP, jobId: 'job-7' } });

    expect(vi.mocked(cosEvents.emit).mock.calls).toContainEqual(['job:spawn-failed', { jobId: 'job-7' }]);
  });
});
