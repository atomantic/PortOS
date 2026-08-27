/**
 * `recalculateDurationStats` re-derives the success-only duration ETAs by
 * scanning the agent ARCHIVE directly, bypassing `recordTaskCompletion`. That
 * makes it the second reader of `result.validationPassed`, and it applies the
 * same exit-code fallback the #4107 skip sentinel exists to bypass — so a run
 * the live path declined to record could otherwise come back in here and bank
 * its duration anyway. These tests pin that it doesn't.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The archive layout the scan walks: AGENTS_DIR/<YYYY-MM-DD>/<agentId>/metadata.json.
// The root is inlined in both factories below — `vi.mock` is hoisted above every
// top-level binding, so a shared const would be in its TDZ when they run.
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true)
}));

vi.mock('fs/promises', () => ({
  readdir: vi.fn(async (path) => (
    path === '/tmp/portos-test-agents'
      ? [{ name: '2026-08-14', isDirectory: () => true }]
      : [{ name: 'agent-a', isDirectory: () => true }, { name: 'agent-b', isDirectory: () => true }]
  ))
}));

vi.mock('./store.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    AGENTS_DIR: '/tmp/portos-test-agents',
    tryReadFile: vi.fn(),
    loadLearningData: vi.fn(),
    saveLearningData: vi.fn(async () => {}),
    emitLog: vi.fn()
  };
});

import { recalculateDurationStats } from './metrics.js';
import { tryReadFile, loadLearningData, saveLearningData } from './store.js';
import { SKIP_LEARNING_VERDICT } from '../../lib/learningVerdict.js';
import { readdir } from 'fs/promises';
import { join } from 'path';

const makeData = () => ({
  version: 1,
  byTaskType: {
    'internal-task': {
      completed: 2, succeeded: 2, failed: 0,
      totalDurationMs: 0, successDurationMs: 999, successMaxDurationMs: 999,
      avgDurationMs: 0, maxDurationMs: 0, p80DurationMs: 0
    }
  },
  byModelTier: {},
  errorPatterns: {},
  totals: { completed: 2, succeeded: 2, failed: 0, totalDurationMs: 0, successDurationMs: 999, successMaxDurationMs: 999 }
});

// Two archived runs, both exit-0, both 60s — they differ ONLY in the verdict.
const archived = (validationPassed) => JSON.stringify({
  metadata: { taskType: 'internal', taskDescription: 'Study the app' },
  result: { success: true, duration: 60000, validationPassed }
});

describe('recalculateDurationStats — skip verdict (#4107)', () => {
  let saved;

  beforeEach(() => {
    vi.clearAllMocks();
    saved = null;
    loadLearningData.mockImplementation(async () => makeData());
    saveLearningData.mockImplementation(async (data) => { saved = data; });
  });

  it('excludes an archived run whose hook aborted before evaluating it', async () => {
    tryReadFile.mockImplementation(async () => archived(SKIP_LEARNING_VERDICT));

    const out = await recalculateDurationStats();

    // Both archived runs are skipped, so the reset-to-zero success totals stay zero
    // rather than picking the exit-code fallback back up.
    expect(out.successfulAgents ?? out.successCount ?? 0).toBe(0);
    expect(saved.totals.successDurationMs).toBe(0);
    expect(saved.byTaskType['internal-task'].successDurationMs).toBe(0);
  });

  it('still counts an archived run with NO verdict via the exit-code fallback', async () => {
    // The regression guard: the skip must not have swallowed the ordinary
    // predates-validationPassed path this rebuild depends on.
    tryReadFile.mockImplementation(async () => archived(undefined));

    await recalculateDurationStats();

    expect(saved.totals.successDurationMs).toBe(120000); // 2 runs × 60s
    expect(saved.byTaskType['internal-task'].successDurationMs).toBe(120000);
  });

  it('still excludes an archived run that MISSED its declared criterion', async () => {
    tryReadFile.mockImplementation(async () => archived(false));

    await recalculateDurationStats();

    expect(saved.totals.successDurationMs).toBe(0);
  });

  it('uses async directory traversal and limits concurrent metadata reads', async () => {
    const agentDirs = Array.from({ length: 25 }, (_, index) => ({
      name: `agent-${index}`,
      isDirectory: () => true
    }));
    readdir.mockImplementation(async (path) => (
      path === '/tmp/portos-test-agents'
        ? [{ name: '2026-08-14', isDirectory: () => true }]
        : agentDirs
    ));

    let activeReads = 0;
    let maxActiveReads = 0;
    tryReadFile.mockImplementation(async () => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, 0));
      activeReads -= 1;
      return archived(undefined);
    });

    await recalculateDurationStats();

    expect(readdir).toHaveBeenCalledWith('/tmp/portos-test-agents', { withFileTypes: true });
    // The scan joins with path.join, so the date-dir separator is platform-native (Windows CI).
    expect(readdir).toHaveBeenCalledWith(join('/tmp/portos-test-agents', '2026-08-14'), { withFileTypes: true });
    expect(tryReadFile).toHaveBeenCalledTimes(25);
    expect(maxActiveReads).toBe(20);
  });
});
