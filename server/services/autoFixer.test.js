import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// cos.js drags in a giant dependency graph (PM2, fs, sockets…) — mock it
// so autoFixer's defer/cancel behavior can be tested in isolation. Both
// exports the SUT touches are stubbed: `addTask` records what would be
// queued, `isRunning` toggles the running/not-running branches.
vi.mock('./cos.js', () => ({
  addTask: vi.fn().mockResolvedValue({ id: 'task-1' }),
  isRunning: vi.fn().mockReturnValue(true),
}));

const cos = await import('./cos.js');
const {
  noteFallbackHandled,
  initAutoFixer,
  getPendingAutoFixTasks,
  clearPendingAutoFixTasks,
  _resetAutoFixerForTests,
} = await import('./autoFixer.js');
const { errorEvents } = await import('../lib/errorHandler.js');

// initAutoFixer is idempotent — it must run once for the error-event
// listener to be attached, regardless of which test file boots first.
initAutoFixer();

function emitProviderFailure({ provider = 'Primary CLI', model = 'm-1', runId = 'run-1' } = {}) {
  errorEvents.emit('error', {
    code: 'AI_PROVIDER_EXECUTION_FAILED',
    message: `AI provider ${provider} execution failed: boom`,
    severity: 'error',
    canAutoFix: true,
    timestamp: Date.now(),
    context: {
      runId,
      provider,
      providerId: provider.toLowerCase().replace(/\s+/g, '-'),
      model,
      exitCode: 1,
    },
  });
}

describe('autoFixer — defer + noteFallbackHandled', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cos.addTask.mockClear();
    cos.isRunning.mockReturnValue(true);
    _resetAutoFixerForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetAutoFixerForTests();
  });

  it('defers task creation by ~5s instead of creating it immediately', async () => {
    emitProviderFailure({ provider: 'Primary CLI', model: 'm-1' });
    // Allow the synchronous emit + the IIFE's microtask queue to drain so
    // the deferred timer is set before we assert on it.
    await vi.advanceTimersByTimeAsync(0);

    // Task is NOT created right away — it's deferred.
    expect(cos.addTask).not.toHaveBeenCalled();

    // After the defer window elapses, the task is created.
    await vi.advanceTimersByTimeAsync(5500);
    expect(cos.addTask).toHaveBeenCalledTimes(1);
    expect(cos.addTask.mock.calls[0][0]).toMatchObject({
      description: 'Investigate AI provider failure: Primary CLI (m-1)',
    });
  });

  it('cancels the deferred task when noteFallbackHandled fires within the window', async () => {
    emitProviderFailure({ provider: 'Primary CLI', model: 'm-1' });
    await vi.advanceTimersByTimeAsync(0);

    // Fallback succeeded — call noteFallbackHandled BEFORE the defer elapses.
    const handled = noteFallbackHandled({ provider: 'Primary CLI', model: 'm-1' });
    expect(handled).toBe(true);

    // Advancing past the defer window must NOT trigger task creation.
    await vi.advanceTimersByTimeAsync(10000);
    expect(cos.addTask).not.toHaveBeenCalled();
  });

  it('returns false when noteFallbackHandled has no matching deferred task', async () => {
    const handled = noteFallbackHandled({ provider: 'Unknown', model: 'nope' });
    expect(handled).toBe(false);
  });

  it('matches the deferred task by exact provider+model (mismatched key does not cancel)', async () => {
    emitProviderFailure({ provider: 'Primary CLI', model: 'm-1' });
    await vi.advanceTimersByTimeAsync(0);

    // Wrong model — should not cancel.
    expect(noteFallbackHandled({ provider: 'Primary CLI', model: 'wrong-model' })).toBe(false);
    // Wrong provider name — should not cancel.
    expect(noteFallbackHandled({ provider: 'Other CLI', model: 'm-1' })).toBe(false);

    await vi.advanceTimersByTimeAsync(5500);
    expect(cos.addTask).toHaveBeenCalledTimes(1);
  });

  it('allows a future failure of the same provider to raise a new task after suppression (no 60s dedupe lockout)', async () => {
    emitProviderFailure({ provider: 'Primary CLI', model: 'm-1', runId: 'r-1' });
    await vi.advanceTimersByTimeAsync(0);
    noteFallbackHandled({ provider: 'Primary CLI', model: 'm-1' });
    await vi.advanceTimersByTimeAsync(10000);
    expect(cos.addTask).not.toHaveBeenCalled();

    // Same provider fails again later — must NOT be suppressed by the
    // dedupe map (which would otherwise hold the key for 60s).
    emitProviderFailure({ provider: 'Primary CLI', model: 'm-1', runId: 'r-2' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5500);
    expect(cos.addTask).toHaveBeenCalledTimes(1);
  });

  it('queues to pendingAutoFixTasks when CoS is not running', async () => {
    clearPendingAutoFixTasks();
    cos.isRunning.mockReturnValue(false);

    emitProviderFailure({ provider: 'Primary CLI', model: 'm-1' });
    await vi.advanceTimersByTimeAsync(5500);

    expect(cos.addTask).not.toHaveBeenCalled();
    const pending = getPendingAutoFixTasks();
    expect(pending).toHaveLength(1);
    expect(pending[0].description).toBe('Investigate AI provider failure: Primary CLI (m-1)');
    clearPendingAutoFixTasks();
  });

  it('clears the dedupe entry when deferred task creation fails so future failures can still raise tasks', async () => {
    // Simulate addTask rejecting (e.g. PLAN.md write error). Without the
    // dedupe-clear in the catch arm, the next identical failure would be
    // suppressed for 60s even though no investigation task ever landed.
    cos.addTask.mockRejectedValueOnce(new Error('plan write failed'));

    emitProviderFailure({ provider: 'Primary CLI', model: 'm-1', runId: 'r-1' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5500);
    // Drain the rejected addTask's microtask + the .catch's recentErrors.delete.
    await vi.advanceTimersByTimeAsync(0);

    // First attempt: addTask threw, so no task was created.
    expect(cos.addTask).toHaveBeenCalledTimes(1);

    // Second identical failure within the 60s dedupe window must NOT be
    // suppressed — the stale dedupe entry should have been cleared.
    emitProviderFailure({ provider: 'Primary CLI', model: 'm-1', runId: 'r-2' });
    await vi.advanceTimersByTimeAsync(5500);
    expect(cos.addTask).toHaveBeenCalledTimes(2);
  });

  it('does NOT collide on hyphenated provider/model pairs (uses an unambiguous separator)', async () => {
    // Regression: a `-`-joined dedupe key would treat
    // ("gpt-4o", "mini") and ("gpt", "4o-mini") as the same failure,
    // silently suppressing one with the other's deferred task.
    emitProviderFailure({ provider: 'gpt-4o', model: 'mini', runId: 'r-1' });
    emitProviderFailure({ provider: 'gpt', model: '4o-mini', runId: 'r-2' });
    await vi.advanceTimersByTimeAsync(5500);

    // Both distinct failures must schedule their own investigation task.
    expect(cos.addTask).toHaveBeenCalledTimes(2);
  });

  it('dedupes within the defer window — a second identical failure does not double-schedule', async () => {
    emitProviderFailure({ provider: 'Primary CLI', model: 'm-1', runId: 'r-1' });
    await vi.advanceTimersByTimeAsync(0);
    emitProviderFailure({ provider: 'Primary CLI', model: 'm-1', runId: 'r-2' });
    await vi.advanceTimersByTimeAsync(5500);

    // Only the first failure schedules a task; the second is dropped by
    // either isDuplicateError or the deferredTasks.has guard.
    expect(cos.addTask).toHaveBeenCalledTimes(1);
  });
});
