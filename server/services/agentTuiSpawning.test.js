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
  registerExternalSession: vi.fn(),
}));

// Only the spawn rpc is faked. The refusal/ambiguity classifier is the real one
// (importOriginal): re-implementing it here would make the ledger assertions
// below agree with a copy of the rule rather than with the rule (#4615).
vi.mock('./cosRunnerClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
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

// The lifecycle ledger is a real file writer (data/cos/run-events.jsonl) — mocked
// so first-output telemetry lands in a spy rather than the developing install's
// ledger, and because this suite's fileUtils mock carries no PATHS.cos (#4540).
const { appendRunEvent } = vi.hoisted(() => ({ appendRunEvent: vi.fn(async () => ({ appended: true })) }));
vi.mock('./agentRunEventLog.js', () => ({ appendRunEvent }));

vi.mock('./agentRunTracking.js', () => ({
  completeAgentRun: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./agentCompletion.js', () => ({
  processAgentCompletion: vi.fn().mockResolvedValue(undefined)
}));

// The Ollama-backed spawn path prepares the daemon's context window first, which
// otherwise reaches a real localhost:11434 in this suite. Stub it to a no-op —
// its own behavior is covered by services/ollamaAgentContext.test.js.
vi.mock('./ollamaAgentContext.js', () => ({
  ensureOllamaAgentContext: vi.fn().mockResolvedValue({ skipped: false, contextLength: null, applied: false, warning: null })
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

// Only the mutable registries are stubbed; the module's other state helpers
// come from the real module so the test does not duplicate their behavior.
vi.mock('./agentState.js', async (importOriginal) => ({
  ...await importOriginal(),
  activeAgents: new Map(),
  userTerminatedAgents: new Set(),
  pausedAgents: new Map(),
  registerSpawnedAgent: vi.fn(),
  unregisterSpawnedAgent: vi.fn(),
}));

vi.mock('./git.js', () => ({
  getDiff: vi.fn().mockResolvedValue('diff content here'),
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
  readdirSync: vi.fn().mockReturnValue([]),
  // Default: no .agent-done sentinel on disk. The completion-sentinel test
  // overrides this to true. Re-set in beforeEach so it can't leak between tests.
  existsSync: vi.fn().mockReturnValue(false),
  watch: vi.fn(() => {
    let onClose;
    return {
      once: vi.fn((event, callback) => {
        if (event === 'close') onClose = callback;
      }),
      close: vi.fn(() => onClose?.()),
    };
  }),
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
  // `data` is required alongside `root`: this module pulls in taskTypeHooks.js
  // -> ... -> lib/validation.js -> subscriptionSavings.js -> postStreak.js ->
  // activeDays.js -> timezone.js -> services/settings.js, whose module-scope
  // `join(PATHS.data, 'settings.json')` throws on load without it (#4211
  // added the activeDays.js edge). The bare `PATHS: {...}` below fully
  // replaces the real object (it doesn't merge), so every member this graph
  // needs at import time has to be listed explicitly.
  PATHS: { root: '/tmp/portos-root', data: '/tmp/portos-root/data' }
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
vi.mock('../lib/childProcess.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFile: vi.fn((_file, _args, _opts, cb) => cb(new Error('not mocked'))) };
});

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { execFile } from '../lib/childProcess.js';
import { buildTuiSpawnConfig, spawnTuiAgent } from './agentTuiSpawning.js';
import { releaseRetryHold } from './agentWorktreeCleanup.js';
import { spawnTuiSessionViaRunner, RUNNER_SPAWN_REFUSED, RUNNER_SPAWN_AMBIGUOUS } from './cosRunnerClient.js';
import * as shellService from './shell.js';
import * as agentLifecycle from './agentFinalization.js';
import { ensureOllamaAgentContext } from './ollamaAgentContext.js';
import * as agentErrorAnalysis from './agentErrorAnalysis.js';
import * as cosAgentLifecycle from './cosAgentLifecycle.js';
import * as gitService from './git.js';
import { activeAgents, userTerminatedAgents } from './agentState.js';
import {
  SELF_CLEARING_RESUBMIT_INTERVAL_MS,
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
    }, 'codex-configured-default', { shell: '/bin/zsh' });

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

  it('quotes TUI arguments and carries prompt timing config without a runtime limit', () => {
    const config = buildTuiSpawnConfig({
      id: 'claude-code-tui',
      name: 'Claude TUI',
      type: 'tui',
      command: 'claude',
      args: ['--dangerously-skip-permissions', '--add-dir', '/tmp/with space'],
      tuiPromptDelayMs: 1000,
      tuiMaxRuntimeMs: 7200000
    }, 'claude-sonnet', { shell: '/bin/zsh' });

    expect(config.args).toEqual([
      '--dangerously-skip-permissions',
      '--add-dir',
      '/tmp/with space',
      '--model',
      'claude-sonnet'
    ]);
    expect(config.commandLine).toBe("claude --dangerously-skip-permissions --add-dir '/tmp/with space' --model claude-sonnet");
    expect(config.promptDelayMs).toBe(1000);
    expect(config).not.toHaveProperty('maxRuntimeMs');
    expect(config).not.toHaveProperty('idleTimeoutMs');
  });

  it('quotes the command position for PowerShell and cmd.exe while preserving POSIX output', () => {
    const provider = {
      id: 'claude-code-tui',
      name: 'Claude TUI',
      type: 'tui',
      command: 'C:\\Program Files\\Claude\\claude.cmd',
      args: ['--append-system-prompt-file', "I:\\input folder\\it's.md"],
    };

    expect(buildTuiSpawnConfig(provider, null, { shell: '/bin/zsh' }).commandLine)
      .toBe("'C:\\Program Files\\Claude\\claude.cmd' --append-system-prompt-file 'I:\\input folder\\it'\\''s.md'");
    expect(buildTuiSpawnConfig(provider, null, { shell: 'pwsh.exe' }).commandLine)
      .toBe("& 'C:\\Program Files\\Claude\\claude.cmd' '--append-system-prompt-file' 'I:\\input folder\\it''s.md'");
    expect(buildTuiSpawnConfig(provider, null, { shell: 'cmd.exe' }).commandLine)
      .toBe('"C:\\Program Files\\Claude\\claude.cmd" "--append-system-prompt-file" "I:\\input folder\\it\'s.md"');
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

  it('applies the default prompt delay and omits a runtime limit', () => {
    const config = buildTuiSpawnConfig({ id: 'codex-tui', command: 'codex', type: 'tui' }, null);
    expect(config.promptDelayMs).toBe(2500);
    expect(config).not.toHaveProperty('maxRuntimeMs');
    expect(config).not.toHaveProperty('idleTimeoutMs');
  });

  it('does not configure an idle timeout for any TUI provider', () => {
    for (const provider of [
      { id: 'claude-ollama-tui', type: 'tui', command: 'claude', ollamaBacked: true },
      { id: 'opencode-mtplx-tui', type: 'tui', command: 'opencode', mtplxBacked: true },
      { id: 'codex-tui', type: 'tui', command: 'codex' },
    ]) {
      expect(buildTuiSpawnConfig(provider, 'example-model')).not.toHaveProperty('idleTimeoutMs');
    }
  });

  it('omits the --model flag when model is null/empty', () => {
    const config = buildTuiSpawnConfig(
      { id: 'codex-tui', command: 'codex', type: 'tui', args: [] },
      null,
      { shell: '/bin/zsh' },
    );
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
      { effort: 'max' },
    );
    expect(codex.args).toContain('model_reasoning_effort=max');
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
      leanMode: overrides.leanMode ?? false,
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

  it('makes the login shell exit with the TUI command instead of lingering after it exits', async () => {
    runSpawn();
    await flushMicrotasks();

    // The raw command plus the flag — the run-then-exit wrapper is rendered by
    // shell.js, which is the only place that knows the session's shell dialect.
    // Its rendering is covered by shell.test.js and lib/shellExit.test.js.
    expect(shellService.createShellSession).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ initialCommand: 'codex', exitWithCommand: true }),
    );
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

  it('backstops a slashdo-free TUI PR instead of creating one outright (#3733)', async () => {
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

    // The codex TUI drives its own push → PR → review → merge, so PortOS only
    // steps in when the forge says no PR exists — hence prCreation: if-missing.
    expect(cleanupWorktreeFn).toHaveBeenCalledWith('agent-1', true, expect.objectContaining({
      prCreation: 'if-missing',
      prCompletion: 'review-then-merge',
      reviewers: ['codex'],
      skipMerge: true,
    }));
  });

  it('a lean --bare TUI still hands its PR to PortOS outright', async () => {
    const cleanupWorktreeFn = vi.fn().mockResolvedValue(undefined);
    const spawnPromise = runSpawn({
      provider: { id: 'claude-ollama-tui', name: 'Lean Claude TUI', type: 'tui', command: 'claude', ollamaBacked: true, envVars: {} },
      leanMode: true,
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
      prCreation: 'always',
      skipMerge: false,
    }));
  });

  it('prepares the Ollama context window only for Ollama-backed providers', async () => {
    const spawnPromise = runSpawn({
      provider: { id: 'claude-ollama-tui', name: 'Lean Claude TUI', type: 'tui', command: 'claude', ollamaBacked: true, envVars: {} },
    });
    await flushMicrotasks();
    await capturedOnExit({ exitCode: 0, killed: false });
    await spawnPromise;
    expect(ensureOllamaAgentContext).toHaveBeenCalledTimes(1);

    vi.mocked(ensureOllamaAgentContext).mockClear();
    const cloudSpawn = runSpawn();
    await flushMicrotasks();
    await capturedOnExit({ exitCode: 0, killed: false });
    await cloudSpawn;
    expect(ensureOllamaAgentContext).not.toHaveBeenCalled();
  });

  it('does not double-fire a PR owned by a slashdo-capable Claude TUI', async () => {
    const cleanupWorktreeFn = vi.fn().mockResolvedValue(undefined);
    // finalize asked the forge and got an answer for a real branch — the only
    // shape that lets cleanup skip its own query (see `prClaimWasVerified`).
    vi.mocked(agentLifecycle.finalizeAgent).mockResolvedValueOnce({
      success: true, prVerdict: { ok: true, branch: 'cos/task-1/agent-1' },
    });
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

    // `never`, not `if-missing`: finalize already ran `verifyPrClaim` for a
    // slashdo-capable session, so a second forge query would be pure duplication.
    expect(cleanupWorktreeFn).toHaveBeenCalledWith('agent-1', true, expect.objectContaining({
      prCreation: 'never',
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

  // ── CoS agents stay alive while provider output is silent ────────────────────
  it('does not finalize a CoS TUI merely because provider output goes silent', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    const spawnPromise = runSpawn();
    await flushMicrotasks();

    await capturedOnData(Buffer.from('Codex booting...\\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    await capturedOnData(Buffer.from('do the thing\\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3600);
    await flushMicrotasks();

    // The agent has submitted its prompt. No output follows for substantially
    // longer than the old idle window, but the run must remain attached.
    await vi.advanceTimersByTimeAsync(60000);
    await flushMicrotasks();
    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();

    await capturedOnExit({ exitCode: 0, killed: false });
    await spawnPromise;
    vi.useRealTimers();
    await completeDone;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        success: true,
        completionReason: 'shell-exit',
      })
    );
  });

  // ── No wall-clock stop ─────────────────────────────────────────────────────
  // A provider can legitimately spend more than a day on one task. Advancing
  // well past the old three-hour ceiling must not send a wrap-up prompt or
  // finalize the agent; completion remains sentinel-, exit-, or failure-driven.
  it('keeps a submitted OpenCode agent attached beyond 24 hours', async () => {
    let resolveComplete;
    const completeDone = new Promise((r) => { resolveComplete = r; });
    vi.mocked(agentLifecycle.finalizeAgent).mockImplementation(async () => { resolveComplete(); });

    const spawnPromise = runSpawn({
      provider: { ...defaultProvider, id: 'opencode-tui', name: 'OpenCode TUI' },
      tuiConfig: { ...defaultTuiConfig, command: 'opencode', commandLine: 'opencode' },
    });
    await flushMicrotasks();
    await capturedOnData(Buffer.from('OpenCode booting...\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    await capturedOnData(Buffer.from('do the thing\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3600);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    await flushMicrotasks();

    expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();
    expect(shellService.pasteToSession).not.toHaveBeenCalledWith(
      SESSION_ID,
      expect.anything(),
      { label: '[cosAgents] max-runtime wrap-up' },
    );

    await capturedOnExit({ exitCode: 0, killed: false });
    await spawnPromise;
    vi.useRealTimers();
    await completeDone;

    expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        success: true,
        completionReason: 'shell-exit',
      })
    );
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

    const spawnPromise = runSpawn();
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
  const claudeTuiConfig = { command: 'claude', args: [], commandLine: 'claude', promptDelayMs: 100 };
  // Antigravity (agy) gets the SAME positive input-ready gate as claude (#2705).
  const agyTuiConfig = { command: 'agy', args: [], commandLine: 'agy', promptDelayMs: 100 };
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

  // Claude Code v2.1.233's auto-mode offer. The trust gate above paints BEFORE
  // the composer; this one paints after, with paste mode already on — so the old
  // gate said "ready" and the prompt went into a modal that ignored it. All four
  // claude-code-tui agents on 2026-08-14 died `paste-not-rendered` this way.
  it('claude auto-mode offer: declines it and pastes only after it is cleared', async () => {
    runSpawn({ tuiConfig: claudeTuiConfig });
    await flushMicrotasks();

    // Composer comes up live — under the old gate this alone would paste.
    await capturedOnData(Buffer.from(`${PASTE_OFF}${PASTE_ON}`));
    await flushMicrotasks();

    // ...then the modal paints over it, before the prompt delay elapses.
    await capturedOnData(Buffer.from(
      'Make auto mode your default permission mode?\n'
      + '   ❯ 1. Yes, set auto mode as my default permission mode\n'
      + "     2. No, keep don't ask\n"
    ));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(700);
    await flushMicrotasks();

    // Down+Enter selects option 2. A BARE Enter would accept the highlighted
    // option 1 and rewrite the user's global permission default — assert we did
    // not do that.
    const writes = vi.mocked(shellService.writeToSession).mock.calls.map(([, d]) => d);
    expect(writes).toContain('\x1b[B\r');
    expect(writes).not.toContain('\r');

    // Only once the dialog is answered does the prompt go out — and exactly once.
    await vi.advanceTimersByTimeAsync(3000);
    await flushMicrotasks();
    expect(pasteCount()).toBe(1);
  });

  it('codex hook-review offer: continues without trusting hooks before pasting the prompt', async () => {
    runSpawn();
    await flushMicrotasks();

    await capturedOnData(Buffer.from(
      'Hooks need review\n'
      + '1 hook is new or changed.\n'
      + '› 1. Review hooks\n'
      + '2. Trust all and continue\n'
      + "3. Continue without trusting (hooks won't run)\n",
    ));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(400);
    await flushMicrotasks();

    // Two down-arrows select option 3, preserving the sandbox boundary.
    expect(vi.mocked(shellService.writeToSession).mock.calls.map(([, data]) => data))
      .toContain('\x1b[B\x1b[B\r');
    expect(pasteCount()).toBe(0);

    // The selector clears and Codex repaints its composer; only then can the
    // ordinary Codex readiness path paste the task.
    await capturedOnData(Buffer.from('OpenAI Codex ready\n'));
    await vi.advanceTimersByTimeAsync(2000);
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
  // quiet-startup heuristic (which fired into agy's still-initializing banner and
  // left the agent sitting at an empty prompt). Without the fix agy took that
  // path and WOULD have pasted after ~2s of banner silence;
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

  it('agy tui-not-ready: an agy TUI that never signals input-ready fails fast instead of blind-pasting', async () => {
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

  // ── 1b. Submit-Enter retries ─────────────────────────────────────────────────
  // A single `\r` after a large bracketed paste can be swallowed mid-paste-
  // commit, stranding the prompt unsent (the "I had to hit Enter myself" bug,
  // which was then falsely marked success by the old fallback). The submit path must
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

  // ── 1c2. The readiness probe's own echo must not seed the startup-idle clock ──
  // shell.js's waitForPromptReady round-trips a shell-level probe (posix printf /
  // PowerShell Write-Output) BEFORE injecting the real CLI command, and fires
  // onInitialCommandSent only once that command is actually typed in. If PTY
  // output that arrives before onInitialCommandSent counted toward
  // lastOutputAt/firstOutputAt, a quiet gap after the probe's own echo — e.g.
  // PowerShell's heavier startup, which is slower than bash — would satisfy the
  // idle-based "ready" check and paste the prompt into a still-loading CLI (codex
  // review [P1] on the dialect-aware probe, #4638).
  it('idle-detection: pre-injection PTY output does not satisfy startup-idle readiness', async () => {
    let sendInitialCommand = null;
    vi.mocked(shellService.createShellSession).mockImplementation((_socket, opts) => {
      capturedOnData = opts.onData;
      capturedOnExit = opts.onExit;
      // Do NOT fire onInitialCommandSent yet — mirrors the real shell.js
      // waitForPromptReady gap between the probe round-trip and command
      // injection, unlike the suite's default mock (which fires it immediately).
      sendInitialCommand = () => opts.onInitialCommandSent?.();
      return SESSION_ID;
    });

    runSpawn({ prompt: 'evaluate our animation prompts and generate drafts' });
    await flushMicrotasks();

    // Shell-level probe echo/noise arrives BEFORE the real command is injected.
    await capturedOnData(Buffer.from("bash-5.2$ printf '%s\\n' 'PORTOSRDY''abc123'\nPORTOSRDYabc123\n"));
    await flushMicrotasks();

    // Advance well past promptDelayMs + the idle threshold. Pre-fix, this probe
    // echo would have seeded firstOutputAt/lastOutputAt and the idle poll would
    // have fired the paste here — before the CLI command was ever typed in.
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    const pasteWrites = () => vi.mocked(shellService.writeToSession).mock.calls
      .filter(([id, data]) => id === SESSION_ID && data.startsWith('\x1b[200~'));
    expect(pasteWrites()).toHaveLength(0);

    // Now the real command is injected and the CLI produces its own output —
    // the idle clock should start from here and the paste should proceed.
    sendInitialCommand();
    await capturedOnData(Buffer.from('Codex booting...\n'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

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

    runSpawn({ tuiConfig: { command: 'gemini', args: [], commandLine: 'gemini', promptDelayMs: 100 } });
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

  it('spools the runner exit tail when an immediate exit beat live TUI output', async () => {
    const { appendFile } = await import('fs/promises');
    const spawnPromise = runSpawn({ useDurableRunner: true });
    await flushMicrotasks();

    await capturedOnExit({
      exitCode: 1,
      killed: false,
      outputTail: 'OpenCode startup error: configured model is unavailable',
    });
    await flushMicrotasks();
    await spawnPromise;

    const rawTail = vi.mocked(appendFile).mock.calls.find(
      ([path, contents]) => typeof path === 'string' && path.endsWith('raw.txt') && String(contents).includes('OpenCode startup error'),
    );
    expect(rawTail).toBeDefined();
  });

  it('does not revive an agent when the durable runner exits before its spawn response', async () => {
    let resolveRunnerSession;
    let exitPromise;
    const session = {
      sessionId: SESSION_ID,
      pid: 4321,
      ptyProcess: { pid: 4321, kill: vi.fn() },
    };
    vi.mocked(spawnTuiSessionViaRunner).mockImplementationOnce((options) => {
      capturedOnData = options.onData;
      capturedOnExit = options.onExit;
      // The socket relay registers this callback before its POST resolves, so
      // a CLI that exits immediately can finalize while the response is held.
      exitPromise = options.onExit({ exitCode: 1, killed: false, outputTail: 'startup failed' });
      return new Promise((resolve) => { resolveRunnerSession = resolve; });
    });

    const spawnPromise = runSpawn({ useDurableRunner: true });
    await flushMicrotasks();
    resolveRunnerSession(session);

    await spawnPromise;
    await exitPromise;

    expect(activeAgents.has('agent-1')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(shellService.killSession).toHaveBeenCalledWith(SESSION_ID);
    expect(cosAgentLifecycle.updateAgent).not.toHaveBeenCalled();
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

    const spawnPromise = runSpawn();
    await flushMicrotasks();

    // Drive the prompt far enough to exercise normal post-submit output, then
    // use the ordinary shell-exit completion path.
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
    await vi.advanceTimersByTimeAsync(800);
    await capturedOnData(Buffer.from('(2s · thinking with high effort)\n'));
    await capturedOnExit({ exitCode: 0, killed: false });
    await spawnPromise;
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
  // (it does NOT `/quit`). Normally the doneSentinelWatcher finalizes the
  // agent, but the TUI process can also exit on its own (or be killed) before
  // the watcher fires — when that shell-exit path wins the race, finish() MUST
  // still ingest the sentinel so its markdown resolution lands in outputBuffer /
  // output.txt and shows up in the completed-agent details view. Regression
  // guard for the lost-resolution bug where the summary only got ingested by
  // the watcher path.
  it('shell-exit after sentinel write: ingests .agent-done summary into the persisted output (process exit beats the watcher)', async () => {
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

    it('classifies a runner executable preflight failure as command-not-found', async () => {
      vi.mocked(spawnTuiSessionViaRunner).mockRejectedValueOnce(
        new Error('Command executable unavailable: opencode did not pass the CoS Runner capability check. Reinstall it or update the provider command.'),
      );

      await expect(runSpawn({ useDurableRunner: true })).resolves.toBeNull();

      expect(agentLifecycle.finalizeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          success: false,
          completionReason: 'command-not-found',
          error: expect.stringContaining('did not pass the CoS Runner capability check'),
        })
      );
    });

    // The ledger has to carry the outcome it actually knows (#4615). A runner
    // that ANSWERED with a refusal and a transport failure that answered
    // nothing are different facts, and a diagnostic that reads the second as
    // the first sends the reader after a rejection that never happened.
    const handoffs = () => appendRunEvent.mock.calls.map(([e]) => e).filter((e) => e.kind === 'run.handoff');

    it('records a refused handoff as accepted:false', async () => {
      vi.mocked(spawnTuiSessionViaRunner).mockRejectedValueOnce(
        Object.assign(new Error('Command not allowed: grok'), { spawnOutcome: RUNNER_SPAWN_REFUSED, status: 400 }),
      );

      await runSpawn({ useDurableRunner: true });

      expect(handoffs()).toEqual([expect.objectContaining({
        eventId: 'handoff:agent-1:run-1:rejected',
        data: expect.objectContaining({ to: 'none', accepted: false, outcome: RUNNER_SPAWN_REFUSED, kind: 'tui' }),
      })]);
    });

    it('records an ambiguous handoff as accepted:null with the transport reason', async () => {
      vi.mocked(spawnTuiSessionViaRunner).mockRejectedValueOnce(
        Object.assign(new TypeError('fetch failed'), { spawnOutcome: RUNNER_SPAWN_AMBIGUOUS }),
      );

      await runSpawn({ useDurableRunner: true });

      expect(handoffs()).toEqual([expect.objectContaining({
        eventId: 'handoff:agent-1:run-1:unconfirmed',
        data: expect.objectContaining({
          to: 'none',
          accepted: null,
          outcome: RUNNER_SPAWN_AMBIGUOUS,
          kind: 'tui',
          reason: 'fetch failed',
        }),
      })]);
    });

    it('records an adopted PTY as an accepted handoff and keeps the run alive', async () => {
      // The spawn rpc re-attached the relay to a PTY the runner already had, so
      // this is a live run — it must not be finalized as a failed spawn.
      const spawnDefault = vi.mocked(spawnTuiSessionViaRunner).getMockImplementation();
      vi.mocked(spawnTuiSessionViaRunner).mockImplementationOnce(async (options) => ({
        ...(await spawnDefault(options)),
        adopted: true,
        adoptedReason: 'fetch failed',
      }));

      const spawnPromise = runSpawn({ useDurableRunner: true });
      await flushMicrotasks();

      expect(handoffs()).toEqual([expect.objectContaining({
        eventId: 'handoff:agent-1:run-1:cos-runner',
        data: expect.objectContaining({
          to: 'cos-runner',
          accepted: true,
          adopted: true,
          outcome: RUNNER_SPAWN_AMBIGUOUS,
          reason: 'fetch failed',
        }),
      })]);
      expect(agentLifecycle.finalizeAgent).not.toHaveBeenCalled();

      await capturedOnExit({ exitCode: 0, killed: false, signal: null });
      await flushMicrotasks();
      await spawnPromise;
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

  });
});
