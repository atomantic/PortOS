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

vi.mock('./cos.js', () => ({
  updateTask: vi.fn().mockResolvedValue(true),
  addTask: vi.fn().mockResolvedValue({ id: 'sys-mocked' }),
  getTaskById: vi.fn(),
  getAllTasks: vi.fn()
}));

vi.mock('./cosEvents.js', () => ({
  emitLog: vi.fn()
}));

vi.mock('./agentRunTracking.js', () => ({
  checkForTaskCommit: vi.fn().mockResolvedValue(false)
}));

// Stub other transitive imports we don't exercise in handleOrphanedTask.
vi.mock('./cosAgents.js', () => ({ completeAgent: vi.fn(), updateAgent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./cosRunnerClient.js', () => ({
  terminateAgentViaRunner: vi.fn(),
  killAgentViaRunner: vi.fn(),
  pauseAgentViaRunner: vi.fn(),
  getAgentStatsFromRunner: vi.fn(),
  getActiveAgentsFromRunner: vi.fn().mockResolvedValue([])
}));
vi.mock('./agents.js', () => ({ unregisterSpawnedAgent: vi.fn() }));
vi.mock('./executionLanes.js', () => ({ release: vi.fn() }));
vi.mock('./toolStateMachine.js', () => ({ completeExecution: vi.fn(), errorExecution: vi.fn() }));
vi.mock('./shell.js', () => ({ writeToSession: vi.fn(), killSession: vi.fn() }));
vi.mock('./agentWorktreeCleanup.js', () => ({ cleanupAgentWorktree: vi.fn() }));
vi.mock('./agentRunnerSync.js', () => ({ syncRunnerAgents: vi.fn().mockResolvedValue(0) }));
vi.mock('./agentRunnerOutputBatchers.js', () => ({ flushRunnerOutputBatcher: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./worktreeManager.js', () => ({ cleanupOrphanedWorktrees: vi.fn() }));
vi.mock('./creativeDirector/local.js', () => ({
  updateRun: vi.fn().mockResolvedValue(undefined),
  getProject: vi.fn().mockResolvedValue(null),
}));
vi.mock('./creativeDirector/planAdvance.js', () => ({ advanceAfterPlanStepSettled: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./creativeDirector/completionHook.js', () => ({ advanceAfterSceneSettled: vi.fn().mockResolvedValue(undefined) }));

import { handleOrphanedTask, pauseAgent, settleOrphanedCreativeDirectorRun } from './agentManagement.js';
import { updateRun, getProject } from './creativeDirector/local.js';
import { advanceAfterPlanStepSettled } from './creativeDirector/planAdvance.js';
import { advanceAfterSceneSettled } from './creativeDirector/completionHook.js';
import { updateTask, addTask, getTaskById } from './cos.js';
import { updateAgent } from './cosAgents.js';
import { pauseAgentViaRunner } from './cosRunnerClient.js';
import * as shellService from './shell.js';
import { activeAgents, runnerAgents, pausedAgents } from './agentState.js';

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

  it('requires approval on the investigation task once orphan retries are exhausted', async () => {
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

    await handleOrphanedTask('task-foo', 'agent-orphaned', getTaskById);

    expect(addTask).toHaveBeenCalledTimes(1);
    expect(addTask.mock.calls[0][0]).toMatchObject({
      description: expect.stringContaining('[Auto-Fix] Investigate repeated agent orphaning'),
      approvalRequired: true,
    });
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
      process: { kill },
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
      process: { kill: vi.fn() },
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
      process: { kill },
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
    // The guard appears in the claudeProcess.on('close', ...) callback.
    const closeIdx = AGENT_CLI_SRC.indexOf("claudeProcess.on('close'");
    expect(closeIdx, "claudeProcess 'close' handler must exist").toBeGreaterThan(-1);

    // Extract the full callback body via brace-balancing rather than a fixed
    // slice — a try/catch crash-guard wrapper can push finalizeAgent past any
    // fixed window (see #1825).
    const closeBody = extractFunctionBody(AGENT_CLI_SRC, "claudeProcess.on('close'");
    expect(closeBody, "claudeProcess 'close' handler body must be extractable").toBeTruthy();

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

  it('runner handleAgentCompletion guards with pausedAgents.has and returns before completeAgent', () => {
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('export async function handleAgentCompletion');
    expect(fnStart, 'handleAgentCompletion must exist').toBeGreaterThan(-1);

    const fnBody = AGENT_LIFECYCLE_SRC.slice(fnStart, fnStart + 6000);

    // Guard present
    expect(fnBody).toMatch(/pausedAgents\.has\(agentId\)/);

    // Guard appears BEFORE the main completeAgent / finalizeAgent calls
    const guardPos = fnBody.indexOf('pausedAgents.has(agentId)');
    const completePos = fnBody.indexOf('completeAgent(');
    expect(guardPos, 'pause guard must precede completeAgent in handleAgentCompletion').toBeLessThan(completePos);

    // There is a return inside the guard block (early exit before finalization)
    const guardBlock = fnBody.slice(guardPos, completePos);
    expect(guardBlock).toMatch(/\breturn\b/);
  });

  it('runner pause guard also cleans up runnerAgents entry before returning', () => {
    // After returning early, the runner agent map entry must not be leaked.
    const fnStart = AGENT_LIFECYCLE_SRC.indexOf('export async function handleAgentCompletion');
    const fnBody = AGENT_LIFECYCLE_SRC.slice(fnStart, fnStart + 6000);

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
