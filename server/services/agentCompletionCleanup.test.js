/**
 * Tests for agentCompletionCleanup.handlePipelineProgression — the
 * pipeline-stage advancement extracted out of handleAgentCompletion.
 *
 * Pins the four branches: not-running (no-op), stage failure (mark failed),
 * last stage (mark completed), and advance (enqueue the next stage task).
 * These were previously exercised only indirectly via the agentLifecycle
 * completion path; the extraction gives them a direct home.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn() }));
vi.mock('./cosAgentLifecycle.js', () => ({ updateAgent: vi.fn() }));
vi.mock('./cos.js', () => ({
  updateTask: vi.fn().mockResolvedValue({}),
  addTask: vi.fn().mockResolvedValue({}),
  reviveBlockedTask: vi.fn().mockResolvedValue({}),
  checkStagePrecondition: vi.fn().mockReturnValue({ passed: true }),
  getAgent: vi.fn().mockResolvedValue(null),
}));
vi.mock('./jira.js', () => ({ getInstances: vi.fn(), addComment: vi.fn() }));
vi.mock('./git.js', () => ({ push: vi.fn(), getRepoBranches: vi.fn(), generatePRDescription: vi.fn(), suggestPRTitle: vi.fn(), createPR: vi.fn(), checkout: vi.fn() }));
vi.mock('./codeReview.js', () => ({ resolveReviewLoopOptions: vi.fn().mockResolvedValue({}) }));
vi.mock('./agentWorktreeCleanup.js', () => ({
  cleanupAgentWorktree: vi.fn().mockResolvedValue([]),
  spawnMergeRecoveryTask: vi.fn(),
  releaseRetryHold: vi.fn().mockResolvedValue({}),
}));
vi.mock('./taskPromptService.js', () => ({ getStagePrompt: vi.fn().mockResolvedValue('do stage work in {appName}') }));

import { handlePipelineProgression, runAgentCompletionCleanup, runSpawnerCompletionCleanup } from './agentCompletionCleanup.js';
import { updateTask, addTask, reviveBlockedTask, getAgent } from './cos.js';
import { cleanupAgentWorktree, releaseRetryHold } from './agentWorktreeCleanup.js';
import { resolveReviewLoopOptions } from './codeReview.js';
import { promptOpensOwnPr } from './promptSections/completion.js';

const runningPipeline = (overrides = {}) => ({
  id: 'p1',
  status: 'running',
  currentStage: 0,
  stages: [{ name: 'stage-0' }, { name: 'stage-1' }],
  stageResults: [],
  ...overrides,
});

beforeEach(() => { vi.clearAllMocks(); });

describe('handlePipelineProgression', () => {
  it('is a no-op when the pipeline is not running', async () => {
    const task = { id: 't', taskType: 'user', metadata: { pipeline: runningPipeline({ status: 'completed' }) } };
    await handlePipelineProgression(task, 'agent-1', true);
    expect(updateTask).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('marks the pipeline failed on a failed stage and does not advance', async () => {
    const task = { id: 't', taskType: 'user', metadata: { pipeline: runningPipeline() } };
    await handlePipelineProgression(task, 'agent-1', false);
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask.mock.calls[0][1].metadata.pipeline.status).toBe('failed');
    expect(addTask).not.toHaveBeenCalled();
  });

  it('marks the pipeline completed after the last stage', async () => {
    const task = { id: 't', taskType: 'user', metadata: { pipeline: runningPipeline({ currentStage: 1 }) } };
    await handlePipelineProgression(task, 'agent-1', true);
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask.mock.calls[0][1].metadata.pipeline.status).toBe('completed');
    expect(addTask).not.toHaveBeenCalled();
  });

  it('enqueues the next stage task when advancing', async () => {
    const task = { id: 't', taskType: 'user', metadata: { pipeline: runningPipeline() } };
    await handlePipelineProgression(task, 'agent-1', true);
    expect(addTask).toHaveBeenCalledTimes(1);
    const [nextTask, group] = addTask.mock.calls[0];
    expect(group).toBe('internal');
    expect(nextTask.metadata.pipeline.currentStage).toBe(1);
    expect(nextTask.metadata.pipeline.status).toBe('running');
    expect(nextTask.metadata.pipeline.previousStageAgentId).toBe('agent-1');
  });

  it('propagates the next stage provider/model/effort pins into the enqueued task', async () => {
    const stages = [{ name: 'stage-0' }, { name: 'stage-1', providerId: 'codex', model: 'gpt-5', effort: 'xhigh' }];
    const task = { id: 't', taskType: 'user', metadata: { pipeline: runningPipeline({ stages }) } };
    await handlePipelineProgression(task, 'agent-1', true);
    const [nextTask] = addTask.mock.calls[0];
    expect(nextTask.metadata.provider).toBe('codex');
    expect(nextTask.metadata.providerId).toBe('codex');
    expect(nextTask.metadata.model).toBe('gpt-5');
    expect(nextTask.metadata.effort).toBe('xhigh');
  });

  it('does not carry the previous stage prompt into the next stage task', async () => {
    // addTask promotes a multi-line description to metadata.prompt only when
    // none is set, so an inherited prompt made stage 1+ run on stage 0's text.
    const task = { id: 't', taskType: 'user', metadata: { prompt: 'stage-0 instructions\nmore', context: 'note', pipeline: runningPipeline() } };
    await handlePipelineProgression(task, 'agent-1', true);
    const [nextTask] = addTask.mock.calls[0];
    expect(nextTask.metadata).not.toHaveProperty('prompt');
    expect(nextTask.metadata.context).toBe('note');
    expect(nextTask.description).toBe('do stage work in {appName}');
  });

  it('leaves effort unset when the next stage has no effort pin', async () => {
    const task = { id: 't', taskType: 'user', metadata: { pipeline: runningPipeline() } };
    await handlePipelineProgression(task, 'agent-1', true);
    const [nextTask] = addTask.mock.calls[0];
    expect(nextTask.metadata.effort).toBeUndefined();
  });

  it('inherits a task-level effort into a stage that has no effort pin of its own', async () => {
    // Effort is SET-only on hand-off: a task-level effort (from the interval
    // config) must reach stage 1+ via the metadata carry-forward, not be wiped.
    const task = { id: 't', taskType: 'user', metadata: { effort: 'high', pipeline: runningPipeline() } };
    await handlePipelineProgression(task, 'agent-1', true);
    const [nextTask] = addTask.mock.calls[0];
    expect(nextTask.metadata.effort).toBe('high');
  });

  it('revives a blocked duplicate stage task instead of silently dropping the advance (#2614)', async () => {
    // Stage prompts interpolate only app fields, so two runs of the same
    // pipeline collide on the dedup scan — which now also matches blocked
    // tasks. A stale blocked stage task from an earlier run must be revived
    // with the fresh pipeline state, not swallow the advance.
    addTask.mockResolvedValue({ id: 'sys-stale-stage', status: 'blocked', duplicate: true });
    const task = { id: 't', taskType: 'user', metadata: { pipeline: runningPipeline() } };
    await handlePipelineProgression(task, 'agent-1', true);
    expect(reviveBlockedTask).toHaveBeenCalledTimes(1);
    const [taskId, updates, group] = reviveBlockedTask.mock.calls[0];
    expect(taskId).toBe('sys-stale-stage');
    expect(updates.metadata.pipeline.currentStage).toBe(1);
    expect(updates.metadata.pipeline.previousStageAgentId).toBe('agent-1');
    expect(group).toBe('internal');
  });

  it('skips the advance without reviving when the duplicate stage task is still active (#2614)', async () => {
    addTask.mockResolvedValue({ id: 'sys-live-stage', status: 'pending', duplicate: true });
    const task = { id: 't', taskType: 'user', metadata: { pipeline: runningPipeline() } };
    await handlePipelineProgression(task, 'agent-1', true);
    expect(reviveBlockedTask).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });
});

// #3114 — `agentOwnsPR` decides whether PortOS skips its own push+PR because the
// agent was told to run `/do:pr` itself. It MUST derive from the same
// `canTypeSlashCommands` predicate the prompt's completion-mode gate used: when the
// two disagree, PortOS fires `gh pr create` on a branch that already has a PR
// ("a pull request already exists" preserves the worktree as a false-positive
// failure), or conversely never opens the PR the agent was told not to open.
// The execution profile selects the provider POSTURE and the stripped child
// environment. Inheriting the previous stage's value (or silently clearing it)
// would run a stage holding untrusted public content under the wrong contract.
describe('handlePipelineProgression — execution profile hand-off', () => {
  const publicReviewPipeline = (stages) => runningPipeline({ currentStage: 0, stages });

  it('sets the next stage\'s own profile rather than inheriting the previous one', async () => {
    const task = {
      id: 't',
      taskType: 'user',
      metadata: {
        executionProfile: 'public-review-gate',
        pipeline: publicReviewPipeline([
          { name: 'Eligibility Gate', executionProfile: 'public-review-gate' },
          { name: 'Code Review & Actions', executionProfile: 'public-review-actions' },
        ]),
      },
    };
    await handlePipelineProgression(task, 'agent-1', true);
    expect(addTask.mock.calls[0][0].metadata.executionProfile).toBe('public-review-actions');
  });

  it('fails the pipeline closed rather than advancing a restricted run into an unprofiled stage', async () => {
    const task = {
      id: 't',
      taskType: 'user',
      metadata: {
        executionProfile: 'public-review-gate',
        pipeline: publicReviewPipeline([
          { name: 'Eligibility Gate', executionProfile: 'public-review-gate' },
          { name: 'Unprofiled' },
        ]),
      },
    };
    await handlePipelineProgression(task, 'agent-1', true);
    expect(addTask).not.toHaveBeenCalled();
    expect(updateTask.mock.calls[0][1].metadata.pipeline.status).toBe('failed');
  });

  it('leaves an ordinary pipeline unprofiled', async () => {
    const task = { id: 't', taskType: 'user', metadata: { pipeline: runningPipeline() } };
    await handlePipelineProgression(task, 'agent-1', true);
    expect(addTask.mock.calls[0][0].metadata.executionProfile).toBeNull();
  });

  // The gate is pinned to a tool-free local model; the sandboxed review stage
  // must not inherit it. An unpinned public-review stage resolves to the first
  // eligible provider for ITS posture, so the previous stage's pins are dropped.
  it('does not carry the previous stage\'s provider/model/effort into an unpinned public-review stage', async () => {
    const task = {
      id: 't',
      taskType: 'user',
      metadata: {
        executionProfile: 'public-review-gate',
        provider: 'claude-ollama',
        providerId: 'claude-ollama',
        model: 'gemma3:27b',
        effort: 'medium',
        pipeline: publicReviewPipeline([
          { name: 'Eligibility Gate', executionProfile: 'public-review-gate', providerId: 'claude-ollama', model: 'gemma3:27b', effort: 'medium' },
          { name: 'Code Review & Actions', executionProfile: 'public-review-actions' },
        ]),
      },
    };
    await handlePipelineProgression(task, 'agent-1', true);
    const next = addTask.mock.calls[0][0].metadata;
    expect(next.executionProfile).toBe('public-review-actions');
    expect(next).not.toHaveProperty('provider');
    expect(next).not.toHaveProperty('providerId');
    expect(next).not.toHaveProperty('model');
    expect(next).not.toHaveProperty('effort');
  });

  it('applies a public-review stage\'s own pins', async () => {
    const task = {
      id: 't',
      taskType: 'user',
      metadata: {
        executionProfile: 'public-review-gate',
        provider: 'claude-ollama',
        model: 'gemma3:27b',
        pipeline: publicReviewPipeline([
          { name: 'Eligibility Gate', executionProfile: 'public-review-gate' },
          { name: 'Code Review & Actions', executionProfile: 'public-review-actions', providerId: 'codex-tui', model: 'gpt-5.6', effort: 'high' },
        ]),
      },
    };
    await handlePipelineProgression(task, 'agent-1', true);
    expect(addTask.mock.calls[0][0].metadata).toMatchObject({ provider: 'codex-tui', providerId: 'codex-tui', model: 'gpt-5.6', effort: 'high' });
  });
});

describe('runAgentCompletionCleanup — agentOpensOwnPr mirrors the prompt gate', () => {
  const prTask = { id: 't', taskType: 'user', metadata: { openPR: true } };
  const worktreeInfo = { branchName: 'agent/t', worktreePath: '/tmp/wt', baseBranch: 'main' };

  // The stamp is DERIVED through the real predicate the spawn path writes with,
  // never hand-written: a literal here is how the suite came to pin
  // `ownsPrWorkflow: true` for a Claude host, a value the spawn path has never
  // produced for one (#6869). `providerType` mirrors the descriptor the
  // registration record carries.
  const stampFor = ({ providerType = 'tui', providerId, providerCommand, leanMode = false, task = prTask, worktree = worktreeInfo }) =>
    promptOpensOwnPr(task, {
      providerType, providerId, providerCommand, leanMode,
      worktreeInfo: worktree,
      isTruthyMetaFn: (v) => v === true || v === 'true',
    });

  // `prClaimVerified` is the caller's answer to "did finalize's PR-claim check
  // actually produce a forge verdict for this run?" — threaded in, never
  // re-derived here (see the note at its use site).
  const cleanupCallFor = async (agent, { prClaimVerified = false, noChangesToShip = false, task = prTask } = {}) => {
    await runAgentCompletionCleanup({
      agentId: 'a1', task, agent, effectiveSuccess: true, outputBuffer: '', prClaimVerified, noChangesToShip,
    });
    // cleanupAgentWorktree(agentId, success, options) — options is the 3rd arg.
    return cleanupAgentWorktree.mock.calls.at(-1)[2];
  };

  // The #6869 regression: the old stamp answered "did the prompt render the
  // INLINE `git`/`gh` PR section", which is false for exactly the hosts that
  // run `/do:pr`. Cleanup then re-pushed the branch and called `git.createPR`
  // for a PR the agent had already opened and often already merged.
  it.each([
    ['tui', 'claude-code', 'claude'],
    ['cli', 'claude-code', 'claude'],
    // The case an id allowlist missed: a path-configured claude under a custom
    // id IS handed `/do:pr`, so PortOS must not open a second PR.
    ['cli', 'my-custom-agent', '/opt/homebrew/bin/claude'],
  ])('a slashdo-capable claude %s opens its own PR — PortOS must not re-create it', async (providerType, providerId, providerCommand) => {
    const prOpenedBy = stampFor({ providerType, providerId, providerCommand });
    expect(prOpenedBy).toBe('agent-slashdo');

    // Finalize verified the claim: nothing left for cleanup to ask or create.
    expect(await cleanupCallFor(
      { providerId, providerCommand, leanMode: false, prOpenedBy }, { prClaimVerified: true },
    )).toMatchObject({ prCreation: 'never', skipMerge: true });

    // Finalize did NOT verify (its check threw, or the run was user-terminated):
    // cleanup asks the forge once and only creates on a definite "none".
    expect(await cleanupCallFor(
      { providerId, providerCommand, leanMode: false, prOpenedBy }, { prClaimVerified: false },
    )).toMatchObject({ prCreation: 'if-missing', skipMerge: true });
  });

  // #3733: a codex/grok/agy harness can't type `/do:pr` but is told to run
  // `gh pr create` itself, so it is backstopped rather than double-fired.
  it('a codex harness that owns its inline PR workflow is backstopped, not double-fired', async () => {
    const prOpenedBy = stampFor({ providerType: 'tui', providerId: 'codex', providerCommand: 'codex' });
    expect(prOpenedBy).toBe('agent-inline');
    // Finalize skipped `verifyPrClaim` for it (`prExpected` keys on the
    // slash-command predicate), so cleanup asks the forge once itself.
    const opts = await cleanupCallFor({ providerId: 'codex', providerCommand: 'codex', leanMode: false, prOpenedBy });
    expect(opts.prCreation).toBe('if-missing');
    expect(opts.skipMerge).toBe(true);
  });

  it('a lean --bare claude session does NOT own its PR (it fumbles multi-step flows)', async () => {
    const prOpenedBy = stampFor({ providerType: 'tui', providerId: 'claude-ollama', providerCommand: 'claude', leanMode: true });
    expect(prOpenedBy).toBe('portos');
    const opts = await cleanupCallFor({
      providerId: 'claude-ollama', providerCommand: 'claude', leanMode: true, prOpenedBy,
    });
    expect(opts.prCreation).toBe('always');
    expect(opts.skipMerge).toBe(false);
  });

  // The task shapes whose prompt hands the PR back to PortOS keep today's
  // answer even on a slashdo-capable host — the stamp is task-shape-aware, not
  // provider-only (see agentRegistrationRecord.js).
  it.each([
    ['read-only', { openPR: true, readOnly: true }, worktreeInfo],
    ['discard-worktree', { openPR: true, discardWorktree: true }, worktreeInfo],
    ['no-code-output', { openPR: true, noCodeOutput: true }, worktreeInfo],
    ['JIRA hand-off (no worktree)', { openPR: true, jiraTicketId: 'ABC-1' }, null],
  ])('a %s claude run stays PortOS-owned', async (_label, metadata, worktree) => {
    const task = { id: 't', taskType: 'user', metadata };
    const prOpenedBy = stampFor({ providerId: 'claude-code', providerCommand: 'claude', task, worktree });
    expect(prOpenedBy).toBe('portos');
    const opts = await cleanupCallFor(
      { providerId: 'claude-code', providerCommand: 'claude', leanMode: false, prOpenedBy },
      { task },
    );
    expect(opts.prCreation).toBe('always');
    expect(opts.skipMerge).toBe(false);
  });

  it('does not create an empty PR after finalize proves a no-change audit', async () => {
    const prOpenedBy = stampFor({ providerId: 'claude-ollama', providerCommand: 'claude', leanMode: true });
    const opts = await cleanupCallFor(
      { providerId: 'claude-ollama', providerCommand: 'claude', leanMode: true, prOpenedBy },
      { noChangesToShip: true },
    );
    expect(opts.prCreation).toBe('never');
  });

  it('a task that asked for no PR never creates one', async () => {
    await runAgentCompletionCleanup({
      agentId: 'a1', task: { id: 't', taskType: 'user', metadata: {} },
      agent: { providerId: 'codex', providerCommand: 'codex', prOpenedBy: 'agent-inline' },
      effectiveSuccess: true, outputBuffer: '',
    });
    expect(cleanupAgentWorktree.mock.calls.at(-1)[2].prCreation).toBe('never');
  });
});

// Other installs upgrade on their own schedule, so records written before the
// `prOpenedBy` stamp keep arriving here forever. They carry either the #3733
// boolean `ownsPrWorkflow` (which answered "did the prompt render the INLINE PR
// section") or nothing at all (pre-#3733).
describe('runAgentCompletionCleanup — legacy records with no prOpenedBy stamp', () => {
  const prTask = { id: 't', taskType: 'user', metadata: { openPR: true } };
  const cleanupCallFor = async (agent, { prClaimVerified = false } = {}) => {
    await runAgentCompletionCleanup({
      agentId: 'a1', task: prTask, agent, effectiveSuccess: true, outputBuffer: '', prClaimVerified,
    });
    return cleanupAgentWorktree.mock.calls.at(-1)[2];
  };

  it('a slashdo-free harness stamped `ownsPrWorkflow: true` still owns its PR', async () => {
    const opts = await cleanupCallFor({ providerId: 'codex', providerCommand: 'codex', leanMode: false, ownsPrWorkflow: true });
    expect(opts.prCreation).toBe('if-missing');
    expect(opts.skipMerge).toBe(true);
  });

  it('a lean session stamped `ownsPrWorkflow: false` still hands the PR back', async () => {
    const opts = await cleanupCallFor({ providerId: 'claude-ollama', providerCommand: 'claude', leanMode: true, ownsPrWorkflow: false });
    expect(opts.prCreation).toBe('always');
    expect(opts.skipMerge).toBe(false);
  });

  // The one legacy shape whose ANSWER changes, because it is the defect: a
  // slashdo-capable record stamped `false` really did run `/do:pr`, and cleanup
  // re-created its PR. Reading it as `agent-slashdo` applies the #6869 fix to
  // records written by an older version too.
  it('a slashdo-capable record stamped `ownsPrWorkflow: false` is read as a /do:pr run', async () => {
    expect(await cleanupCallFor(
      { providerId: 'claude-code', providerCommand: 'claude', leanMode: false, ownsPrWorkflow: false },
      { prClaimVerified: true },
    )).toMatchObject({ prCreation: 'never', skipMerge: true });
  });

  it.each([
    ['claude-code', 'claude', true],
    ['claude-code-bedrock', 'claude', true],
    // The case an id allowlist missed: a path-configured claude under a custom id
    // IS told to run /do:pr, so PortOS must not open a second PR.
    ['my-custom-agent', '/opt/homebrew/bin/claude', true],
    // Prompted by the OLD builder, which told these to commit and stop.
    ['codex', 'codex', false],
    ['antigravity-cli', 'agy', false],
  ])('a pre-#3733 %s record falls back to the slash-command derivation it was prompted with', async (providerId, providerCommand, owns) => {
    // No ownership key at all: written before #3733, so the run really was
    // prompted by the old builder and the old gate is the correct answer.
    const opts = await cleanupCallFor({ providerId, providerCommand, leanMode: false }, { prClaimVerified: owns });
    expect(opts.prCreation).toBe(owns ? 'never' : 'always');
    expect(opts.skipMerge).toBe(owns);
  });

  it('a pre-upgrade agent record with only providerId still resolves', async () => {
    // Records written before providerCommand/leanMode were persisted: a blank
    // command reads as `claude`, which is what the old id allowlist effectively
    // assumed for the claude-code ids anyway.
    expect((await cleanupCallFor({ providerId: 'claude-code' }, { prClaimVerified: true })).prCreation).toBe('never');
    expect((await cleanupCallFor({ providerId: 'codex-tui' })).prCreation).toBe('always');
  });
});

// Runner mode shares the resume-pointer gate with the direct-CLI and TUI spawn
// paths (#3368) — it must call the helper, not keep its own inline copy.
describe('runAgentCompletionCleanup — resume pointer', () => {
  const task = { id: 't', taskType: 'user', metadata: {} };

  it('hands the verdict and the already-loaded agent metadata to the shared helper', async () => {
    getAgent.mockResolvedValue({ metadata: { isWorktree: true, sourceWorkspace: '/repo' } });

    await runAgentCompletionCleanup({
      agentId: 'a1', task, agent: { providerId: 'codex' }, effectiveSuccess: false, outputBuffer: '',
    });

    expect(releaseRetryHold).toHaveBeenCalledWith({
      agentId: 'a1', task, success: false,
      agentMetadata: { isWorktree: true, sourceWorkspace: '/repo' },
    });
    // After cleanup, so the pointer reflects what actually survived.
    expect(cleanupAgentWorktree.mock.invocationCallOrder[0])
      .toBeLessThan(releaseRetryHold.mock.invocationCallOrder[0]);
  });

  // A missing agent record must reach the helper as an explicit null, not
  // `undefined` — `undefined` is the helper's "go read it yourself" sentinel, and
  // re-reading here would re-split the whole output.txt transcript for nothing.
  it('passes null when the agent record could not be read', async () => {
    getAgent.mockResolvedValue(null);

    await runAgentCompletionCleanup({
      agentId: 'a1', task, agent: { providerId: 'codex' }, effectiveSuccess: false, outputBuffer: '',
    });

    expect(releaseRetryHold).toHaveBeenCalledWith(expect.objectContaining({ agentMetadata: null }));
  });

  // The release is what makes a held task spawnable again (#3373), so it cannot
  // hang off the worktree-cleanup branch: a JIRA-branch task skips that block
  // entirely, and previously skipped the pointer with it.
  it('still releases the hold for a JIRA-branch task, which skips worktree cleanup', async () => {
    getAgent.mockResolvedValue({ metadata: { isWorktree: true, sourceWorkspace: '/repo' } });
    const jiraTask = { id: 't', taskType: 'user', metadata: { jiraTicketId: 'ABC-1', jiraBranch: 'feature/ABC-1' } };

    await runAgentCompletionCleanup({
      agentId: 'a1', task: jiraTask, agent: { providerId: 'codex' }, effectiveSuccess: false, outputBuffer: '',
    });

    expect(cleanupAgentWorktree).not.toHaveBeenCalled();
    expect(releaseRetryHold).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1', success: false }));
  });

  // ...and a throw from any earlier cleanup step must not strand the task held.
  it('releases the hold even when a cleanup step throws', async () => {
    getAgent.mockResolvedValue({ metadata: { isWorktree: true } });
    cleanupAgentWorktree.mockRejectedValueOnce(new Error('git exploded'));

    await expect(runAgentCompletionCleanup({
      agentId: 'a1', task, agent: { providerId: 'codex' }, effectiveSuccess: false, outputBuffer: '',
    })).rejects.toThrow('git exploded');

    expect(releaseRetryHold).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1' }));
  });
});

// The dispatch the TUI `finish()` and direct-CLI `close` handlers hand off to
// from their `finally`. It replaced two hand-mirrored inline copies that had
// drifted in both directions, so what these pin is the sequence itself, the PR
// disposition it derives from the spawner's ownership verdict, and the two
// behaviors each copy was missing. The spawner suites pin only the hand-off.
describe('runSpawnerCompletionCleanup — the in-process spawners\' dispatch', () => {
  const spawnerArgs = (overrides = {}) => ({
    agentId: 'a1',
    task: { id: 't', taskType: 'user', description: 'do it', metadata: { openPR: true } },
    success: true,
    // A task that asked for a PR from a run whose prompt hands it back to PortOS.
    prOwnership: { taskOpenPR: true, prOpenedBy: 'portos', agentOpensOwnPr: false, prClaimExpected: false },
    prClaimVerified: false,
    noChangesToShip: false,
    outputBuffer: 'out',
    ...overrides,
  });

  it('advances a running pipeline, cleans the worktree with the PR disposition, then releases the hold', async () => {
    const order = [];
    updateTask.mockImplementationOnce(async () => { order.push('pipeline'); });
    cleanupAgentWorktree.mockImplementationOnce(async () => { order.push('worktree'); });
    releaseRetryHold.mockImplementationOnce(async () => { order.push('hold'); });
    const task = { id: 't', taskType: 'user', description: 'stage', metadata: { openPR: true, pipeline: runningPipeline({ currentStage: 1 }) } };

    await runSpawnerCompletionCleanup(spawnerArgs({ task }));

    expect(order).toEqual(['pipeline', 'worktree', 'hold']);
    expect(updateTask.mock.calls[0][1].metadata.pipeline.status).toBe('completed');
    // PortOS opens the PR itself (`always`) and may auto-merge the branch.
    expect(cleanupAgentWorktree).toHaveBeenCalledWith('a1', true, expect.objectContaining({
      prCreation: 'always', skipMerge: false, agentOutput: 'out', originalTask: task,
    }));
    expect(releaseRetryHold).toHaveBeenCalledWith({ agentId: 'a1', task, success: true });
  });

  it('threads the resolved reviewer options and the task\'s PR completion through to the worktree cleanup', async () => {
    resolveReviewLoopOptions.mockResolvedValueOnce({ reviewers: ['codex', 'antigravity'], reviewStopMode: 'on-clean', reviewerApplies: false });
    const task = { id: 't', taskType: 'user', description: 'do it', metadata: { openPR: true, prCompletion: 'review-then-merge' } };

    await runSpawnerCompletionCleanup(spawnerArgs({ task }));

    expect(cleanupAgentWorktree).toHaveBeenCalledWith('a1', true, expect.objectContaining({
      prCreation: 'always',
      prCompletion: 'review-then-merge',
      reviewers: ['codex', 'antigravity'],
      reviewStopMode: 'on-clean',
      reviewerApplies: false,
    }));
    // No pipeline on this task: progression is a no-op, not a stray task write.
    expect(updateTask).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  // A non-owning run whose no-change audit finalize verified: there is nothing
  // to ship, so no PR is opened for an empty branch and no reviewer defaults
  // are read for a follow-up that will never spawn.
  it('never opens a PR when finalize proved there was nothing to ship', async () => {
    await runSpawnerCompletionCleanup(spawnerArgs({ noChangesToShip: true }));

    expect(cleanupAgentWorktree).toHaveBeenCalledWith('a1', true, expect.objectContaining({ prCreation: 'never' }));
    expect(resolveReviewLoopOptions).not.toHaveBeenCalled();
  });

  // The hardening the TUI copy had and the CLI copy lacked: a reviewer-defaults
  // read that throws must not skip the worktree cleanup and hold release behind
  // it — that strands the worktree and leaves the task held until the orphan
  // sweep notices.
  it('still cleans the worktree and releases the hold when the reviewer resolve throws', async () => {
    resolveReviewLoopOptions.mockRejectedValueOnce(new Error('settings unreadable'));
    const args = spawnerArgs({ success: false });

    await runSpawnerCompletionCleanup(args);

    expect(cleanupAgentWorktree).toHaveBeenCalledWith('a1', false, expect.objectContaining({ prCreation: 'always' }));
    expect(cleanupAgentWorktree.mock.calls[0][2]).not.toHaveProperty('reviewers');
    expect(releaseRetryHold).toHaveBeenCalledWith({ agentId: 'a1', task: args.task, success: false });
  });

  // ...and a worktree cleanup that rejects must not either (#3373): the hold is
  // released in a `finally`, not by the previous step's success.
  it('releases the hold even when the worktree cleanup rejects', async () => {
    cleanupAgentWorktree.mockRejectedValueOnce(new Error('git exploded'));
    const args = spawnerArgs({ success: false });

    await expect(runSpawnerCompletionCleanup(args)).resolves.toBeUndefined();

    expect(releaseRetryHold).toHaveBeenCalledWith({ agentId: 'a1', task: args.task, success: false });
  });

  // The dominant path: a harness that opened and landed its own PR. Cleanup can
  // spawn no follow-up, so the reviewer defaults are never even read.
  it('skips the reviewer resolve for a run whose own PR claim finalize verified', async () => {
    await runSpawnerCompletionCleanup(spawnerArgs({
      prOwnership: { taskOpenPR: true, prOpenedBy: 'agent-slashdo', agentOpensOwnPr: true, prClaimExpected: true },
      prClaimVerified: true,
    }));

    expect(resolveReviewLoopOptions).not.toHaveBeenCalled();
    expect(cleanupAgentWorktree).toHaveBeenCalledWith('a1', true, expect.objectContaining({ prCreation: 'never', skipMerge: true }));
  });
});
