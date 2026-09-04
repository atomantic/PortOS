/**
 * Tests for handleOrphanedTask — guards that prevent duplicate investigation
 * tasks when the same underlying task is orphaned by multiple agents in the
 * same cleanup sweep.
 *
 * The bug: cleanupOrphanedAgents iterates over all stale "running" agents and
 * calls handleOrphanedTask once per agent. If two agents shared a taskId, the
 * first call would block the task with 'max-retries' and spawn an investigation
 * task; the second call would see the (now-blocked) task, increment
 * orphanRetryCount again, and spawn ANOTHER investigation task. The addTask
 * dedup at cos.js:2194 doesn't catch it because the description body embeds
 * per-agent retryCount/agentId, so the strings differ.
 *
 * The guard added at agentManagement.js:381 short-circuits handleOrphanedTask
 * when the task is already blocked with 'max-retries' or 'orphan-cooldown'.
 *
 * Also covers the Windows tasklist CSV parsing logic in getAgentProcessStats.
 * `tasklist /FO CSV /NH` emits rows like:
 *   "node.exe","12345","Console","1","82,156 K"
 * The pre-fix code called line.split(/\s+/) on this CSV, which misparses the
 * quoted, comma-separated output. The fix uses a proper CSV parser
 * (parseTasklistCsvRow, module-private) on the win32 branch.
 *
 * The Windows tests replicate the parser inline (matching project convention
 * from agentLifecycle.test.js — pure-logic copies instead of mocking the full
 * async-heavy production module).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChildProcess } from '../lib/childProcess.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Normalize CRLF→LF so the fixed char-window slices below stay deterministic on
// Windows checkouts (CRLF inflates byte offsets and can push a matched anchor
// past the window, producing a spurious failure).
const normalizeEol = (s) => s.replace(/\r\n/g, '\n');
const AGENT_CLI_SRC = normalizeEol(readFileSync(join(__dirname, 'agentCliSpawning.js'), 'utf-8'));
const AGENT_TUI_SRC = normalizeEol(readFileSync(join(__dirname, 'agentTuiSpawning.js'), 'utf-8'));
const AGENT_LIFECYCLE_SRC = normalizeEol(readFileSync(join(__dirname, 'agentLifecycle.js'), 'utf-8'));
const AGENT_MANAGEMENT_SRC = normalizeEol(readFileSync(join(__dirname, 'agentManagement.js'), 'utf-8'));

// The lifecycle ledger is a real file writer (data/cos/run-events.jsonl). Mocked
// so the sweep's telemetry lands in a spy instead of the developing install's
// ledger — and so the orphan-boundary assertion below can read the envelope.
const { appendRunEvent } = vi.hoisted(() => ({ appendRunEvent: vi.fn(async () => ({ appended: true })) }));
vi.mock('./agentRunEventLog.js', () => ({ appendRunEvent }));

vi.mock('./cos.js', () => ({
  updateTask: vi.fn().mockResolvedValue(true),
  addTask: vi.fn().mockResolvedValue({ id: 'sys-mocked' }),
  getTaskById: vi.fn(),
  getAllTasks: vi.fn(),
  reviveBlockedTask: vi.fn().mockResolvedValue(true),
  evaluateTasks: vi.fn().mockResolvedValue(undefined),
  forceSpawnTask: vi.fn().mockResolvedValue({ success: true })
}));

vi.mock('./cosEvents.js', () => ({
  emitLog: vi.fn()
}));

vi.mock('../lib/gitCommitProbe.js', async (importOriginal) => ({
  ...(await importOriginal()),
  committedDuringRun: vi.fn().mockResolvedValue(false),
}));
vi.mock('./agentRunTracking.js', () => ({
  completeAgentRun: vi.fn().mockResolvedValue(undefined),
}));

// Stub other transitive imports we don't exercise in handleOrphanedTask.
// The DEFINING module, not the `cosAgentLifecycle.js` module — mirrors the production
// import (#3450). Mocking the barrel here would silently stop applying and let
// the real state layer load.
// `isLiveAgentRecord` and the sentinel come from the real module — the reverse
// prune turns on that predicate, so a re-implemented copy here would keep
// passing while the real one changed underneath it.
vi.mock('./cosAgentLifecycle.js', async (importOriginal) => ({
  ...(await importOriginal()),
  completeAgent: vi.fn().mockResolvedValue(undefined),
  updateAgent: vi.fn().mockResolvedValue(undefined),
  getAgents: vi.fn().mockResolvedValue([]),
  getAgentRecord: vi.fn().mockResolvedValue(null),
  readAgentRecordOrUnreadable: vi.fn().mockResolvedValue(null),
}));
vi.mock('./cosRunnerClient.js', () => ({
  terminateAgentViaRunner: vi.fn(),
  killAgentViaRunner: vi.fn(),
  pauseAgentViaRunner: vi.fn(),
  getAgentStatsFromRunner: vi.fn(),
  getActiveAgentsFromRunner: vi.fn().mockResolvedValue([])
}));
vi.mock('./executionLanes.js', () => ({ release: vi.fn() }));
vi.mock('./toolStateMachine.js', () => ({ completeExecution: vi.fn(), errorExecution: vi.fn() }));
vi.mock('./shell.js', () => ({ writeToSession: vi.fn(), killSession: vi.fn() }));
vi.mock('./agentWorktreeCleanup.js', () => ({
  cleanupAgentWorktree: vi.fn(),
  resolveTaskResumePatch: vi.fn().mockResolvedValue({})
}));
vi.mock('./agentFinalization.js', () => ({ dispatchRecoveredTaskOutputHook: vi.fn().mockResolvedValue(undefined) }));
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

import { handleOrphanedTask, pauseAgent, resumeAgent, relaunchAgent, settleOrphanedCreativeDirectorRun, cleanupOrphanedAgents, terminateAgent, killAgent } from './agentManagement.js';
import { cleanupAgentWorktree, resolveTaskResumePatch } from './agentWorktreeCleanup.js';
import { getAgents, updateAgent, getAgentRecord, readAgentRecordOrUnreadable, AGENT_RECORD_UNREADABLE, completeAgent as markAgentComplete } from './cosAgentLifecycle.js';
import { updateRun, getProject } from './creativeDirector/local.js';
import { advanceAfterPlanStepSettled } from './creativeDirector/planAdvance.js';
import { advanceAfterSceneSettled } from './creativeDirector/completionHook.js';
import { updateTask, addTask, getTaskById, getAllTasks, reviveBlockedTask, forceSpawnTask } from './cos.js';
import { pauseAgentViaRunner, terminateAgentViaRunner, getActiveAgentsFromRunner } from './cosRunnerClient.js';
import * as shellService from './shell.js';
import { readHostShutdownMarker, clearHostShutdownMarker } from '../lib/hostShutdown.js';
import { completeAgentRun } from './agentRunTracking.js';
import { committedDuringRun } from '../lib/gitCommitProbe.js';
import { activeAgents, runnerAgents, pausedAgents, consumePausedAgentExit } from './agentState.js';

/**
 * A direct-mode agent's spawned handle. Its prototype is ChildProcess so it
 * takes killProcessTree's spawned-child branch (Windows `taskkill` tree / POSIX
 * signal) rather than the node-pty branch, exactly as a real `spawn()` result
 * would — mirroring `makeFakeChild` in `lib/bufferedSpawn.test.js`.
 */
const fakeChildProcess = (kill = vi.fn()) =>
  Object.assign(Object.create(ChildProcess.prototype), { kill });
import { hasPauseReleaseAdapter, resolvePausedTaskResume, retirePausedAgent } from '../lib/taskPauseHold.js';

describe('cleanupOrphanedAgents — startup recovery coordination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeAgents.clear();
    runnerAgents.clear();
  });

  it('shares one in-flight sweep between concurrent startup callers', async () => {
    let releaseProbe;
    const probe = new Promise((resolve) => { releaseProbe = resolve; });
    getAgents.mockReturnValueOnce(probe);

    const first = cleanupOrphanedAgents();
    await Promise.resolve();
    const second = cleanupOrphanedAgents();

    expect(second).toBe(first);
    releaseProbe([]);
    await Promise.all([first, second]);
    expect(getAgents).toHaveBeenCalledTimes(1);
  });

  it('does not reap runner-owned agents while the runner probe is unavailable', async () => {
    getAgents.mockResolvedValueOnce([{
      id: 'agent-runner',
      status: 'running',
      taskId: 'task-1',
      metadata: { useRunner: true, executionMode: 'runner' },
    }]);
    getActiveAgentsFromRunner.mockRejectedValueOnce(new Error('runner is booting'));

    await cleanupOrphanedAgents();

    expect(markAgentComplete).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  // The sweep walks durable RECORDS, so it can never reach a `runnerAgents`
  // entry that has no record — and nothing else prunes that map. A phantom
  // adopted from the runner therefore survived until the process restarted,
  // over-protecting worktrees from the cleanup job and counting against the
  // update gate that blocks the very restart that would clear it.
  it('drops runner-agent tracking whose record is gone or finalized, keeping live and unknowable ones', async () => {
    runnerAgents.set('agent-ghost', { taskId: 'task-1' });
    runnerAgents.set('agent-done', { taskId: 'task-1' });
    runnerAgents.set('agent-live', { taskId: 'task-1' });
    runnerAgents.set('agent-unreadable', { taskId: 'task-1' });
    readAgentRecordOrUnreadable.mockImplementation(async (id) => {
      if (id === 'agent-ghost') return null;
      if (id === 'agent-done') return { id, status: 'completed' };
      if (id === 'agent-unreadable') return AGENT_RECORD_UNREADABLE;
      return { id, status: 'running' };
    });

    await cleanupOrphanedAgents();

    expect(runnerAgents.has('agent-ghost')).toBe(false);
    expect(runnerAgents.has('agent-done')).toBe(false);
    expect(runnerAgents.has('agent-live')).toBe(true);
    // A failed read proves nothing — dropping tracking on it would strand a run
    // whose completion event still has to land.
    expect(runnerAgents.has('agent-unreadable')).toBe(true);
    runnerAgents.clear();
  });

  it('treats a malformed runner probe as unavailable', async () => {
    getAgents.mockResolvedValueOnce([{
      id: 'agent-runner',
      status: 'running',
      taskId: 'task-1',
      metadata: { useRunner: true, executionMode: 'runner-tui' },
    }]);
    getActiveAgentsFromRunner.mockResolvedValueOnce({ agents: [] });

    await cleanupOrphanedAgents();

    expect(markAgentComplete).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('reaps a durable running record whose runner listing is stale', async () => {
    getAgents.mockResolvedValueOnce([{
      id: 'agent-stale',
      status: 'running',
      pid: 2147483646,
      taskId: 'task-1',
      metadata: { useRunner: true, executionMode: 'runner' },
    }]);
    getActiveAgentsFromRunner.mockResolvedValueOnce([{
      id: 'agent-stale',
      pid: 2147483646,
      kind: 'cli',
      processActive: false,
      liveness: 'pid',
    }]);
    getTaskById.mockResolvedValue({ id: 'task-1', taskType: 'user', status: 'in_progress', metadata: {} });

    await cleanupOrphanedAgents();

    expect(markAgentComplete).toHaveBeenCalledWith('agent-stale', expect.objectContaining({
      success: false,
      orphaned: true,
    }));
  });

  it('does not reap a live runner-owned TUI advertised via onExit liveness', async () => {
    getAgents.mockResolvedValueOnce([{
      id: 'agent-tui',
      status: 'running',
      pid: 0,
      taskId: 'task-1',
      metadata: { useRunner: true, executionMode: 'runner-tui' },
    }]);
    getActiveAgentsFromRunner.mockResolvedValueOnce([{
      id: 'agent-tui',
      pid: 0,
      kind: 'tui',
      processActive: true,
      liveness: 'pty',
    }]);

    await cleanupOrphanedAgents();

    expect(markAgentComplete).not.toHaveBeenCalled();
  });

  it('reaps a stale listing even if runnerAgents already adopted the id', async () => {
    runnerAgents.set('agent-stale', { taskId: 'task-1' });
    getAgents.mockResolvedValueOnce([{
      id: 'agent-stale',
      status: 'running',
      pid: 2147483646,
      taskId: 'task-1',
      metadata: { useRunner: true, executionMode: 'runner' },
    }]);
    getActiveAgentsFromRunner.mockResolvedValueOnce([{
      id: 'agent-stale',
      pid: 2147483646,
      kind: 'cli',
      processActive: false,
      liveness: 'pid',
    }]);
    getTaskById.mockResolvedValue({ id: 'task-1', taskType: 'user', status: 'in_progress', metadata: {} });

    await cleanupOrphanedAgents();

    expect(markAgentComplete).toHaveBeenCalledWith('agent-stale', expect.objectContaining({
      success: false,
      orphaned: true,
    }));
    expect(runnerAgents.has('agent-stale')).toBe(false);
  });

  it('does not reap a pre-fix Windows TUI whose processActive is a pid-0 artifact', async () => {
    getAgents.mockResolvedValueOnce([{
      id: 'agent-tui-old',
      status: 'running',
      pid: 0,
      taskId: 'task-1',
      metadata: { useRunner: true, executionMode: 'runner-tui' },
    }]);
    getActiveAgentsFromRunner.mockResolvedValueOnce([{
      id: 'agent-tui-old',
      pid: 0,
      kind: 'tui',
      processActive: false,
    }]);

    await cleanupOrphanedAgents();

    expect(markAgentComplete).not.toHaveBeenCalled();
  });
});

describe('settleOrphanedCreativeDirectorRun — reap a dead CD agent run (#2705)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fails the run AND retires the task (so handleOrphanedTask skips it), then advances the plan', async () => {
    // Directive project → the deduped plan-advance loop re-dispatches.
    getProject.mockResolvedValueOnce({ id: 'cd-p1', status: 'planning', directive: { goal: 'x' } });
    const task = {
      id: 'cd-cd-p1-plan-abc',
      metadata: { creativeDirector: { projectId: 'cd-p1', runId: 'run-abc', kind: 'plan', sceneId: null } },
    };
    const settled = await settleOrphanedCreativeDirectorRun(task);
    expect(settled).toBe(true);
    // (1) run failed with an orphan reason
    expect(updateRun).toHaveBeenCalledWith(
      'cd-p1',
      'run-abc',
      expect.objectContaining({ status: 'failed', failureReason: expect.stringContaining('orphaned') }),
    );
    // (2) task retired to `completed` — the boot-race fix: handleOrphanedTask skips completed tasks
    expect(updateTask).toHaveBeenCalledWith(
      'cd-cd-p1-plan-abc',
      expect.objectContaining({ status: 'completed' }),
      'internal',
    );
    // (3) re-dispatch via the deduped advance loop, not raw task respawn
    expect(advanceAfterPlanStepSettled).toHaveBeenCalledWith('cd-p1');
    expect(advanceAfterSceneSettled).not.toHaveBeenCalled();
  });

  it('uses the scene-advance loop for a legacy (non-directive) project', async () => {
    getProject.mockResolvedValueOnce({ id: 'cd-p2', status: 'rendering', directive: null });
    await settleOrphanedCreativeDirectorRun({
      id: 'cd-cd-p2-evaluate-x',
      metadata: { creativeDirector: { projectId: 'cd-p2', runId: 'run-xyz', kind: 'evaluate', sceneId: 's1' } },
    });
    expect(advanceAfterSceneSettled).toHaveBeenCalledWith('cd-p2');
    expect(advanceAfterPlanStepSettled).not.toHaveBeenCalled();
  });

  it('does NOT re-dispatch a paused or failed project', async () => {
    getProject.mockResolvedValueOnce({ id: 'cd-p3', status: 'paused', directive: { goal: 'x' } });
    await settleOrphanedCreativeDirectorRun({
      id: 'cd-cd-p3-plan-z',
      metadata: { creativeDirector: { projectId: 'cd-p3', runId: 'run-z', kind: 'plan' } },
    });
    // still failed the run + retired the task, but no advance for a paused project
    expect(updateRun).toHaveBeenCalled();
    expect(updateTask).toHaveBeenCalledWith('cd-cd-p3-plan-z', expect.objectContaining({ status: 'completed' }), 'internal');
    expect(advanceAfterPlanStepSettled).not.toHaveBeenCalled();
    expect(advanceAfterSceneSettled).not.toHaveBeenCalled();
  });

  it('is a no-op (no updateRun/updateTask) for a non-CD task or a CD task missing projectId/runId', async () => {
    expect(await settleOrphanedCreativeDirectorRun({ id: 't', metadata: {} })).toBe(false);
    expect(await settleOrphanedCreativeDirectorRun(null)).toBe(false);
    // metadata present but incomplete — must not settle a run it can't identify.
    expect(await settleOrphanedCreativeDirectorRun({ metadata: { creativeDirector: { projectId: 'cd-p1' } } })).toBe(false);
    expect(updateRun).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });
});

describe('handleOrphanedTask — duplicate-investigation guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeAgents.clear();
    pausedAgents.clear();
  });

  it('skips tasks already blocked with blockedCategory=max-retries (no new investigation task)', async () => {
    const blockedTask = {
      id: 'task-foo',
      status: 'blocked',
      taskType: 'user',
      description: 'Original work',
      metadata: {
        blockedCategory: 'max-retries',
        blockedReason: 'orphan retries exceeded (3/3)',
        orphanRetryCount: 3,
        totalSpawnCount: 3
      }
    };
    const getTaskById = vi.fn().mockResolvedValue(blockedTask);

    await handleOrphanedTask('task-foo', 'agent-second', getTaskById);

    expect(updateTask).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('skips tasks already blocked with blockedCategory=orphan-cooldown', async () => {
    const cooldownTask = {
      id: 'task-foo',
      status: 'blocked',
      taskType: 'user',
      description: 'Original work',
      metadata: {
        blockedCategory: 'orphan-cooldown',
        cooldownUntil: new Date(Date.now() + 60000).toISOString(),
        orphanRetryCount: 1
      }
    };
    const getTaskById = vi.fn().mockResolvedValue(cooldownTask);

    await handleOrphanedTask('task-foo', 'agent-second', getTaskById);

    expect(updateTask).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('still skips user-terminated tasks (preserves prior behavior)', async () => {
    const terminatedTask = {
      id: 'task-foo',
      status: 'blocked',
      taskType: 'user',
      description: 'Original work',
      metadata: { blockedCategory: 'user-terminated' }
    };
    const getTaskById = vi.fn().mockResolvedValue(terminatedTask);

    await handleOrphanedTask('task-foo', 'agent-x', getTaskById);

    expect(updateTask).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('still processes a fresh in_progress task (resets to pending for retry)', async () => {
    const inProgressTask = {
      id: 'task-foo',
      status: 'in_progress',
      taskType: 'user',
      description: 'Original work',
      metadata: { orphanRetryCount: 0, totalSpawnCount: 1 }
    };
    const getTaskById = vi.fn().mockResolvedValue(inProgressTask);

    await handleOrphanedTask('task-foo', 'agent-orphaned', getTaskById);

    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith(
      'task-foo',
      expect.objectContaining({
        status: 'pending',
        metadata: expect.objectContaining({
          orphanRetryCount: 1,
          lastOrphanedAgentId: 'agent-orphaned'
        })
      }),
      'user'
    );
    expect(addTask).not.toHaveBeenCalled();
  });

  it('files the investigation unattended and links it back to the orphaned task for auto-retry', async () => {
    // orphanRetryCount: 2 -> retryCount 3 hits MAX_ORPHAN_RETRIES, tripping the
    // "else" branch that blocks the task and spawns an investigation task.
    const exhaustedTask = {
      id: 'task-foo',
      status: 'in_progress',
      taskType: 'user',
      description: 'Original work',
      metadata: { orphanRetryCount: 2, totalSpawnCount: 2 }
    };
    const getTaskById = vi.fn().mockResolvedValue(exhaustedTask);
    getAllTasks.mockResolvedValue({ user: { tasks: [] }, cos: { tasks: [] } });

    await handleOrphanedTask('task-foo', 'agent-orphaned', getTaskById);

    expect(addTask).toHaveBeenCalledTimes(1);
    expect(addTask.mock.calls[0][0]).toMatchObject({
      description: expect.stringContaining('[Auto-Fix] Investigate repeated agent orphaning'),
      approvalRequired: false,
      // The link the auto-retry reads: completing this investigation revives
      // `task-foo` instead of leaving it blocked for a human.
      isInvestigation: true,
      affectedTasks: ['task-foo'],
      // And the key the loop policy reads — without it stamped here, a repeat of
      // this same cause could never be recognized as a loop.
      investigationFingerprint: 'max-retries:user:none',
    });
  });

  it('holds the orphan investigation for a human when the same cause was already investigated today', async () => {
    const exhaustedTask = {
      id: 'task-foo',
      status: 'in_progress',
      taskType: 'user',
      description: 'Original work',
      metadata: { orphanRetryCount: 2, totalSpawnCount: 2 }
    };
    getAllTasks.mockResolvedValue({
      user: { tasks: [] },
      cos: {
        tasks: [{
          id: 'sys-prior',
          status: 'completed',
          metadata: {
            isInvestigation: true,
            investigationFingerprint: 'max-retries:user:none',
            updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          }
        }]
      }
    });

    await handleOrphanedTask('task-foo', 'agent-orphaned', vi.fn().mockResolvedValue(exhaustedTask));

    expect(addTask.mock.calls[0][0]).toMatchObject({
      approvalRequired: true,
      approvalReason: 'investigation-loop:repeat-fingerprint',
    });
    expect(addTask.mock.calls[0][0].description).toContain('Why this is held for you');
  });
});

describe('pauseAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeAgents.clear();
    runnerAgents.clear();
    pausedAgents.clear();
  });

  it('marks a direct agent paused, blocks the task as agent-paused, and signals SIGTERM', async () => {
    const kill = vi.fn();
    activeAgents.set('agent-1', {
      process: fakeChildProcess(kill),
      taskId: 'task-1',
      runId: 'run-1',
      pid: 123,
      workspacePath: '/repo/worktree',
      executionId: 'exec-1',
      laneName: 'standard'
    });
    getTaskById.mockResolvedValue({
      id: 'task-1',
      taskType: 'user',
      description: 'Do work',
      metadata: { openPR: true }
    });

    const result = await pauseAgent('agent-1', 'billing window');

    expect(result).toMatchObject({ success: true, agentId: 'agent-1', mode: 'direct' });
    expect(updateAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      status: 'paused',
      metadata: expect.objectContaining({ phase: 'paused', pauseReason: 'billing window' })
    }));
    expect(updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({
      status: 'blocked',
      metadata: expect.objectContaining({
        blockedCategory: 'agent-paused',
        pausedAgentId: 'agent-1',
        resumeWorkspacePath: '/repo/worktree',
        resumeRunId: 'run-1'
      })
    }), 'user');
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(pausedAgents.has('agent-1')).toBe(true);
    clearTimeout(activeAgents.get('agent-1')?.killTimer);
  });
});

// ─── Inline replica of parseTasklistCsvRow ───────────────────────────────────
// Keep in sync with the implementation in agentManagement.js.

function parseTasklistCsvRow(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { fields.push(cur); cur = ''; continue; }
    cur += ch;
  }
  fields.push(cur);
  return fields;
}

// ─── Inline replica of the Windows parse branch ──────────────────────────────
// Mirrors the win32 block inside getAgentProcessStats.

function parseWindowsTasklistLine(line, agentId, fallbackPid) {
  const fields = parseTasklistCsvRow(line);
  if (fields.length >= 5) {
    const pid = parseInt(fields[1], 10);
    const memoryKb = parseInt(fields[4].replace(/,/g, '').replace(/\s*K$/i, '').trim(), 10) || 0;
    return {
      active: true,
      agentId,
      pid,
      cpu: 0,
      memoryKb,
      memoryMb: Math.round(memoryKb / 1024 * 10) / 10,
      state: 'running'
    };
  }
  return { active: true, agentId, pid: fallbackPid, cpu: 0, memoryKb: 0, memoryMb: 0, state: 'unknown' };
}

describe('parseTasklistCsvRow', () => {
  it('splits a standard tasklist CSV row into 5 fields', () => {
    const line = '"node.exe","12345","Console","1","82,156 K"';
    const fields = parseTasklistCsvRow(line);
    expect(fields).toHaveLength(5);
    expect(fields[0]).toBe('node.exe');
    expect(fields[1]).toBe('12345');
    expect(fields[2]).toBe('Console');
    expect(fields[3]).toBe('1');
    expect(fields[4]).toBe('82,156 K');
  });

  it('handles commas inside quoted fields without splitting', () => {
    const line = '"My, App.exe","99","Console","0","1,024 K"';
    const fields = parseTasklistCsvRow(line);
    expect(fields[0]).toBe('My, App.exe');
    expect(fields[1]).toBe('99');
    expect(fields[4]).toBe('1,024 K');
  });

  it('handles unquoted fields gracefully', () => {
    const line = 'node.exe,12345,Console,1,82156 K';
    const fields = parseTasklistCsvRow(line);
    expect(fields).toHaveLength(5);
    expect(fields[1]).toBe('12345');
  });

  it('returns a single-element array for a line with no commas', () => {
    expect(parseTasklistCsvRow('"node.exe"')).toEqual(['node.exe']);
  });

  it('handles an empty string', () => {
    expect(parseTasklistCsvRow('')).toEqual(['']);
  });
});

describe('getAgentProcessStats — Windows tasklist parsing', () => {
  it('extracts pid and memoryKb from a typical tasklist row', () => {
    const line = '"node.exe","12345","Console","1","82,156 K"';
    const result = parseWindowsTasklistLine(line, 'agent-1', 12345);
    expect(result.active).toBe(true);
    expect(result.agentId).toBe('agent-1');
    expect(result.pid).toBe(12345);
    expect(result.cpu).toBe(0);
    expect(result.memoryKb).toBe(82156);
    expect(result.memoryMb).toBe(Math.round(82156 / 1024 * 10) / 10);
    expect(result.state).toBe('running');
  });

  it('handles small memory values without thousands separator', () => {
    const line = '"node.exe","777","Console","0","512 K"';
    const result = parseWindowsTasklistLine(line, 'agent-2', 777);
    expect(result.memoryKb).toBe(512);
    expect(result.memoryMb).toBe(Math.round(512 / 1024 * 10) / 10);
  });

  it('handles large memory with multiple comma separators', () => {
    const line = '"node.exe","55555","Console","1","1,024,768 K"';
    const result = parseWindowsTasklistLine(line, 'agent-3', 55555);
    expect(result.memoryKb).toBe(1024768);
  });

  it('falls back to unknown state when fewer than 5 fields are present', () => {
    const line = '"node.exe","12345"';
    const result = parseWindowsTasklistLine(line, 'agent-4', 12345);
    expect(result.active).toBe(true);
    expect(result.state).toBe('unknown');
    expect(result.pid).toBe(12345);
    expect(result.memoryKb).toBe(0);
  });

  it('cpu is always 0 (not available from basic tasklist)', () => {
    const line = '"node.exe","99","Console","0","4,096 K"';
    const result = parseWindowsTasklistLine(line, 'agent-5', 99);
    expect(result.cpu).toBe(0);
  });

  it('correctly parses a process name containing spaces and commas', () => {
    const line = '"My, App Service.exe","4321","Services","0","10,240 K"';
    const result = parseWindowsTasklistLine(line, 'agent-6', 4321);
    expect(result.pid).toBe(4321);
    expect(result.memoryKb).toBe(10240);
  });
});

// ─── pauseAgent — runner branch ──────────────────────────────────────────────

describe('pauseAgent — runner branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeAgents.clear();
    runnerAgents.clear();
    pausedAgents.clear();
  });

  it('success path: persists pause, removes agent from runnerAgents, returns mode=runner', async () => {
    runnerAgents.set('runner-agent-1', {
      taskId: 'task-r1',
      task: { id: 'task-r1', taskType: 'user', description: 'Runner task', metadata: {} },
      workspacePath: '/repo/worktree-r1',
      runId: 'run-r1',
      executionId: 'exec-r1'
    });
    getTaskById.mockResolvedValue({
      id: 'task-r1',
      taskType: 'user',
      description: 'Runner task',
      metadata: {}
    });
    pauseAgentViaRunner.mockResolvedValue({ success: true });

    const result = await pauseAgent('runner-agent-1', 'cost limit');

    expect(result).toMatchObject({ success: true, agentId: 'runner-agent-1', mode: 'runner' });
    expect(pauseAgentViaRunner).toHaveBeenCalledWith('runner-agent-1', 'cost limit');
    // Agent must be removed from runnerAgents after a successful pause
    expect(runnerAgents.has('runner-agent-1')).toBe(false);
    // pausedAgents is cleared by markAgentPaused + runnerAgents.delete path,
    // but the Set entry is set during the call. Verify overall success persisted.
    expect(updateAgent).toHaveBeenCalledWith('runner-agent-1', expect.objectContaining({
      status: 'paused',
      metadata: expect.objectContaining({ phase: 'paused', pauseReason: 'cost limit' })
    }));
    expect(updateTask).toHaveBeenCalledWith('task-r1', expect.objectContaining({
      status: 'blocked',
      metadata: expect.objectContaining({
        blockedCategory: 'agent-paused',
        pausedAgentId: 'runner-agent-1'
      })
    }), 'user');
  });

  it('failure path: pauseAgentViaRunner rejects → throws, pausedAgents rolled back, runnerAgents intact', async () => {
    runnerAgents.set('runner-agent-2', {
      taskId: 'task-r2',
      task: { id: 'task-r2', taskType: 'user', description: 'Runner task 2', metadata: {} },
      workspacePath: '/repo/worktree-r2'
    });
    pauseAgentViaRunner.mockResolvedValue({ success: false, error: 'runner unreachable' });

    await expect(pauseAgent('runner-agent-2', 'test-pause')).rejects.toMatchObject({
      message: 'runner unreachable',
      status: 500,
      code: 'AGENT_PAUSE_FAILED',
    });
    // pausedAgents must be rolled back when runner call fails
    expect(pausedAgents.has('runner-agent-2')).toBe(false);
    // runnerAgents must still contain the agent (not prematurely deleted)
    expect(runnerAgents.has('runner-agent-2')).toBe(true);
  });

  it('runner 404: a genuine runner-side 404 stays NOT_FOUND (not remapped to 500)', async () => {
    runnerAgents.set('runner-agent-3', {
      taskId: 'task-r3',
      task: { id: 'task-r3', taskType: 'user', description: 'Runner task 3', metadata: {} },
      workspacePath: '/repo/worktree-r3'
    });
    // pauseAgentViaRunner rejects with a status-carrying Error (runner restarted
    // out of sync with runnerAgents), which must be preserved as a 404.
    pauseAgentViaRunner.mockRejectedValue(
      Object.assign(new Error('Agent not found'), { status: 404 }),
    );

    await expect(pauseAgent('runner-agent-3', 'test-pause')).rejects.toMatchObject({
      message: 'Agent not found',
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(pausedAgents.has('runner-agent-3')).toBe(false);
    expect(runnerAgents.has('runner-agent-3')).toBe(true);
  });
});

// ─── pauseAgent — TUI branch ─────────────────────────────────────────────────

describe('pauseAgent — TUI branch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    activeAgents.clear();
    runnerAgents.clear();
    pausedAgents.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends ESC to the TUI session and schedules a delayed killSession', async () => {
    const sessionId = 'tui-session-99';
    activeAgents.set('tui-agent-1', {
      process: fakeChildProcess(),
      taskId: 'task-tui-1',
      tuiSessionId: sessionId,
      runId: 'run-tui-1',
      pid: 999,
      workspacePath: '/repo/worktree-tui',
      executionId: 'exec-tui-1'
    });
    getTaskById.mockResolvedValue({
      id: 'task-tui-1',
      taskType: 'user',
      description: 'TUI task',
      metadata: {}
    });

    const result = await pauseAgent('tui-agent-1', 'user request');

    expect(result).toMatchObject({ success: true, agentId: 'tui-agent-1', mode: 'tui' });
    // ESC written immediately
    expect(shellService.writeToSession).toHaveBeenCalledWith(sessionId, '\x1b');
    // killSession not yet called (scheduled with 250ms delay)
    expect(shellService.killSession).not.toHaveBeenCalled();

    // Advance past the 250ms delay; agent is still in activeAgents at this point
    vi.advanceTimersByTime(300);

    expect(shellService.killSession).toHaveBeenCalledWith(sessionId);
  });

  it('does NOT call process.kill (SIGTERM) for a TUI agent', async () => {
    const kill = vi.fn();
    activeAgents.set('tui-agent-2', {
      process: fakeChildProcess(kill),
      taskId: 'task-tui-2',
      tuiSessionId: 'tui-session-100',
      pid: 888,
      workspacePath: '/repo/worktree-tui2',
      executionId: 'exec-tui-2'
    });
    getTaskById.mockResolvedValue({
      id: 'task-tui-2',
      taskType: 'user',
      description: 'TUI task 2',
      metadata: {}
    });

    await pauseAgent('tui-agent-2');

    expect(kill).not.toHaveBeenCalled();
  });
});

// ─── pauseAgent — not found ───────────────────────────────────────────────────

describe('pauseAgent — agent not found', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeAgents.clear();
    runnerAgents.clear();
    pausedAgents.clear();
  });

  it('throws a 404 ServerError when agent is not in activeAgents or runnerAgents', async () => {
    await expect(pauseAgent('nonexistent-agent')).rejects.toMatchObject({
      message: 'Agent not found or not running',
      status: 404,
      code: 'NOT_FOUND',
    });
  });
});

// ─── resumeAgent ──────────────────────────────────────────────────────────────
//
// Resuming used to be a client-side illusion: the UI queued a brand-new
// `[Resume] <description>` task, so a SECOND agent spawned on a clean worktree,
// the paused agent's own task stayed `blocked` as `agent-paused` forever, and
// the paused record was never retired. These lock the real transition.

describe('resumeAgent — requeues the paused agent\'s own task', () => {
  const PAUSED_AGENT = {
    id: 'agent-paused-1',
    status: 'paused',
    taskId: 'task-abc',
    metadata: {
      isWorktree: true,
      worktreeBranch: 'cos/task-abc/agent-paused-1',
      workspacePath: '/tmp/worktrees/agent-paused-1',
      sourceWorkspace: '/tmp/repo',
      taskType: 'user',
    },
  };
  const PAUSED_TASK = {
    id: 'task-abc',
    taskType: 'user',
    description: 'Do the thing',
    status: 'blocked',
    metadata: {
      blockedCategory: 'agent-paused',
      pausedAgentId: 'agent-paused-1',
      pausedAt: '2026-08-10T00:00:00.000Z',
      resumeWorkspacePath: '/tmp/worktrees/agent-paused-1',
      resumeRunId: 'run-1',
      context: 'original context',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    pausedAgents.clear();
    getAgentRecord.mockResolvedValue(PAUSED_AGENT);
    getTaskById.mockResolvedValue(PAUSED_TASK);
    resolveTaskResumePatch.mockResolvedValue({
      existingBranch: 'cos/task-abc/agent-paused-1',
      resumedFromAgentId: 'agent-paused-1',
      resumeWorktreePath: '/tmp/worktrees/agent-paused-1',
    });
    forceSpawnTask.mockResolvedValue({ success: true, taskId: 'task-abc' });
    getAgents.mockResolvedValue([]);
  });

  it('flips the SAME task back to pending — no new task', async () => {
    const result = await resumeAgent('agent-paused-1');

    expect(result).toMatchObject({ success: true, taskId: 'task-abc', mode: 'requeued' });
    expect(addTask).not.toHaveBeenCalled();
    // ONLY the dialog's overrides (none here). Since #3730 the resume pointer and
    // the pause release are `updateTask`'s, so the Tasks-tab toggle and every other
    // door into this flip get them too — see the adapter suite below and
    // cosTaskStore.test.js for the transition itself.
    expect(reviveBlockedTask).toHaveBeenCalledWith('task-abc', { metadata: {} }, 'user');
    // Through reviveBlockedTask, NOT a raw updateTask: it also resets the
    // spawn/orphan budgets, so a task paused near MAX_TOTAL_SPAWNS doesn't resume
    // straight into `max-spawns`.
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('reports the branch the shared transition resumed on', async () => {
    reviveBlockedTask.mockResolvedValueOnce({ metadata: { existingBranch: 'cos/task-abc/agent-paused-1' } });
    await expect(resumeAgent('agent-paused-1')).resolves.toMatchObject({
      mode: 'requeued', branchName: 'cos/task-abc/agent-paused-1',
    });
  });

  it('reports a review-loop task’s canonical PR branch when no legacy duplicate exists', async () => {
    reviveBlockedTask.mockResolvedValueOnce({ metadata: {
      reviewLoopFollowUp: true,
      reviewLoopPRBranch: 'cos/task-abc/agent-pr',
    } });
    await expect(resumeAgent('agent-paused-1')).resolves.toMatchObject({
      mode: 'requeued', branchName: 'cos/task-abc/agent-pr',
    });
  });

  it('retires the paused agent record so it stops showing as paused', async () => {
    await resumeAgent('agent-paused-1');
    expect(markAgentComplete).toHaveBeenCalledWith('agent-paused-1', expect.objectContaining({
      success: false,
      resumed: true,
      resumedTaskId: 'task-abc',
    }));
  });

  it('requeues BEFORE retiring the record — the dequeue completeAgent triggers must see a pointed task', async () => {
    const order = [];
    reviveBlockedTask.mockImplementationOnce(async () => { order.push('reviveBlockedTask'); return true; });
    markAgentComplete.mockImplementationOnce(async () => { order.push('completeAgent'); });
    await resumeAgent('agent-paused-1');
    expect(order).toEqual(['reviveBlockedTask', 'completeAgent']);
  });

  it('appends dialog context to the task\'s own and applies provider/model/effort overrides', async () => {
    await resumeAgent('agent-paused-1', {
      context: 'extra guidance', provider: 'claude', model: 'claude-opus-5', effort: 'high',
    });
    const { metadata } = reviveBlockedTask.mock.calls[0][1];
    expect(metadata.context).toBe('original context\n\nextra guidance');
    expect(metadata).toMatchObject({ provider: 'claude', model: 'claude-opus-5', effort: 'high' });
  });

  it('leaves unspecified run settings alone — a blank dialog field is absence, not a clear', async () => {
    await resumeAgent('agent-paused-1', { provider: '', model: undefined, context: '' });
    const { metadata } = reviveBlockedTask.mock.calls[0][1];
    expect(metadata).not.toHaveProperty('provider');
    expect(metadata).not.toHaveProperty('model');
    expect(metadata).not.toHaveProperty('context');
  });

  it('still requeues (clean) when the paused run left nothing resumable behind', async () => {
    reviveBlockedTask.mockResolvedValueOnce({ metadata: {} });
    await expect(resumeAgent('agent-paused-1')).resolves.toMatchObject({ mode: 'requeued', branchName: null });
  });

  it('throws 404 for an unknown agent and 409 for one that is not paused', async () => {
    getAgentRecord.mockResolvedValueOnce(null);
    await expect(resumeAgent('nope')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });

    getAgentRecord.mockResolvedValueOnce({ ...PAUSED_AGENT, status: 'running' });
    await expect(resumeAgent('agent-paused-1')).rejects.toMatchObject({ status: 409, code: 'AGENT_NOT_PAUSED' });
    expect(reviveBlockedTask).not.toHaveBeenCalled();
  });

  it('falls back to a fresh task when the pause is spent — and still retires the record', async () => {
    // The task was revived and completed while the agent sat paused; requeueing
    // it would stomp that outcome.
    getTaskById.mockResolvedValue({ ...PAUSED_TASK, status: 'completed' });
    const result = await resumeAgent('agent-paused-1', { description: '[Resume] Do the thing' });

    expect(result).toMatchObject({ mode: 'new-task', taskId: 'sys-mocked' });
    expect(reviveBlockedTask).not.toHaveBeenCalled();
    expect(addTask).toHaveBeenCalledWith(
      expect.objectContaining({ description: '[Resume] Do the thing' }),
      'user',
    );
    expect(markAgentComplete).toHaveBeenCalled();
  });

  it('inherits the replaced task\'s app and run settings — a bare description is not runnable', async () => {
    getTaskById.mockResolvedValue({
      ...PAUSED_TASK,
      status: 'completed',
      metadata: { ...PAUSED_TASK.metadata, app: 'bookloom', provider: 'codex-tui', model: 'gpt-5.6-terra', effort: 'medium' },
    });
    await resumeAgent('agent-paused-1', { description: '[Resume] Do the thing', context: 'extra guidance' });
    expect(addTask).toHaveBeenCalledWith(expect.objectContaining({
      app: 'bookloom',
      provider: 'codex-tui',
      model: 'gpt-5.6-terra',
      effort: 'medium',
      context: 'original context\n\nextra guidance',
    }), 'user');
  });

  it('preserves the scheduled hook contract when replacing a spent task', async () => {
    const issueWatcher = {
      repoFullName: 'example/example',
      issueComments: [],
      pullRequests: [{ number: 7, headSha: 'a'.repeat(40) }],
    };
    getTaskById.mockResolvedValue({
      ...PAUSED_TASK,
      status: 'completed',
      metadata: {
        ...PAUSED_TASK.metadata,
        analysisType: 'issue-watcher',
        issueWatcher,
        outputHookDispatchedAt: '2026-08-30T00:00:00.000Z',
        totalSpawnCount: 3,
        autoRetryCount: 2,
        autoRetriedByInvestigation: 'sys-investigation',
        autoRetriedAt: '2026-08-29T00:00:00.000Z',
        autoRetryExhaustedAt: '2026-08-29T01:00:00.000Z',
        resolution: 'auto-expired',
        autoExpiredReason: 'investigation-resolved',
        autoExpiredAt: '2026-08-29T02:00:00.000Z',
      },
    });

    await resumeAgent('agent-paused-1', { description: '[Resume] Issue watcher' });

    const [replacement] = addTask.mock.calls[0];
    expect(replacement.metadata).toMatchObject({ analysisType: 'issue-watcher', issueWatcher });
    expect(replacement.metadata).not.toHaveProperty('outputHookDispatchedAt');
    expect(replacement.metadata).not.toHaveProperty('totalSpawnCount');
    for (const key of [
      'autoRetryCount', 'autoRetriedByInvestigation', 'autoRetriedAt', 'autoRetryExhaustedAt',
      'resolution', 'autoExpiredReason', 'autoExpiredAt',
    ]) expect(replacement.metadata).not.toHaveProperty(key);
  });

  it('leaves a LATER agent\'s pause intact and creates nothing', async () => {
    getTaskById.mockResolvedValue({
      ...PAUSED_TASK,
      metadata: { ...PAUSED_TASK.metadata, pausedAgentId: 'agent-someone-else' },
    });
    await expect(resumeAgent('agent-paused-1')).resolves.toMatchObject({ mode: 'superseded', taskId: 'task-abc' });
    expect(reviveBlockedTask).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
    // The stale record still retires — leaving it paused is what makes the NEXT
    // resume click read its own pause as spent and queue a duplicate.
    expect(markAgentComplete).toHaveBeenCalledWith('agent-paused-1', expect.objectContaining({ resumed: true }));
  });

  // The regression this whole mode exists for: something else (a dedupe revive, an
  // autopilot re-dispatch, a cooldown expiry, a human unblocking it) already put the
  // task back in flight. Queueing anything here is the "second agent" users saw.
  it.each(['pending', 'in_progress'])('creates nothing when the task is already %s', async (status) => {
    getTaskById.mockResolvedValue({ ...PAUSED_TASK, status, metadata: { context: 'original context' } });
    await expect(resumeAgent('agent-paused-1')).resolves.toMatchObject({ mode: 'already-active', taskId: 'task-abc' });
    expect(addTask).not.toHaveBeenCalled();
    expect(reviveBlockedTask).not.toHaveBeenCalled();
    expect(markAgentComplete).toHaveBeenCalledWith('agent-paused-1', expect.objectContaining({ resumed: true }));
  });

  // The lifecycle ledger (#4540) records a RESUME, not a retirement. The two
  // non-continuing modes retire the paused record without queueing anything, so
  // recording them would show a run going back to `running` that nothing runs.
  it('records run.resumed only for the modes that actually continued the work', async () => {
    appendRunEvent.mockClear();
    await resumeAgent('agent-paused-1');
    expect(appendRunEvent.mock.calls.map(([e]) => e).filter((e) => e.kind === 'run.resumed')).toEqual([
      expect.objectContaining({ agentId: 'agent-paused-1', data: expect.objectContaining({ mode: 'requeued' }) })
    ]);

    appendRunEvent.mockClear();
    getTaskById.mockResolvedValue({ ...PAUSED_TASK, status: 'in_progress', metadata: { context: 'original context' } });
    await resumeAgent('agent-paused-1');
    expect(appendRunEvent.mock.calls.map(([e]) => e).filter((e) => e.kind === 'run.resumed')).toHaveLength(0);
  });

  // A user asking to resume is an explicit dispatch, and reviveBlockedTask resets the
  // spawn/orphan budgets — so a task that fell into a LATER failure block restarts in
  // place rather than being duplicated onto a fresh task.
  it('requeues a task re-blocked for a non-pause reason instead of duplicating it', async () => {
    getTaskById.mockResolvedValue({
      ...PAUSED_TASK,
      metadata: { ...PAUSED_TASK.metadata, blockedCategory: 'pr-missing' },
    });
    await expect(resumeAgent('agent-paused-1')).resolves.toMatchObject({ mode: 'requeued', taskId: 'task-abc' });
    expect(addTask).not.toHaveBeenCalled();
  });

  it('falls back to a fresh task when the task was deleted outright', async () => {
    getTaskById.mockResolvedValue(null);
    await expect(resumeAgent('agent-paused-1')).resolves.toMatchObject({ mode: 'new-task' });
  });

  // The requeue only makes the task ELIGIBLE, and the automatic dequeue admits
  // system tasks only under CoS auto-run — so without an explicit dispatch a
  // resumed task sits `pending` until the user opens the task list and presses
  // Run, which is the two-step both Resume and Relaunch exist to avoid.
  it('force-spawns the requeued task instead of leaving it pending', async () => {
    const result = await resumeAgent('agent-paused-1');

    expect(forceSpawnTask).toHaveBeenCalledWith('task-abc');
    expect(result).toMatchObject({ spawned: true, spawnHold: null });
  });

  it('reports the refusal instead of claiming a resume that never started', async () => {
    // A full pool / paused daemon / unreachable runner all mean "stays queued".
    // Reporting `spawned: true` there is what would send the user to a task list
    // showing a pending task after a toast that said it was running.
    forceSpawnTask.mockResolvedValue({ error: 'No available agent slots (3/3)' });

    await expect(resumeAgent('agent-paused-1')).resolves.toMatchObject({
      mode: 'requeued', spawned: false, spawnHold: 'No available agent slots (3/3)',
    });
  });

  it('treats a task the racing dequeue already claimed as started, not as held', async () => {
    // `completeAgent` schedules a dequeue that can claim the task first; the
    // force-spawn then refuses because it is no longer `pending`. That is the
    // resume working, so the result must not report a hold.
    forceSpawnTask.mockImplementation(async () => {
      getTaskById.mockResolvedValue({ ...PAUSED_TASK, status: 'in_progress' });
      return { error: 'Task is in_progress, not pending' };
    });

    await expect(resumeAgent('agent-paused-1')).resolves.toMatchObject({ spawned: true, spawnHold: null });
  });

  // A spawn registers its agent as `running` BEFORE it flips the task off
  // `pending`, and the refusal that lands in that window is forceSpawnTask's own
  // holder guard. Reading the task status alone still sees `pending` there, so
  // the resume would report a hold for a run that is already under way — the
  // exact mis-report this dispatch exists to avoid.
  it('treats a task claimed mid-spawn as started, even while it still reads pending', async () => {
    forceSpawnTask.mockImplementation(async () => {
      getAgents.mockResolvedValue([{ id: 'agent-new-1', status: 'running', taskId: 'task-abc' }]);
      return { error: 'Agent agent-new-1 is already running this task' };
    });

    await expect(resumeAgent('agent-paused-1')).resolves.toMatchObject({ spawned: true, spawnHold: null });
  });

  it('does not dispatch a mode that deliberately queued nothing', async () => {
    // `already-active` means some other path already put the work in flight —
    // force-spawning here is the duplicate agent classifyResume exists to prevent.
    getTaskById.mockResolvedValue({ ...PAUSED_TASK, status: 'in_progress', metadata: { context: 'original context' } });

    await expect(resumeAgent('agent-paused-1')).resolves.toMatchObject({ mode: 'already-active', spawned: false });
    expect(forceSpawnTask).not.toHaveBeenCalled();
  });
});

// ─── relaunchAgent ────────────────────────────────────────────────────────────
//
// The stall this exists for: a RUNNING agent whose CLI is parked on a provider
// usage limit. Kill loses the worktree, Pause leaves the task parked — the
// recovery is "same task, different provider", which is a pause and a resume
// glued together. These lock the two things the gluing can get wrong: dropping
// the overrides, and resuming before the stopped process is actually gone.

describe('relaunchAgent — moves a running agent\'s task onto another provider', () => {
  const LIVE_AGENT = {
    id: 'agent-live-1',
    taskId: 'task-abc',
    metadata: { taskType: 'user', provider: 'claude', model: 'claude-opus-5' },
  };
  const PAUSED_TASK = {
    id: 'task-abc',
    taskType: 'user',
    description: 'Do the thing',
    status: 'blocked',
    metadata: {
      blockedCategory: 'agent-paused',
      pausedAgentId: 'agent-live-1',
      pausedAt: '2026-08-10T00:00:00.000Z',
      context: 'original context',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    activeAgents.clear();
    runnerAgents.clear();
    pausedAgents.clear();
    // The record flips through the same write production makes: markAgentPaused's
    // `updateAgent`. Hard-coding `paused` from the first read would let a relaunch
    // that never actually paused still pass.
    let paused = false;
    updateAgent.mockImplementation(async (_id, patch) => { if (patch?.status === 'paused') paused = true; });
    getAgentRecord.mockImplementation(async () => ({ ...LIVE_AGENT, status: paused ? 'paused' : 'running' }));
    getTaskById.mockResolvedValue(PAUSED_TASK);
    reviveBlockedTask.mockResolvedValue({ metadata: {} });
    forceSpawnTask.mockResolvedValue({ success: true, taskId: 'task-abc' });
    getAgents.mockResolvedValue([]);
  });

  it('requeues the SAME task with the new provider/model/effort — no second task', async () => {
    runnerAgents.set('agent-live-1', { taskId: 'task-abc', runId: 'run-1' });
    pauseAgentViaRunner.mockResolvedValue({ success: true });

    const result = await relaunchAgent('agent-live-1', {
      provider: 'codex', model: 'gpt-5', effort: 'high',
    });

    expect(result).toMatchObject({ success: true, taskId: 'task-abc', mode: 'requeued', relaunched: true });
    expect(addTask).not.toHaveBeenCalled();
    expect(reviveBlockedTask.mock.calls[0][1].metadata).toMatchObject({
      provider: 'codex', model: 'gpt-5', effort: 'high',
    });
  });

  it('waits for the stopped process to leave activeAgents before requeueing', async () => {
    // The close handler consumes the `pausedAgents` flag and drops the
    // `activeAgents` entry together. resumeAgent deletes that flag, so requeueing
    // before the exit lands leaves the close handler treating the exit as a
    // completion — which cleans up the worktree the relaunched task points at.
    activeAgents.set('agent-live-1', { process: fakeChildProcess(), taskId: 'task-abc' });
    let stillLiveAtRequeue = null;
    reviveBlockedTask.mockImplementation(async () => {
      stillLiveAtRequeue = activeAgents.has('agent-live-1');
      return { metadata: {} };
    });
    setTimeout(() => {
      // Through the real close-handler door, not a hand-rolled map delete: that
      // consumer is what releases the waiter, so a test that deleted the entries
      // itself would pass against a relaunch that never waited at all.
      consumePausedAgentExit('agent-live-1');
      activeAgents.delete('agent-live-1');
    }, 150);

    await relaunchAgent('agent-live-1', { provider: 'codex' });

    expect(stillLiveAtRequeue).toBe(false);
  });

  it('drops the model pinned to the provider it is moving off', async () => {
    // The whole point of a relaunch is leaving a provider that stopped answering.
    // `selectModelForTask` hands `metadata.model` to the CLI verbatim, so carrying
    // the old provider's model across would make the requeued run die on its first
    // spawn — the failure the relaunch was supposed to end.
    getTaskById.mockResolvedValue({
      ...PAUSED_TASK,
      metadata: { ...PAUSED_TASK.metadata, provider: 'claude', model: 'claude-opus-5', effort: 'high' },
    });
    runnerAgents.set('agent-live-1', { taskId: 'task-abc', runId: 'run-1' });
    pauseAgentViaRunner.mockResolvedValue({ success: true });

    await relaunchAgent('agent-live-1', { provider: 'codex' });

    const { metadata } = reviveBlockedTask.mock.calls[0][1];
    expect(metadata.provider).toBe('codex');
    expect(metadata.model).toBe('');
    expect(metadata.effort).toBe('');
  });

  it('leaves the model alone when the provider is unchanged — blank still means unchanged there', async () => {
    getTaskById.mockResolvedValue({
      ...PAUSED_TASK,
      metadata: { ...PAUSED_TASK.metadata, provider: 'claude', model: 'claude-opus-5' },
    });
    runnerAgents.set('agent-live-1', { taskId: 'task-abc', runId: 'run-1' });
    pauseAgentViaRunner.mockResolvedValue({ success: true });

    await relaunchAgent('agent-live-1', { provider: 'claude', effort: 'max' });

    const { metadata } = reviveBlockedTask.mock.calls[0][1];
    expect(metadata).not.toHaveProperty('model');
    expect(metadata.effort).toBe('max');
  });

  // Relaunch is a pause plus a resume, so the immediate dispatch is inherited from
  // `resumeAgent` rather than repeated here (its own refusal/race handling is
  // covered in the resume suite above). This locks the inheritance: a relaunch that
  // stopped passing the dispatch outcome through would silently go back to leaving
  // the task pending for a user to run by hand.
  it('starts the requeued task and passes the dispatch outcome through', async () => {
    runnerAgents.set('agent-live-1', { taskId: 'task-abc', runId: 'run-1' });
    pauseAgentViaRunner.mockResolvedValue({ success: true });

    const result = await relaunchAgent('agent-live-1', { provider: 'codex' });

    expect(forceSpawnTask).toHaveBeenCalledWith('task-abc');
    expect(result).toMatchObject({ relaunched: true, spawned: true, spawnHold: null });
  });

  it('refuses an agent that is not running, and one that does not exist', async () => {
    getAgentRecord.mockResolvedValue({ ...LIVE_AGENT, status: 'completed' });
    await expect(relaunchAgent('agent-live-1')).rejects.toMatchObject({
      status: 409, code: 'AGENT_NOT_RUNNING',
    });
    expect(reviveBlockedTask).not.toHaveBeenCalled();

    getAgentRecord.mockResolvedValue(null);
    await expect(relaunchAgent('nope')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});

// ─── Pause-release adapter (#3730) ────────────────────────────────────────────
//
// The agent-addressed half `cosTaskStore.updateTask` calls through, registered at
// this module's load. Exercised via the lib accessors — the same address the task
// store uses — so a registration that silently stops happening fails here. It is
// what makes an unblock from ANY door resume on the preserved worktree, not just
// the Resume dialog.

describe('pause-release adapter registration', () => {
  const PAUSED_AGENT = {
    id: 'agent-paused-9',
    status: 'paused',
    taskId: 'task-xyz',
    metadata: { isWorktree: true, worktreeBranch: 'cos/task-xyz/agent-paused-9', workspacePath: '/tmp/worktrees/agent-paused-9' },
  };
  const PAUSED_TASK = {
    id: 'task-xyz',
    status: 'blocked',
    metadata: { blockedCategory: 'agent-paused', pausedAgentId: 'agent-paused-9' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    pausedAgents.clear();
    getAgentRecord.mockResolvedValue(PAUSED_AGENT);
  });

  it('is wired at module load', () => {
    expect(hasPauseReleaseAdapter()).toBe(true);
  });

  it('resolves the pointer from the agent the task names', async () => {
    resolveTaskResumePatch.mockResolvedValue({ existingBranch: 'cos/task-xyz/agent-paused-9' });
    await expect(resolvePausedTaskResume(PAUSED_TASK)).resolves.toMatchObject({ existingBranch: 'cos/task-xyz/agent-paused-9' });
    expect(resolveTaskResumePatch).toHaveBeenCalledWith({
      task: PAUSED_TASK, agentId: 'agent-paused-9', agentMetadata: PAUSED_AGENT.metadata,
    });
  });

  it('resolves empty when the task names no paused agent', async () => {
    await expect(resolvePausedTaskResume({ id: 't', metadata: {} })).resolves.toEqual({});
    expect(resolveTaskResumePatch).not.toHaveBeenCalled();
  });

  it('retires the paused record immediately, with the verdict resumeAgent would write', async () => {
    pausedAgents.set('agent-paused-9', { pausedAt: 'now' });
    await retirePausedAgent('agent-paused-9', 'task-xyz', 'cos/task-xyz/agent-paused-9');
    expect(pausedAgents.has('agent-paused-9')).toBe(false);
    expect(markAgentComplete).toHaveBeenCalledWith('agent-paused-9', {
      success: false,
      resumed: true,
      resumedTaskId: 'task-xyz',
      error: 'Resumed agent agent-paused-9 — task task-xyz requeued on cos/task-xyz/agent-paused-9',
    });
  });

  it('is a no-op when the record is no longer paused — the second retire must not re-complete it', async () => {
    getAgentRecord.mockResolvedValue({ ...PAUSED_AGENT, status: 'completed' });
    await retirePausedAgent('agent-paused-9', 'task-xyz', null);
    expect(markAgentComplete).not.toHaveBeenCalled();
  });
});

// ─── Close-handler skip-finalization contract ─────────────────────────────────
//
// When a pausedAgents-flagged agent's process exits, the close handlers in
// agentCliSpawning.js (CLI), agentTuiSpawning.js (TUI), and
// agentLifecycle.js (runner handleAgentCompletion) must guard with
// `pausedAgents.has(agentId)` and return BEFORE calling finalizeAgent /
// cleanupWorktreeFn — so the worktree and task are preserved for a later resume.
//
// These tests use source-level assertions (matching the agentLifecycle.test.js
// convention) to lock the structural contract without requiring the full
// async dep chain to be wired up in this test suite.

describe('close-handler skip-finalization — source contract', () => {
  // Helper: extract the body of a function from source text.
  // Returns everything from the function's opening brace to its matched closing brace.
  function extractFunctionBody(src, fnSignatureSubstring) {
    const fnStart = src.indexOf(fnSignatureSubstring);
    if (fnStart === -1) return null;
    const braceStart = src.indexOf('{', fnStart);
    let depth = 0;
    for (let i = braceStart; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(braceStart, i + 1); }
    }
    return null;
  }

  it('CLI close handler guards with pausedAgents.has and returns before finalizeAgent', () => {
    // The real body lives in `handleClose`, not in the `claudeProcess.on('close')`
    // registration — that registration is a forwarding shim attached in the same
    // tick as spawn() so a fast-exiting child's close event isn't dropped while
    // the async setup is still yielding (#5791).
    const closeIdx = AGENT_CLI_SRC.indexOf('handleClose = async (code)');
    expect(closeIdx, 'CLI handleClose handler must exist').toBeGreaterThan(-1);

    // Extract the full callback body via brace-balancing rather than a fixed
    // slice — a try/catch crash-guard wrapper can push finalizeAgent past any
    // fixed window (see #1825).
    const closeBody = extractFunctionBody(AGENT_CLI_SRC, 'handleClose = async (code)');
    expect(closeBody, 'CLI handleClose handler body must be extractable').toBeTruthy();

    // Guard present
    expect(closeBody).toMatch(/pausedAgents\.has\(agentId\)/);

    // Guard appears BEFORE finalizeAgent in the close body
    const guardPos = closeBody.indexOf('pausedAgents.has(agentId)');
    const finalizePos = closeBody.indexOf('finalizeAgent(');
    expect(guardPos, 'pause guard must precede finalizeAgent call').toBeLessThan(finalizePos);

    // There is a `return` inside the pause guard block before finalizeAgent
    // (the guard block ends with a bare `return;` or `return` before reaching finalize)
    const guardBlock = closeBody.slice(guardPos, finalizePos);
    expect(guardBlock).toMatch(/\breturn\b/);
  });

  it('TUI finish() guards with pausedAgents.has and returns before finalizeAgent', () => {
    // finish() is defined as a const arrow-function inside spawnTuiAgent.
    // The signature is: const finish = async ({ ... }) => {
    // We need the body that starts at `=> {`, not the destructured params `{`.
    const finishIdx = AGENT_TUI_SRC.indexOf('const finish = async');
    expect(finishIdx, 'finish function must exist in agentTuiSpawning').toBeGreaterThan(-1);

    // Find the `=> {` that opens the arrow body (past the parameter list)
    const arrowIdx = AGENT_TUI_SRC.indexOf('=> {', finishIdx);
    expect(arrowIdx, "'=> {' of finish() must exist").toBeGreaterThan(finishIdx);

    // Extract body from the arrow body's `{` to its matched closing `}`
    const braceStart = arrowIdx + 3; // points at `{`
    let depth = 0;
    let bodyEnd = braceStart;
    for (let i = braceStart; i < AGENT_TUI_SRC.length; i++) {
      if (AGENT_TUI_SRC[i] === '{') depth++;
      else if (AGENT_TUI_SRC[i] === '}') { depth--; if (depth === 0) { bodyEnd = i; break; } }
    }
    const finishBody = AGENT_TUI_SRC.slice(braceStart, bodyEnd + 1);

    // Guard present
    expect(finishBody).toMatch(/pausedAgents\.has\(agentId\)/);

    // Guard appears BEFORE finalizeAgent
    const guardPos = finishBody.indexOf('pausedAgents.has(agentId)');
    const finalizePos = finishBody.indexOf('finalizeAgent(');
    expect(guardPos, 'pause guard must precede finalizeAgent in finish()').toBeLessThan(finalizePos);

    // There is a return inside the guard block before reaching finalizeAgent
    const guardBlock = finishBody.slice(guardPos, finalizePos);
    expect(guardBlock).toMatch(/\breturn\b/);
  });

  // The behavioral counterpart of this guard lives in
  // `agentCompletionRouting.test.js` — it calls the real `handleAgentCompletion`
  // with a paused agent and asserts nothing is completed. That is the durable
  // form (it survives extraction); this source check only pins the ORDERING
  // inside the router, which has no behavioral seam of its own.
  //
  // The window is the router's own brace-balanced body, and the assertion is
  // that the guard precedes BOTH ways out of it — the post-restart recovery
  // hand-off and the live in-memory path — rather than a bare `completeAgent(`,
  // which moved into `completeUntrackedAgentFromCosState` in #3872 and would
  // silently make this test vacuous (indexOf → -1) if it were still named here.
  it('runner handleAgentCompletion guards with pausedAgents.has and returns before either completion path', () => {
    const fnBody = extractFunctionBody(AGENT_LIFECYCLE_SRC, 'export async function handleAgentCompletion');
    expect(fnBody, 'handleAgentCompletion must exist and be extractable').toBeTruthy();

    // Guard present
    expect(fnBody).toMatch(/pausedAgents\.has\(agentId\)/);

    const guardPos = fnBody.indexOf('pausedAgents.has(agentId)');
    for (const [label, dispatch] of [
      ['post-restart recovery hand-off', 'completeUntrackedAgentFromCosState('],
      ['live in-memory completion path', 'withMapEntryCleanup('],
    ]) {
      const dispatchPos = fnBody.indexOf(dispatch);
      expect(dispatchPos, `${label} (${dispatch}) must exist in handleAgentCompletion`).toBeGreaterThan(-1);
      expect(guardPos, `pause guard must precede the ${label}`).toBeLessThan(dispatchPos);
      // There is a return inside the guard block (early exit before either path)
      expect(fnBody.slice(guardPos, dispatchPos)).toMatch(/\breturn\b/);
    }
  });

  it('runner pause guard also cleans up runnerAgents entry before returning', () => {
    // After returning early, the runner agent map entry must not be leaked.
    const fnBody = extractFunctionBody(AGENT_LIFECYCLE_SRC, 'export async function handleAgentCompletion');

    const guardPos = fnBody.indexOf('pausedAgents.has(agentId)');
    const returnAfterGuard = fnBody.indexOf('return', guardPos);
    // Between the guard and the early return, runnerAgents.delete must be called
    const guardToReturn = fnBody.slice(guardPos, returnAfterGuard + 10);
    expect(guardToReturn).toMatch(/runnerAgents\.delete\(agentId\)/);
  });
});

describe('terminate/kill drains batched output before completion — source contract', () => {
  function fnBody(src, signature) {
    const start = src.indexOf(signature);
    if (start === -1) return '';
    const braceStart = src.indexOf('{', start);
    let depth = 0;
    for (let i = braceStart; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(braceStart, i + 1); }
    }
    return '';
  }

  it('terminateRunnerAgent flushes the runner output batcher before completeAgent', () => {
    const body = fnBody(AGENT_MANAGEMENT_SRC, 'async function terminateRunnerAgent');
    expect(body).toMatch(/flushRunnerOutputBatcher\(agentId\)/);
    const flushPos = body.indexOf('flushRunnerOutputBatcher(agentId)');
    const completePos = body.indexOf('completeAgent(');
    expect(flushPos, 'runner batcher must drain before completeAgent').toBeGreaterThan(-1);
    expect(flushPos).toBeLessThan(completePos);
  });

  it('terminateAgent (direct) drains agent.flushOutput before completeAgent', () => {
    const body = fnBody(AGENT_MANAGEMENT_SRC, 'export async function terminateAgent');
    expect(body).toMatch(/agent\.flushOutput\?\.\(\)/);
    const flushPos = body.indexOf('agent.flushOutput?.()');
    const completePos = body.indexOf('completeAgent(');
    expect(flushPos).toBeLessThan(completePos);
  });

  it('killAgent (direct) drains agent.flushOutput before completeAgent', () => {
    const body = fnBody(AGENT_MANAGEMENT_SRC, 'export async function killAgent');
    expect(body).toMatch(/agent\.flushOutput\?\.\(\)/);
    const flushPos = body.indexOf('agent.flushOutput?.()');
    const completePos = body.indexOf('completeAgent(');
    expect(flushPos).toBeLessThan(completePos);
  });
});

// A server restart kills every agent PTY without running a completion hook, so
// the ONLY thing that retires those runs is this sweep. Before its retry carried a
// resume pointer, every restart-killed task was re-dispatched to a fresh agent
// with a fresh worktree, which redid work still sitting on disk.
describe('orphan retries resume what the dead run left behind', () => {
  const deadMetadata = { isWorktree: true, sourceWorkspace: '/repo', worktreeBranch: 'cos/task-1/agent-dead' };
  const deadAgent = { id: 'agent-dead', status: 'running', pid: null, taskId: 'task-1', metadata: deadMetadata };
  const pointer = { branchName: 'cos/task-1/agent-dead', worktreePath: '/w/agent-dead' };

  beforeEach(() => {
    vi.clearAllMocks();
    getAgents.mockResolvedValue([deadAgent]);
    getTaskById.mockResolvedValue({ id: 'task-1', taskType: 'user', status: 'in_progress', metadata: {} });
    resolveTaskResumePatch.mockResolvedValue({});
    activeAgents.clear();
    runnerAgents.clear();
  });

  // The sweep is the only place that knows an agent DIED rather than exited, so
  // it is the only place that can put that distinction in the ledger (#4540).
  it('records the reap in the lifecycle ledger, keyed by agent when no run id survived', async () => {
    await cleanupOrphanedAgents();

    expect(appendRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'run.orphan-recovered',
      agentId: 'agent-dead',
      taskId: 'task-1',
      runId: undefined,
      data: expect.objectContaining({ hasRunId: false, interruptedByRestart: false })
    }));
  });

  // The sweep re-runs every 15 minutes and can re-observe the same dead agent if
  // the completeAgent write never landed. The ledger's default id covers the
  // wall-clock timestamp, so without an explicit natural key a retry would file
  // a second "this agent died" fact for one death.
  it('keys the reap on the agent life, so a repeated sweep dedupes', async () => {
    await cleanupOrphanedAgents();
    await cleanupOrphanedAgents();

    const ids = appendRunEvent.mock.calls
      .filter(([e]) => e.kind === 'run.orphan-recovered')
      .map(([e]) => e.eventId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toContain('agent-dead');
  });

  it('hands the dead agent’s worktree metadata from the sweep to the retry handler', async () => {
    await cleanupOrphanedAgents();

    expect(resolveTaskResumePatch).toHaveBeenCalledWith({
      task: expect.objectContaining({ id: 'task-1' }),
      agentId: 'agent-dead',
      agentMetadata: deadMetadata
    });
  });

  // Ordering is the whole contract: the pointer must reflect what SURVIVED
  // cleanup, and must land in the SAME write that flips the task to pending —
  // that flip emits tasks:changed, which can spawn the retry immediately.
  it('resolves the pointer after worktree cleanup and writes it with the requeue', async () => {
    const order = [];
    cleanupAgentWorktree.mockImplementation(() => { order.push('cleanup'); });
    resolveTaskResumePatch.mockImplementation(() => {
      order.push('resolve');
      return Promise.resolve({ existingBranch: pointer.branchName, resumedFromAgentId: 'agent-dead', resumeWorktreePath: pointer.worktreePath });
    });
    updateTask.mockImplementation(() => { order.push('requeue'); return Promise.resolve(true); });

    await cleanupOrphanedAgents();

    expect(order).toEqual(['cleanup', 'resolve', 'requeue']);
    expect(updateTask).toHaveBeenCalledWith('task-1', {
      status: 'pending',
      metadata: expect.objectContaining({
        existingBranch: pointer.branchName,
        resumedFromAgentId: 'agent-dead',
        resumeWorktreePath: pointer.worktreePath
      })
    }, 'user');
  });

  it('skips the resume entirely when the dead agent had no task', async () => {
    getAgents.mockResolvedValue([{ ...deadAgent, taskId: null }]);

    await cleanupOrphanedAgents();

    expect(resolveTaskResumePatch).not.toHaveBeenCalled();
  });

  it('closes the orphaned run before completing the agent record', async () => {
    getAgents.mockResolvedValue([{
      ...deadAgent,
      startedAt: new Date(Date.now() - 1000).toISOString(),
      metadata: { ...deadMetadata, runId: 'run-orphan' },
      output: [{ line: 'last buffered line' }],
    }]);
    const order = [];
    completeAgentRun.mockImplementation(() => { order.push('run'); });
    markAgentComplete.mockImplementation(() => { order.push('agent'); });

    await cleanupOrphanedAgents();

    expect(completeAgentRun).toHaveBeenCalledWith(
      'run-orphan',
      'last buffered line',
      1,
      expect.any(Number),
      { message: 'Agent process terminated unexpectedly', category: 'orphaned' },
    );
    expect(order.slice(0, 2)).toEqual(['run', 'agent']);
  });

  it('skips run completion for legacy agents without a runId', async () => {
    await cleanupOrphanedAgents();

    expect(completeAgentRun).not.toHaveBeenCalled();
  });

  // A caller that doesn't know which agent died (resetOrphanedTasks on an archived
  // agent) still requeues — it just starts clean.
  it('requeues without a pointer when no agent metadata is available', async () => {
    getTaskById.mockResolvedValue({ id: 'task-1', taskType: 'user', status: 'in_progress', metadata: {} });

    await handleOrphanedTask('task-1', 'unknown-reset', getTaskById);

    expect(resolveTaskResumePatch).toHaveBeenCalledWith(expect.objectContaining({ agentMetadata: null }));
    expect(updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'pending' }), 'user');
  });

  it('checks for completed work in the orphaned agent’s actual workspace', async () => {
    committedDuringRun.mockResolvedValueOnce(true);
    getTaskById.mockResolvedValue({ id: 'task-1', taskType: 'user', status: 'in_progress', metadata: {} });

    await handleOrphanedTask('task-1', 'agent-dead', getTaskById, {
      agentMetadata: { workspacePath: '/example-app' },
      agentStartedAt: '2026-08-09T00:00:00.000Z',
    });

    expect(committedDuringRun).toHaveBeenCalledWith('/example-app', Date.parse('2026-08-09T00:00:00.000Z'));
    expect(updateTask).toHaveBeenCalledWith('task-1', { status: 'completed' }, 'user');
  });

  // `Date.parse(1754696324000)` stringifies its argument and returns NaN, which
  // would silently skip the probe for any caller holding an epoch-ms start time.
  it('accepts a raw epoch-ms start time, not just the persisted ISO string', async () => {
    committedDuringRun.mockResolvedValueOnce(true);
    getTaskById.mockResolvedValue({ id: 'task-1', taskType: 'user', status: 'in_progress', metadata: {} });

    await handleOrphanedTask('task-1', 'agent-dead', getTaskById, {
      agentMetadata: { workspacePath: '/example-app' },
      agentStartedAt: 1754696324000,
    });

    expect(committedDuringRun).toHaveBeenCalledWith('/example-app', 1754696324000);
    expect(updateTask).toHaveBeenCalledWith('task-1', { status: 'completed' }, 'user');
  });

  // Without a run window there is nothing to attribute a commit to — probing an
  // unbounded `git log` would credit this task with any commit already in the
  // repo, including another agent's, and complete a task that did nothing (#3637).
  it('skips the commit probe entirely when the dead run has no start time', async () => {
    getTaskById.mockResolvedValue({ id: 'task-1', taskType: 'user', status: 'in_progress', metadata: {} });

    await handleOrphanedTask('task-1', 'agent-dead', getTaskById, {
      agentMetadata: { workspacePath: '/example-app' },
    });

    expect(committedDuringRun).not.toHaveBeenCalled();
    expect(updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'pending' }), 'user');
  });
});

// The crash-recovery half of the retry hold (#3373). finalizeAgent left the task
// `in_progress` + held so nothing could dequeue its retry before the resume pointer
// landed; if the process dies before `releaseRetryHold` runs, the marker on disk is
// what stops the task being stranded non-spawnable forever.
describe('the orphan sweep finishes an interrupted retry transition (#3373)', () => {
  const heldTask = () => ({
    id: 'task-1',
    taskType: 'user',
    status: 'in_progress',
    metadata: { retryPendingCleanup: 'agent-dead', retryPendingSince: new Date().toISOString(), failureCount: 1 },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getAgents.mockResolvedValue([]);
    resolveTaskResumePatch.mockResolvedValue({});
    committedDuringRun.mockResolvedValue(false);
    activeAgents.clear();
    runnerAgents.clear();
  });

  // `clearAllMocks` keeps implementations, so hand the commit check back in the
  // state the suites after this one expect (no queued verdict).
  afterEach(() => {
    committedDuringRun.mockReset();
  });

  it('flips the held task to pending with the resume pointer and drops the marker', async () => {
    getTaskById.mockResolvedValue(heldTask());
    resolveTaskResumePatch.mockResolvedValue({ existingBranch: 'cos/task-1/agent-dead', resumedFromAgentId: 'agent-dead', resumeWorktreePath: null });

    await handleOrphanedTask('task-1', 'agent-dead', getTaskById, {
      agentMetadata: { isWorktree: true, sourceWorkspace: '/repo', worktreeBranch: 'cos/task-1/agent-dead' },
    });

    expect(updateTask).toHaveBeenCalledWith('task-1', {
      status: 'pending',
      metadata: {
        existingBranch: 'cos/task-1/agent-dead',
        resumedFromAgentId: 'agent-dead',
        resumeWorktreePath: null,
        retryPendingCleanup: undefined,
        retryPendingSince: undefined,
      },
    }, 'user');
  });

  // The verdict was already reached and already budgeted a retry — this is not a
  // fresh orphan, so it costs no orphan-retry budget and arms no cooldown.
  it('charges no orphan-retry budget for finishing the transition', async () => {
    getTaskById.mockResolvedValue(heldTask());

    await handleOrphanedTask('task-1', 'agent-dead', getTaskById, { agentMetadata: null });

    const [, update] = updateTask.mock.calls[0];
    expect(update.metadata.orphanRetryCount).toBeUndefined();
    expect(update.metadata.lastOrphanedAt).toBeUndefined();
  });

  // A failed run that committed is exactly what the resume pointer is FOR —
  // completing the task on that evidence would discard the granted retry.
  it('does not let the commit check complete a held task', async () => {
    getTaskById.mockResolvedValue(heldTask());
    committedDuringRun.mockResolvedValue(true);

    await handleOrphanedTask('task-1', 'agent-dead', getTaskById, { agentMetadata: null });

    expect(committedDuringRun).not.toHaveBeenCalled();
    expect(updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'pending' }), 'user');
  });

  // The sweep is NOT owner-scoped by design — whoever armed the hold is gone by
  // the time it looks, so a hold from any agent is recoverable.
  it('finishes a transition armed by an agent it was not told about', async () => {
    getTaskById.mockResolvedValue({ ...heldTask(), metadata: { retryPendingCleanup: 'agent-someone-else' } });

    await handleOrphanedTask('task-1', 'unknown-reset', getTaskById, { agentMetadata: null });

    expect(updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'pending' }), 'user');
  });

  // A user-terminated (or budget-exhausted) task is blocked and never held, so the
  // pre-existing guards still win over the hold branch.
  it('still skips a user-terminated task', async () => {
    getTaskById.mockResolvedValue({ id: 'task-1', taskType: 'user', status: 'blocked', metadata: { blockedCategory: 'user-terminated', retryPendingCleanup: 'agent-dead' } });

    await handleOrphanedTask('task-1', 'agent-dead', getTaskById, { agentMetadata: null });

    expect(updateTask).not.toHaveBeenCalled();
  });
});

// A PortOS restart kills every server-owned agent. Charging those runs the same
// retry budget as a self-inflicted crash meant three routine restarts blocked the
// task outright — and the second restart in the reported reproduction landed it in
// the 30-minute orphan cooldown instead of resuming it (#3202).
describe('host-restart interruptions are not charged orphan-retry budget (#3202)', () => {
  const deadMetadata = { isWorktree: true, sourceWorkspace: '/repo', worktreeBranch: 'cos/task-1/agent-dead' };
  const deadAgent = { id: 'agent-dead', status: 'running', pid: null, taskId: 'task-1', metadata: deadMetadata };

  beforeEach(() => {
    vi.clearAllMocks();
    getAgents.mockResolvedValue([deadAgent]);
    resolveTaskResumePatch.mockResolvedValue({ existingBranch: 'cos/task-1/agent-dead', resumedFromAgentId: 'agent-dead' });
    readHostShutdownMarker.mockResolvedValue(null);
    activeAgents.clear();
    runnerAgents.clear();
  });

  const requeuedMetadata = () => updateTask.mock.calls.at(-1)[1].metadata;

  it('requeues an interrupted run without incrementing orphanRetryCount or stamping lastOrphanedAt', async () => {
    getTaskById.mockResolvedValue({
      id: 'task-1', taskType: 'user', status: 'in_progress',
      metadata: { orphanRetryCount: 1, lastOrphanedAt: '2020-01-01T00:00:00.000Z' },
    });
    readHostShutdownMarker.mockResolvedValue({ at: '2026-07-29T00:00:00.000Z', signal: 'SIGTERM', agentIds: ['agent-dead'] });

    await cleanupOrphanedAgents();

    expect(updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'pending' }), 'user');
    const metadata = requeuedMetadata();
    // Budget untouched: same count, and the cooldown clock is NOT re-armed —
    // a later genuine orphan still measures its cooldown from the last genuine one.
    expect(metadata.orphanRetryCount).toBe(1);
    expect(metadata.lastOrphanedAt).toBe('2020-01-01T00:00:00.000Z');
    // ...but the interruption IS recorded, and the run stays resumable.
    expect(metadata.interruptedByRestart).toBe(true);
    expect(metadata.lastInterruptedAgentId).toBe('agent-dead');
    expect(metadata.existingBranch).toBe('cos/task-1/agent-dead');
  });

  it('resumes an interrupted run even at the orphan-retry ceiling', async () => {
    getTaskById.mockResolvedValue({
      id: 'task-1', taskType: 'user', status: 'in_progress',
      metadata: { orphanRetryCount: 3, totalSpawnCount: 3 },
    });
    readHostShutdownMarker.mockResolvedValue({ at: null, signal: 'SIGINT', agentIds: ['agent-dead'] });

    await cleanupOrphanedAgents();

    expect(updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'pending' }), 'user');
    expect(addTask).not.toHaveBeenCalled();
  });

  it('bypasses the orphan cooldown for an interrupted run', async () => {
    getTaskById.mockResolvedValue({
      id: 'task-1', taskType: 'user', status: 'in_progress',
      // Orphaned a minute ago — an ordinary orphan would be blocked on cooldown.
      metadata: { orphanRetryCount: 1, lastOrphanedAt: new Date(Date.now() - 60_000).toISOString() },
    });
    readHostShutdownMarker.mockResolvedValue({ at: null, signal: 'SIGTERM', agentIds: ['agent-dead'] });

    await cleanupOrphanedAgents();

    expect(updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'pending' }), 'user');
    expect(requeuedMetadata().blockedCategory).toBeUndefined();
  });

  it('still charges an agent NOT named in the marker (a genuine orphan alongside an interrupted one)', async () => {
    getTaskById.mockResolvedValue({
      id: 'task-1', taskType: 'user', status: 'in_progress',
      metadata: { orphanRetryCount: 1 },
    });
    // Marker names a DIFFERENT agent — this one really did die on its own.
    readHostShutdownMarker.mockResolvedValue({ at: null, signal: 'SIGTERM', agentIds: ['agent-other'] });

    await cleanupOrphanedAgents();

    const metadata = requeuedMetadata();
    expect(metadata.orphanRetryCount).toBe(2);
    expect(metadata.lastOrphanedAt).toEqual(expect.any(String));
    expect(metadata.interruptedByRestart).toBe(false);
  });

  // The metadata spread carries every prior key forward, so a task interrupted
  // once would otherwise read as restart-interrupted forever.
  it('clears a stale interruptedByRestart flag when the next orphan is genuine', async () => {
    getTaskById.mockResolvedValue({
      id: 'task-1', taskType: 'user', status: 'in_progress',
      metadata: { interruptedByRestart: true, lastInterruptedAt: '2026-07-29T00:00:00.000Z' },
    });

    await cleanupOrphanedAgents();

    expect(requeuedMetadata().interruptedByRestart).toBe(false);
  });

  // Callers that didn't watch the agent die (resetOrphanedTasks, post-restart
  // completion recovery) pass no verdict — the breadcrumb the abandon path
  // stamped on the agent supplies it, so correctness no longer rests on
  // cleanupOrphanedAgents happening to run first in cos.js's boot sequence.
  it('derives the interruption from the agent breadcrumb when the caller passes no verdict', async () => {
    getTaskById.mockResolvedValue({
      id: 'task-1', taskType: 'user', status: 'in_progress',
      metadata: { orphanRetryCount: 1 },
    });

    await handleOrphanedTask('task-1', 'agent-dead', getTaskById, {
      agentMetadata: { ...deadMetadata, interruptedBy: 'host-shutdown' },
    });

    const metadata = requeuedMetadata();
    expect(metadata.orphanRetryCount).toBe(1);
    expect(metadata.interruptedByRestart).toBe(true);
  });

  // The marker is best-effort — a stalled disk can blow the 1.5s shutdown grace.
  // The sweep must therefore pass a null verdict (not a bare `false`, which would
  // hard-override the `??` fallback) so the breadcrumb can still be honored. This
  // is the SWEEP path, not a direct handleOrphanedTask call: without it the
  // fallback is dead exactly where nearly all boot recovery happens.
  it('falls back to the breadcrumb through the sweep when the marker did not survive', async () => {
    getAgents.mockResolvedValue([
      { ...deadAgent, metadata: { ...deadMetadata, interruptedBy: 'host-shutdown' } },
    ]);
    getTaskById.mockResolvedValue({
      id: 'task-1', taskType: 'user', status: 'in_progress',
      metadata: { orphanRetryCount: 1, totalSpawnCount: 2 },
    });
    readHostShutdownMarker.mockResolvedValue(null); // marker lost

    await cleanupOrphanedAgents();

    const metadata = requeuedMetadata();
    expect(metadata.orphanRetryCount).toBe(1);
    expect(metadata.interruptedByRestart).toBe(true);
  });

  // The breadcrumb is consumed on use, like the marker. Left in place, a respawn
  // that dies before creating its own agent record would keep re-deriving
  // "interrupted" from it — and, because an interrupted run bypasses the
  // cooldown, respawn on every 15-minute sweep instead of once per 30 minutes.
  it('clears the breadcrumb once it has been honored', async () => {
    getTaskById.mockResolvedValue({ id: 'task-1', taskType: 'user', status: 'in_progress', metadata: {} });

    await handleOrphanedTask('task-1', 'agent-dead', getTaskById, {
      agentMetadata: { ...deadMetadata, interruptedBy: 'host-shutdown' },
    });

    expect(updateAgent).toHaveBeenCalledWith('agent-dead', { metadata: { interruptedBy: null } });
  });

  // totalSpawnCount is charged when the task goes in_progress, so the destroyed
  // run already consumed a spawn. Without the refund the fix only moves the
  // ceiling: the task still ends up blocked `max-retries` with a bogus
  // "investigate repeated agent orphaning" task filed against a healthy agent.
  it('refunds the spawn a restart destroyed so MAX_TOTAL_SPAWNS is not charged', async () => {
    getTaskById.mockResolvedValue({
      id: 'task-1', taskType: 'user', status: 'in_progress',
      metadata: { totalSpawnCount: 3 },
    });
    readHostShutdownMarker.mockResolvedValue({ at: null, signal: 'SIGTERM', agentIds: ['agent-dead'] });

    await cleanupOrphanedAgents();

    expect(requeuedMetadata().totalSpawnCount).toBe(2);
  });

  it('does not refund a spawn for a genuine orphan', async () => {
    getTaskById.mockResolvedValue({
      id: 'task-1', taskType: 'user', status: 'in_progress',
      metadata: { totalSpawnCount: 3 },
    });

    await cleanupOrphanedAgents();

    // Carried through the metadata spread unchanged — a genuine failure keeps
    // costing a spawn; only a restart is refunded.
    expect(requeuedMetadata().totalSpawnCount).toBe(3);
  });

  // A truncated/malformed marker parses to zero ids. Gating the clear on the id
  // count would leave that file on disk to be re-read on every boot and every
  // 15-minute sweep, forever.
  it('clears a marker that parsed to no agents at all', async () => {
    getTaskById.mockResolvedValue({ id: 'task-1', taskType: 'user', status: 'in_progress', metadata: {} });
    readHostShutdownMarker.mockResolvedValue({ at: null, signal: null, agentIds: [] });

    await cleanupOrphanedAgents();

    expect(clearHostShutdownMarker).toHaveBeenCalled();
  });

  it('flags the interruption on the agent record and consumes the marker', async () => {
    getTaskById.mockResolvedValue({ id: 'task-1', taskType: 'user', status: 'in_progress', metadata: {} });
    getAgents.mockResolvedValue([{
      ...deadAgent,
      metadata: { ...deadMetadata, runId: 'run-interrupted' },
    }]);
    readHostShutdownMarker.mockResolvedValue({ at: null, signal: 'SIGTERM', agentIds: ['agent-dead'] });

    await cleanupOrphanedAgents();

    expect(markAgentComplete).toHaveBeenCalledWith('agent-dead', expect.objectContaining({
      success: false,
      interruptedByRestart: true,
      error: expect.stringContaining('restart'),
    }));
    expect(completeAgentRun).toHaveBeenCalledWith(
      'run-interrupted',
      '',
      143,
      0,
      { message: expect.stringContaining('restart'), category: 'interrupted' },
    );
    expect(clearHostShutdownMarker).toHaveBeenCalled();
  });

  it('leaves the marker alone when it names nobody (nothing to reclassify)', async () => {
    getTaskById.mockResolvedValue({ id: 'task-1', taskType: 'user', status: 'in_progress', metadata: {} });

    await cleanupOrphanedAgents();

    expect(clearHostShutdownMarker).not.toHaveBeenCalled();
    expect(markAgentComplete).toHaveBeenCalledWith('agent-dead', expect.objectContaining({ interruptedByRestart: false }));
  });
});

// ─── Stranded paused records ──────────────────────────────────────────────────
//
// A pause is TWO halves: the agent record says `paused`, and its task holds the
// matching pause. Plenty of paths take the task half back without knowing about the
// agent — a dedupe revive, an autopilot re-dispatch, a cooldown expiry, a human
// unblocking it. Each left the record in `paused` forever, and because a stale pause
// reads as spent, the next resume click queued a duplicate task on a second agent.
describe('the sweep retires paused records whose task moved on', () => {
  const OLD_PAUSE = new Date('2026-08-10T00:00:00.000Z').toISOString();
  const pausedAgent = {
    id: 'agent-paused-9', status: 'paused', taskId: 'task-9', pausedAt: OLD_PAUSE, metadata: {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getAgents.mockResolvedValue([pausedAgent]);
    readHostShutdownMarker.mockResolvedValue(null);
    activeAgents.clear();
    runnerAgents.clear();
    pausedAgents.clear();
  });

  const livePause = {
    id: 'task-9', taskType: 'user', status: 'blocked',
    metadata: { blockedCategory: 'agent-paused', pausedAgentId: 'agent-paused-9' },
  };

  it('leaves a live pause alone — a user may resume it days later', async () => {
    getTaskById.mockResolvedValue(livePause);
    await cleanupOrphanedAgents();
    expect(markAgentComplete).not.toHaveBeenCalled();
  });

  it.each([
    ['the task is running again', { ...livePause, status: 'in_progress', metadata: {} }],
    ['a later agent owns the pause', { ...livePause, metadata: { blockedCategory: 'agent-paused', pausedAgentId: 'agent-other' } }],
    ['the task was deleted', null],
  ])('retires the record when %s', async (_label, task) => {
    getTaskById.mockResolvedValue(task);
    await cleanupOrphanedAgents();
    // `resumed: true` for the same reason resumeAgent uses it — this run has no
    // verdict of its own, so charging it an error invents a failure.
    expect(markAgentComplete).toHaveBeenCalledWith('agent-paused-9', expect.objectContaining({
      success: false, resumed: true, error: expect.stringContaining('Pause retired'),
    }));
  });

  it('leaves a just-paused record alone — markAgentPaused writes the agent before the task', async () => {
    getAgents.mockResolvedValue([{ ...pausedAgent, pausedAt: new Date().toISOString() }]);
    getTaskById.mockResolvedValue({ id: 'task-9', taskType: 'user', status: 'in_progress', metadata: {} });
    await cleanupOrphanedAgents();
    expect(markAgentComplete).not.toHaveBeenCalled();
  });

  it('leaves a paused record with no task alone — nothing proves the pause is spent', async () => {
    getAgents.mockResolvedValue([{ ...pausedAgent, taskId: null }]);
    await cleanupOrphanedAgents();
    expect(getTaskById).not.toHaveBeenCalled();
    expect(markAgentComplete).not.toHaveBeenCalled();
  });
});

// ─── Lifecycle ledger — pause / interruption boundaries (#4540) ──────────────

describe('lifecycle ledger — pause and interruption', () => {
  const ledgerCalls = (kind) => appendRunEvent.mock.calls.map(([e]) => e).filter((e) => e.kind === kind);

  beforeEach(() => {
    vi.clearAllMocks();
    activeAgents.clear();
    runnerAgents.clear();
    pausedAgents.clear();
    getTaskById.mockResolvedValue({ id: 'task-1', taskType: 'user', description: 'Do work', metadata: {} });
  });

  it('records a pause once, stamped with the same instant the agent record gets', async () => {
    // markAgentPaused is the single chokepoint both pause arms funnel through,
    // and `at: pausedAt` is what makes a retried persist file one paused event
    // instead of two.
    activeAgents.set('agent-1', { process: fakeChildProcess(), taskId: 'task-1', runId: 'run-1', pid: 123, workspacePath: '/repo/worktree' });

    await pauseAgent('agent-1', 'billing window');

    const [paused] = ledgerCalls('run.paused');
    expect(paused).toMatchObject({ runId: 'run-1', agentId: 'agent-1', taskId: 'task-1', data: { reason: 'billing window' } });
    const persisted = updateAgent.mock.calls.find(([id]) => id === 'agent-1')?.[1];
    expect(paused.at).toBe(persisted.pausedAt);
    clearTimeout(activeAgents.get('agent-1')?.killTimer);
  });

  it('writes no paused event when the persist that pause depends on failed', async () => {
    // Both pause arms roll their in-memory flag back when the persist throws.
    // An event written ahead of it would leave the projection reading `paused`
    // for a pause that never stuck — the exact class of lie the ledger exists
    // to catch.
    const kill = vi.fn();
    activeAgents.set('agent-1', { process: fakeChildProcess(kill), taskId: 'task-1', runId: 'run-1', pid: 123 });
    updateAgent.mockRejectedValueOnce(new Error('agent record unwritable'));

    await pauseAgent('agent-1', 'billing window').catch(() => null);

    expect(ledgerCalls('run.paused')).toHaveLength(0);
    clearTimeout(activeAgents.get('agent-1')?.killTimer);
  });

  it('records a termination REQUEST before either arm runs', async () => {
    activeAgents.set('agent-1', { process: fakeChildProcess(), taskId: 'task-1', runId: 'run-1', pid: 123 });

    await terminateAgent('agent-1');

    expect(ledgerCalls('run.interrupted')).toEqual([expect.objectContaining({
      runId: 'run-1',
      agentId: 'agent-1',
      taskId: 'task-1',
      data: expect.objectContaining({ reason: 'terminated-by-user', signal: 'SIGTERM', mode: 'direct' })
    })]);
    clearTimeout(activeAgents.get('agent-1')?.killTimer);
  });

  it('reads the ids out of the RUNNER map when that is where the agent lives', async () => {
    // A runner-spawned agent is absent from activeAgents entirely; a boundary
    // that consulted only that map would record the interrupt with no run id.
    runnerAgents.set('runner-1', { taskId: 'task-1', runId: 'run-9' });
    terminateAgentViaRunner.mockResolvedValue({ success: true });

    await terminateAgent('runner-1');

    expect(ledgerCalls('run.interrupted')).toEqual([expect.objectContaining({
      runId: 'run-9', agentId: 'runner-1', data: expect.objectContaining({ mode: 'runner' })
    })]);
  });

  it('writes nothing for a kill aimed at an agent that is already gone', async () => {
    // Nothing live to interrupt — minting an event here would create a
    // projection for a run that does not exist.
    await expect(killAgent('ghost')).rejects.toMatchObject({ status: 404 });
    expect(ledgerCalls('run.interrupted')).toHaveLength(0);
  });
});
