import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks for spawnTuiAgent tests ──────────────────────────────────────────
// All vi.mock calls must be at the top level before any imports.

vi.mock('./shell.js', () => ({
  createShellSession: vi.fn(),
  writeToSession: vi.fn(),
  killSession: vi.fn(),
  getSession: vi.fn(),
  getSessionProcess: vi.fn()
}));

vi.mock('./cosEvents.js', () => ({
  emitLog: vi.fn()
}));

vi.mock('./cosAgents.js', () => ({
  appendAgentOutputLines: vi.fn().mockResolvedValue(undefined),
  updateAgent: vi.fn().mockResolvedValue(undefined),
  completeAgent: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./agents.js', () => ({
  registerSpawnedAgent: vi.fn(),
  unregisterSpawnedAgent: vi.fn()
}));

vi.mock('./providerStatus.js', () => ({
  markProviderUsageLimit: vi.fn().mockResolvedValue(undefined),
  markProviderRateLimited: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./cos.js', () => ({
  updateTask: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./executionLanes.js', () => ({
  release: vi.fn()
}));

vi.mock('./toolStateMachine.js', () => ({
  completeExecution: vi.fn(),
  errorExecution: vi.fn()
}));

vi.mock('./agentErrorAnalysis.js', () => ({
  analyzeAgentFailure: vi.fn().mockReturnValue(null),
  resolveFailedTaskUpdate: vi.fn().mockResolvedValue({ status: 'failed' })
}));

vi.mock('./agentRunTracking.js', () => ({
  completeAgentRun: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./agentCompletion.js', () => ({
  processAgentCompletion: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./agentLifecycle.js', () => ({
  persistSimplifySummaries: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./agentState.js', () => ({
  activeAgents: new Map(),
  userTerminatedAgents: new Set()
}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { root: '/tmp/portos-root' }
}));

vi.mock('../lib/providerModels.js', () => ({
  // Mirror the real behaviour: pass through the model string, return null for
  // the codex-configured-default sentinel or null/undefined input.
  resolveCliModel: vi.fn((m) => (m === 'codex-configured-default' || !m) ? null : m)
}));

import { buildTuiSpawnConfig, spawnTuiAgent } from './agentTuiSpawning.js';
import * as shellService from './shell.js';
import * as cosAgents from './cosAgents.js';
import * as cos from './cos.js';
import * as agentErrorAnalysis from './agentErrorAnalysis.js';
import { activeAgents, userTerminatedAgents } from './agentState.js';

describe('agent TUI spawning', () => {
  it('builds a codex TUI command without a model flag for the configured-default sentinel', () => {
    const config = buildTuiSpawnConfig({
      id: 'codex-tui',
      name: 'Codex TUI',
      type: 'tui',
      command: 'codex',
      args: []
    }, 'codex-configured-default');

    expect(config.command).toBe('codex');
    expect(config.args).toEqual([]);
    expect(config.commandLine).toBe('codex');
  });

  it('quotes TUI arguments and carries idle timing config', () => {
    const config = buildTuiSpawnConfig({
      id: 'claude-code-tui',
      name: 'Claude TUI',
      type: 'tui',
      command: 'claude',
      args: ['--dangerously-skip-permissions', '--add-dir', '/tmp/with space'],
      tuiPromptDelayMs: 1000,
      tuiIdleTimeoutMs: 30000
    }, 'claude-sonnet');

    expect(config.args).toEqual([
      '--dangerously-skip-permissions',
      '--add-dir',
      '/tmp/with space',
      '--model',
      'claude-sonnet'
    ]);
    expect(config.commandLine).toBe("claude --dangerously-skip-permissions --add-dir '/tmp/with space' --model claude-sonnet");
    expect(config.promptDelayMs).toBe(1000);
    expect(config.idleTimeoutMs).toBe(30000);
  });

  it('falls back to the default command via id heuristic when command is omitted', () => {
    const codexConfig = buildTuiSpawnConfig({ id: 'my-codex-instance', type: 'tui' }, null);
    expect(codexConfig.command).toBe('codex');

    const claudeConfig = buildTuiSpawnConfig({ id: 'whatever', type: 'tui' }, null);
    expect(claudeConfig.command).toBe('claude');
  });

  it('applies default prompt-delay and idle-timeout when the provider omits them', () => {
    const config = buildTuiSpawnConfig({ id: 'codex-tui', command: 'codex', type: 'tui' }, null);
    expect(config.promptDelayMs).toBe(2500);
    expect(config.idleTimeoutMs).toBe(180000);
  });

  it('omits the --model flag when model is null/empty', () => {
    const config = buildTuiSpawnConfig({ id: 'codex-tui', command: 'codex', type: 'tui', args: [] }, null);
    expect(config.args).toEqual([]);
    expect(config.commandLine).toBe('codex');
  });
});

// ─── spawnTuiAgent runtime tests ─────────────────────────────────────────────

// Flush the microtask queue (pending Promise continuations). vi.runAllMicrotasksAsync
// is not available in vitest 4.x — use Promise.resolve() ticks instead.
const flushMicrotasks = () => Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());

describe('spawnTuiAgent runtime', () => {
  let capturedOnData = null;
  let capturedOnExit = null;

  const SESSION_ID = 'test-session-id-abc';

  const defaultProvider = { id: 'codex-tui', name: 'Codex TUI', type: 'tui', envVars: {} };
  // Short delays so fake timers don't need to advance huge amounts of time.
  const defaultTuiConfig = {
    command: 'codex',
    args: [],
    commandLine: 'codex',
    promptDelayMs: 100,
    idleTimeoutMs: 50
  };

  function runSpawn(overrides = {}) {
    const agentId = overrides.agentId ?? 'agent-1';
    const task = overrides.task ?? { id: 'task-1', description: 'do the thing', metadata: {} };
    const prompt = overrides.prompt ?? 'do the thing';
    const workspacePath = overrides.workspacePath ?? '/tmp/ws';
    const model = overrides.model ?? null;
    const provider = overrides.provider ?? defaultProvider;
    const runId = overrides.runId ?? 'run-1';
    const tuiConfig = overrides.tuiConfig ?? defaultTuiConfig;
    const agentDir = overrides.agentDir ?? '/tmp/agentdir';
    const executionId = overrides.executionId ?? null;
    const laneName = overrides.laneName ?? null;
    const helpers = overrides.helpers ?? {
      cleanupWorktreeFn: vi.fn().mockResolvedValue(undefined),
      isTruthyMetaFn: (v) => !!v
    };
    return spawnTuiAgent(agentId, task, prompt, workspacePath, model, provider, runId, tuiConfig, agentDir, executionId, laneName, helpers);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // Clear shared mutable state between tests
    activeAgents.clear();
    userTerminatedAgents.clear();

    capturedOnData = null;
    capturedOnExit = null;

    // Default createShellSession captures callbacks and returns a valid session id
    vi.mocked(shellService.createShellSession).mockImplementation((_socket, opts) => {
      capturedOnData = opts.onData;
      capturedOnExit = opts.onExit;
      return SESSION_ID;
    });

    vi.mocked(shellService.getSessionProcess).mockReturnValue(null);
    vi.mocked(shellService.getSession).mockReturnValue({ id: SESSION_ID });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 1. Successful idle-complete path ────────────────────────────────────────
  it('idle-complete: calls completeAgent(success:true) and updateTask(completed) when idle fires after enough output and runtime', async () => {
    // Wire completeAgent to resolve a promise we can await, so we can detect
    // when the async finish() chain completes without polling.
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(cosAgents.completeAgent).mockImplementation(async () => { resolveComplete(); });

    runSpawn();

    // Flush initial async setup (updateAgent calls etc.)
    await flushMicrotasks();

    // Fire the prompt timer so promptSentAt is set (promptDelayMs = 100ms)
    await vi.advanceTimersByTimeAsync(110);
    await flushMicrotasks();

    // Feed 2 meaningful lines AFTER the prompt so meaningfulLinesAfterPrompt >= 2.
    // These must not match the promptPreview ("do the thing").
    await capturedOnData(Buffer.from('Agent output line one\n'));
    await capturedOnData(Buffer.from('Agent output line two\n'));

    // Advance past DEFAULT_TUI_MIN_RUNTIME_MS (15 000ms) + idleTimeoutMs (50ms).
    // The idle setInterval ticks every 5 000ms; at the >=15s tick the conditions
    // (runtime >= 15s, lines >= 2, idle >= 50ms) are all satisfied.
    await vi.advanceTimersByTimeAsync(21000);

    // finish() is called as fire-and-forget inside the interval callback;
    // switch to real timers and await our sentinel promise so the full async
    // chain (completeAgent → updateTask → ...) drains completely.
    vi.useRealTimers();
    await completeDone;

    expect(cosAgents.completeAgent).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({ success: true, completionReason: 'idle-complete' })
    );
    expect(cos.updateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ status: 'completed' }),
      expect.any(String)
    );
  });

  // ── 2. Command-not-found path ────────────────────────────────────────────────
  it('command-not-found: completeAgent called with exitCode 127 and task updated to failed', async () => {
    const spawnPromise = runSpawn();
    await flushMicrotasks();

    // Feed "command not found" output BEFORE the prompt timer fires (promptSentAt === null).
    // commandName is derived from tuiConfig.command = 'codex' via .split('/').pop().
    await capturedOnData(Buffer.from('bash: codex: command not found\n'));
    await flushMicrotasks();

    await spawnPromise;

    expect(cosAgents.completeAgent).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({
        success: false,
        exitCode: 127,
        completionReason: 'command-not-found'
      })
    );
    // resolveFailedTaskUpdate mock returns { status: 'failed' }
    expect(cos.updateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ status: 'failed' }),
      expect.any(String)
    );
  });

  // ── 3. Shell-exit path with non-zero exit code ───────────────────────────────
  it('shell-exit: completeAgent called with success:false and exitCode 1 when shell exits non-zero', async () => {
    const spawnPromise = runSpawn();
    await flushMicrotasks();

    await capturedOnExit({ exitCode: 1, killed: false });
    await flushMicrotasks();

    await spawnPromise;

    expect(cosAgents.completeAgent).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({
        success: false,
        exitCode: 1,
        completionReason: 'shell-exit'
      })
    );
  });

  // ── 4. Killed / user-terminated path ────────────────────────────────────────
  it('user-terminated: completeAgent receives terminated-by-user error and updateTask called with blocked+user-terminated', async () => {
    // Mark agent as user-terminated before the exit fires
    userTerminatedAgents.add('agent-1');

    const spawnPromise = runSpawn();
    await flushMicrotasks();

    await capturedOnExit({ exitCode: 0, killed: true });
    await flushMicrotasks();

    await spawnPromise;

    expect(cosAgents.completeAgent).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({
        success: false,
        error: 'Agent terminated by user'
      })
    );
    expect(cos.updateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'blocked',
        metadata: expect.objectContaining({ blockedCategory: 'user-terminated' })
      }),
      expect.any(String)
    );
  });

  // ── 5. Spawn-error path (createShellSession returns null) ────────────────────
  it('spawn-error: function returns null and completeAgent reports spawn-error when session creation fails', async () => {
    vi.mocked(shellService.createShellSession).mockReturnValue(null);

    const result = await runSpawn();

    expect(result).toBeNull();
    expect(cosAgents.completeAgent).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({
        success: false,
        error: 'Failed to create TUI shell session',
        completionReason: 'spawn-error'
      })
    );
  });
});
