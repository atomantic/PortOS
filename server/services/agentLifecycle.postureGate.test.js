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
 *
 * The last describe (#6105) observes the same spawn one step further in, at the
 * DISPATCH: a public-review stage is direct-only, and the gate passing is not
 * enough on its own. `reachDispatch()` below carries a case past the workspace
 * prep the gate cases deliberately stop at.
 */

import { afterAll, describe, it, expect, vi, beforeEach } from 'vitest';
import { rmSync } from 'fs';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

// A spawn that reaches the DISPATCH writes `prompt.txt` into `PATHS.cosAgents`
// and creates the agent directory. Re-rooted at a temp dir so this suite never
// writes into the developing install's agent archive. Allocated inside
// `vi.hoisted` because `agentLifecycle.js` reads `PATHS.cosAgents` at import
// time — a plain module-level const would still be in its temporal dead zone
// when the factory below runs.
const { TEMP_ROOT } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join: joinPath } = await import('path');
  return { TEMP_ROOT: mkdtempSync(joinPath(tmpdir(), 'portos-posture-gate-')) };
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
// By default, stops the spawn immediately AFTER the posture gate — the gate is
// what most of this file observes, and letting the real workspace prep run
// would touch git. The dispatch cases override it per test via `reachDispatch`.
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
  // Read by the `registerAgent` projection on the way to the dispatch; the real
  // predicates are pinned in agentPromptBuilder's own suite.
  inlinePrLifecycleSection: vi.fn(() => null),
  isClaimFlowTask: vi.fn(() => false),
}));
// Dynamically imported mid-spawn purely to snapshot workspace context. Stubbed
// so a spawn that reaches the dispatch cannot touch the install's context store.
vi.mock('./workspaceContext.js', () => ({ snapshotOnRepoSwitch: vi.fn().mockResolvedValue(null) }));
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
import { prepareAgentWorkspace } from './agentWorkspacePrep.js';
import { materializePublicReviewInput, materializePublicReviewPatches, readPublicReviewInputSnapshot } from './modelAbuseGuard.js';
import { removeWorktree } from './worktreeManager.js';
import { resolveAgentProviderAndModel } from './agentProviderResolution.js';
import { buildAgentPrompt } from './agentPromptBuilder.js';
import { createAgentRun } from './agentRunTracking.js';
import { buildCliSpawnConfig, isTuiProvider, spawnDirectly } from './agentCliSpawning.js';
import { spawnAgentViaRunner } from './cosRunnerClient.js';
import { updateTask } from './cos.js';
import { spawningTasks, runnerAgents, setUseRunner } from './agentState.js';

// The provider every install actually runs its CoS agents on, and the one named
// in the #5866 outage: the broken gate rejected it for ordinary work.
const CLAUDE_TUI = { id: 'claude-code-tui', type: 'tui', command: 'claude', envVars: {} };
// A TUI record whose vendor declares no public-review recipe at all.
const OPENCODE_TUI = { id: 'opencode-tui', type: 'tui', command: 'opencode', envVars: {} };

/** Every `updateTask` call that wrote a public-review posture block. */
const postureBlockWrites = () => vi.mocked(updateTask).mock.calls.filter(
  ([, update]) => typeof update?.metadata?.blockedReason === 'string'
    && update.metadata.blockedReason.includes('public-content review mode'),
);

/**
 * Carry a spawn PAST `prepareAgentWorkspace` — which the mock set above stops
 * every other case at — so the dispatch at the end of `runAgentSpawn` is
 * actually reached. Only the leaves between prep and dispatch are filled in;
 * the orchestrator itself stays the production one, which is the whole point:
 * the invariant under test is a single expression inside it.
 *
 * No `worktreeInfo`, so the run never reads a real checkout for its
 * branch-jack baseline.
 */
function reachDispatch() {
  vi.mocked(prepareAgentWorkspace).mockResolvedValueOnce({
    outcome: 'ready',
    workspacePath: join(TEMP_ROOT, 'workspace'),
    resolvedAppName: 'example-app',
    worktreeInfo: null,
  });
  vi.mocked(materializePublicReviewInput).mockResolvedValue(true);
  // The actions stage also materializes the read-only patch files; without this
  // its dispatch cases block on `public-review-input-missing` before routing.
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
  // A runner spawn that resolves normally. Set for EVERY case, including the
  // ones that must never reach the runner: a rejecting stub would fail those on
  // a TypeError instead of on the assertion that names the invariant.
  vi.mocked(spawnAgentViaRunner).mockResolvedValue({ pid: 4242 });
  // Truthy: a falsy in_progress write is read as "the claim did not land" and
  // aborts the spawn before the dispatch.
  vi.mocked(updateTask).mockResolvedValue({ metadata: {} });
  vi.mocked(resolveAgentProviderAndModel).mockResolvedValue({
    ok: true, provider: CLAUDE_TUI, selectedModel: 'sonnet', modelSelection: {},
  });
});

afterAll(() => rmSync(TEMP_ROOT, { recursive: true, force: true }));

describe('spawn setup failure after the worktree exists', () => {
  // Every failed Stage 2 spawn used to leave its checkout behind: the task
  // stayed pending and each retry cut another worktree.
  it('removes the worktree this attempt cut', async () => {
    vi.mocked(prepareAgentWorkspace).mockResolvedValueOnce({
      outcome: 'ready',
      workspacePath: '/tmp/worktrees/agent-x',
      worktreeInfo: { worktreePath: '/tmp/worktrees/agent-x', branchName: 'cos/task-public-review/agent-x' },
    });
    vi.mocked(materializePublicReviewInput).mockRejectedValueOnce(new Error('The "cb" argument must be of type function'));

    await spawnAgentForTask({
      id: 'task-public-review',
      metadata: {
        executionProfile: 'public-review-gate',
        pipeline: { securityScan: { completed: true, status: 'passed', safePrCount: 1 }, reviewInputKey: 'a'.repeat(64) },
      },
    });

    expect(removeWorktree).toHaveBeenCalledTimes(1);
    const [, , branchName, options] = vi.mocked(removeWorktree).mock.calls[0];
    expect(branchName).toBe('cos/task-public-review/agent-x');
    expect(options).toEqual({ discardDirt: true });
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
    vi.mocked(resolveAgentProviderAndModel).mockResolvedValue({
      ok: true, provider: OPENCODE_TUI, selectedModel: 'qwen', modelSelection: {},
    });
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
    expect(update.metadata.blockedReason).toContain("Provider 'opencode-tui'");
    expect(update.metadata.blockedReason).toContain('no-tool');
    expect(update.metadata.blockedCategory).toBe('public-review-provider-unsupported');
  });

  // The user's enabled providers are typically the TUI records. A public-content
  // stage runs the same binary headless through the vendor's enforced recipe,
  // so a TUI record of a recipe-bearing vendor passes the gate and must never
  // be handed to the interactive PTY spawner.
  it('spawns a public-review stage on a TUI provider headless, never as a PTY session', async () => {
    const { buildTuiSpawnConfig, spawnTuiAgent } = await import('./agentTuiSpawning.js');
    // Without this the spawn stops at `prepareAgentWorkspace` and the negatives
    // below hold for the wrong reason — no spawner is reached at all.
    reachDispatch();

    await spawnAgentForTask({
      id: 'task-public-review-tui',
      metadata: {
        executionProfile: 'public-review-gate',
        pipeline: { securityScan: { completed: true, status: 'passed', safePrCount: 1 } },
      },
    });

    expect(postureBlockWrites()).toEqual([]);
    expect(spawnDirectly).toHaveBeenCalledTimes(1);
    expect(buildTuiSpawnConfig).not.toHaveBeenCalled();
    expect(spawnTuiAgent).not.toHaveBeenCalled();
  });

  // #6062 — Stage 3 is the longest-running, least predictable stage (it applies
  // a patch and runs the repo's tests), so it is the one an operator wants to
  // attach to and steer. It gets a PTY when its provider is a TUI record whose
  // vendor declares an attachable recipe.
  it('spawns the sandboxed-actions stage as a PTY when its TUI provider has an attachable recipe', async () => {
    const { buildTuiSpawnConfig, spawnTuiAgent } = await import('./agentTuiSpawning.js');
    vi.mocked(buildTuiSpawnConfig).mockReturnValue({ command: 'claude', args: [], commandLine: 'claude' });
    reachDispatch();

    await spawnAgentForTask({
      id: 'task-public-review-actions-tui',
      metadata: {
        executionProfile: 'public-review-actions',
        issueWatcher: { pullRequests: [{ number: 42 }] },
        pipeline: {
          securityScan: { completed: true, status: 'passed', safePrCount: 1 },
          eligibility: { complete: true, eligibleNumbers: [42] },
        },
      },
    });

    expect(postureBlockWrites()).toEqual([]);
    expect(spawnDirectly).not.toHaveBeenCalled();
    expect(spawnTuiAgent).toHaveBeenCalledTimes(1);
    // The posture must reach BOTH the argv builder (so the vendor recipe, not
    // the generic assembly, decides the flags) and the session (so the PTY
    // child gets the same allowlisted env its headless sibling would).
    expect(buildTuiSpawnConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'claude-code-tui' }),
      'sonnet',
      expect.objectContaining({ safetyProfile: 'public-review-actions' }),
    );
    expect(spawnTuiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ safetyProfile: 'public-review-actions' }),
    );
  });

  // #6238 — OpenCode's actions row exists for exactly this: a Stage 3 run on an
  // OpenCode-backed TUI record gets a PTY (and so an attachable Shell session)
  // instead of being forced headless. Its no-tool gate stays blocked above.
  it('blocks OpenCode actions because a worktree cannot isolate untrusted code', async () => {
    const { buildTuiSpawnConfig, spawnTuiAgent } = await import('./agentTuiSpawning.js');
    vi.mocked(resolveAgentProviderAndModel).mockResolvedValue({
      ok: true, provider: { ...OPENCODE_TUI, mtplxBacked: true }, selectedModel: 'example-model', modelSelection: {},
    });
    vi.mocked(buildTuiSpawnConfig).mockReturnValue({ command: 'opencode', args: [], commandLine: 'opencode' });
    reachDispatch();

    await spawnAgentForTask({
      id: 'task-public-review-actions-opencode',
      metadata: {
        executionProfile: 'public-review-actions',
        issueWatcher: { pullRequests: [{ number: 42 }] },
        pipeline: {
          securityScan: { completed: true, status: 'passed', safePrCount: 1 },
          eligibility: { complete: true, eligibleNumbers: [42] },
        },
      },
    });

    expect(postureBlockWrites()).toHaveLength(1);
    expect(spawnDirectly).not.toHaveBeenCalled();
    expect(spawnTuiAgent).not.toHaveBeenCalled();
    expect(buildTuiSpawnConfig).not.toHaveBeenCalled();
  });

  // The narrow half of the same rule. A vendor whose actions recipe has not been
  // reviewed for a PTY emits headless argv (`exec`, `--print`, `run`) that a PTY
  // can neither prompt nor enforce, so it stays headless rather than opening a
  // session whose posture is decorative.
  it('keeps the sandboxed-actions stage headless on a TUI provider with no attachable recipe', async () => {
    const { buildTuiSpawnConfig, spawnTuiAgent } = await import('./agentTuiSpawning.js');
    vi.mocked(resolveAgentProviderAndModel).mockResolvedValue({
      ok: true, provider: { id: 'codex-tui', type: 'tui', command: 'codex', envVars: {} },
      selectedModel: 'gpt-5.6', modelSelection: {},
    });
    reachDispatch();

    await spawnAgentForTask({
      id: 'task-public-review-actions-codex',
      metadata: {
        executionProfile: 'public-review-actions',
        issueWatcher: { pullRequests: [{ number: 42 }] },
        pipeline: {
          securityScan: { completed: true, status: 'passed', safePrCount: 1 },
          eligibility: { complete: true, eligibleNumbers: [42] },
        },
      },
    });

    expect(postureBlockWrites()).toEqual([]);
    expect(spawnDirectly).toHaveBeenCalledTimes(1);
    expect(buildTuiSpawnConfig).not.toHaveBeenCalled();
    expect(spawnTuiAgent).not.toHaveBeenCalled();
  });

  // The other exclusion, and the one that is a security posture rather than a
  // capability gap: an interactive session for a reasoner with no tools buys
  // nothing and widens the boundary for free.
  it('keeps a no-tool stage headless even on a provider whose actions recipe is attachable', async () => {
    const { buildTuiSpawnConfig, spawnTuiAgent } = await import('./agentTuiSpawning.js');
    reachDispatch();

    await spawnAgentForTask({
      id: 'task-public-review-no-tool-claude',
      metadata: {
        executionProfile: 'public-review-gate',
        pipeline: { securityScan: { completed: true, status: 'passed', safePrCount: 1 } },
      },
    });

    expect(postureBlockWrites()).toEqual([]);
    expect(spawnDirectly).toHaveBeenCalledTimes(1);
    expect(buildTuiSpawnConfig).not.toHaveBeenCalled();
    expect(spawnTuiAgent).not.toHaveBeenCalled();
  });
});

/**
 * `const dispatchUseRunner = publicReview ? false : useRunner;`
 *
 * Direct-only is not a style choice: the two halves of a vendor's `no-tool`
 * posture are enforced in different places. The argv is declared on the vendor
 * row and resolved inside the spawn-config builder, so it survives any dispatch
 * path — but OpenCode's posture lives entirely in the config content that
 * `buildCliChildEnv` writes from the `safetyProfile` it is handed, and the CoS
 * runner payload carries no `safetyProfile`. A public-review stage that reached
 * the runner would therefore still LOOK enforced (right flag, right provider,
 * gate passed) while running tool-enabled against contributor-authored PR text.
 * Silent, and green in CI — so the routing itself is what gets pinned.
 */
describe('public-review dispatch — direct-only, never the CoS runner (#6105)', () => {
  it('sends a public-review stage to the direct spawner even with runner mode on', async () => {
    setUseRunner(true);
    reachDispatch();

    await spawnAgentForTask({
      id: 'task-public-review-runner',
      metadata: {
        executionProfile: 'public-review-gate',
        pipeline: { securityScan: { completed: true, status: 'passed', safePrCount: 1 } },
      },
    });

    expect(spawnAgentViaRunner).not.toHaveBeenCalled();
    expect(spawnDirectly).toHaveBeenCalledTimes(1);
    // The posture the direct spawner hands to `buildCliChildEnv` — the half of
    // the enforcement the runner payload has no field for.
    expect(vi.mocked(spawnDirectly).mock.calls[0][0]).toMatchObject({ safetyProfile: 'public-review-gate' });
  });

  // The control. Without it the assertion above would also pass if runner mode
  // simply never reached the dispatch in this mock set, which is how the sibling
  // TUI negatives came to hold vacuously.
  it('still sends an ordinary task to the runner when runner mode is on', async () => {
    setUseRunner(true);
    // A non-TUI record: an ordinary TUI task is spawned as a PTY session, and
    // the runner arm sits on the headless side of that branch.
    vi.mocked(isTuiProvider).mockReturnValue(false);
    reachDispatch();

    await spawnAgentForTask({ id: 'task-ordinary-runner', metadata: {} });

    expect(spawnAgentViaRunner).toHaveBeenCalledTimes(1);
    expect(spawnDirectly).not.toHaveBeenCalled();
    // spawnViaRunner arms a 3s "still initializing" timer on the live agent.
    for (const agent of runnerAgents.values()) clearTimeout(agent.initializationTimeout);
  });
});
