import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks for spawnTuiAgent tests ──────────────────────────────────────────
// All vi.mock calls must be at the top level before any imports.

vi.mock('./shell.js', () => ({
  createShellSession: vi.fn(),
  writeToSession: vi.fn(),
  killSession: vi.fn(),
  getSession: vi.fn(),
  getSessionProcess: vi.fn(),
  getLastInputAt: vi.fn().mockReturnValue(null)
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
  userTerminatedAgents: new Set(),
  pausedAgents: new Map()
}));

vi.mock('./git.js', () => ({
  // Default: worktree has changes so idle-complete succeeds. Tests that want
  // to exercise the idle-no-changes failure path override via mockResolvedValueOnce.
  getStatus: vi.fn().mockResolvedValue({ clean: false, files: [{ path: 'file.txt', status: 'M' }] }),
  getDiff: vi.fn().mockResolvedValue('diff content here'),
}));

vi.mock('fs', () => ({
  // Default: no .agent-done sentinel on disk. The completion-sentinel test
  // overrides this to true. Re-set in beforeEach so it can't leak between tests.
  existsSync: vi.fn().mockReturnValue(false),
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

vi.mock('../lib/providerModels.js', async (importOriginal) => ({
  // Pull the real module first so pure helpers added later (isClaudeCommand,
  // applyLeanClaudeArgs, leanClaudeAuthEnv, …) don't silently vanish from the
  // mock — only the fns below are stubbed/spied.
  ...(await importOriginal()),
  // Mirror the real behaviour: pass through the model string, return null for
  // the codex-configured-default sentinel or null/undefined input.
  resolveCliModel: vi.fn((m) => (m === 'codex-configured-default' || !m) ? null : m),
  // Bedrock map is a no-op off Bedrock — mirror that pass-through here (the
  // mapper itself is unit-tested in providerModels.test.js).
  resolveBedrockCliModel: vi.fn((m) => m),
  // Mirror the real opencode-command basename match (fully unit-tested in
  // providerModels.test.js).
  isOpencodeCommand: vi.fn((c) => typeof c === 'string' && c.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '') === 'opencode'),
  // Mirror the real ollama/ namespacing for opencode providers (fully unit-
  // tested in providerModels.test.js).
  prefixOpencodeModel: vi.fn((p, m) => (typeof p?.command === 'string' && p.command.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '') === 'opencode' && p?.ollamaBacked === true && m && !String(m).startsWith('ollama/')) ? `ollama/${m}` : m),
  // Mirror hasModelFlag (real impl unit-tested in providerModels.test.js).
  hasModelFlag: vi.fn((a) => Array.isArray(a) && a.some((x) => x === '--model' || x === '-m' || (typeof x === 'string' && (x.startsWith('--model=') || x.startsWith('-m=')))))
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

// child_process.execFile is used only by the TUI liveness probe
// (shellHasLiveChild). Default to an error callback so the probe resolves
// "assume alive" (guard bypassed) for every test that doesn't exercise it —
// the early-exit test below overrides this to report no child process.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFile: vi.fn((_file, _args, _opts, cb) => cb(new Error('not mocked'))) };
});

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { execFile } from 'child_process';
import { buildTuiSpawnConfig, spawnTuiAgent } from './agentTuiSpawning.js';
import * as shellService from './shell.js';
import * as agentLifecycle from './agentLifecycle.js';
import * as agentErrorAnalysis from './agentErrorAnalysis.js';
import * as cosAgents from './cosAgents.js';
import * as gitService from './git.js';
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
    expect(config.args).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
    expect(config.commandLine).toBe('codex --dangerously-bypass-approvals-and-sandbox');
  });

  it('injects --dangerously-bypass-approvals-and-sandbox for codex TUI when not already set', () => {
    const config = buildTuiSpawnConfig({
      id: 'codex-tui',
      command: 'codex',
      type: 'tui',
      args: ['--cd', '/tmp/work']
    }, null);
    expect(config.args).toEqual(['--dangerously-bypass-approvals-and-sandbox', '--cd', '/tmp/work']);
  });

  it('does not inject the bypass flag when the provider config already pins an approval policy', () => {
    const config = buildTuiSpawnConfig({
      id: 'codex-tui',
      command: 'codex',
      type: 'tui',
      args: ['--ask-for-approval', 'on-failure']
    }, null);
    expect(config.args).toEqual(['--ask-for-approval', 'on-failure']);
  });

  it('does not inject the bypass flag for non-codex TUI commands', () => {
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

  it('namespaces the Ollama model under ollama/ for an OpenCode TUI', () => {
    const config = buildTuiSpawnConfig({
      id: 'opencode-ollama-tui', type: 'tui', command: 'opencode', args: [], ollamaBacked: true,
    }, 'qwen2.5:7b');
    expect(config.command).toBe('opencode');
    expect(config.args).toEqual(['--model', 'ollama/qwen2.5:7b']);
  });

  it('respects a user-baked --model pin on an OpenCode TUI and does not duplicate it', () => {
    const config = buildTuiSpawnConfig({
      id: 'opencode-ollama-tui', type: 'tui', command: 'opencode',
      args: ['--model', 'ollama/custom'], ollamaBacked: true,
    }, 'qwen2.5:7b');
    expect(config.args).toEqual(['--model', 'ollama/custom']);
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
    expect(config.args).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
    expect(config.commandLine).toBe('codex --dangerously-bypass-approvals-and-sandbox');
  });

  it('adds lean-mode flags and the system-prompt file for an Ollama-backed claude TUI', () => {
    const config = buildTuiSpawnConfig({
      id: 'claude-ollama-tui', type: 'tui', command: 'claude', ollamaBacked: true,
      args: ['--dangerously-skip-permissions'],
    }, 'qwen3.6:35b', { systemPromptFile: '/data/cos/agents/agent-1/system-prompt.md' });
    expect(config.args).toEqual([
      '--dangerously-skip-permissions',
      '--model', 'qwen3.6:35b',
      '--bare', '--strict-mcp-config',
      '--append-system-prompt-file', '/data/cos/agents/agent-1/system-prompt.md',
    ]);
  });

  it('does NOT add lean flags to the standard claude TUI, and skips the system-prompt flag for non-claude commands', () => {
    const standard = buildTuiSpawnConfig({
      id: 'claude-code-tui', type: 'tui', command: 'claude', args: ['--dangerously-skip-permissions'],
    }, 'claude-opus-4-8', { systemPromptFile: '/tmp/sys.md' });
    expect(standard.args).not.toContain('--bare');
    // Claude command still honors an explicitly provided system-prompt file.
    expect(standard.args).toContain('--append-system-prompt-file');

    const opencode = buildTuiSpawnConfig({
      id: 'opencode-ollama-tui', type: 'tui', command: 'opencode', args: [], ollamaBacked: true,
    }, 'qwen3.6:35b', { systemPromptFile: '/tmp/sys.md' });
    expect(opencode.args).not.toContain('--append-system-prompt-file');
    expect(opencode.args).not.toContain('--bare');
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
    idleTimeoutMs: 50,
    // Large so the wall-clock backstop never fires during the modest fake-timer
    // advances the idle/paste tests perform (the max-runtime test overrides it).
    maxRuntimeMs: 3600000
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

    // Default createShellSession captures callbacks and returns a valid session id.
    // Real shell.js fires onInitialCommandSent when it injects the CLI command
    // (after its round-trip readiness probe); the claude input-ready gate only
    // observes paste-mode toggles AFTER that fires, so invoke it here to mirror
    // the real flow (otherwise commandInjected stays false and no paste ever gates).
    vi.mocked(shellService.createShellSession).mockImplementation((_socket, opts) => {
      capturedOnData = opts.onData;
      capturedOnExit = opts.onExit;
      opts.onInitialCommandSent?.();
      return SESSION_ID;
    });

    vi.mocked(shellService.getSessionProcess).mockReturnValue(null);
    vi.mocked(shellService.getSession).mockReturnValue({ id: SESSION_ID });

    // Reset sentinel state: no .agent-done on disk, empty read. The
    // completion-sentinel test overrides both. clearAllMocks keeps the factory
    // implementation, so re-set explicitly to prevent cross-test leakage.
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFile).mockResolvedValue('');

    // Reset git mock: default is worktree has changes (idle-complete succeeds).
    // Tests that want to exercise the idle-no-changes failure path override this.
    vi.mocked(gitService.getStatus).mockResolvedValue({ clean: false, files: [{ path: 'file.txt', status: 'M' }] });
    vi.mocked(gitService.getDiff).mockResolvedValue('diff content here');

    // Reset input-recency state: no input recorded by default. The
    // recent-input test overrides this — clearAllMocks doesn't undo a
    // mockReturnValue override, so it must be reset explicitly here.
    vi.mocked(shellService.getLastInputAt).mockReturnValue(null);
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

    // Emit the prompt echo so paste verification passes (issue #2192).
    // In a real TUI, the paste is echoed in the input buffer; tests must
    // simulate this or verification fails and Enter is never sent.
    await capturedOnData(Buffer.from('do the thing\n'));
    await flushMicrotasks();

    // Advance past PASTE_TO_ENTER_FALLBACK_MS (3500ms) so the submit-Enter fires
    // and promptSubmittedAt is set — work-activity is only observed AFTER submit
    // (the prompt echo before that must not be scanned; issue #1229 review).
    await vi.advanceTimersByTimeAsync(3600);
    await flushMicrotasks();

    // Feed PTY chunks AFTER submit that prove the model is actually WORKING — the
    // elapsed working counter ADVANCING through two distinct values SPACED ACROSS
    // WALL-CLOCK TIME (≥750ms apart). This sets lastOutputAt > promptSentAt AND
    // trips the work-activity tracker, which the idle gate now requires before
    // finalizing as success (issue #1229 — pure chrome churn, a single counter
    // value, or two counters arriving at once must NOT count; see the no-activity
    // and echoed-transcript tests).
    await capturedOnData(Buffer.from('(1s · thinking with high effort)\n'));
    await vi.advanceTimersByTimeAsync(800);
    await capturedOnData(Buffer.from('(2s · thinking with high effort)\n'));

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

  // ── 1b. Idle timer must not reap a session that just received real input ────
  // A large bracketed paste into a live agent TUI can sit in a silent
  // reflow/commit window with no PTY output yet, which looks identical to
  // "idle" to this timer. While input keeps arriving recently (within
  // PASTE_INPUT_GRACE_MS), the idle reaper must not fire — gated on input
  // RECENCY rather than "is a socket attached", since a regular Shell session
  // keeps its socket bound after the viewer navigates away (only external
  // one-shot runs release on `shell:release-views`), which would otherwise
  // permanently suppress idle-complete for any agent glanced at once (caught
  // in review — see shell.test.js for the isolated getLastInputAt coverage).
  it('idle timer does not reap while getLastInputAt reports recent input', async () => {
    vi.mocked(shellService.getLastInputAt).mockImplementation(() => Date.now());

    runSpawn();
    await flushMicrotasks();

    await capturedOnData(Buffer.from('Codex booting...\n'));
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    await capturedOnData(Buffer.from('do the thing\n'));
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(3600);
    await flushMicrotasks();

    await capturedOnData(Buffer.from('(1s · thinking with high effort)\n'));
    await vi.advanceTimersByTimeAsync(800);
    await capturedOnData(Buffer.from('(2s · thinking with high effort)\n'));

    // Advance well past DEFAULT_TUI_MIN_RUNTIME_MS + idleTimeoutMs — the
    // un-guarded timer would have reaped by now (see test 1 above).
    await vi.advanceTimersByTimeAsync(21000);
    await flushMicrotasks();

    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();
  });

  // ── 1a. Idle-out with NO work activity → failure (issue #1229) ───────────────
  // The bug: when the prompt never submits, the TUI keeps repainting its banner /
  // status line, so `lastOutputAt > promptSentAt` passes on pure chrome churn and
  // the agent — which did ZERO work — was finalized as `success: idle-complete`.
  // The fix gates idle-complete success on having seen a real work-activity
  // signal (working counter / interrupt hint / "thinking"). With only chrome
  // post-paste, idle must finalize as FAILURE with reason 'idle-no-activity'.
  it('idle-no-activity: finalizes failure when idle fires but no work signal ever appeared (unsubmitted prompt)', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    runSpawn();
    await flushMicrotasks();

    await capturedOnData(Buffer.from('Codex booting...\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    // Post-paste output, but ONLY chrome that repaints with an unsent prompt —
    // the input footer + effort indicator from the real #1229 stuck transcript.
    // None of this advances the working counter, so the work-activity tracker
    // stays inactive.
    await capturedOnData(Buffer.from('⏵⏵ bypass permissions on (shift+tab to cycle)\n'));
    await capturedOnData(Buffer.from('● high · /effort\n'));

    await vi.advanceTimersByTimeAsync(21000);
    vi.useRealTimers();
    await completeDone;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        success: false,
        completionReason: 'idle-no-activity',
      })
    );
  });

  // ── 1a-ter. Idle-out with work activity but zero file changes → failure (#2191) ─
  // Issue #2191: a TUI agent that shows the working counter (workActivity.active
  // becomes true) but produces NO file changes in the worktree should fail, not
  // succeed. Examples: the model rambled, made invalid tool calls, hit an error
  // ("Model is not valid"), or ended at an interactive prompt with zero edits.
  // The fix gates idle-complete success on evidence of work in the worktree
  // (non-empty git status) in addition to the work-counter signal.
  it('idle-no-changes: finalizes failure when work counter advanced but worktree is clean (zero file changes)', async () => {
    // Override the default git mock to report a clean worktree (no changes, no diff).
    vi.mocked(gitService.getStatus).mockResolvedValue({ clean: true, files: [] });
    vi.mocked(gitService.getDiff).mockResolvedValue('');

    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    runSpawn();
    await flushMicrotasks();

    await capturedOnData(Buffer.from('Codex booting...\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    // Emit the prompt echo so paste verification passes (issue #2192) — without
    // it the Enter is never sent, promptSubmittedAt stays null, and the run
    // finalizes as idle-no-activity instead of exercising the idle-no-changes path.
    await capturedOnData(Buffer.from('do the thing\n'));
    await flushMicrotasks();

    // Advance past PASTE_TO_ENTER_FALLBACK_MS so submit fires.
    await vi.advanceTimersByTimeAsync(3600);
    await flushMicrotasks();

    // Feed PTY chunks that PROVE the model was working — the elapsed working
    // counter ADVANCING through two distinct values. This sets workActivity.active
    // to true, but the worktree is still clean (no file changes).
    await capturedOnData(Buffer.from('(1s · thinking with high effort)\n'));
    await vi.advanceTimersByTimeAsync(800);
    await capturedOnData(Buffer.from('(2s · thinking with high effort)\n'));

    // Advance past DEFAULT_TUI_MIN_RUNTIME_MS + idleTimeoutMs.
    await vi.advanceTimersByTimeAsync(21000);

    vi.useRealTimers();
    await completeDone;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        success: false,
        completionReason: 'idle-no-changes',
      })
    );
  });

  // ── 1c. Absolute wall-clock backstop reaps a busy-but-stuck agent ───────────
  // The idle reaper resets on every PTY chunk, so an agent whose working counter
  // keeps repainting through a stalled provider retry never idles out and would
  // run unbounded (real incident 2026-07-06: agent-b1c56083 churned for 98min).
  // The max-runtime timer is the honest ceiling: it fires from submission
  // regardless of PTY chatter and, with no .agent-done sentinel present,
  // finalizes as a needs-manual-finish FAILURE.
  it('max-runtime: reaps a still-chattering agent as failure once the wall-clock ceiling elapses', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    // Idle window LARGER than the max-runtime ceiling so the idle reaper can't
    // win — this isolates the wall-clock backstop (the real-world stuck agent
    // keeps its working counter ticking, so idle never fires anyway).
    runSpawn({ tuiConfig: { ...defaultTuiConfig, idleTimeoutMs: 600000, maxRuntimeMs: 30000 } });
    await flushMicrotasks();

    await capturedOnData(Buffer.from('Codex booting...\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    // Prompt echo → paste verification passes → submit-Enter fires → the
    // max-runtime timer is armed.
    await capturedOnData(Buffer.from('do the thing\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3600);
    await flushMicrotasks();

    // A busy agent that keeps chattering — but the idle window (600s) is huge so
    // only the 30s wall-clock ceiling can reap it. Advance past the ceiling.
    await capturedOnData(Buffer.from('(1s · thinking with high effort)\n'));
    await vi.advanceTimersByTimeAsync(31000);
    await flushMicrotasks();

    vi.useRealTimers();
    await completeDone;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        success: false,
        completionReason: 'max-runtime-timeout',
      })
    );
  });

  // ── 1d. A written .agent-done sentinel is never overridden by a FAILURE reap ─
  // If the agent wrote .agent-done, the run truly finished — the max-runtime
  // ceiling firing would be a false failure. The 2s sentinel poll normally
  // finalizes it as success first; the max-runtime timer's own salvage branch
  // (existsSync check) is the boundary backstop mirroring the one-shot runner's
  // response-file salvage. Either way, with the sentinel present the run must
  // finalize as SUCCESS — never as a max-runtime FAILURE.
  it('max-runtime does not fail a run whose .agent-done sentinel exists', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    runSpawn({ tuiConfig: { ...defaultTuiConfig, maxRuntimeMs: 30000 } });
    await flushMicrotasks();

    await capturedOnData(Buffer.from('Codex booting...\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    await capturedOnData(Buffer.from('do the thing\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3600);
    await flushMicrotasks();

    vi.useRealTimers();
    await completeDone;

    const call = vi.mocked(agentLifecycle.finalizeAgent).mock.calls.at(-1)?.[0];
    expect(call?.success).toBe(true);
    expect(call?.completionReason).not.toBe('max-runtime-timeout');
  });

  // ── 1b. Command exited before the prompt → don't paste into the bare shell ───
  // The TUI command (claude/codex/…) runs as a CHILD of the persistent PTY
  // shell, so if it exits at startup the PTY stays open and onExit never fires.
  // The ready-gate would then paste the bracketed-paste prompt into the returned
  // shell prompt — the wedged `^[[200~ …` session. The liveness probe must catch
  // "shell has no live child", skip the paste, and finalize failure with the
  // command's captured output.
  it('tui-exited-early: skips the paste and finalizes failure when the command exited before the prompt', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    // Truthy pid so the probe runs; ps reports NO process whose ppid is 4242.
    vi.mocked(shellService.getSessionProcess).mockReturnValue({ pid: 4242 });
    vi.mocked(execFile).mockImplementation((_file, _args, _opts, cb) => cb(null, '1\n1\n999\n'));
    // raw.txt tail surfaced in the error.
    vi.mocked(readFile).mockResolvedValue('Error: claude exited at startup\n');

    runSpawn();
    await flushMicrotasks();

    await capturedOnData(Buffer.from('booting...\n'));
    await flushMicrotasks();

    // Open the ready-gate (promptDelay floor + idle threshold) so sendPrompt fires.
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    vi.useRealTimers();
    await completeDone;

    // The bracketed-paste prompt must NOT have been written.
    const pasteWrites = vi.mocked(shellService.writeToSession).mock.calls
      .filter(([, data]) => typeof data === 'string' && data.includes('\x1b[200~'));
    expect(pasteWrites).toHaveLength(0);

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        success: false,
        completionReason: 'tui-exited-early',
      })
    );
  });

  // ── 1c. claude waits for bracketed-paste mode (input ready) before pasting ───
  const claudeTuiConfig = { command: 'claude', args: [], commandLine: 'claude', promptDelayMs: 100, idleTimeoutMs: 50 };
  const pasteCount = () => vi.mocked(shellService.writeToSession).mock.calls
    .filter(([, d]) => typeof d === 'string' && d.includes('\x1b[200~')).length;
  // The launch shell turns bracketed-paste OFF to run the command, then claude
  // turns it back ON when its input box is ready — that OFF→ON is "ready".
  const PASTE_OFF = '\x1b[?2004l';
  const PASTE_ON = '\x1b[?2004h';

  it('claude input-ready: does NOT paste on the startup banner, only once paste mode is re-enabled', async () => {
    runSpawn({ tuiConfig: claudeTuiConfig });
    await flushMicrotasks();

    // Startup banner (and the shell turning paste mode OFF to run the command).
    await capturedOnData(Buffer.from(`${PASTE_OFF}Claude Code v2.1.186\nOpus 4.8 (1M context) with high effort\n`));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(0); // banner / paste-mode-off is not "input ready"

    // claude re-enables bracketed-paste mode → input box live, safe to paste.
    await capturedOnData(Buffer.from(PASTE_ON));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(400);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
  });

  it('claude input-ready: holds the paste while paste mode is OFF (so the paste ESC cannot cancel the input)', async () => {
    runSpawn({ tuiConfig: claudeTuiConfig });
    await flushMicrotasks();

    // Command launched, paste mode OFF — pasting now would send a bare ESC that
    // cancels claude's input. Gate must NOT paste.
    await capturedOnData(Buffer.from(PASTE_OFF));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(0);

    await capturedOnData(Buffer.from(PASTE_ON));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(400);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
  });

  it('claude trust gate: auto-confirms the folder-trust prompt with Enter, then pastes once ready', async () => {
    runSpawn({ tuiConfig: claudeTuiConfig });
    await flushMicrotasks();

    await capturedOnData(Buffer.from(`${PASTE_OFF}Is this a project you trust?\n  1. Yes, I trust this folder\n  2. No, exit\n`));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(700);
    await flushMicrotasks();

    // A bare Enter was sent to confirm the default ("Yes, I trust").
    const enters = vi.mocked(shellService.writeToSession).mock.calls.filter(([, d]) => d === '\r');
    expect(enters.length).toBeGreaterThanOrEqual(1);

    // After trust is accepted claude's input box comes up (paste mode ON) → paste.
    await capturedOnData(Buffer.from(PASTE_ON));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(400);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
  });

  it('tui-not-ready: claude that never shows an input prompt finalizes failure without pasting', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    runSpawn({ tuiConfig: claudeTuiConfig });
    await flushMicrotasks();
    await capturedOnData(Buffer.from('some startup noise but no input box ever appears\n'));
    await flushMicrotasks();

    // Advance past TUI_INPUT_READY_DEADLINE_MS (45s).
    await vi.advanceTimersByTimeAsync(46000);
    vi.useRealTimers();
    await completeDone;

    expect(pasteCount()).toBe(0);
    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1', success: false, completionReason: 'tui-not-ready' })
    );
  });

  // ── 1a-bis. Non-counter TUI provider keeps the permissive idle-complete ──────
  // The work-counter signal only exists on Claude Code / Codex. On a provider
  // that never renders it (Antigravity/Gemini), absence proves nothing — so a
  // sentinel-less idle-out must stay SUCCESS (the original behavior), not be
  // downgraded to failure. Regression guard for #1229 review (codex P2): gating
  // idle-complete solely on a Claude/Codex screen pattern would falsely fail
  // every sentinel-less completion on the other supported TUI providers.
  it('idle-complete: a non-counter provider (gemini) stays success even with no work-counter signal', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    runSpawn({ tuiConfig: { command: 'gemini', args: [], commandLine: 'gemini', promptDelayMs: 100, idleTimeoutMs: 50 } });
    await flushMicrotasks();

    await capturedOnData(Buffer.from('Gemini booting...\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3600); // submit fires
    await flushMicrotasks();
    // Real work output, but NO `(Ns ·` counter (gemini doesn't render one).
    await capturedOnData(Buffer.from('Editing src/foo.js …\n'));
    await vi.advanceTimersByTimeAsync(21000);
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

  // ── 1b. Submit-Enter retries ─────────────────────────────────────────────────
  // A single `\r` after a large bracketed paste can be swallowed mid-paste-
  // commit, stranding the prompt unsent (the "I had to hit Enter myself" bug,
  // which then idles out and is falsely marked success). The fallback path must
  // fire the Enter SUBMIT_ENTER_ATTEMPTS times, spaced apart, so one lands after
  // the paste settles. Asserts the bracketed paste is written once and `\r` is
  // written exactly SUBMIT_ENTER_ATTEMPTS times.
  it('submit-enter: writes the bracketed paste once and retries the submit Enter SUBMIT_ENTER_ATTEMPTS times', async () => {
    const { SUBMIT_ENTER_ATTEMPTS, SUBMIT_ENTER_SPACING_MS, PASTE_TO_ENTER_FALLBACK_MS } =
      await vi.importActual('../lib/tuiHandshake.js');

    runSpawn({ prompt: 'paste me into the box' });
    await flushMicrotasks();

    // Banner output so firstOutputAt is set, then advance past the prompt-delay
    // floor + readiness idle threshold so the ready poll fires the paste.
    await capturedOnData(Buffer.from('Codex booting...\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    const writes = () => vi.mocked(shellService.writeToSession).mock.calls
      .filter(([id]) => id === SESSION_ID);
    const pasteWrites = () => writes().filter(([, data]) => data.startsWith('\x1b[200~'));
    const enterWrites = () => writes().filter(([, data]) => data === '\r');

    // Paste is written exactly once; no Enter has been sent yet (we never
    // emit the [Pasted text] marker, so the 3500ms fallback drives submit).
    expect(pasteWrites()).toHaveLength(1);
    expect(enterWrites()).toHaveLength(0);

    // Emit the prompt echo so paste verification passes (issue #2192).
    // In a real TUI, the paste is echoed in the input buffer.
    await capturedOnData(Buffer.from('ste me into the box\n'));
    await flushMicrotasks();

    // Advance past the fallback window AND the full spread of retry spacing
    // intervals. Once the budget is exhausted the interval stops re-sending
    // (Enter into an empty box would be a no-op anyway).
    await vi.advanceTimersByTimeAsync(
      PASTE_TO_ENTER_FALLBACK_MS + SUBMIT_ENTER_SPACING_MS * (SUBMIT_ENTER_ATTEMPTS + 3)
    );
    await flushMicrotasks();

    // Exactly SUBMIT_ENTER_ATTEMPTS Enters, and the paste was never re-sent.
    expect(enterWrites()).toHaveLength(SUBMIT_ENTER_ATTEMPTS);
    expect(pasteWrites()).toHaveLength(1);
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

    // Drive the idle-complete success path (mirrors test 1) — the post-paste
    // chunk must carry a work-activity signal so the idle gate finalizes as
    // success (issue #1229).
    await capturedOnData(Buffer.from('Codex booting...\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    // Emit the prompt echo so paste verification passes (issue #2192).
    await capturedOnData(Buffer.from('do the thing\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3600); // submit-Enter fires → promptSubmittedAt set
    await flushMicrotasks();
    await capturedOnData(Buffer.from('(1s · thinking with high effort)\n'));
    await vi.advanceTimersByTimeAsync(800); // counter must tick across ≥750ms to count as work
    await capturedOnData(Buffer.from('(2s · thinking with high effort)\n'));
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

  // ── 10. Completion-sentinel ingestion on the shell-exit path ─────────────────
  // The completion workflow has the agent write `.agent-done` and then stop
  // (it does NOT `/quit`). Normally the 2s doneSentinelTimer poll finalizes the
  // agent, but the TUI process can also exit on its own (or be killed) before
  // the poll ticks — when that shell-exit path wins the race, finish() MUST
  // still ingest the sentinel so its markdown resolution lands in outputBuffer /
  // output.txt and shows up in the completed-agent details view. Regression
  // guard for the lost-resolution bug where the summary only got ingested by
  // the poll path.
  it('shell-exit after sentinel write: ingests .agent-done summary into the persisted output (process exit beats the 2s poll)', async () => {
    const { appendFile } = await import('fs/promises');
    const sentinel = '## Summary\nImplemented the fix.\n\n## PR\nhttps://example.com/pr/42';
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockImplementation(async (p) =>
      typeof p === 'string' && p.endsWith('.agent-done') ? sentinel : ''
    );

    const spawnPromise = runSpawn({ workspacePath: '/tmp/ws' });
    await flushMicrotasks();

    // Simulate the TUI process exiting cleanly from /quit — NOT the poll.
    await capturedOnExit({ exitCode: 0, killed: false });
    await flushMicrotasks();

    await spawnPromise;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledTimes(1);

    // The completed-agent details view reads output.txt (getAgent) and the
    // in-state output stream (live view / fallback). Both must carry the
    // sentinel resolution — assert on the persistence paths, not outputBuffer,
    // since the test mocks OUTPUT_BUFFER_CAP down to 1 byte.
    const flushedLines = vi.mocked(cosAgents.appendAgentOutputLines).mock.calls
      .flatMap(([, lines]) => lines);
    expect(flushedLines).toContain('✅ Agent signaled completion');
    expect(flushedLines.some(l => l.includes('Implemented the fix.'))).toBe(true);
    expect(flushedLines.some(l => l.includes('https://example.com/pr/42'))).toBe(true);

    const outputTxtWrites = vi.mocked(appendFile).mock.calls
      .filter(([p]) => typeof p === 'string' && p.endsWith('output.txt'))
      .map(([, data]) => String(data))
      .join('');
    expect(outputTxtWrites).toContain('Implemented the fix.');
    expect(outputTxtWrites).toContain('https://example.com/pr/42');
  });
});

// Issue #2074 — the idle reaper must extend its grace while a swarm orchestrator
// is in its Phase C merge queue, and, if the EXTENDED window still blows, surface
// a needs-manual-finish failure instead of a silent `status: completed`. This is
// the exact decision the `idleTimer` interval makes; mirror it as a pure function
// (the inline-copy pattern from subAgentSpawner.test.js) so the branch matrix is
// tested without standing up the full fake-timer PTY harness. Generalized to
// do:release/do:pr/do:rpr's multi-reviewer loop below (agent-61508f36, PR #2084).
describe('agentTuiSpawning — idle reap decision (#2074)', () => {
  const MERGE_QUEUE_IDLE_TIMEOUT_MS = 900000;
  const REVIEW_LOOP_IDLE_TIMEOUT_MS = 900000;

  // Faithful copy of the SYNCHRONOUS part of the idleTimer body's finalize-
  // selection logic. The real code has an async worktree-changes check (#2191)
  // that may downgrade `idle-complete` to `idle-no-changes` — that's tested via
  // the full fake-timer harness above, not this pure function.
  function decideIdleReap({ idle, baseIdleTimeoutMs, mergeQueueActive, reviewLoopActive, workActive, rendersCounter }) {
    const effectiveIdleTimeoutMs = mergeQueueActive
      ? Math.max(baseIdleTimeoutMs, MERGE_QUEUE_IDLE_TIMEOUT_MS)
      : reviewLoopActive
        ? Math.max(baseIdleTimeoutMs, REVIEW_LOOP_IDLE_TIMEOUT_MS)
        : baseIdleTimeoutMs;
    if (idle < effectiveIdleTimeoutMs) return { action: 'wait', effectiveIdleTimeoutMs };
    if (mergeQueueActive) {
      return { action: 'reap', success: false, reason: 'merge-queue-idle-timeout', effectiveIdleTimeoutMs };
    }
    if (reviewLoopActive) {
      return { action: 'reap', success: false, reason: 'review-loop-idle-timeout', effectiveIdleTimeoutMs };
    }
    const noWorkButCounterExpected = !workActive && rendersCounter;
    if (noWorkButCounterExpected) {
      return { action: 'reap', success: false, reason: 'idle-no-activity', effectiveIdleTimeoutMs };
    }
    return { action: 'reap', success: true, reason: 'idle-complete', effectiveIdleTimeoutMs };
  }

  const BASE = 180000;

  it('does NOT reap at the 3-min default while in a merge queue — grace extends to 15min', () => {
    const r = decideIdleReap({ idle: BASE + 5000, baseIdleTimeoutMs: BASE, mergeQueueActive: true, workActive: true, rendersCounter: true });
    expect(r.action).toBe('wait');
    expect(r.effectiveIdleTimeoutMs).toBe(MERGE_QUEUE_IDLE_TIMEOUT_MS);
  });

  it('reaps a merge-queue agent as needs-manual-finish once the EXTENDED window blows', () => {
    const r = decideIdleReap({ idle: MERGE_QUEUE_IDLE_TIMEOUT_MS + 1, baseIdleTimeoutMs: BASE, mergeQueueActive: true, workActive: true, rendersCounter: true });
    expect(r.action).toBe('reap');
    expect(r.success).toBe(false);
    expect(r.reason).toBe('merge-queue-idle-timeout');
  });

  it('leaves the pre-#2074 idle-complete path untouched when NOT in a merge queue', () => {
    const r = decideIdleReap({ idle: BASE + 1, baseIdleTimeoutMs: BASE, mergeQueueActive: false, workActive: true, rendersCounter: true });
    expect(r.action).toBe('reap');
    expect(r.success).toBe(true);
    expect(r.reason).toBe('idle-complete');
  });

  it('leaves the #1229 no-activity failure path untouched when NOT in a merge queue', () => {
    const r = decideIdleReap({ idle: BASE + 1, baseIdleTimeoutMs: BASE, mergeQueueActive: false, workActive: false, rendersCounter: true });
    expect(r.action).toBe('reap');
    expect(r.success).toBe(false);
    expect(r.reason).toBe('idle-no-activity');
  });

  it('a merge-queue reap takes precedence over the no-activity downgrade', () => {
    // Even with no work counter seen, a latched merge queue means real work was
    // happening — surface it as needs-manual-finish, not a never-submitted prompt.
    const r = decideIdleReap({ idle: MERGE_QUEUE_IDLE_TIMEOUT_MS + 1, baseIdleTimeoutMs: BASE, mergeQueueActive: true, workActive: false, rendersCounter: true });
    expect(r.reason).toBe('merge-queue-idle-timeout');
  });

  // Generalizes the #2074 fix to do:release/do:pr/do:rpr's multi-reviewer loop —
  // observed 2026-07-02 on agent-61508f36 (PR #2084): a slow codex review pass
  // went silent past the 3-minute default and the still-waiting release agent
  // was reaped as a false `idle-complete` success before it ever merged.
  it('does NOT reap at the 3-min default while in a review loop — grace extends to 15min', () => {
    const r = decideIdleReap({ idle: BASE + 5000, baseIdleTimeoutMs: BASE, reviewLoopActive: true, workActive: true, rendersCounter: true });
    expect(r.action).toBe('wait');
    expect(r.effectiveIdleTimeoutMs).toBe(REVIEW_LOOP_IDLE_TIMEOUT_MS);
  });

  it('reaps a review-loop agent as needs-manual-finish once the EXTENDED window blows', () => {
    const r = decideIdleReap({ idle: REVIEW_LOOP_IDLE_TIMEOUT_MS + 1, baseIdleTimeoutMs: BASE, reviewLoopActive: true, workActive: true, rendersCounter: true });
    expect(r.action).toBe('reap');
    expect(r.success).toBe(false);
    expect(r.reason).toBe('review-loop-idle-timeout');
  });

  it('a review-loop reap takes precedence over the no-activity downgrade', () => {
    const r = decideIdleReap({ idle: REVIEW_LOOP_IDLE_TIMEOUT_MS + 1, baseIdleTimeoutMs: BASE, reviewLoopActive: true, workActive: false, rendersCounter: true });
    expect(r.reason).toBe('review-loop-idle-timeout');
  });

  it('a merge-queue reap takes precedence over a review-loop reap when both are (implausibly) active', () => {
    const r = decideIdleReap({ idle: 900001, baseIdleTimeoutMs: BASE, mergeQueueActive: true, reviewLoopActive: true, workActive: true, rendersCounter: true });
    expect(r.reason).toBe('merge-queue-idle-timeout');
  });
});
