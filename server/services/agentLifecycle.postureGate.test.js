/**
 * The spawn-time public-review posture gate, driven through `spawnAgentForTask`.
 *
 * Deliberately a BEHAVIORAL test, not a source scrape. #5830 collapsed the two
 * per-stage gates into one posture check and dropped the `publicReview &&`
 * condition guarding them (fixed in #5866). An
 * ordinary task's execution profile maps to a `null` posture, and
 * `supportsPublicReviewPosture(provider, null)` is false for EVERY provider —
 * so the gate fired on every spawn and blocked every CoS agent on the install
 * with "has no enforced null public-content review mode".
 *
 * Neither the guard that existed at the time nor the one #5866 added can see
 * that: agentLifecycle.test.js reads the orchestrator as a STRING, so it pins
 * only that the call site NAMES `publicReviewProviderBlock`. A dropped
 * condition is invisible to a grep — and so is a bare
 * `supportsPublicReviewPosture` block reintroduced next to it tomorrow, which
 * would blank every install again with CI green. So the observing surface here
 * is the spawn itself. The ordinary-task cases below fail against the broken
 * revision and pass against the fix; the last one pins that the gate still
 * fails closed for a stage that actually requested a posture, so the suite
 * cannot be satisfied by simply deleting the gate.
 *
 * Mirrors the mock set in agentLifecycle.spawnViaRunner.test.js — the leaves are
 * stubbed so the real orchestrator runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
vi.mock('./git.js', () => ({ resolveForgeTokenEnv: vi.fn().mockResolvedValue({}) }));
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
// Stops the spawn immediately AFTER the posture gate — the gate is what this
// file observes, and letting the real workspace prep run would touch git.
vi.mock('./agentWorkspacePrep.js', () => ({
  prepareAgentWorkspace: vi.fn().mockResolvedValue({ outcome: 'blocked', reason: 'stop here' }),
}));
vi.mock('./agentWorktreeCleanup.js', () => ({
  cleanupAgentWorktree: vi.fn(),
  releaseRetryHold: vi.fn().mockResolvedValue({}),
}));
vi.mock('./agentCompletionCleanup.js', () => ({ runAgentCompletionCleanup: vi.fn() }));
vi.mock('./agentSummaryExtraction.js', () => ({ extractFinalSummary: vi.fn() }));
vi.mock('./agentManagement.js', () => ({ handleOrphanedTask: vi.fn() }));
vi.mock('./agentRunEventLog.js', () => ({ appendRunEvent: vi.fn(async () => ({ appended: true })) }));
vi.mock('./agentPromptBuilder.js', () => ({ buildAgentPrompt: vi.fn(), getAppWorkspace: vi.fn() }));
vi.mock('./agentErrorAnalysis.js', () => ({
  analyzeAgentFailure: vi.fn().mockReturnValue({ category: 'startup-failure', actionable: false }),
}));
vi.mock('./appActivity.js', () => ({ releaseAppReviewMarker: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./instances.js', () => ({ ensureInstanceId: vi.fn().mockResolvedValue('instance-1') }));
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
import { resolveAgentProviderAndModel } from './agentProviderResolution.js';
import { updateTask } from './cos.js';
import { spawningTasks, runnerAgents } from './agentState.js';

// The provider every install actually runs its CoS agents on, and the one named
// in the #5866 outage: a TUI session has no maintained public-review recipe, so
// it is exactly the provider the broken gate rejected for ordinary work.
const CLAUDE_TUI = { id: 'claude-code-tui', type: 'tui', command: 'claude', envVars: {} };

/** Every `updateTask` call that wrote a public-review posture block. */
const postureBlockWrites = () => vi.mocked(updateTask).mock.calls.filter(
  ([, update]) => typeof update?.metadata?.blockedReason === 'string'
    && update.metadata.blockedReason.includes('public-content review mode'),
);

beforeEach(() => {
  vi.clearAllMocks();
  spawningTasks.clear();
  runnerAgents.clear();
  vi.mocked(resolveAgentProviderAndModel).mockResolvedValue({
    ok: true, provider: CLAUDE_TUI, selectedModel: 'sonnet', modelSelection: {},
  });
});

describe('public-review posture gate — spawn behavior (#5866)', () => {
  // THE regression. An ordinary task declares no execution profile, so it
  // requests no posture and the gate must not fire. When it did, every CoS
  // agent — user tasks and scheduled tasks alike — was blocked on arrival.
  it('does not block an ordinary task, which requests no posture', async () => {
    await spawnAgentForTask({ id: 'task-ordinary', metadata: {} });

    expect(postureBlockWrites()).toEqual([]);
  });

  it('does not block an ordinary task that carries unrelated metadata', async () => {
    await spawnAgentForTask({ id: 'task-plain', taskType: 'user', metadata: { app: 'portos-default' } });

    expect(postureBlockWrites()).toEqual([]);
  });

  // The other half of the contract: a stage that DID request a posture still
  // fails closed on a provider with no maintained recipe. A fix for the above
  // that simply deleted the gate would pass every test but this one.
  it('still blocks a public-review stage whose provider has no enforced posture', async () => {
    await spawnAgentForTask({
      id: 'task-public-review',
      metadata: {
        executionProfile: 'public-review-gate',
        // The scan gate runs first and would block on its own; clear it so the
        // posture gate is what this case actually reaches.
        pipeline: { securityScan: { completed: true, status: 'passed', safePrCount: 1 } },
      },
    });

    const [call] = postureBlockWrites();
    expect(call).toBeDefined();
    const [, update] = call;
    expect(update.status).toBe('blocked');
    expect(update.metadata.blockedReason).toContain("Provider 'claude-code-tui'");
    expect(update.metadata.blockedReason).toContain('no-tool');
    expect(update.metadata.blockedCategory).toBe('public-review-provider-unsupported');
  });
});
