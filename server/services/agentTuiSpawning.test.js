import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';

// ─── Mocks for spawnTuiAgent tests ──────────────────────────────────────────
// All vi.mock calls must be at the top level before any imports.

vi.mock('./shell.js', () => ({
  createShellSession: vi.fn(),
  writeToSession: vi.fn(),
  pasteToSession: vi.fn(),
  killSession: vi.fn(),
  getSession: vi.fn(),
  getSessionProcess: vi.fn(),
  getLastInputAt: vi.fn().mockReturnValue(null),
  registerExternalSession: vi.fn(),
}));

vi.mock('./cosRunnerClient.js', () => ({
  spawnTuiSessionViaRunner: vi.fn(),
}));

vi.mock('./cosEvents.js', () => ({
  emitLog: vi.fn()
}));

vi.mock('./cosAgentLifecycle.js', () => ({
  appendAgentOutputLines: vi.fn().mockResolvedValue(undefined),
  updateAgent: vi.fn().mockResolvedValue(undefined),
  completeAgent: vi.fn().mockResolvedValue(undefined)
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

vi.mock('./agentFinalization.js', () => ({
  persistSimplifySummaries: vi.fn().mockResolvedValue(undefined),
  finalizeAgent: vi.fn().mockResolvedValue(undefined),
  releaseAgentLane: vi.fn()
}));

vi.mock('./codeReview.js', () => ({
  resolveReviewLoopOptions: vi.fn().mockResolvedValue({
    reviewers: ['codex'],
    usernames: [],
    optionalReviewers: [],
    reviewerMaxRounds: {},
    reviewStopMode: 'on-clean',
    reviewerApplies: false,
    reviewerModels: {},
  })
}));

// Only the mutable registries are stubbed; the module's pure predicates
// (isFalsyMeta et al., which the worktreeChangesExpected opt-out reads through)
// come from the real module — it is import-free, so there is nothing to isolate,
// and a hand-written copy would silently drift from the real metadata coercion.
vi.mock('./agentState.js', async (importOriginal) => ({
  ...await importOriginal(),
  activeAgents: new Map(),
  userTerminatedAgents: new Set(),
  pausedAgents: new Map(),
  registerSpawnedAgent: vi.fn(),
  unregisterSpawnedAgent: vi.fn(),
}));

// ONE execGit double behind BOTH entry points. The commit half of the
// work-evidence probe moved to `lib/gitCommitProbe.js` (#3637), which reaches
// `lib/execGit.js` directly rather than through `git.js`'s re-export — so mocking
// only `git.js` would leave the probe shelling out to real git. Sharing the spy
// keeps every `vi.mocked(gitService.execGit)` override in this file authoritative
// for the probe too.
const { execGitMock, getPullRequestStateMock } = vi.hoisted(() => ({
  execGitMock: vi.fn(),
  getPullRequestStateMock: vi.fn().mockResolvedValue({ status: 'known', state: 'OPEN' }),
}));
vi.mock('../lib/execGit.js', () => ({ execGit: execGitMock }));
vi.mock('./github.js', () => ({
  getPullRequestState: (...args) => getPullRequestStateMock(...args),
}));

vi.mock('./git.js', () => ({
  // Default: worktree has changes so idle-complete succeeds. Tests that want
  // to exercise the idle-no-changes failure path override via mockResolvedValueOnce.
  getStatus: vi.fn().mockResolvedValue({ clean: false, files: [{ path: 'file.txt', status: 'M' }] }),
  getDiff: vi.fn().mockResolvedValue('diff content here'),
  // `git rev-list --count --since=…` for the commit half of the work-evidence
  // probe. Default: zero commits during the run, so a clean tree still fails —
  // the commit-and-push test overrides this to a non-zero count.
  execGit: execGitMock,
  // No owner-matched gh account by default → empty overlay (ambient auth kept).
  resolveForgeTokenEnv: vi.fn().mockResolvedValue({}),
}));

// Lazily imported by finish()'s cleanup block to record a failed run's resume
// pointer (#3368). Mocked so the test doesn't pull the real cleanup graph
// (cos.js, worktreeManager, recoveryTasks) in behind it.
vi.mock('./agentWorktreeCleanup.js', () => ({
  releaseRetryHold: vi.fn().mockResolvedValue({}),
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

vi.mock('../lib/fileUtils.js', async (importOriginal) => ({
  // Keep the real pure helpers (safeJSONParse — used transitively by
  // agentSentinel.parseSentinelPayload, etc.); only stub the I/O + PATHS.
  ...(await importOriginal()),
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
  // NOTE: `appendModelArgs` calls `resolveInjectedTuiModel`, which is pulled in
  // REAL via importOriginal above and calls `resolveBedrockCliModel` /
  // `prefixOpencodeModel` as module-INTERNAL references — a vi.mock override of
  // those two names cannot intercept an internal call, so stubbing them here
  // would be dead weight that reads as protection. Instead the suite pins the
  // one input the real mapper keys on (`CLAUDE_CODE_USE_BEDROCK`, cleared in
  // beforeEach below), so these assertions are deterministic regardless of the
  // ambient env on a developer's Bedrock box or a CI runner.
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
import { releaseRetryHold } from './agentWorktreeCleanup.js';
import { spawnTuiSessionViaRunner } from './cosRunnerClient.js';
import * as shellService from './shell.js';
import * as agentLifecycle from './agentFinalization.js';
import * as agentErrorAnalysis from './agentErrorAnalysis.js';
import * as cosAgentLifecycle from './cosAgentLifecycle.js';
import * as gitService from './git.js';
import { activeAgents, userTerminatedAgents } from './agentState.js';
import {
  MAX_RUNTIME_WRAP_UP_GRACE_MS,
  SELF_CLEARING_RESUBMIT_INTERVAL_MS,
  MERGE_QUEUE_IDLE_TIMEOUT_MS,
  REVIEW_LOOP_IDLE_TIMEOUT_MS,
  BACKGROUND_SHELL_IDLE_TIMEOUT_MS,
  decideIdleReap,
} from '../lib/tuiHandshake.js';
// Real module, not a mock: the flag is a plain process-local boolean, so driving
// it directly exercises the same code path production does.
import { markHostShuttingDown, resetHostShutdownFlagForTests } from '../lib/hostShutdown.js';

describe('agent TUI spawning', () => {
  // `buildTuiSpawnConfig` → `appendModelArgs` → the REAL `resolveInjectedTuiModel`,
  // whose Bedrock arm reads process.env directly (see the vi.mock note above on why
  // stubbing the mapper can't intercept that internal call). Pin the var here so a
  // developer's Bedrock box — or a CI runner that exports it — can't flip these
  // assertions; the tests that WANT Bedrock set it explicitly.
  const bedrockBefore = process.env.CLAUDE_CODE_USE_BEDROCK;
  beforeEach(() => { delete process.env.CLAUDE_CODE_USE_BEDROCK; });
  afterEach(() => {
    if (bedrockBefore === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
    else process.env.CLAUDE_CODE_USE_BEDROCK = bedrockBefore;
  });

  // Regression guard for the drift this path actually shipped: `appendModelArgs`
  // was a second, open-coded copy of the model-injection ladder, so cursor's
  // Bedrock exemption landed only in `buildTuiInvocation` and a cursor CoS agent
  // on a Bedrock box launched with a rewritten, unroutable model id. Both copies
  // now delegate to `resolveInjectedTuiModel`; re-inlining the mapper here would
  // break this test.
  it('does not Bedrock-map a cursor TUI model id that merely contains "claude"', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    const config = buildTuiSpawnConfig({
      id: 'cursor-tui',
      type: 'tui',
      command: 'cursor-agent',
      args: ['--force'],
    }, 'claude-opus-5-thinking-high');
    expect(config.args).toEqual(['--force', '--model', 'claude-opus-5-thinking-high']);
    expect(config.args.join(' ')).not.toContain('anthropic.');
  });

  it('still Bedrock-maps a claude TUI model id on a Bedrock box', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    const config = buildTuiSpawnConfig({
      id: 'claude-code-tui',
      type: 'tui',
      command: 'claude',
      args: ['--dangerously-skip-permissions'],
    }, 'claude-opus-4-8');
    expect(config.args).toContain('global.anthropic.claude-opus-4-8');
  });

  // A user-baked --model pin used to be honored only for opencode here, so a
  // pinned claude/codex/cursor TUI spawned `--model <pin> --model <ui-choice>`
  // and last-flag-wins silently discarded the pin.
  it('honors a user-baked --model pin instead of appending a second flag', () => {
    const config = buildTuiSpawnConfig({
      id: 'cursor-tui',
      type: 'tui',
      command: 'cursor-agent',
      args: ['--force', '--model', 'composer-2.5'],
    }, 'auto');
    expect(config.args.filter((a) => a === '--model')).toHaveLength(1);
    expect(config.args).toContain('composer-2.5');
    expect(config.args).not.toContain('auto');
  });

  it('builds a codex TUI command without a model flag for the configured-default sentinel', () => {
    const config = buildTuiSpawnConfig({
      id: 'codex-tui',
      name: 'Codex TUI',
      type: 'tui',
      command: 'codex',
      args: []
    }, 'codex-configured-default');

    expect(config.command).toBe('codex');
    expect(config.args).toEqual(['--dangerously-bypass-approvals-and-sandbox', '-c', 'check_for_update_on_startup=false']);
    expect(config.commandLine).toBe('codex --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false');
  });

  it('injects --dangerously-bypass-approvals-and-sandbox for codex TUI when not already set', () => {
    const config = buildTuiSpawnConfig({
      id: 'codex-tui',
      command: 'codex',
      type: 'tui',
      args: ['--cd', '/tmp/work']
    }, null);
    expect(config.args).toEqual(['--dangerously-bypass-approvals-and-sandbox', '-c', 'check_for_update_on_startup=false', '--cd', '/tmp/work']);
  });

  it('skips the bypass flag but still disables the update check when the provider config pins an approval policy', () => {
    const config = buildTuiSpawnConfig({
      id: 'codex-tui',
      command: 'codex',
      type: 'tui',
      args: ['--ask-for-approval', 'on-failure']
    }, null);
    expect(config.args).toEqual(['-c', 'check_for_update_on_startup=false', '--ask-for-approval', 'on-failure']);
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
    expect(config.args).toEqual(['--dangerously-bypass-approvals-and-sandbox', '-c', 'check_for_update_on_startup=false']);
    expect(config.commandLine).toBe('codex --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false');
  });

  it('adds --effort for a claude TUI and a -c model_reasoning_effort pair for a codex TUI', () => {
    const claude = buildTuiSpawnConfig(
      { id: 'claude-code-tui', command: 'claude', type: 'tui', args: [] },
      'claude-opus-4-8',
      { effort: 'xhigh' },
    );
    expect(claude.args[claude.args.indexOf('--effort') + 1]).toBe('xhigh');

    const codex = buildTuiSpawnConfig(
      { id: 'codex-tui', command: 'codex', type: 'tui', args: [] },
      null,
      { effort: 'ultra' },
    );
    expect(codex.args).toContain('model_reasoning_effort=ultra');
    expect(codex.args).not.toContain('--effort');
  });

  it('omits effort args when unset or when the TUI has no effort control', () => {
    const noEffort = buildTuiSpawnConfig({ id: 'claude-code-tui', command: 'claude', type: 'tui', args: [] }, null);
    expect(noEffort.args).not.toContain('--effort');

    const grok = buildTuiSpawnConfig({ id: 'grok-tui', command: 'grok', type: 'tui', args: [] }, null, { effort: 'high' });
    expect(grok.args.join(' ')).not.toContain('effort');
  });

  it('passes --effort through to the Antigravity TUI, clamped to its low|medium|high ladder', () => {
    const agy = buildTuiSpawnConfig({ id: 'antigravity-tui', command: 'agy', type: 'tui', args: [] }, null, { effort: 'high' });
    expect(agy.args).toEqual(['--dangerously-skip-permissions', '--effort', 'high']);

    const clamped = buildTuiSpawnConfig({ id: 'antigravity-tui', command: 'agy', type: 'tui', args: [] }, null, { effort: 'max' });
    expect(clamped.args).toEqual(['--dangerously-skip-permissions', '--effort', 'high']);
  });

  it('passes the per-task model through to the Antigravity TUI', () => {
    const agy = buildTuiSpawnConfig(
      { id: 'antigravity-tui', command: 'agy', type: 'tui', args: [] },
      'gemini-3.1-pro-high',
      { effort: 'low' },
    );
    // An explicitly selected effort wins over the tier baked into the model id,
    // and the id is passed as its base so agy sees exactly one effort source.
    expect(agy.args).toEqual(['--dangerously-skip-permissions', '--model', 'gemini-3.1-pro', '--effort', 'low']);
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
    // Default the connectivity probe to "online" so the idle reaper behaves
    // exactly as before for every existing test — no real network I/O. The
    // outage tests below inject their own resolver.
    const checkOnlineFn = overrides.checkOnlineFn ?? vi.fn().mockResolvedValue(true);
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
      checkOnlineFn,
      useDurableRunner: overrides.useDurableRunner ?? false,
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
    vi.mocked(spawnTuiSessionViaRunner).mockImplementation(async (options) => {
      capturedOnData = options.onData;
      capturedOnExit = options.onExit;
      return {
        sessionId: SESSION_ID,
        pid: 4321,
        ptyProcess: {
          pid: 4321,
          onData: vi.fn(),
          onExit: vi.fn(),
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
        },
      };
    });

    // Reset sentinel state: no .agent-done on disk, empty read. The
    // completion-sentinel test overrides both. clearAllMocks keeps the factory
    // implementation, so re-set explicitly to prevent cross-test leakage.
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFile).mockResolvedValue('');

    // Reset git mock: default is worktree has changes (idle-complete succeeds).
    // Tests that want to exercise the idle-no-changes failure path override this.
    vi.mocked(gitService.getStatus).mockResolvedValue({ clean: false, files: [{ path: 'file.txt', status: 'M' }] });
    vi.mocked(gitService.getDiff).mockResolvedValue('diff content here');
    vi.mocked(gitService.execGit).mockResolvedValue({ exitCode: 0, stdout: '0\n', stderr: '' });

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

  // ── GH_TOKEN pinning: the agent's own `gh pr create` must auth as the repo owner ─
  it('uses a runner-owned PTY and registers it as an attachable shell session', async () => {
    runSpawn({ useDurableRunner: true });
    await flushMicrotasks();

    expect(spawnTuiSessionViaRunner).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1',
      taskId: 'task-1',
      command: 'codex',
      workspacePath: '/tmp/ws',
      // Per-agent sentinel: `/tmp/ws` is a SHARED workspace (its basename is not
      // the agent id), so the run watches only its own `.agent-done-agent-1`.
      doneSentinelPath: join('/tmp/ws', '.agent-done-agent-1'),
    }));
    expect(shellService.createShellSession).not.toHaveBeenCalled();
    expect(shellService.registerExternalSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ pid: 4321 }),
      expect.objectContaining({ agentId: 'agent-1', kind: 'agent-tui' }),
    );

    await capturedOnExit({ exitCode: 1, signal: 15 });
  });

  it('passes the repo-owner-pinned GH_TOKEN into the TUI session env (buildSafeEnv would otherwise strip it)', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });
    vi.mocked(gitService.resolveForgeTokenEnv).mockResolvedValueOnce({ GH_TOKEN: 'ghp_pinned_owner_token' });

    runSpawn({ workspacePath: '/tmp/ws' });
    await flushMicrotasks();

    // Resolved against the agent's workspace and folded into the session env.
    expect(gitService.resolveForgeTokenEnv).toHaveBeenCalledWith('/tmp/ws');
    expect(shellService.createShellSession).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ env: expect.objectContaining({ GH_TOKEN: 'ghp_pinned_owner_token' }) }),
    );

    // Drive the shell-exit path so the completion chain settles and no timer leaks.
    await capturedOnExit({ exitCode: 0, killed: false });
    await completeDone;
  });

  it('skips the owner-token probe when the provider supplies its own GITHUB_TOKEN so the explicit credential wins', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    runSpawn({ provider: { id: 'codex-tui', name: 'Codex TUI', type: 'tui', envVars: { GITHUB_TOKEN: 'ghp_provider_bot' } } });
    await flushMicrotasks();

    // gh prefers GH_TOKEN over GITHUB_TOKEN, so injecting an owner GH_TOKEN would
    // shadow the provider's bot credential — the probe must be skipped entirely.
    expect(gitService.resolveForgeTokenEnv).not.toHaveBeenCalled();
    const env = vi.mocked(shellService.createShellSession).mock.calls[0][1].env;
    expect(env.GITHUB_TOKEN).toBe('ghp_provider_bot');
    expect(env.GH_TOKEN).toBeUndefined();

    await capturedOnExit({ exitCode: 0, killed: false });
    await completeDone;
  });

  it('hands a slashdo-free TUI PR to PortOS for creation and review/merge follow-up', async () => {
    const cleanupWorktreeFn = vi.fn().mockResolvedValue(undefined);
    const spawnPromise = runSpawn({
      provider: { id: 'codex-tui', name: 'Codex TUI', type: 'tui', command: 'codex', envVars: {} },
      task: {
        id: 'task-1',
        description: 'do the thing',
        metadata: { openPR: true, prCompletion: 'review-then-merge', reviewers: ['codex'] },
      },
      helpers: { cleanupWorktreeFn, isTruthyMetaFn: (value) => value === true || value === 'true' },
    });
    await flushMicrotasks();

    await capturedOnExit({ exitCode: 0, killed: false });
    await spawnPromise;

    expect(cleanupWorktreeFn).toHaveBeenCalledWith('agent-1', true, expect.objectContaining({
      openPR: true,
      prCompletion: 'review-then-merge',
      reviewers: ['codex'],
      skipMerge: false,
    }));
  });

  it('does not double-fire a PR owned by a slashdo-capable Claude TUI', async () => {
    const cleanupWorktreeFn = vi.fn().mockResolvedValue(undefined);
    const spawnPromise = runSpawn({
      provider: { id: 'claude-code-tui', name: 'Claude TUI', type: 'tui', command: 'claude', envVars: {} },
      task: {
        id: 'task-1',
        description: 'do the thing',
        metadata: { openPR: true, prCompletion: 'review-then-merge' },
      },
      helpers: { cleanupWorktreeFn, isTruthyMetaFn: (value) => value === true || value === 'true' },
    });
    await flushMicrotasks();

    await capturedOnExit({ exitCode: 0, killed: false });
    await spawnPromise;

    expect(cleanupWorktreeFn).toHaveBeenCalledWith('agent-1', true, expect.objectContaining({
      openPR: false,
      prCompletion: 'review-then-merge',
      skipMerge: true,
    }));
  });

  // A failed TUI run's branch is preserved by cleanup when it holds commits; without
  // this call nothing ever points the retry at it and the work is redone from
  // scratch (#3368). Runs after cleanup so it reflects what actually survived.
  it('records a resume pointer after cleanup when the run failed', async () => {
    vi.mocked(releaseRetryHold).mockClear();
    const cleanupWorktreeFn = vi.fn().mockResolvedValue(undefined);
    const task = { id: 'task-1', description: 'do the thing', metadata: {} };
    const spawnPromise = runSpawn({ task, helpers: { cleanupWorktreeFn, isTruthyMetaFn: (v) => !!v } });
    await flushMicrotasks();

    await capturedOnExit({ exitCode: 1, killed: false });
    await spawnPromise;

    expect(releaseRetryHold).toHaveBeenCalledWith({ agentId: 'agent-1', task, success: false });
    expect(cleanupWorktreeFn.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(releaseRetryHold).mock.invocationCallOrder[0]);
  });

  // The helper no-ops on success (unit-tested in cleanupAgentWorktree.test.js) —
  // what this pins is that finish() hands it the real verdict, not a hardcoded
  // false that would stamp pointers on every completed run.
  it('passes the success verdict through on a clean run', async () => {
    vi.mocked(releaseRetryHold).mockClear();
    const spawnPromise = runSpawn({ helpers: { cleanupWorktreeFn: vi.fn().mockResolvedValue(undefined), isTruthyMetaFn: (v) => !!v } });
    await flushMicrotasks();

    await capturedOnExit({ exitCode: 0, killed: false });
    await spawnPromise;

    expect(releaseRetryHold).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

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

  // ── 1a-quater. worktreeChangesExpected:false skips the clean-tree gate (#3102) ─
  // Issue #3102: the #2191 gate above assumes every agent's work product is a
  // file change. A `reference-watch` run against a GitHub/GitLab/JIRA work
  // tracker files ISSUES and — per its own prompt — edits no application code,
  // so a run that did its whole job leaves a CLEAN worktree and was recorded as
  // `idle-no-changes` failure. `worktreeChangesExpected: false` opts such a task
  // out of the worktree gate, leaving `workActivity.active` as the sole signal.
  //
  // Drives the same PTY sequence as the idle-no-changes test: prompt echo →
  // submit → an ADVANCING work counter → idle out, with a clean worktree.
  // Shared PTY choreography: boot banner → prompt echo (paste verify) → submit
  // Enter → an ADVANCING work counter (sets workActivity.active and
  // lastOutputAt > promptSentAt). Leaves fake timers running at the second
  // counter; callers add their own tail (idle advance + git/finalize/assertions).
  async function driveToSubmittedAndWorking(overrides = {}) {
    runSpawn(overrides);
    await flushMicrotasks();

    await capturedOnData(Buffer.from('Codex booting...\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    // Prompt echo so paste verification passes and the submit-Enter fires.
    await capturedOnData(Buffer.from('do the thing\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3600);
    await flushMicrotasks();

    // An ADVANCING work counter → workActivity.active becomes true.
    await capturedOnData(Buffer.from('(1s · thinking with high effort)\n'));
    await vi.advanceTimersByTimeAsync(800);
    await capturedOnData(Buffer.from('(2s · thinking with high effort)\n'));
  }

  async function driveIdleWithWorkOnCleanTree(overrides) {
    vi.mocked(gitService.getStatus).mockResolvedValue({ clean: true, files: [] });
    vi.mocked(gitService.getDiff).mockResolvedValue('');

    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    await driveToSubmittedAndWorking(overrides);

    await vi.advanceTimersByTimeAsync(21000);
    vi.useRealTimers();
    await completeDone;
  }

  it('idle-complete: worktreeChangesExpected:false succeeds on a clean worktree (non-file work tracker)', async () => {
    await driveIdleWithWorkOnCleanTree({
      task: { id: 'task-1', description: 'do the thing', metadata: { worktreeChangesExpected: false } },
    });

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        success: true,
        completionReason: 'idle-complete',
      })
    );
    // The gate is skipped, so git status is never consulted — but the diff
    // capture still runs unconditionally (a no-op on a clean tree, and useful
    // for post-mortems either way).
    expect(gitService.getStatus).not.toHaveBeenCalled();
    expect(gitService.getDiff).toHaveBeenCalledWith('/tmp/ws', true);
    expect(gitService.getDiff).toHaveBeenCalledWith('/tmp/ws', false);
  });

  it("idle-no-changes: the TASKS.md string round-trip 'false' also opts out of the gate", async () => {
    // Task metadata survives a markdown round-trip as strings, so the opt-out
    // must read through isFalsyMeta rather than a bare `=== false`.
    await driveIdleWithWorkOnCleanTree({
      task: { id: 'task-1', description: 'do the thing', metadata: { worktreeChangesExpected: 'false' } },
    });

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, completionReason: 'idle-complete' })
    );
  });

  it('idle-no-changes: worktreeChangesExpected:true still fails on a clean worktree (no behavior change)', async () => {
    await driveIdleWithWorkOnCleanTree({
      task: { id: 'task-1', description: 'do the thing', metadata: { worktreeChangesExpected: true } },
    });

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, completionReason: 'idle-no-changes' })
    );
  });

  // ── 1a-sexies. A programmatic-I/O run is judged by its PAYLOAD, not the tree ──
  // A layered-intelligence run reasons over the app's goals and returns JSON that
  // a deterministic step files as one tracker issue; its prompt FORBIDS touching
  // the repo. Measuring it by worktree evidence blamed it for exactly the thing it
  // was told not to do — the failure read "zero file changes" on a task that must
  // change no files — and buried the real miss: no `.agent-done` payload landed,
  // so nothing was filed.
  const liTask = (metadata = {}) => ({
    id: 'task-1',
    description: 'do the thing',
    taskType: 'internal',
    metadata: { analysisType: 'layered-intelligence', useWorktree: true, openPR: false, discardWorktree: true, ...metadata },
  });

  it('idle-no-deliverable: a programmatic-I/O run with no sentinel fails on its OWN criterion', async () => {
    await driveIdleWithWorkOnCleanTree({ task: liTask() });

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, completionReason: 'idle-no-deliverable' })
    );
    // The worktree question is never asked — it measures nothing about this run.
    expect(gitService.getStatus).not.toHaveBeenCalled();
  });

  it('idle-no-deliverable: the failure names the missing payload, not missing file changes', async () => {
    await driveIdleWithWorkOnCleanTree({ task: liTask() });

    const { error } = vi.mocked(agentLifecycle.finalizeAgent).mock.calls.at(-1)[0];
    expect(error).toContain('.agent-done');
    expect(error).not.toContain('zero uncommitted file changes');
  });

  // A DIRTY tree doesn't rescue it either: this type ships a payload, and stray
  // edits in a worktree that is discarded unmerged are not the deliverable.
  it('idle-no-deliverable: a dirty worktree does not substitute for the payload', async () => {
    vi.mocked(gitService.getStatus).mockResolvedValue({ clean: false, files: [{ path: 'f.txt', status: 'M' }] });
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    await driveToSubmittedAndWorking({ task: liTask() });
    await vi.advanceTimersByTimeAsync(21000);
    vi.useRealTimers();
    await completeDone;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, completionReason: 'idle-no-deliverable' })
    );
  });

  // The type-derived question must not leak to a code-editing task that merely
  // carries the same worktree-disposal metadata: a quota-burn job can want a
  // scratch checkout it builds in and never lands, and it declares that shape via
  // `worktreeChangesExpected` instead.
  it('idle-no-changes: a code-editing task keeps the worktree criterion', async () => {
    await driveIdleWithWorkOnCleanTree({
      task: { id: 'task-1', description: 'do the thing', metadata: { analysisType: 'security', discardWorktree: true } },
    });

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, completionReason: 'idle-no-changes' })
    );
    expect(gitService.getStatus).toHaveBeenCalled();
  });

  // ── 1a-quinquies. A COMMIT during the run is evidence of work ────────────────
  // The #2191 gate above read only UNCOMMITTED changes, so a job whose
  // deliverable is a commit — `/do:release`, `/do:pr` — idled out on a clean
  // tree *because it succeeded* and was scored a failure. Rationale and the
  // 2026-08-08 release incident: worktreeHasWorkEvidence. The clean-tree +
  // zero-commit failure stays covered by the sibling tests above, which run on
  // the beforeEach default of `rev-list --count` → 0.
  it('idle-complete: a commit made during the run counts as work on a clean tree (release/do:pr jobs)', async () => {
    vi.mocked(gitService.execGit).mockResolvedValue({ exitCode: 0, stdout: '2\n', stderr: '' });
    await driveIdleWithWorkOnCleanTree();

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        success: true,
        completionReason: 'idle-complete',
      })
    );
    // The probe is scoped to the run window by committer date, so commits that
    // were already on the branch at spawn can't launder a no-op into a success.
    expect(gitService.execGit).toHaveBeenCalledWith(
      ['rev-list', '--count', expect.stringMatching(/^--since=\d{4}-/), 'HEAD'],
      '/tmp/ws',
      { ignoreExitCode: true, timeout: 10_000 }
    );
  });

  it('idle-no-activity: worktreeChangesExpected:false does NOT rescue a run with zero work-counter activity', async () => {
    // The flag only relaxes the worktree-evidence gate. A prompt that never
    // submitted (no working indicator ever appeared) must still fail — otherwise
    // opting out of the file gate would silently launder a total no-op run.
    vi.mocked(gitService.getStatus).mockResolvedValue({ clean: true, files: [] });
    vi.mocked(gitService.getDiff).mockResolvedValue('');

    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    runSpawn({ task: { id: 'task-1', description: 'do the thing', metadata: { worktreeChangesExpected: false } } });
    await flushMicrotasks();

    await capturedOnData(Buffer.from('Codex booting...\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    // Chrome-only repaints — the working counter never advances.
    await capturedOnData(Buffer.from('⏵⏵ bypass permissions on (shift+tab to cycle)\n'));
    await capturedOnData(Buffer.from('● high · /effort\n'));

    await vi.advanceTimersByTimeAsync(21000);
    vi.useRealTimers();
    await completeDone;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, completionReason: 'idle-no-activity' })
    );
  });

  // ── 1d. Connectivity-aware idle reaper ──────────────────────────────────────
  // When the machine loses internet, a live TUI goes silent (it can't reach the
  // model) exactly like a hung or finished agent looks to the idle timer — so an
  // outage would reap an agent that's only blocked on the network. The reaper is
  // the ONLY liveness signal for a genuinely hung TUI, so it isn't removed —
  // it's gated on a reachability probe and DEFERS while offline.
  const OFFLINE_TUI_CONFIG = {
    command: 'codex',
    args: [],
    commandLine: 'codex',
    promptDelayMs: 100,
    // A larger idle window than the fast default so the lead probe
    // (idleTimeoutMs/2, capped) resolves on an earlier 5s tick than the reap
    // tick — mirroring how a real 3-minute window spans many probe ticks.
    idleTimeoutMs: 15000,
    maxRuntimeMs: 3600000,
  };

  async function driveToIdleSilence({ checkOnlineFn, silenceMs = 45000 }) {
    await driveToSubmittedAndWorking({ tuiConfig: OFFLINE_TUI_CONFIG, checkOnlineFn });
    // Go silent well past the 15s idle window (several 5s ticks) so the lead
    // probe fires and resolves before the reap tick.
    await vi.advanceTimersByTimeAsync(silenceMs);
    await flushMicrotasks();
  }

  it('idle reaper DEFERS while the machine is offline (does not reap an agent that lost internet)', async () => {
    const checkOnlineFn = vi.fn().mockResolvedValue(false);
    await driveToIdleSilence({ checkOnlineFn });

    expect(checkOnlineFn).toHaveBeenCalled(); // the reachability probe fired
    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled(); // …and the reap was deferred
  });

  it('idle reaper still reaps on the SAME window when online (deferral is outage-specific, not a timing artifact)', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    // dirty tree (default git mock) → idle-complete success
    await driveToIdleSilence({ checkOnlineFn: vi.fn().mockResolvedValue(true) });
    vi.useRealTimers();
    await completeDone;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, completionReason: 'idle-complete' })
    );
  });

  it('idle reaper resumes reaping once connectivity RETURNS (deferral is not permanent)', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    // Offline for the first probe, then the connection comes back. The reap is
    // deferred through the outage, then fires after the reconnect grace window.
    const checkOnlineFn = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    await driveToIdleSilence({ checkOnlineFn, silenceMs: 90000 });
    vi.useRealTimers();
    await completeDone;

    expect(checkOnlineFn.mock.calls.length).toBeGreaterThan(1); // probed again after the outage
    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, completionReason: 'idle-complete' })
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

    // The ceiling PRODS rather than reaping (#3167): it pastes a wrap-up message
    // and opens a grace window, so the agent is NOT finalized yet.
    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();
    expect(shellService.pasteToSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.stringContaining('you have hit your maximum runtime'),
      { label: '[cosAgents] max-runtime wrap-up' },
    );

    // No sentinel ever appears → the grace window expires → NOW it reaps.
    await vi.advanceTimersByTimeAsync(MAX_RUNTIME_WRAP_UP_GRACE_MS + 2000);
    await flushMicrotasks();

    vi.useRealTimers();
    await completeDone;

    // Reaped under the DISTINCT reason: it was asked to wrap up and didn't, which
    // means a wedged provider — not "raise the runtime budget".
    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        success: false,
        completionReason: 'max-runtime-no-wrap-up',
      })
    );
  });

  // The whole point of the grace window: an agent that was SECONDS from writing
  // its sentinel when the ceiling landed must finalize as a SUCCESS, not be
  // reaped. This is the agent-d2ae0352 shape (PR merged 01:32:29, killed
  // 01:32:59) that made a fresh agent redo already-shipped work.
  it('max-runtime: an agent that wraps up during the grace window finalizes as success', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    runSpawn({ tuiConfig: { ...defaultTuiConfig, idleTimeoutMs: 600000, maxRuntimeMs: 30000 } });
    await flushMicrotasks();

    await capturedOnData(Buffer.from('Codex booting...\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    await capturedOnData(Buffer.from('do the thing\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3600);
    await flushMicrotasks();

    // Ceiling fires → prod + grace window, no finalize.
    await vi.advanceTimersByTimeAsync(31000);
    await flushMicrotasks();
    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();

    // The prod works: the agent writes .agent-done well inside the grace window.
    vi.mocked(existsSync).mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(4000);
    await flushMicrotasks();

    vi.useRealTimers();
    await completeDone;

    // Finalized as a SUCCESS via the ordinary sentinel path — never reaped.
    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1', success: true })
    );
    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalledWith(
      expect.objectContaining({ completionReason: 'max-runtime-timeout' })
    );
  });

  // A dead session can't be prodded, so the grace window is pointless — reap
  // immediately rather than idling the full window for a message nobody reads.
  it('max-runtime: reaps immediately (no grace) when the TUI session is already gone', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    runSpawn({ tuiConfig: { ...defaultTuiConfig, idleTimeoutMs: 600000, maxRuntimeMs: 30000 } });
    await flushMicrotasks();

    await capturedOnData(Buffer.from('Codex booting...\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    await capturedOnData(Buffer.from('do the thing\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3600);
    await flushMicrotasks();

    // Session died before the ceiling landed.
    vi.mocked(shellService.getSession).mockReturnValue(null);
    await vi.advanceTimersByTimeAsync(31000);
    await flushMicrotasks();

    vi.useRealTimers();
    await completeDone;

    // Never prodded, so this keeps the plain-ceiling reason (not no-wrap-up).
    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, completionReason: 'max-runtime-timeout' })
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
  // Antigravity (agy) gets the SAME positive input-ready gate as claude (#2705).
  // maxRuntimeMs is explicit for the same reason defaultTuiConfig pins it: left
  // undefined, the wall-clock backstop is a `setTimeout(…, undefined)` that fires
  // on the next tick and prods every one of these runs to wrap up.
  const agyTuiConfig = { command: 'agy', args: [], commandLine: 'agy', promptDelayMs: 100, idleTimeoutMs: 50, maxRuntimeMs: 3600000 };
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

  // Regression (#3202 durable runner): the runner pty.spawns claude DIRECTLY —
  // no launch shell — so the shell's paste-mode OFF never appears in the
  // stream. The tracker must treat claude's own first ON as ready; before the
  // fix every runner-tui claude agent died `tui-not-ready` at the 45s deadline
  // with a live input box on screen (agent-ade9a664 / agent-29ca86ef).
  it('claude input-ready (runner mode): pastes on claude\'s own paste-mode ON with no shell OFF ever seen', async () => {
    // Runner mode must also SKIP the shell-child liveness probe: the TUI is the
    // PTY process itself (no launch shell), so a ps listing where the pid has no
    // children does not mean the TUI exited. Make ps return no child of pid 4321
    // to prove the probe can't veto the paste.
    vi.mocked(execFile).mockImplementation((_file, _args, _opts, cb) => cb(null, '1\n1\n999\n'));
    runSpawn({ tuiConfig: claudeTuiConfig, useDurableRunner: true });
    await flushMicrotasks();

    // Startup banner only — no bracketed-paste OFF precedes it in runner mode.
    await capturedOnData(Buffer.from('Claude Code v2.1.220\nOpus 5 with high effort\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(0); // banner alone is still not "input ready"

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

  // ── 1c-bis. Antigravity (agy) uses the SAME positive input-ready gate (#2705) ─
  // agy's TUI emits the bracketed-paste-mode toggle exactly like claude, so it
  // must gate the paste on paste-mode-re-enabled rather than blind-pasting on the
  // idle heuristic (which fired into agy's still-initializing banner and left the
  // agent sitting at an empty prompt until it was reaped). Without the fix agy
  // took the idle-heuristic path and WOULD have pasted after ~2s of banner idle;
  // asserting pasteCount()===0 there is what discriminates the fix.
  //
  // agy needs a SECOND gate on top of paste mode, because — unlike claude — it
  // enables bracketed paste on alt-screen entry, before its composer exists. Its
  // composer footer is the marker that says the input box is actually live.
  const AGY_COMPOSER_FOOTER = '? for shortcuts';

  it('agy input-ready: does NOT paste until the composer footer follows paste-mode-on', async () => {
    runSpawn({ tuiConfig: agyTuiConfig });
    await flushMicrotasks();

    // Startup banner (and the shell turning paste mode OFF to run the command).
    await capturedOnData(Buffer.from(`${PASTE_OFF}Antigravity CLI 1.1.3\nGemini 3.5 Flash (Medium)\n`));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(0); // banner / paste-mode-off is not "input ready"

    // agy enables bracketed paste when it enters the alt screen — still signing
    // in, no composer yet. Paste mode ALONE must not be treated as ready.
    await capturedOnData(Buffer.from(`${PASTE_ON}Welcome to the Antigravity CLI.\n Signing in...\n`));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(0);

    // Composer renders → input box live, safe to paste.
    await capturedOnData(Buffer.from(`>\n${AGY_COMPOSER_FOOTER}Gemini 3.5 Flash · medium`));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(400);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
  });

  // Regression: the real `paste-not-rendered` failure. agy turned bracketed paste
  // ON at alt-screen entry (~200ms in) and then spent longer than promptDelayMs
  // signing in, so the old paste-mode-only gate fired while the folder-trust menu
  // was still pending — `needsTrust` was still false, the trust auto-confirm never
  // ran, and the menu swallowed the prompt plus all three paste retries.
  it('agy trust gate: paste mode turns on BEFORE the trust menu — waits for trust confirm, then the composer', async () => {
    runSpawn({ tuiConfig: agyTuiConfig });
    await flushMicrotasks();

    // Alt-screen entry enables paste mode while agy is still signing in.
    await capturedOnData(Buffer.from(`${PASTE_OFF}${PASTE_ON}Welcome to the Antigravity CLI. You are currently not signed in.\n Signing in...\n`));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(0); // would have pasted into the void before the fix

    // Trust gate finally paints (after the sign-in round trip).
    await capturedOnData(Buffer.from('Do you trust the contents of this project?\nAntigravity CLI requires permission to read, edit, and execute files here.\n> Yes, I trust this folder\n  No, exit\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(700);
    await flushMicrotasks();

    // Auto-confirmed with a bare Enter, and still no paste.
    expect(vi.mocked(shellService.writeToSession).mock.calls.filter(([, d]) => d === '\r').length)
      .toBeGreaterThanOrEqual(1);
    expect(pasteCount()).toBe(0);

    // Composer comes up only after trust is accepted → now the paste lands.
    await capturedOnData(Buffer.from(`>\n${AGY_COMPOSER_FOOTER}Gemini 3.5 Flash · medium`));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(400);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
  });

  it('agy tui-not-ready: an agy TUI that never signals input-ready fails fast instead of idle-reaping', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    runSpawn({ tuiConfig: agyTuiConfig });
    await flushMicrotasks();
    await capturedOnData(Buffer.from('some agy startup noise but no input box ever appears\n'));
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

  // ── Antigravity account-eligibility banner: a WAIT, not a verdict ───────────
  // The banner paints while agy's `loadCodeAssist` handshake is still retrying;
  // the CLI's own log shows the session authenticated fine and generating
  // normally once it settles. Killing on sight cost every agy CoS run from
  // 2026-08-07 on (5/5, each dead 3–5s in). So the signal now arms a
  // grace window (the signal's own `graceMs`) instead of finalizing immediately.
  const ELIGIBILITY_BANNER =
    "We're finishing verifying your account eligibility. This usually takes a moment. Please try again shortly.";

  // Drive agy to a submitted prompt, which is where the banner really appears
  // (agent-09824620: composer up, paste lands, THEN the banner paints). Starting
  // from a bare spawn instead would let the 45s tui-not-ready deadline finalize
  // the run before the grace window is ever reached, masking what's under test.
  const driveAgyToSubmittedPrompt = async () => {
    runSpawn({ tuiConfig: agyTuiConfig });
    await flushMicrotasks();
    // Shell turns paste mode off to run the command, agy turns it back on at
    // alt-screen entry, then its composer footer says the input box is live.
    await capturedOnData(Buffer.from(`${PASTE_OFF}Antigravity CLI 1.1.12\n`));
    await flushMicrotasks();
    await capturedOnData(Buffer.from(`${PASTE_ON}Welcome to the Antigravity CLI.\n Signing in...\n`));
    await flushMicrotasks();
    await capturedOnData(Buffer.from(`>\n${AGY_COMPOSER_FOOTER}Gemini 3.6 Flash · high`));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(400);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
    // Echo the prompt back the way a real TUI renders it into the input buffer,
    // so paste verification passes and the submit Enter goes out (issue #2192).
    await capturedOnData(Buffer.from('do the thing\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(4000); // past PASTE_TO_ENTER_FALLBACK_MS (3500ms)
    await flushMicrotasks();
  };

  it('holds the session open when Antigravity reports that account eligibility is still being verified', async () => {
    await driveAgyToSubmittedPrompt();

    await capturedOnData(Buffer.from(ELIGIBILITY_BANNER));
    await flushMicrotasks();
    // The old behavior finalized here, within a second of the banner.
    await vi.advanceTimersByTimeAsync(30000);
    await flushMicrotasks();

    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();
  });

  // The banner is the REJECTION of the submission — agy discards the prompt and
  // drops back to an empty, idle composer (agent-1f08178b's raw.txt, and a live
  // session confirmed parked there). Nothing is in flight, so a PASSIVE window
  // can never see the generation chrome it waits for: its only reachable outcome
  // is expiry, making it a pause bolted in front of the same fail-over. Re-asking
  // is the only way out, and what the banner itself instructs.
  it('re-submits the prompt while the eligibility window is open, and stops once agy answers', async () => {
    await driveAgyToSubmittedPrompt();

    await capturedOnData(Buffer.from(ELIGIBILITY_BANNER));
    await capturedOnData(Buffer.from('> ? for shortcuts'));
    await flushMicrotasks();
    expect(shellService.pasteToSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SELF_CLEARING_RESUBMIT_INTERVAL_MS + 5000);
    await flushMicrotasks();
    expect(shellService.pasteToSession).toHaveBeenCalledWith(
      SESSION_ID,
      'do the thing',
      expect.objectContaining({ label: expect.stringContaining('handshake') }),
    );

    // The retry lands: agy paints its in-flight chrome, which closes the window
    // and must stop the re-asking too.
    await capturedOnData(Buffer.from('Generating...\nesc to cancel'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3 * SELF_CLEARING_RESUBMIT_INTERVAL_MS);
    await flushMicrotasks();
    expect(shellService.pasteToSession).toHaveBeenCalledTimes(1);
    // The run belongs to the ordinary reaper again, not to the fail-over.
    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalledWith(
      expect.objectContaining({ completionReason: 'fallback-signal' })
    );
  });

  it('resumes the run when the eligibility banner clears and agy starts generating', async () => {
    await driveAgyToSubmittedPrompt();

    await capturedOnData(Buffer.from(ELIGIBILITY_BANNER));
    await flushMicrotasks();
    // agy settles its handshake and paints its in-flight chrome.
    await capturedOnData(Buffer.from('Generating...\nesc to cancel'));
    await flushMicrotasks();

    // Past the grace deadline — the run must NOT be failed over to a fallback.
    await vi.advanceTimersByTimeAsync(70000);
    await flushMicrotasks();

    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalledWith(
      expect.objectContaining({ completionReason: 'fallback-signal' })
    );
  });

  it('falls back once the eligibility banner outlasts its grace window with no generation', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    await driveAgyToSubmittedPrompt();

    await capturedOnData(Buffer.from(ELIGIBILITY_BANNER));
    await flushMicrotasks();
    // Only idle composer chrome repaints — no sign of life.
    await capturedOnData(Buffer.from('> ? for shortcuts'));
    await flushMicrotasks();

    // Past the full grace window — every re-submission inside it went unanswered
    // too, so the fail-over is the correct verdict.
    await vi.advanceTimersByTimeAsync(130000);
    vi.useRealTimers();
    await completeDone;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        success: false,
        completionReason: 'fallback-signal',
        error: expect.stringContaining('account eligibility')
      })
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

  // ── 1d. Codex MCP-server boot patience (incident 2026-07-10, agent-c5a26b40) ──
  // Codex boots the user's globally-configured MCP servers (playwright via npx,
  // a node_repl with startup_timeout_sec=120) on every headless spawn. During
  // that boot codex swallows pastes and renders no `[Pasted Content N chars]`
  // marker, and its input viewport shows only the paste TAIL (never the verified
  // prefix), so the paste-verify retry can't confirm. With the fixed 3-attempt
  // budget the agent was killed `paste-not-rendered` at ~19s — long before a
  // legitimately-slow boot finishes. Once the MCP-boot banner is seen, the retry
  // budget must extend to MCP_BOOT_PASTE_DEADLINE_MS so a slow boot completes and
  // the paste finally lands.
  it('codex MCP boot: extends the paste-retry budget past the fixed 3-attempt cap while booting', async () => {
    const pasteFailSpy = vi.fn();
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async (args) => {
      if (args?.completionReason === 'paste-not-rendered') pasteFailSpy(args);
    });

    runSpawn({ prompt: 'evaluate our animation prompts and generate drafts' });
    await flushMicrotasks();

    // Codex prints its MCP-boot banner during startup → latches the boot tracker.
    await capturedOnData(Buffer.from('>_ OpenAI Codex (v0.144.1)\nStarting MCP servers (0/3): codex_apps, node_repl, playwright\n'));
    await flushMicrotasks();
    // Fire the paste (past prompt-delay floor + readiness idle threshold).
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    // No marker and no echo ever arrive — every attempt is swallowed. Advance
    // well past the ~19s that would exhaust the fixed 3-attempt budget, but under
    // the 150s MCP-boot deadline.
    await vi.advanceTimersByTimeAsync(45000);
    await flushMicrotasks();

    // Boot-aware budget kept retrying instead of failing paste-not-rendered…
    expect(pasteFailSpy).not.toHaveBeenCalled();
    // …and re-pasted more times than the 3-attempt cap would ever allow.
    expect(pasteCount()).toBeGreaterThan(3);
  });

  it('codex MCP boot: fails paste-not-rendered only after the extended deadline if boot never completes', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    runSpawn();
    await flushMicrotasks();
    await capturedOnData(Buffer.from('Booting MCP server: node_repl(0s • esc to interrupt)\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    // Never becomes ready. Advance past MCP_BOOT_PASTE_DEADLINE_MS (150s).
    await vi.advanceTimersByTimeAsync(155000);
    vi.useRealTimers();
    await completeDone;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1', success: false, completionReason: 'paste-not-rendered' })
    );
  });

  it('paste-not-rendered: without an MCP-boot banner, still fails after the fixed 3 attempts (~19s)', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    runSpawn();
    await flushMicrotasks();
    // Ordinary banner chrome — NOT an MCP-boot signal, so the budget stays fixed.
    await capturedOnData(Buffer.from('Codex booting...\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    // No marker/echo. Advance past the 3-attempt budget (~19s) but well under the
    // 150s MCP-boot deadline — proves the non-boot path is unchanged.
    await vi.advanceTimersByTimeAsync(25000);
    vi.useRealTimers();
    await completeDone;

    expect(pasteCount()).toBe(3);
    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1', success: false, completionReason: 'paste-not-rendered' })
    );
  });

  it('MCP-boot budget is codex-only: a non-codex TUI emitting the same banner still fails at 3 attempts', async () => {
    // Regression for codex review [P2]: the boot tracker must not latch for a
    // non-codex provider, or an unrelated TUI whose startup text contains
    // "starting mcp servers" would inherit codex's 150s budget and its
    // codex-specific failure guidance, breaking "non-codex TUIs are unchanged."
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    runSpawn({ tuiConfig: { command: 'gemini', args: [], commandLine: 'gemini', promptDelayMs: 100, idleTimeoutMs: 50 } });
    await flushMicrotasks();
    // Same banner text codex prints — but this is a gemini session.
    await capturedOnData(Buffer.from('Starting MCP servers (0/3): a, b, c\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    // Fails at the fixed 3-attempt cap (~19s), NOT the 150s boot budget.
    await vi.advanceTimersByTimeAsync(25000);
    vi.useRealTimers();
    await completeDone;

    expect(pasteCount()).toBe(3);
    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1', success: false, completionReason: 'paste-not-rendered' })
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

    const inMemTruncMetaCalls = vi.mocked(cosAgentLifecycle.updateAgent).mock.calls.filter(
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

    const truncMetaCalls = vi.mocked(cosAgentLifecycle.updateAgent).mock.calls.filter(
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

    const truncMetaCalls = vi.mocked(cosAgentLifecycle.updateAgent).mock.calls.filter(
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
    // The agent writes the run-scoped sentinel name the prompt gave it.
    vi.mocked(readFile).mockImplementation(async (p) =>
      typeof p === 'string' && p.endsWith('.agent-done-agent-1') ? sentinel : ''
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
    const flushedLines = vi.mocked(cosAgentLifecycle.appendAgentOutputLines).mock.calls
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

  // ── 11. A PortOS host restart is an interruption, never a completion ─────────
  //
  // Reported in #3202: `pm2 restart portos-server` TreeKills the agent's PTY.
  // node-pty reports that as exit code 0, so `success: code === 0 && !killed`
  // recorded a run that had produced nothing as SUCCESSFUL — and worse, finalize
  // handed the worktree to cleanupWorktreeFn, destroying the state a resume
  // needs. Both halves are asserted here.
  describe('host restart (#3202)', () => {
    afterEach(() => resetHostShutdownFlagForTests());

    it('abandons instead of finalizing when the PTY dies during shutdown', async () => {
      const cleanupWorktreeFn = vi.fn().mockResolvedValue(undefined);
      const spawnPromise = runSpawn({ helpers: { cleanupWorktreeFn, isTruthyMetaFn: (v) => !!v } });
      await flushMicrotasks();

      markHostShuttingDown();
      // Exactly what pm2's TreeKill looks like from node-pty: a clean exit code.
      await capturedOnExit({ exitCode: 0, killed: false });
      await flushMicrotasks();
      await spawnPromise;

      // No outcome recorded, and — critically — the worktree is left alone.
      expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();
      expect(cleanupWorktreeFn).not.toHaveBeenCalled();
      // The record stays `running`; only the phase label is refined, so boot
      // recovery still sees it as an agent to reconcile from the marker.
      expect(vi.mocked(cosAgentLifecycle.updateAgent).mock.calls.some(
        ([, patch]) => patch?.metadata?.phase === 'interrupted' && patch?.metadata?.interruptedBy === 'host-shutdown'
      )).toBe(true);
    });

    it('still finalizes as success when the agent had already written its sentinel', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockImplementation(async (p) =>
        typeof p === 'string' && p.endsWith('.agent-done') ? '## Summary\nDone.' : ''
      );

      const spawnPromise = runSpawn({ workspacePath: '/tmp/ws' });
      await flushMicrotasks();

      markHostShuttingDown();
      await capturedOnExit({ exitCode: 0, killed: false });
      await flushMicrotasks();
      await spawnPromise;

      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'agent-1', success: true })
      );
    });

    // The backstop for a SIGKILL'd or crashed portos-server, which never runs its
    // shutdown handler — so the in-process flag is never set, and the only
    // evidence left is node-pty's `signal`.
    it('records a signal-terminated PTY as a failure even with exit code 0', async () => {
      const spawnPromise = runSpawn();
      await flushMicrotasks();

      await capturedOnExit({ exitCode: 0, killed: false, signal: 15 });
      await flushMicrotasks();
      await spawnPromise;

      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          success: false,
          completionReason: 'shell-signaled',
          error: expect.stringContaining('signal 15'),
        })
      );
    });

    // Guard against over-correcting: a TUI that genuinely exits 0 on its own,
    // outside a shutdown and with no signal, keeps its prior success semantics.
    it('leaves an ordinary clean exit alone', async () => {
      const spawnPromise = runSpawn();
      await flushMicrotasks();

      await capturedOnExit({ exitCode: 0, killed: false, signal: null });
      await flushMicrotasks();
      await spawnPromise;

      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, completionReason: 'shell-exit' })
      );
    });
  });

  // A session that never spawns at all. The runner rejects the spawn (e.g. its
  // command allowlist doesn't carry the provider's CLI), createAgentTuiSession
  // throws, and before this was handled the throw propagated out of
  // spawnTuiAgent to a caller that only logs — leaving the agent record stuck in
  // `initializing` until the zombie reaper finalized it a minute later with a
  // generic message, so the real cause never reached the user.
  //
  // The reason splits on the runner hop — see spawnTuiAgent's catch. Note a
  // refused/mid-restart runner surfaces from undici as a bare
  // TypeError('fetch failed').
  describe('spawn failure', () => {
    it.each([
      ['a runner refusal', new Error('Command not allowed: grok. Permitted commands: claude, codex'), 'Command not allowed: grok'],
      ['an unreachable runner', new TypeError('fetch failed'), 'fetch failed'],
    ])('finalizes %s as spawn-rejected instead of throwing', async (_label, rejection, expectedFragment) => {
      vi.mocked(spawnTuiSessionViaRunner).mockRejectedValueOnce(rejection);

      // Resolves, does not reject.
      await expect(runSpawn({ useDurableRunner: true })).resolves.toBeNull();

      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          success: false,
          completionReason: 'spawn-rejected',
          error: expect.stringContaining(expectedFragment),
        })
      );
    });

    it('keeps the actionable spawn-error when the local PTY path throws', async () => {
      vi.mocked(shellService.createShellSession).mockImplementationOnce(() => {
        throw new Error('posix_spawnp failed');
      });

      await expect(runSpawn({ useDurableRunner: false })).resolves.toBeNull();

      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          success: false,
          completionReason: 'spawn-error',
          error: 'Failed to start TUI session: posix_spawnp failed',
        })
      );
    });

    it('skips PR state polling when review-loop follow-up has an unresolved PR host (#4007)', async () => {
      runSpawn({
        task: {
          id: 'task-4007',
          description: 'do the thing',
          metadata: {
            reviewLoopFollowUp: 'true',
            reviewLoopPRHost: null,
            reviewLoopPRUrl: 'https://unknown-forge.example.com/owner/repo/pull/4007',
          },
        },
      });

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
      await vi.advanceTimersByTimeAsync(16000);
      await flushMicrotasks();

      expect(getPullRequestStateMock).not.toHaveBeenCalled();
    });

    it('polls PR state when review-loop follow-up has a resolved github PR host (#4007)', async () => {
      runSpawn({
        task: {
          id: 'task-4007-gh',
          description: 'do the thing',
          metadata: {
            reviewLoopFollowUp: 'true',
            reviewLoopPRHost: 'github.com',
            reviewLoopPRUrl: 'https://github.com/owner/repo/pull/4007',
          },
        },
      });

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
      await vi.advanceTimersByTimeAsync(16000);
      await flushMicrotasks();

      expect(getPullRequestStateMock).toHaveBeenCalledWith('https://github.com/owner/repo/pull/4007', expect.anything());
    });
  });
});

// Issue #2074 — the idle reaper must extend its grace while a swarm orchestrator
// is in its Phase C merge queue, and, if the EXTENDED window still blows, surface
// a needs-manual-finish failure instead of a silent `status: completed`.
//
// Exercises the REAL `decideIdleReap` the idleTimer body calls (it was an inline
// copy here until the merge-follow-up branch below made the drift risk concrete
// — a copy would have "passed" while the shipped reaper still failed merged
// PRs). The real code keeps an async worktree-changes check (#2191) that can
// downgrade `idle-complete` to `idle-no-changes`; that's covered by the full
// fake-timer harness above, not by this pure function.
describe('agentTuiSpawning — idle reap decision (#2074)', () => {
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

  it('a background-shell wait extends the window but carries no verdict of its own', () => {
    const waiting = decideIdleReap({ idle: BASE + 1, baseIdleTimeoutMs: BASE, backgroundShellActive: true, workActive: true, rendersCounter: true });
    expect(waiting.action).toBe('wait');
    expect(waiting.effectiveIdleTimeoutMs).toBe(BACKGROUND_SHELL_IDLE_TIMEOUT_MS);
    const blown = decideIdleReap({ idle: BACKGROUND_SHELL_IDLE_TIMEOUT_MS + 1, baseIdleTimeoutMs: BASE, backgroundShellActive: true, workActive: true, rendersCounter: true });
    expect(blown.reason).toBe('idle-complete');
    expect(blown.success).toBe(true);
  });

  // The merge-follow-up false failure (task sys-rl-msr1j1a5 / PR #3909,
  // 2026-08-13). The follow-up prompt QUOTES `gh pr checks` / `gh pr merge` /
  // `--delete-branch`, so the TUI's echo of it latches `mergeQueueActive` before
  // any work runs. The agent then merged the PR in ~60s, printed "PR Status:
  // MERGED", made no commit (nothing to commit — it only merges), skipped the
  // sentinel, and idled — and was recorded as `merge-queue-idle-timeout` 15
  // minutes later, three times over, ending in Blocked with a HIGH "PR left
  // open" card naming an already-merged PR.
  describe('PR follow-up whose PR already merged', () => {
    it('reaps as a SUCCESS at the BASE window even with the merge queue latched', () => {
      const r = decideIdleReap({
        idle: BASE + 1, baseIdleTimeoutMs: BASE,
        mergeQueueActive: true, prFollowUpMerged: true, workActive: true, rendersCounter: true,
      });
      expect(r.action).toBe('reap');
      expect(r.success).toBe(true);
      expect(r.reason).toBe('pr-follow-up-merged');
    });

    it('does not fire before the BASE window — a merged PR is not a reason to cut a working agent short', () => {
      const r = decideIdleReap({
        idle: BASE - 1, baseIdleTimeoutMs: BASE,
        mergeQueueActive: true, prFollowUpMerged: true, workActive: true, rendersCounter: true,
      });
      expect(r.action).toBe('wait');
    });

    it('outranks the no-activity downgrade too — the deliverable landed regardless of the work counter', () => {
      const r = decideIdleReap({
        idle: BASE + 1, baseIdleTimeoutMs: BASE,
        prFollowUpMerged: true, workActive: false, rendersCounter: true,
      });
      expect(r.success).toBe(true);
      expect(r.reason).toBe('pr-follow-up-merged');
    });

    // The bug this whole branch exists to kill: without `prFollowUpMerged` the
    // SAME signals produce the needs-manual-finish failure. Guards against a
    // future refactor that quietly stops threading the forge answer through.
    it('still fails as needs-manual-finish when the PR did NOT merge', () => {
      const r = decideIdleReap({
        idle: MERGE_QUEUE_IDLE_TIMEOUT_MS + 1, baseIdleTimeoutMs: BASE,
        mergeQueueActive: true, prFollowUpMerged: false, workActive: true, rendersCounter: true,
      });
      expect(r.success).toBe(false);
      expect(r.reason).toBe('merge-queue-idle-timeout');
    });
  });
});
