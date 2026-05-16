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

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  checkForTaskCommit: vi.fn().mockReturnValue(false)
}));

// Stub other transitive imports we don't exercise in handleOrphanedTask.
vi.mock('./cosAgents.js', () => ({ completeAgent: vi.fn() }));
vi.mock('./cosRunnerClient.js', () => ({
  terminateAgentViaRunner: vi.fn(),
  killAgentViaRunner: vi.fn(),
  getAgentStatsFromRunner: vi.fn(),
  getActiveAgentsFromRunner: vi.fn().mockResolvedValue([])
}));
vi.mock('./agents.js', () => ({ unregisterSpawnedAgent: vi.fn() }));
vi.mock('./agentLifecycle.js', () => ({
  cleanupAgentWorktree: vi.fn(),
  syncRunnerAgents: vi.fn().mockResolvedValue(0)
}));
vi.mock('./worktreeManager.js', () => ({ cleanupOrphanedWorktrees: vi.fn() }));

import { handleOrphanedTask } from './agentManagement.js';
import { updateTask, addTask } from './cos.js';

describe('handleOrphanedTask — duplicate-investigation guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
