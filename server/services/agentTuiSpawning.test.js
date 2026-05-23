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
  persistSimplifySummaries: vi.fn().mockResolvedValue(undefined),
  finalizeAgent: vi.fn().mockResolvedValue(undefined),
  releaseAgentLane: vi.fn()
}));

vi.mock('./agentState.js', () => ({
  activeAgents: new Map(),
  userTerminatedAgents: new Set()
}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(''),
  rm: vi.fn().mockResolvedValue(undefined),
  // raw.txt tail-read for failure analysis. The default stat → open/read
  // chain reports a zero-byte file so non-tail-read tests don't accidentally
  // exercise the read path. The two tail-read tests below override stat
  // and open via mockResolvedValueOnce to assert the IO contract on the
  // failure / success finalize branches.
  stat: vi.fn().mockResolvedValue({ size: 0 }),
  open: vi.fn().mockResolvedValue({
    read: vi.fn().mockResolvedValue({ bytesRead: 0 }),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: { root: '/tmp/portos-root' }
}));

vi.mock('../lib/providerModels.js', () => ({
  // Mirror the real behaviour: pass through the model string, return null for
  // the codex-configured-default sentinel or null/undefined input.
  resolveCliModel: vi.fn((m) => (m === 'codex-configured-default' || !m) ? null : m)
}));

// Shrink buffer thresholds so the truncation tests can trip them with tiny
// inputs. Real values (10MB output, 256MB raw spool) would force tests to
// push millions of bytes through the spawner; the wiring under test is
// identical at any cap. OUTPUT_BUFFER_HEADROOM is intentionally 1 byte so
// ANY appendLine call trips it — otherwise the output-buffer overflow test
// would assert on the byte count of the two spawn-startup string literals
// (which would silently stop tripping if those strings change). The raw
// spool cap is shrunk to 100 bytes so the disk-safety-valve test exercises
// the truncation path without allocating hundreds of MB.
vi.mock('../lib/tuiHandshake.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    OUTPUT_BUFFER_HEADROOM: 1,
    OUTPUT_BUFFER_CAP: 1,
    RAW_SPOOL_MAX_BYTES: 100,
  };
});

import { buildTuiSpawnConfig, spawnTuiAgent } from './agentTuiSpawning.js';
import * as shellService from './shell.js';
import * as agentLifecycle from './agentLifecycle.js';
import * as agentErrorAnalysis from './agentErrorAnalysis.js';
import * as cosAgents from './cosAgents.js';
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
    expect(config.args).toEqual(['--ask-for-approval', 'never']);
    expect(config.commandLine).toBe('codex --ask-for-approval never');
  });

  it('injects --ask-for-approval never for codex TUI when not already set', () => {
    const config = buildTuiSpawnConfig({
      id: 'codex-tui',
      command: 'codex',
      type: 'tui',
      args: ['--cd', '/tmp/work']
    }, null);
    expect(config.args).toEqual(['--ask-for-approval', 'never', '--cd', '/tmp/work']);
  });

  it('does not duplicate --ask-for-approval when the provider config already pins it', () => {
    const config = buildTuiSpawnConfig({
      id: 'codex-tui',
      command: 'codex',
      type: 'tui',
      args: ['--ask-for-approval', 'on-failure']
    }, null);
    expect(config.args).toEqual(['--ask-for-approval', 'on-failure']);
  });

  it('does not inject --ask-for-approval for non-codex TUI commands', () => {
    const config = buildTuiSpawnConfig({
      id: 'claude-code-tui',
      command: 'claude',
      type: 'tui',
      args: ['--dangerously-skip-permissions']
    }, null);
    expect(config.args).toEqual(['--dangerously-skip-permissions']);
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
    expect(config.args).toEqual(['--ask-for-approval', 'never']);
    expect(config.commandLine).toBe('codex --ask-for-approval never');
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
    return spawnTuiAgent({
      agentId,
      task,
      prompt,
      workspacePath,
      model,
      provider,
      runId,
      tuiConfig,
      agentDir,
      executionId,
      laneName,
      ...helpers,
    });
  }

  let warnSpy = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // Clear shared mutable state between tests
    activeAgents.clear();
    userTerminatedAgents.clear();

    capturedOnData = null;
    capturedOnExit = null;

    // Silence the truncation warn globally for this describe block — the
    // mocked tiny OUTPUT_BUFFER_HEADROOM (above) makes every spawn trip it
    // via the two initial appendLine calls, so non-truncation tests would
    // otherwise spam stderr. The truncation-specific tests below reach for
    // this same spy to assert the warn fired.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

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
    warnSpy?.mockRestore();
  });

  // The TUI spawn path delegates the central completion sequence
  // (completeAgent + completeAgentRun + updateTask + processAgentCompletion +
  // provider markers) to `finalizeAgent` so those concerns stay shared with
  // the runner-mode and direct-CLI paths. The tests below assert the
  // arguments handed to `finalizeAgent`, not the downstream individual
  // calls — those are covered by agentLifecycle.test.js.

  // ── 1. Successful idle-complete path ────────────────────────────────────────
  it('idle-complete: calls finalizeAgent(success:true) with completionReason=idle-complete when idle fires after enough output and runtime', async () => {
    // Wire finalizeAgent to resolve a promise we can await, so we can detect
    // when the async finish() chain completes without polling.
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    runSpawn();

    // Flush initial async setup (updateAgent calls etc.)
    await flushMicrotasks();

    // Feed a banner-style line so firstOutputAt is set — the paste timer
    // gates on "we've seen at least one chunk of output" plus an idle window
    // before sending the prompt (ready-signal detection).
    await capturedOnData(Buffer.from('Codex booting...\n'));
    await flushMicrotasks();

    // Advance past the prompt-delay floor (100ms) AND the readiness idle
    // threshold (1200ms). The poll interval (300ms) ticks during this window
    // and fires the paste once both gates open, setting promptSentAt.
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    // Feed one PTY chunk AFTER the paste so lastOutputAt > promptSentAt
    // (the idle gate's "we saw activity post-paste" signal — replaces the
    // old per-line count now that line capture is dropped).
    await capturedOnData(Buffer.from('Agent post-paste activity\n'));

    // Advance past DEFAULT_TUI_MIN_RUNTIME_MS (15 000ms) + idleTimeoutMs (50ms).
    // The idle setInterval ticks every 5 000ms; at the >=15s tick the
    // conditions (runtime >= 15s, lastOutputAt > promptSentAt, idle >= 50ms)
    // are all satisfied.
    await vi.advanceTimersByTimeAsync(21000);

    // finish() is called as fire-and-forget inside the interval callback;
    // switch to real timers and await our sentinel promise so the full async
    // chain (finalizeAgent → ...) drains completely.
    vi.useRealTimers();
    await completeDone;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        success: true,
        completionReason: 'idle-complete',
      })
    );
  });

  // ── 2. Command-not-found path ────────────────────────────────────────────────
  it('command-not-found: finalizeAgent called with success:false, exitCode 127, completionReason=command-not-found', async () => {
    const spawnPromise = runSpawn();
    await flushMicrotasks();

    // Feed "command not found" output BEFORE the prompt timer fires (promptSentAt === null).
    // commandName is derived from tuiConfig.command = 'codex' via .split('/').pop().
    await capturedOnData(Buffer.from('bash: codex: command not found\n'));
    await flushMicrotasks();

    await spawnPromise;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        success: false,
        exitCode: 127,
        completionReason: 'command-not-found',
      })
    );
  });

  // ── 3. Shell-exit path with non-zero exit code ───────────────────────────────
  it('shell-exit: finalizeAgent called with success:false and exitCode 1 when shell exits non-zero', async () => {
    const spawnPromise = runSpawn();
    await flushMicrotasks();

    await capturedOnExit({ exitCode: 1, killed: false });
    await flushMicrotasks();

    await spawnPromise;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        success: false,
        exitCode: 1,
        completionReason: 'shell-exit',
      })
    );
  });

  // ── 4. Killed / user-terminated path ────────────────────────────────────────
  it('user-terminated: finalizeAgent receives terminatedByUser:true + error=Agent terminated by user', async () => {
    // Mark agent as user-terminated before the exit fires
    userTerminatedAgents.add('agent-1');

    const spawnPromise = runSpawn();
    await flushMicrotasks();

    await capturedOnExit({ exitCode: 0, killed: true });
    await flushMicrotasks();

    await spawnPromise;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        success: false,
        terminatedByUser: true,
        error: 'Agent terminated by user',
      })
    );
  });

  // ── 5. Spawn-error path (createShellSession returns null) ────────────────────
  it('spawn-error: function returns null and finalizeAgent reports spawn-error when session creation fails', async () => {
    vi.mocked(shellService.createShellSession).mockReturnValue(null);

    const result = await runSpawn();

    expect(result).toBeNull();
    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        success: false,
        error: 'Failed to create TUI shell session',
        completionReason: 'spawn-error',
      })
    );
  });

  // ── 6. Raw PTY stream spools to disk (no in-memory cap, no in-memory warn) ─
  // Raw chunks are written to raw.txt via the debounced flush pipeline so
  // memory stays bounded regardless of run length. analyzeAgentFailure
  // reads the file on failure. No "raw PTY buffer exceeded" warn and no
  // rawBufferTruncated metadata flag — those were signals of the OLD
  // in-memory cap. Disk-side truncation has its own warn / flag covered
  // separately by test 8b.
  it('raw PTY bytes spool to raw.txt without the old in-memory truncation signals', async () => {
    const { appendFile } = await import('fs/promises');
    runSpawn();
    await flushMicrotasks();

    // Small chunks that stay under the mocked 100-byte raw-spool cap so this
    // test exercises the normal appendFile path. The disk-safety-valve path
    // (writeFile when over cap) is covered by test 8b.
    await capturedOnData(Buffer.from('hello '));
    await flushMicrotasks();
    await capturedOnData(Buffer.from('world\n'));
    await flushMicrotasks();

    // Fire the 250ms debounced raw flush.
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();

    const inMemTruncWarns = warnSpy.mock.calls.filter(args =>
      typeof args[0] === 'string' && args[0].includes('raw PTY buffer exceeded')
    );
    expect(inMemTruncWarns).toHaveLength(0);

    const inMemTruncMetaCalls = vi.mocked(cosAgents.updateAgent).mock.calls.filter(
      ([_id, payload]) => payload?.metadata?.rawBufferTruncated === true
    );
    expect(inMemTruncMetaCalls).toHaveLength(0);

    // raw.txt got the chunks via the batched appendFile flush.
    const rawAppendCalls = vi.mocked(appendFile).mock.calls.filter(
      ([path]) => typeof path === 'string' && path.endsWith('raw.txt')
    );
    expect(rawAppendCalls.length).toBeGreaterThan(0);
  });

  // ── 7. Output-buffer truncation warning + metadata flag ─────────────────────
  // outputBuffer is filled via appendLine, which fires on initial spawn
  // (session-started + open-shell-tab) plus the prompt-pasted notice. With
  // the mocked 1-byte HEADROOM the first spawn line trips the cap, so the
  // wiring is exercised on every spawn — but only ONCE per run regardless
  // of how many subsequent lines arrive.
  it('outputBuffer overflow: warns once and writes outputBufferTruncated:true to agent metadata', async () => {
    runSpawn();
    await flushMicrotasks();

    const truncWarns = warnSpy.mock.calls.filter(args =>
      typeof args[0] === 'string' && args[0].includes('parsed-output buffer exceeded')
    );
    expect(truncWarns).toHaveLength(1);

    const truncMetaCalls = vi.mocked(cosAgents.updateAgent).mock.calls.filter(
      ([_id, payload]) => payload?.metadata?.outputBufferTruncated === true
    );
    expect(truncMetaCalls).toHaveLength(1);
    expect(truncMetaCalls[0][0]).toBe('agent-1');
  });

  // ── 8. Failure-path tail-read of raw.txt ────────────────────────────────────
  // analyzeAgentFailure needs the recent PTY tail; finalize MUST read it from
  // raw.txt via readFileTail (NOT readFile, which would load the whole spool).
  // This test wires stat to report a >1MB spool and asserts the tail-read
  // pattern: stat → open → read at offset (size - RAW_TAIL_ANALYSIS_BYTES).
  it('failure finalize: reads only the tail of raw.txt for analyzeAgentFailure', async () => {
    const fsPromises = await import('fs/promises');
    const RAW_TAIL_BYTES = 1024 * 1024;
    const SPOOL_SIZE = 5 * 1024 * 1024;   // 5MB on disk

    vi.mocked(fsPromises.stat).mockResolvedValueOnce({ size: SPOOL_SIZE });
    const readMock = vi.fn().mockResolvedValue({ bytesRead: RAW_TAIL_BYTES });
    const closeMock = vi.fn().mockResolvedValue(undefined);
    vi.mocked(fsPromises.open).mockResolvedValueOnce({ read: readMock, close: closeMock });

    const spawnPromise = runSpawn();
    await flushMicrotasks();

    // Trigger a failure finalize via the shell-exit path.
    await capturedOnExit({ exitCode: 1, killed: false });
    await flushMicrotasks();
    await spawnPromise;

    const statCalls = vi.mocked(fsPromises.stat).mock.calls.filter(
      ([p]) => typeof p === 'string' && p.endsWith('raw.txt')
    );
    expect(statCalls.length).toBeGreaterThan(0);

    const openCalls = vi.mocked(fsPromises.open).mock.calls.filter(
      ([p]) => typeof p === 'string' && p.endsWith('raw.txt')
    );
    expect(openCalls.length).toBeGreaterThan(0);

    // read() must be called with offset = size - tailBytes (5MB - 1MB = 4MB)
    // so analyzeAgentFailure sees only the most-recent 1MB, not the full spool.
    expect(readMock).toHaveBeenCalledWith(
      expect.any(Buffer),
      0,
      RAW_TAIL_BYTES,
      SPOOL_SIZE - RAW_TAIL_BYTES
    );
    expect(closeMock).toHaveBeenCalled();
  });

  // ── 8b. Disk safety valve ───────────────────────────────────────────────────
  // The raw spool truncates rather than appends once it crosses
  // RAW_SPOOL_MAX_BYTES so a runaway agent can't fill the volume. The mock
  // above shrinks the cap to 100 bytes so we can trip it with two ~80-byte
  // chunks instead of pushing hundreds of MB through the spawner. The wiring
  // under test (Buffer.byteLength count, writeFile vs appendFile dispatch,
  // once-per-run warn + metadata flag) is identical at any cap.
  it('raw spool: truncates instead of appending once it crosses the cap', async () => {
    const fsPromises = await import('fs/promises');
    runSpawn();
    await flushMicrotasks();

    // First chunk (80 bytes) fits under the 100-byte cap → appendFile.
    await capturedOnData(Buffer.alloc(80, 0x61));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();

    // Second chunk (80 bytes) would push total to 160 > 100 → writeFile.
    await capturedOnData(Buffer.alloc(80, 0x62));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();

    const writeFileRawCalls = vi.mocked(fsPromises.writeFile).mock.calls.filter(
      ([p]) => typeof p === 'string' && p.endsWith('raw.txt')
    );
    expect(writeFileRawCalls.length).toBeGreaterThan(0);

    const truncWarns = warnSpy.mock.calls.filter(args =>
      typeof args[0] === 'string' && args[0].includes('raw PTY spool reached')
    );
    expect(truncWarns).toHaveLength(1);

    const truncMetaCalls = vi.mocked(cosAgents.updateAgent).mock.calls.filter(
      ([_id, payload]) => payload?.metadata?.rawSpoolTruncated === true
    );
    expect(truncMetaCalls).toHaveLength(1);
    expect(truncMetaCalls[0][0]).toBe('agent-1');
  });

  // ── 9. Success-path skips the tail read ─────────────────────────────────────
  // Successful finalize must not touch raw.txt — that's what makes the
  // disk-spool's bounded-memory guarantee hold for healthy long runs.
  it('success finalize: skips raw.txt tail read entirely', async () => {
    const fsPromises = await import('fs/promises');

    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    runSpawn();
    await flushMicrotasks();

    // Drive the idle-complete success path (mirrors test 1).
    await capturedOnData(Buffer.from('Codex booting...\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    await capturedOnData(Buffer.from('Agent post-paste activity\n'));
    await vi.advanceTimersByTimeAsync(21000);
    vi.useRealTimers();
    await completeDone;

    // No raw.txt stat / open should fire on the success path. (The mock
    // for fs.promises.stat / open was reset between tests by clearAllMocks,
    // so any calls here are from this run.)
    const statCalls = vi.mocked(fsPromises.stat).mock.calls.filter(
      ([p]) => typeof p === 'string' && p.endsWith('raw.txt')
    );
    expect(statCalls).toHaveLength(0);

    const openCalls = vi.mocked(fsPromises.open).mock.calls.filter(
      ([p]) => typeof p === 'string' && p.endsWith('raw.txt')
    );
    expect(openCalls).toHaveLength(0);
  });
});
