/**
 * `spawnViaRunner` — the runner-CLI arm of the spawn dispatch.
 *
 * The case under test is a spawn the runner REJECTS: no child process is ever
 * created, so no `agent:completed` / `agent:error` event will ever arrive to
 * finalize the record. Before this was handled the throw propagated to
 * subAgentSpawner's `task:ready` listener, which only logs — and because the
 * `runnerAgents` entry survived, `isAgentOwnedLocally` made the orphan sweep
 * skip the record too, so the 3s initialization timer flipped it to `working`
 * and it stayed there for the life of the process. (The TUI arm of the same
 * dispatch had the same hole with a shorter tail: the zombie reaper eventually
 * finalized it with a generic message that named no cause.)
 *
 * The follow-on hole (#3632): that recovery finalized the AGENT with a bare
 * `completeAgent` and never transitioned the TASK, so it sat `in_progress`
 * holding its federation claim until the 15-minute orphan sweep — which treats
 * it as an orphan, charging `orphanRetryCount` and arming a 30-minute cooldown
 * for a failure the task did not cause. It now runs the same
 * finalizeAgent → releaseRetryHold chain the TUI `finish()` does, which is
 * pinned at the same seam in agentTuiSpawning.test.js.
 *
 * Lives in its own file because agentLifecycle.test.js deliberately imports no
 * part of the orchestrator graph — it reads the source as a string. Driving the
 * real function needs the leaves mocked, which would change that file's whole
 * character.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Real module except for the two rpcs: the spawn-failure classifier under test
// stays the production one rather than a copy of itself (#4615).
vi.mock('./cosRunnerClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawnAgentViaRunner: vi.fn(),
  // Reported healthy and long-lived so waitForRunnerStability returns on its
  // first check — the failure under test is the spawn call, not the wait.
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
  isTuiProvider: vi.fn().mockReturnValue(false),
  getClaudeSettingsEnv: vi.fn().mockResolvedValue({}),
  spawnDirectly: vi.fn(),
}));

vi.mock('./agentTuiSpawning.js', () => ({
  buildTuiSpawnConfig: vi.fn(),
  spawnTuiAgent: vi.fn(),
}));

vi.mock('./agentProviderResolution.js', () => ({ resolveAgentProviderAndModel: vi.fn() }));
vi.mock('./agentWorkspacePrep.js', () => ({ prepareAgentWorkspace: vi.fn() }));
vi.mock('./agentWorktreeCleanup.js', () => ({
  cleanupAgentWorktree: vi.fn(),
  releaseRetryHold: vi.fn().mockResolvedValue({}),
}));
vi.mock('./agentCompletionCleanup.js', () => ({ runAgentCompletionCleanup: vi.fn() }));
vi.mock('./agentSummaryExtraction.js', () => ({ extractFinalSummary: vi.fn() }));
vi.mock('./agentManagement.js', () => ({ handleOrphanedTask: vi.fn() }));

// The lifecycle ledger is a real file writer (data/cos/run-events.jsonl) — mocked
// so handoff telemetry lands in a spy rather than the developing install's
// ledger, and so the boundary assertions below can read the envelope (#4540).
const { appendRunEvent } = vi.hoisted(() => ({ appendRunEvent: vi.fn(async () => ({ appended: true })) }));
vi.mock('./agentRunEventLog.js', () => ({ appendRunEvent }));
vi.mock('./agentPromptBuilder.js', () => ({ buildAgentPrompt: vi.fn(), getAppWorkspace: vi.fn() }));
// The real classification of a `spawn-rejected` reason (non-actionable, so the
// task is budgeted a retry rather than blocked) is pinned in
// agentErrorAnalysis.test.js; here we only need a stand-in object to follow.
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

import { spawnViaRunner } from './agentLifecycle.js';
import { spawnAgentViaRunner, RUNNER_SPAWN_REFUSED, RUNNER_SPAWN_AMBIGUOUS } from './cosRunnerClient.js';
import { completeAgent, updateAgent } from './cosAgentLifecycle.js';
import { completeAgentRun } from './agentRunTracking.js';
import { finalizeAgent, releaseAgentLane } from './agentFinalization.js';
import { releaseRetryHold } from './agentWorktreeCleanup.js';
import { analyzeAgentFailure } from './agentErrorAnalysis.js';
import { handleOrphanedTask } from './agentManagement.js';
import { runnerAgents } from './agentState.js';

const REJECTION = 'Command not allowed: grok. Permitted commands: claude, codex';

// The runner ANSWERED and declined. The shape mirrors what `spawnAgentViaRunner`
// stamps on a non-2xx (pinned in cosRunnerClient.test.js); a bare Error would
// classify as AMBIGUOUS, which is the whole point of the split (#4615).
const refusal = (message = REJECTION) =>
  Object.assign(new Error(message), { spawnOutcome: RUNNER_SPAWN_REFUSED, status: 400 });

function runnerOpts() {
  return {
    prompt: 'do the thing',
    workspacePath: '/tmp/ws',
    model: 'some-model',
    provider: { id: 'grok-cli', name: 'Grok Build CLI', command: 'grok', envVars: {} },
    runId: 'run-1',
    cliConfig: { command: 'grok', args: [] },
    executionId: 'exec-1',
    laneName: 'standard',
  };
}

describe('spawnViaRunner — the runner rejects the spawn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runnerAgents.clear();
  });

  it('resolves instead of throwing, so the caller is not left to log-and-forget', async () => {
    vi.mocked(spawnAgentViaRunner).mockRejectedValueOnce(refusal());
    await expect(spawnViaRunner('agent-1', { id: 'task-1' }, runnerOpts())).resolves.toBeNull();
  });

  it('finalizes through finalizeAgent with the runner\'s actual error, not a bare completeAgent', async () => {
    vi.mocked(spawnAgentViaRunner).mockRejectedValueOnce(refusal());

    await spawnViaRunner('agent-1', { id: 'task-1' }, runnerOpts());

    expect(finalizeAgent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1',
      runId: 'run-1',
      providerId: 'grok-cli',
      success: false,
      exitCode: 1,
      // Attributable: a rejected spawn is not an ordinary run failure, and the
      // agent never ran so it cannot owe a PR.
      completionReason: 'spawn-rejected',
      prExpected: false,
      error: expect.stringContaining('Command not allowed: grok'),
    }));
    // finalizeAgent owns the completeAgent + completeAgentRun writes (with the
    // #2344 null validation sentinel) — doing them here as well would double-write.
    expect(completeAgent).not.toHaveBeenCalled();
    expect(completeAgentRun).not.toHaveBeenCalled();
  });

  it('classifies the rejection under the spawn-rejected reason, carrying the runner message', async () => {
    vi.mocked(spawnAgentViaRunner).mockRejectedValueOnce(refusal());

    await spawnViaRunner('agent-1', { id: 'task-1' }, runnerOpts());

    expect(analyzeAgentFailure).toHaveBeenCalledWith('', expect.objectContaining({ id: 'task-1' }), 'some-model', {
      completionReason: 'spawn-rejected',
      completionError: REJECTION,
    });
  });

  it('releases the retry hold so the task returns to pending instead of waiting on the orphan sweep', async () => {
    const task = { id: 'task-1' };
    vi.mocked(spawnAgentViaRunner).mockRejectedValueOnce(refusal());

    await spawnViaRunner('agent-1', task, runnerOpts());

    // The seam the TUI path is pinned at (agentTuiSpawning.test.js). releaseRetryHold
    // flips the held retry to `pending` in one write, and leaving `in_progress`
    // is what strips the federation claim keys (cosTaskClaim.CLAIM_METADATA_KEYS).
    expect(releaseRetryHold).toHaveBeenCalledWith({ agentId: 'agent-1', task, success: false });
    // Ordering matters: finalizeAgent arms the hold, releaseRetryHold clears it.
    expect(vi.mocked(finalizeAgent).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(releaseRetryHold).mock.invocationCallOrder[0]);
    // The whole point: the orphan path — which charges `orphanRetryCount` and
    // arms a 30-minute cooldown — is never reached for a spawn the task didn't cause.
    expect(handleOrphanedTask).not.toHaveBeenCalled();
  });

  it('still finalizes when releaseRetryHold rejects — the orphan sweep is the fallback, not a crash', async () => {
    vi.mocked(spawnAgentViaRunner).mockRejectedValueOnce(refusal());
    vi.mocked(releaseRetryHold).mockRejectedValueOnce(new Error('task store unreadable'));

    await expect(spawnViaRunner('agent-1', { id: 'task-1' }, runnerOpts())).resolves.toBeNull();
    expect(finalizeAgent).toHaveBeenCalled();
  });

  it('drops the runnerAgents entry so the orphan sweep can see the record', async () => {
    vi.mocked(spawnAgentViaRunner).mockRejectedValueOnce(refusal());

    await spawnViaRunner('agent-1', { id: 'task-1' }, runnerOpts());

    // Left behind, isAgentOwnedLocally() reports the agent as live and every
    // sweep skips it — the record never gets reconciled at all.
    expect(runnerAgents.has('agent-1')).toBe(false);
  });

  it('releases the lane and tool execution', async () => {
    vi.mocked(spawnAgentViaRunner).mockRejectedValueOnce(refusal());

    await spawnViaRunner('agent-1', { id: 'task-1' }, runnerOpts());

    expect(releaseAgentLane).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1',
      success: false,
      executionId: 'exec-1',
      laneName: 'standard',
      errorExecutionMessage: expect.stringContaining('Command not allowed: grok'),
    }));
  });

  it('cancels the 3s initialization timer so the record cannot flip to "working"', async () => {
    vi.useFakeTimers();
    vi.mocked(spawnAgentViaRunner).mockRejectedValueOnce(refusal());

    await spawnViaRunner('agent-1', { id: 'task-1' }, runnerOpts());
    vi.mocked(updateAgent).mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();

    expect(vi.mocked(updateAgent).mock.calls.some(
      ([, patch]) => patch?.metadata?.phase === 'working'
    )).toBe(false);
  });

  it('still records the pid and returns the agent id on a successful spawn', async () => {
    vi.mocked(spawnAgentViaRunner).mockResolvedValueOnce({ pid: 4242 });

    await expect(spawnViaRunner('agent-1', { id: 'task-1' }, runnerOpts())).resolves.toBe('agent-1');

    expect(updateAgent).toHaveBeenCalledWith('agent-1', { pid: 4242 });
    expect(finalizeAgent).not.toHaveBeenCalled();
    expect(releaseRetryHold).not.toHaveBeenCalled();
    expect(runnerAgents.has('agent-1')).toBe(true);
  });
});

// ─── Ambiguous transport failures (#4615) ────────────────────────────────────

/**
 * A spawn rpc that never got an answer cannot say the run did not start. The
 * rpc reconciles against the runner's own /agents view first, so what reaches
 * `spawnViaRunner` is either a resolved (possibly ADOPTED) spawn or a failure
 * for which no child exists. Both endings are pinned here: the adopted one must
 * NOT be finalized — it is a live run — and the unadopted one must keep the
 * existing non-actionable `spawn-rejected` retry semantics.
 */
describe('spawnViaRunner — an ambiguous spawn failure', () => {
  const transportFailure = () =>
    Object.assign(new Error('fetch failed'), { spawnOutcome: RUNNER_SPAWN_AMBIGUOUS });

  beforeEach(() => {
    vi.clearAllMocks();
    runnerAgents.clear();
  });

  it('keeps an adopted spawn tracked instead of finalizing a live agent as rejected', async () => {
    vi.mocked(spawnAgentViaRunner).mockResolvedValueOnce({ pid: 4242, adopted: true, adoptedReason: 'fetch failed' });

    await expect(spawnViaRunner('agent-1', { id: 'task-1' }, runnerOpts())).resolves.toBe('agent-1');

    // Dropping the entry here is what strands the process: nothing local would
    // own its completion event and the orphan sweep skips it either way.
    expect(runnerAgents.has('agent-1')).toBe(true);
    expect(updateAgent).toHaveBeenCalledWith('agent-1', { pid: 4242 });
    expect(finalizeAgent).not.toHaveBeenCalled();
    expect(releaseRetryHold).not.toHaveBeenCalled();
    expect(releaseAgentLane).not.toHaveBeenCalled();
  });

  it('still finalizes as spawn-rejected when the runner does not have the agent', async () => {
    vi.mocked(spawnAgentViaRunner).mockRejectedValueOnce(transportFailure());

    await expect(spawnViaRunner('agent-1', { id: 'task-1' }, runnerOpts())).resolves.toBeNull();

    // Unchanged from a refusal: `spawn-rejected` is non-actionable, so the task
    // is budgeted a retry rather than blocked for a human.
    expect(finalizeAgent).toHaveBeenCalledWith(expect.objectContaining({
      completionReason: 'spawn-rejected',
      error: 'fetch failed',
    }));
    expect(runnerAgents.has('agent-1')).toBe(false);
  });
});

// ─── Lifecycle ledger — the handoff boundary (#4540) ─────────────────────────

describe('spawnViaRunner — records who owns the process', () => {
  const handoffs = () => appendRunEvent.mock.calls.map(([e]) => e).filter((e) => e.kind === 'run.handoff');

  beforeEach(() => {
    vi.clearAllMocks();
    runnerAgents.clear();
  });

  it('records the handoff only AFTER the runner accepted the spawn', async () => {
    // `runnerAgents` — the map that says which process owns this run — is
    // in-memory and gone on the next restart. This is the only durable record
    // that the answer was ever "the CoS Runner".
    vi.mocked(spawnAgentViaRunner).mockResolvedValueOnce({ pid: 4242 });

    await spawnViaRunner('agent-1', { id: 'task-1' }, runnerOpts());

    expect(handoffs()).toEqual([expect.objectContaining({
      runId: 'run-1',
      agentId: 'agent-1',
      taskId: 'task-1',
      data: expect.objectContaining({ to: 'cos-runner', accepted: true, pid: 4242, providerId: 'grok-cli' })
    })]);
  });

  it('records a REFUSED handoff as its own boundary', async () => {
    // "The runner would not take it" and "it ran and failed" collapse into the
    // same terminal record; only the ledger can still tell them apart.
    vi.mocked(spawnAgentViaRunner).mockRejectedValueOnce(refusal());

    await spawnViaRunner('agent-1', { id: 'task-1' }, runnerOpts());

    expect(handoffs()).toEqual([expect.objectContaining({
      eventId: 'handoff:agent-1:run-1:rejected',
      data: expect.objectContaining({ to: 'none', accepted: false, outcome: RUNNER_SPAWN_REFUSED, reason: REJECTION })
    })]);
  });

it('records an AMBIGUOUS handoff as unaccepted-but-unknown, never as a refusal', async () => {
    // The runner never answered, and the spawn rpc's own reconcile found no
    // agent. "Never started" and "refused" are different claims, and only one
    // of them the server can actually have observed (#4615).
    vi.mocked(spawnAgentViaRunner).mockRejectedValueOnce(
      Object.assign(new Error('fetch failed'), { spawnOutcome: RUNNER_SPAWN_AMBIGUOUS })
    );

    await spawnViaRunner('agent-1', { id: 'task-1' }, runnerOpts());

    expect(handoffs()).toEqual([expect.objectContaining({
      eventId: 'handoff:agent-1:run-1:unconfirmed',
      data: expect.objectContaining({
        to: 'none',
        accepted: null,
        outcome: RUNNER_SPAWN_AMBIGUOUS,
        reason: 'fetch failed',
      }),
    })]);
  });

  it('records an ADOPTED handoff as accepted, naming the lost acknowledgement', async () => {
    vi.mocked(spawnAgentViaRunner).mockResolvedValueOnce({
      pid: 4242,
      adopted: true,
      adoptedReason: 'fetch failed',
    });

    await spawnViaRunner('agent-1', { id: 'task-1' }, runnerOpts());

    expect(handoffs()).toEqual([expect.objectContaining({
      eventId: 'handoff:agent-1:run-1:cos-runner',
      data: expect.objectContaining({
        to: 'cos-runner',
        accepted: true,
        adopted: true,
        outcome: RUNNER_SPAWN_AMBIGUOUS,
        pid: 4242,
        reason: 'fetch failed',
      }),
    })]);
  });

  it('keys the handoff on the run, so a retried spawn cannot double-count it', async () => {
    vi.mocked(spawnAgentViaRunner).mockResolvedValue({ pid: 4242 });

    await spawnViaRunner('agent-1', { id: 'task-1' }, runnerOpts());
    await spawnViaRunner('agent-1', { id: 'task-1' }, runnerOpts());

    const ids = handoffs().map((e) => e.eventId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
  });
});
