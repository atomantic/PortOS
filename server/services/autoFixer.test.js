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
  classifyFixTier,
  buildFixDiagnostics,
  FIX_TIERS,
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

  it('logs the actual failure reason + category + exit code inline (not just the provider)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      errorEvents.emit('error', {
        code: 'AI_PROVIDER_EXECUTION_FAILED',
        message: 'AI provider Claude Code CLI execution failed: …',
        severity: 'error',
        canAutoFix: true,
        timestamp: Date.now(),
        context: {
          runId: 'run-bad-model',
          provider: 'Claude Code CLI',
          providerId: 'claude-code',
          model: 'claude-opus-4-8',
          exitCode: 1,
          errorDetails: 'API Error (claude-opus-4-8): 400 The provided model identifier is invalid.',
          errorAnalysis: { category: 'model-not-found', message: 'API Error (claude-opus-4-8): 400 The provided model identifier is invalid.' },
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      const line = logSpy.mock.calls.map((c) => c[0]).find((m) => typeof m === 'string' && m.includes('AI provider error detected'));
      expect(line).toBeTruthy();
      expect(line).toContain('model identifier is invalid'); // the real reason, inline
      expect(line).toContain('model-not-found'); // the category
      expect(line).toContain('exit=1');
      expect(line).toContain('claude-opus-4-8'); // the model
    } finally {
      logSpy.mockRestore();
    }
  });

  it('never creates an investigation task for a content/safety refusal', async () => {
    // A refusal is self-explanatory (the model declined the prompt) — there's
    // nothing for a CoS agent to investigate, and the fallback path handles
    // recovery. Even if the failure arrives via AI_PROVIDER_EXECUTION_FAILED
    // with refusal analysis, the guard must suppress the task.
    errorEvents.emit('error', {
      code: 'AI_PROVIDER_EXECUTION_FAILED',
      message: 'AI provider Codex CLI execution failed: content refused',
      severity: 'error',
      canAutoFix: true,
      timestamp: Date.now(),
      context: {
        runId: 'run-refuse', provider: 'Codex CLI', providerId: 'codex', model: 'm-1',
        errorAnalysis: { category: 'content-refusal' },
      },
    });
    await vi.advanceTimersByTimeAsync(6000);
    expect(cos.addTask).not.toHaveBeenCalled();
  });

  it('suppresses the task for a SLOW fallback that finishes after the defer window', async () => {
    // The bug this fixes: a CLI fallback (Claude Code) can take 20–30s, far
    // longer than TASK_DEFER_MS. noteFallbackStarted cancels the backstop timer
    // immediately, so even though the success notice arrives late, no task fires.
    const { noteFallbackStarted } = await import('./autoFixer.js');
    emitProviderFailure({ provider: 'Ollama', model: 'command-r' });
    await vi.advanceTimersByTimeAsync(0);

    // Fallback starts almost immediately — cancels the deferred task.
    noteFallbackStarted({ provider: 'Ollama', model: 'command-r' });

    // The backstop window elapses with the fallback still running — no task.
    await vi.advanceTimersByTimeAsync(6000);
    expect(cos.addTask).not.toHaveBeenCalled();

    // Fallback finally succeeds ~25s later — still no task.
    noteFallbackHandled({ provider: 'Ollama', model: 'command-r' });
    await vi.advanceTimersByTimeAsync(25000);
    expect(cos.addTask).not.toHaveBeenCalled();
  });

  it('suppresses the task even when noteFallbackStarted races ahead of the error event', async () => {
    // Microtask-ordering guard: if the fallback is announced before the error
    // handler schedules its timer, the in-flight set still suppresses it.
    const { noteFallbackStarted } = await import('./autoFixer.js');
    noteFallbackStarted({ provider: 'Ollama', model: 'command-r' });
    emitProviderFailure({ provider: 'Ollama', model: 'command-r' });
    await vi.advanceTimersByTimeAsync(6000);
    expect(cos.addTask).not.toHaveBeenCalled();
  });

  it('noteFallbackFailed releases suppression so a later identical failure can raise a task', async () => {
    const { noteFallbackStarted, noteFallbackFailed } = await import('./autoFixer.js');
    noteFallbackStarted({ provider: 'Ollama', model: 'command-r' });
    noteFallbackFailed({ provider: 'Ollama', model: 'command-r' });

    // A fresh failure with no fallback in flight now schedules + fires a task.
    emitProviderFailure({ provider: 'Ollama', model: 'command-r' });
    await vi.advanceTimersByTimeAsync(6000);
    expect(cos.addTask).toHaveBeenCalledTimes(1);
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

function emitCriticalError(overrides = {}) {
  errorEvents.emit('error', {
    code: 'UNCAUGHT_EXCEPTION',
    message: 'boom',
    severity: 'critical',
    canAutoFix: true,
    timestamp: Date.now(),
    ...overrides,
  });
}

describe('autoFixer — generic critical-error auto-fix path', () => {
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

  it('requires approval — a bare crash is too thin a signal for an unsupervised agent to patch code', async () => {
    emitCriticalError({ message: 'Cannot read properties of undefined', stack: 'Error: boom\n    at foo (file.js:1:1)' });
    await vi.advanceTimersByTimeAsync(0);

    expect(cos.addTask).toHaveBeenCalledTimes(1);
    expect(cos.addTask.mock.calls[0][0]).toMatchObject({
      description: 'Fix critical error: Cannot read properties of undefined',
      approvalRequired: true,
    });
  });

  it('triggers on canAutoFix even when severity is not critical', async () => {
    emitCriticalError({ code: 'SOME_ERROR', message: 'recoverable-ish failure', severity: 'error' });
    await vi.advanceTimersByTimeAsync(0);

    expect(cos.addTask).toHaveBeenCalledTimes(1);
    expect(cos.addTask.mock.calls[0][0]).toMatchObject({ approvalRequired: true });
  });

  it('does not fire for a non-critical error that is not marked auto-fixable', async () => {
    emitCriticalError({ code: 'VALIDATION_ERROR', message: 'bad input', severity: 'error', canAutoFix: false });
    await vi.advanceTimersByTimeAsync(0);

    expect(cos.addTask).not.toHaveBeenCalled();
  });

  it('does not fire when CoS is not running', async () => {
    cos.isRunning.mockReturnValue(false);
    emitCriticalError();
    await vi.advanceTimersByTimeAsync(0);

    expect(cos.addTask).not.toHaveBeenCalled();
  });

  it('dedupes identical critical errors within the window', async () => {
    emitCriticalError();
    emitCriticalError();
    await vi.advanceTimersByTimeAsync(0);

    expect(cos.addTask).toHaveBeenCalledTimes(1);
  });
});

describe('autoFixer — circuit breaker (guardrail #3)', () => {
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

  // Distinct same-resource failures must be spaced past the 60s dedupe window,
  // otherwise isDuplicateError swallows them before the circuit ever counts.
  const DEDUPE_GAP_MS = 61000;

  it('AI-provider path: suppresses the task once the same resource fails >3 times within the hour', async () => {
    // First 3 distinct failures each raise an investigation task.
    for (let i = 0; i < 3; i++) {
      emitProviderFailure({ provider: 'Ollama', model: 'command-r', runId: `r-${i}` });
      await vi.advanceTimersByTimeAsync(5500); // let the deferred task fire
      await vi.advanceTimersByTimeAsync(DEDUPE_GAP_MS - 5500); // clear the dedupe window
    }
    expect(cos.addTask).toHaveBeenCalledTimes(3);

    // 4th failure within the same hour trips the circuit — no task scheduled.
    emitProviderFailure({ provider: 'Ollama', model: 'command-r', runId: 'r-4' });
    await vi.advanceTimersByTimeAsync(6000);
    expect(cos.addTask).toHaveBeenCalledTimes(3);
  });

  it('AI-provider path: the circuit auto-closes once failures age out of the 1h window', async () => {
    for (let i = 0; i < 4; i++) {
      emitProviderFailure({ provider: 'Ollama', model: 'command-r', runId: `r-${i}` });
      await vi.advanceTimersByTimeAsync(5500);
      await vi.advanceTimersByTimeAsync(DEDUPE_GAP_MS - 5500);
    }
    // 3 tasks (4th suppressed by the open circuit).
    expect(cos.addTask).toHaveBeenCalledTimes(3);

    // Let the whole failure burst age past the rolling 1h window.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1000);

    // A fresh failure now raises a task again — the circuit auto-closed.
    emitProviderFailure({ provider: 'Ollama', model: 'command-r', runId: 'r-late' });
    await vi.advanceTimersByTimeAsync(5500);
    expect(cos.addTask).toHaveBeenCalledTimes(4);
  });

  it('AI-provider path: the circuit is per-resource — a different provider is unaffected', async () => {
    for (let i = 0; i < 4; i++) {
      emitProviderFailure({ provider: 'Ollama', model: 'command-r', runId: `a-${i}` });
      await vi.advanceTimersByTimeAsync(5500);
      await vi.advanceTimersByTimeAsync(DEDUPE_GAP_MS - 5500);
    }
    expect(cos.addTask).toHaveBeenCalledTimes(3); // Ollama circuit open

    // A distinct provider/model still gets its investigation task.
    emitProviderFailure({ provider: 'LM Studio', model: 'qwen', runId: 'b-0' });
    await vi.advanceTimersByTimeAsync(5500);
    expect(cos.addTask).toHaveBeenCalledTimes(4);
  });

  it('AI-provider path: fallback-recovered failures do NOT count toward the circuit', async () => {
    // A failure that a fallback recovers never produces an investigation task,
    // so it must not push the resource toward the circuit threshold. Otherwise
    // a provider that always recovers via fallback would eventually suppress a
    // GENUINE unrecovered failure's investigation task.
    const { noteFallbackStarted, noteFallbackHandled } = await import('./autoFixer.js');
    for (let i = 0; i < 4; i++) {
      emitProviderFailure({ provider: 'Ollama', model: 'command-r', runId: `f-${i}` });
      await vi.advanceTimersByTimeAsync(0);
      noteFallbackStarted({ provider: 'Ollama', model: 'command-r' }); // cancels the deferred timer
      noteFallbackHandled({ provider: 'Ollama', model: 'command-r' }); // success — clears dedupe/in-flight
      await vi.advanceTimersByTimeAsync(DEDUPE_GAP_MS);
    }
    expect(cos.addTask).not.toHaveBeenCalled();

    // A genuine unrecovered failure now STILL raises a task — the circuit never
    // opened because recovered failures were never counted.
    emitProviderFailure({ provider: 'Ollama', model: 'command-r', runId: 'real' });
    await vi.advanceTimersByTimeAsync(5500);
    expect(cos.addTask).toHaveBeenCalledTimes(1);
  });

  it('generic critical-error path: suppresses the fix task once the same error fires >3 times within the hour', async () => {
    for (let i = 0; i < 3; i++) {
      emitCriticalError({ message: 'recurring boom' });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(DEDUPE_GAP_MS);
    }
    expect(cos.addTask).toHaveBeenCalledTimes(3);

    emitCriticalError({ message: 'recurring boom' });
    await vi.advanceTimersByTimeAsync(0);
    expect(cos.addTask).toHaveBeenCalledTimes(3); // circuit open — suppressed
  });
});

describe('autoFixer — tiered fallback classifier (guardrail #1, issue #2328)', () => {
  it('maps config/env-fixable categories to Tier 1', () => {
    for (const cat of ['auth-error', 'forbidden', 'model-not-found', 'model-not-supported',
      'quota-exceeded', 'billing-error', 'usage-limit', 'spawn-error', 'permission-denied', 'file-not-found']) {
      expect(classifyFixTier(cat).tier, cat).toBe(FIX_TIERS.CONFIG_ENV);
    }
  });

  it('maps schema/type/format categories to Tier 2', () => {
    for (const cat of ['parse-error', 'bad-request', 'context-length', 'output-length', 'build-error', 'lint-error']) {
      expect(classifyFixTier(cat).tier, cat).toBe(FIX_TIERS.SCHEMA_TYPE);
    }
  });

  it('maps transient/recoverable categories to Tier 3 (constrained-agent-retry)', () => {
    for (const cat of ['rate-limit', 'network-error', 'timeout', 'server-error', 'tool-error',
      'mcp-error', 'test-failure', 'npm-error', 'memory-error', 'turn-limit']) {
      expect(classifyFixTier(cat).tier, cat).toBe(FIX_TIERS.CONSTRAINED_RETRY);
    }
  });

  it('maps human-judgement categories to Tier 4 (escalate)', () => {
    for (const cat of ['content-refusal', 'content-filtered', 'task-rejected', 'git-conflict', 'unknown']) {
      expect(classifyFixTier(cat).tier, cat).toBe(FIX_TIERS.ESCALATE);
    }
  });

  it('escalates unknown/absent categories to Tier 4 (no silent swallow)', () => {
    expect(classifyFixTier('some-brand-new-category').tier).toBe(FIX_TIERS.ESCALATE);
    expect(classifyFixTier(undefined).tier).toBe(FIX_TIERS.ESCALATE);
    expect(classifyFixTier('').tier).toBe(FIX_TIERS.ESCALATE);
  });

  it('returns a stable {tier, strategy, label} shape', () => {
    const t1 = classifyFixTier('auth-error');
    expect(t1).toMatchObject({ tier: 1, strategy: 'config/env' });
    expect(typeof t1.label).toBe('string');
    expect(classifyFixTier('rate-limit').strategy).toBe('constrained-agent-retry');
    expect(classifyFixTier('unknown').strategy).toBe('escalate');
  });
});

describe('autoFixer — structured per-attempt diagnostics (issue #2328)', () => {
  it('builds a full diagnostics record from trigger/target/category/reason', () => {
    const d = buildFixDiagnostics({
      triggerEvent: 'AI_PROVIDER_EXECUTION_FAILED',
      target: 'Claude Code CLI (claude-opus-4-8)',
      category: 'model-not-found',
      failureReason: 'API Error (claude-opus-4-8): 400 The provided model identifier is invalid.',
    });
    expect(d).toMatchObject({
      triggerEvent: 'AI_PROVIDER_EXECUTION_FAILED',
      target: 'Claude Code CLI (claude-opus-4-8)',
      errorType: 'model-not-found',
      category: 'model-not-found',
      tier: FIX_TIERS.CONFIG_ENV,
      fixStrategy: 'config/env',
    });
    expect(d.failureReason).toContain('model identifier is invalid');
  });

  it('collapses a multi-line failure reason to one line and fills sensible defaults', () => {
    const d = buildFixDiagnostics({ failureReason: 'line one\n\n  line two   \nline three' });
    expect(d.failureReason).toBe('line one line two line three');
    expect(d.triggerEvent).toBe('unknown');
    expect(d.target).toBe('unknown');
    expect(d.category).toBe('unknown');
    expect(d.tier).toBe(FIX_TIERS.ESCALATE);
  });

  it("reports 'no error text captured' when no reason is supplied", () => {
    expect(buildFixDiagnostics({ category: 'auth-error' }).failureReason).toBe('no error text captured');
  });

  it('stamps observedAt — the injected value when given, else a valid ISO now (#2328)', () => {
    const at = '2026-07-09T10:00:00.000Z';
    expect(buildFixDiagnostics({ category: 'auth-error', observedAt: at }).observedAt).toBe(at);
    // Default: a parseable ISO timestamp so the telemetry aggregator can derive
    // time-to-recovery from it.
    const defaulted = buildFixDiagnostics({ category: 'auth-error' }).observedAt;
    expect(typeof defaulted).toBe('string');
    expect(Number.isFinite(Date.parse(defaulted))).toBe(true);
  });
});

describe('autoFixer — diagnostics ride on the created task record (issue #2328)', () => {
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

  it('attaches tier-classified diagnostics to the AI-provider investigation task', async () => {
    errorEvents.emit('error', {
      code: 'AI_PROVIDER_EXECUTION_FAILED',
      message: 'AI provider Claude Code CLI execution failed: …',
      severity: 'error',
      canAutoFix: true,
      timestamp: Date.now(),
      context: {
        runId: 'run-diag', provider: 'Claude Code CLI', providerId: 'claude-code',
        model: 'claude-opus-4-8', exitCode: 1,
        errorDetails: 'API Error (claude-opus-4-8): 400 The provided model identifier is invalid.',
        errorAnalysis: { category: 'model-not-found', message: 'model identifier is invalid' },
      },
    });
    await vi.advanceTimersByTimeAsync(5500);

    expect(cos.addTask).toHaveBeenCalledTimes(1);
    const taskArg = cos.addTask.mock.calls[0][0];
    expect(taskArg.diagnostics).toMatchObject({
      triggerEvent: 'AI_PROVIDER_EXECUTION_FAILED',
      target: 'Claude Code CLI (claude-opus-4-8)',
      category: 'model-not-found',
      tier: FIX_TIERS.CONFIG_ENV,
      fixStrategy: 'config/env',
    });
    expect(taskArg.diagnostics.failureReason).toContain('model identifier is invalid');
    // Diagnostics are also embedded in the agent-facing context markdown.
    expect(taskArg.context).toContain('## Fallback Tier');
    expect(taskArg.context).toContain('Tier:** 1 (config/env)');
  });

  it('emits the tier inline on the "AI provider error detected" log line', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      emitProviderFailure({ provider: 'Ollama', model: 'command-r' });
      await vi.advanceTimersByTimeAsync(0);
      const line = logSpy.mock.calls.map((c) => c[0]).find((m) => typeof m === 'string' && m.includes('AI provider error detected'));
      expect(line).toBeTruthy();
      expect(line).toMatch(/tier=\d/);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('attaches diagnostics to the pending record when CoS is not running', async () => {
    clearPendingAutoFixTasks();
    cos.isRunning.mockReturnValue(false);
    emitProviderFailure({ provider: 'LM Studio', model: 'qwen', runId: 'p-1' });
    await vi.advanceTimersByTimeAsync(5500);

    const pending = getPendingAutoFixTasks();
    expect(pending).toHaveLength(1);
    expect(pending[0].diagnostics).toMatchObject({
      triggerEvent: 'AI_PROVIDER_EXECUTION_FAILED',
      target: 'LM Studio (qwen)',
      tier: FIX_TIERS.ESCALATE, // no errorAnalysis category → unknown → escalate
    });
    clearPendingAutoFixTasks();
  });

  it('attaches diagnostics to the generic critical-error fix task', async () => {
    emitCriticalError({ code: 'UNCAUGHT_EXCEPTION', message: 'Cannot read properties of undefined' });
    await vi.advanceTimersByTimeAsync(0);

    expect(cos.addTask).toHaveBeenCalledTimes(1);
    expect(cos.addTask.mock.calls[0][0].diagnostics).toMatchObject({
      triggerEvent: 'UNCAUGHT_EXCEPTION',
      target: 'UNCAUGHT_EXCEPTION',
      tier: FIX_TIERS.ESCALATE,
    });
  });
});
