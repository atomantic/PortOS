import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { join } from 'path';

// Heavy modules needed only by spawnDirectly — mock them all before importing.
vi.mock('./cosEvents.js', () => ({ cosEvents: { emit: vi.fn() }, emitLog: vi.fn() }));
vi.mock('./cosAgentLifecycle.js', () => {
  const appendAgentOutput = vi.fn().mockResolvedValue(undefined);
  const appendAgentOutputLines = vi.fn().mockResolvedValue(undefined);
  // Faithful stand-in for the real debounced batcher: accumulates pushed lines
  // and, on flush(), routes them through the mocked appendAgentOutputLines while
  // swallowing+logging failures (mirrors the real createAgentOutputBatcher in
  // cosAgentLifecycle.js — whose error handling is unit-tested in cosAgentLifecycle.test.js).
  const createAgentOutputBatcher = vi.fn((agentId) => {
    let pending = [];
    return {
      push(lineOrLines) {
        if (Array.isArray(lineOrLines)) pending.push(...lineOrLines);
        else pending.push(lineOrLines);
      },
      async flush() {
        if (pending.length === 0) return;
        const batch = pending;
        pending = [];
        await appendAgentOutputLines(agentId, batch).catch((err) =>
          console.error(`❌ agent ${agentId} output batch flush failed: ${err.message}`));
      },
    };
  });
  return {
    updateAgent: vi.fn().mockResolvedValue(undefined),
    completeAgent: vi.fn().mockResolvedValue(undefined),
    appendAgentOutput,
    appendAgentOutputLines,
    createAgentOutputBatcher,
  };
});
vi.mock('./executionLanes.js', () => ({ release: vi.fn() }));
vi.mock('./toolStateMachine.js', () => ({
  completeExecution: vi.fn(),
  errorExecution: vi.fn(),
}));
vi.mock('./agentErrorAnalysis.js', () => ({ analyzeAgentFailure: vi.fn().mockResolvedValue(null) }));
// The lifecycle ledger is a real file writer (data/cos/run-events.jsonl) — mocked
// so first-output telemetry lands in a spy rather than the developing install's
// ledger, and because this suite's fileUtils mock carries no PATHS.cos (#4540).
const { appendRunEvent } = vi.hoisted(() => ({ appendRunEvent: vi.fn(async () => ({ appended: true })) }));
vi.mock('./agentRunEventLog.js', () => ({ appendRunEvent }));

vi.mock('./agentRunTracking.js', () => ({ completeAgentRun: vi.fn().mockResolvedValue(undefined) }));
// Mock git.js directly so spawnDirectly's GH_TOKEN pinning is exercised without
// pulling in the real worktreeManager → instances module graph. Default: no
// owner-matched account → empty overlay (ambient gh auth untouched).
vi.mock('./git.js', () => ({ resolveForgeTokenEnv: vi.fn().mockResolvedValue({}) }));
vi.mock('./agentFinalization.js', () => ({
  finalizeAgent: vi.fn().mockResolvedValue(undefined),
  releaseAgentLane: vi.fn(),
}));
vi.mock('./agentCompletionCleanup.js', () => ({
  handlePipelineProgression: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./agentState.js', () => ({
  activeAgents: new Map(),
  userTerminatedAgents: new Set(),
  pausedAgents: new Map(),
  registerSpawnedAgent: vi.fn(),
  unregisterSpawnedAgent: vi.fn(),
  metaStringOr: (value, fallback) => (typeof value === 'string' && value) ? value : fallback,
}));
vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  safeJSONParse: (str, fallback) => { try { return JSON.parse(str); } catch { return fallback; } },
  // agentSentinel builds the per-agent sentinel filename with this — a mock
  // missing it makes doneSentinelPath throw inside the close handler.
  sanitizeFilename: (name) => String(name).replace(/[^a-zA-Z0-9._-]/g, '_'),
  PATHS: { root: '/tmp', cosAgents: '/tmp/agents', data: '/tmp/data' },
}));
vi.mock('../lib/codexCliOutput.js', () => ({ createCodexStderrFormatter: vi.fn() }));
vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('{}'),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('fs', () => ({ existsSync: vi.fn().mockReturnValue(false) }));

// Default passthrough for the Windows resolve+wrap helper (#2243) — POSIX
// behavior. A specific test overrides it with mockReturnValueOnce to assert the
// spawn wiring uses whatever prepareCliSpawn returns.
// Only the two spawn-shaping helpers are stubbed. `guardChildStdin` stays REAL
// so the stdin-EPIPE containment test below pins the production listener rather
// than a test double of it.
vi.mock('../lib/bufferedSpawn.js', async (importActual) => ({
  ...(await importActual()),
  prepareCliSpawn: vi.fn((command, args) => ({ command, args })),
  killProcessTree: vi.fn(),
}));

// Mock child_process.spawn to return a controllable fake process
let fakeProcess;
vi.mock('../lib/childProcess.js', () => ({
  spawn: vi.fn(() => fakeProcess),
  // `execFile` is pulled in transitively by codeReview.js → lmStudioManager
  // (via `resolveReviewLoopOptions`'s dependency graph), even though this
  // test never spawns one directly.
  execFile: vi.fn(),
}));

// Lazily imported by the close handler's cleanup block to record a failed run's
// resume pointer (#3368). Mocked so the test doesn't pull the real cleanup graph
// (cos.js, git.js, worktreeManager) in behind it.
vi.mock('./agentWorktreeCleanup.js', () => ({
  releaseRetryHold: vi.fn().mockResolvedValue({}),
}));
vi.mock('./ollamaAgentContext.js', () => ({
  ensureOllamaAgentContext: vi.fn(async () => ({ skipped: true })),
}));
vi.mock('./providers.js', () => ({
  isOllamaBackedProvider: vi.fn(() => false),
}));

import { buildCliSpawnConfig, createStreamJsonParser, spawnDirectly } from './agentCliSpawning.js';
import { releaseRetryHold } from './agentWorktreeCleanup.js';
import { ensureOllamaAgentContext } from './ollamaAgentContext.js';
import { isOllamaBackedProvider } from './providers.js';
// Real module — the flag is a plain process-local boolean, so driving it
// directly exercises the same code path production does.
import { markHostShuttingDown, resetHostShutdownFlagForTests } from '../lib/hostShutdown.js';
import { existsSync } from 'fs';
import { spawn } from '../lib/childProcess.js';
import { prepareCliSpawn, killProcessTree } from '../lib/bufferedSpawn.js';

// Helper: feed the parser a sequence of stream-json lines
function runStream(parser, events) {
  for (const ev of events) {
    parser.processChunk(JSON.stringify(ev) + '\n');
  }
  parser.flush();
}

const textDelta = (text) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
});

const toolStart = (index, name) => ({
  type: 'stream_event',
  event: { type: 'content_block_start', index, content_block: { type: 'tool_use', name } }
});

const toolStop = (index) => ({
  type: 'stream_event',
  event: { type: 'content_block_stop', index }
});

const resultEvent = (result) => ({ type: 'result', result });

describe('createStreamJsonParser.getFinalResult', () => {
  it('returns only the final wrap-up — interim narrations between tool calls are discarded', () => {
    const parser = createStreamJsonParser();
    runStream(parser, [
      textDelta('Now I have all the info I need. Let me make the changes:\n'),
      toolStart(1, 'Read'),
      toolStop(1),
      textDelta('Now let me run the relevant tests to verify nothing broke:\n'),
      toolStart(2, 'Bash'),
      toolStop(2),
      textDelta('Changes look clean. Now let me update the changelog and commit:\n'),
      toolStart(3, 'Edit'),
      toolStop(3),
      textDelta('## Summary\n\nAdded a `/do:replan` button to the Agent Operations section.'),
      resultEvent('## Summary\n\nAdded a `/do:replan` button to the Agent Operations section.')
    ]);

    const finalResult = parser.getFinalResult();
    expect(finalResult).toContain('## Summary');
    expect(finalResult).toContain('Added a `/do:replan` button');
    expect(finalResult).not.toContain('Now I have all the info');
    expect(finalResult).not.toContain('Now let me run the relevant tests');
    expect(finalResult).not.toContain('Changes look clean');
  });

  it('preserves both summaries across multiple result events (e.g., task + /simplify)', () => {
    const parser = createStreamJsonParser();
    runStream(parser, [
      textDelta('Investigating the bug.\n'),
      toolStart(1, 'Read'),
      toolStop(1),
      textDelta('Task summary: fixed the bug.'),
      resultEvent('Task summary: fixed the bug.'),
      textDelta('Now running /simplify.\n'),
      toolStart(2, 'Read'),
      toolStop(2),
      textDelta('Simplify summary: code is clean.'),
      resultEvent('Simplify summary: code is clean.')
    ]);

    const finalResult = parser.getFinalResult();
    expect(finalResult).toContain('Task summary: fixed the bug.');
    expect(finalResult).toContain('Simplify summary: code is clean.');
    expect(finalResult).not.toContain('Investigating the bug');
    expect(finalResult).not.toContain('Now running /simplify');
  });

  it('returns the CLI result field for a single-turn task with no interim narration', () => {
    const parser = createStreamJsonParser();
    runStream(parser, [
      toolStart(1, 'Read'),
      toolStop(1),
      textDelta('Done. All tests pass.'),
      resultEvent('Done. All tests pass.')
    ]);

    expect(parser.getFinalResult()).toBe('Done. All tests pass.');
  });
});

describe('buildCliSpawnConfig', () => {
  it('omits --model for Codex configured-default sentinel but bypasses sandbox/approvals', () => {
    const config = buildCliSpawnConfig({ id: 'codex', command: 'codex' }, 'codex-configured-default');

    // The bypass flag is the Codex equivalent of Claude/Antigravity's
    // --dangerously-skip-permissions. Without it, codex exec runs sandboxed (no network → `gh`
    // can't reach api.github.com) and non-interactive approval prompts get cancelled.
    expect(config.args).toEqual(['exec', '--dangerously-bypass-approvals-and-sandbox', '-c', 'check_for_update_on_startup=false']);
  });

  it('passes explicit Codex model selections through alongside the sandbox bypass', () => {
    const config = buildCliSpawnConfig({ id: 'codex', command: 'codex' }, 'gpt-5.4');

    expect(config.args).toEqual(['exec', '--dangerously-bypass-approvals-and-sandbox', '-c', 'check_for_update_on_startup=false', '--model', 'gpt-5.4']);
  });

  it('gives a cloud Codex swarm enough threads for its root plus every worker', () => {
    const config = buildCliSpawnConfig(
      { id: 'codex', command: 'codex' },
      'gpt-5.4',
      {},
      { maxConcurrentThreads: 7 },
    );

    expect(config.args).toContain('agents.max_concurrent_threads_per_session=7');
  });

  it('disables the codex update check unconditionally on the headless agent path (ignores provider.args)', () => {
    // This builder constructs codex argv from scratch and never forwards
    // provider.args, so a provider.args pin is NOT honored here — a headless CoS
    // agent can never dismiss the update modal, so the check is always forced off.
    const config = buildCliSpawnConfig(
      { id: 'codex', command: 'codex', args: ['-c', 'check_for_update_on_startup=true'] },
      'gpt-5.4',
    );
    expect(config.args).toContain('check_for_update_on_startup=false');
  });

  it('uses agy print mode for Antigravity without model flags on the configured-default sentinel', () => {
    const config = buildCliSpawnConfig({ id: 'antigravity-cli', command: 'agy', args: [] }, 'antigravity-configured-default');

    expect(config.command).toBe('agy');
    expect(config.args).toEqual(['--dangerously-skip-permissions', '--print']);
  });

  // agy takes the prompt as the trailing --print VALUE, so every injected flag
  // must land before it or agy reads the flag name as its task.
  it('threads the per-task model and effort into agy ahead of --print', () => {
    const config = buildCliSpawnConfig(
      { id: 'antigravity-cli', command: 'agy', args: [] },
      'claude-sonnet-4-6',
      {},
      { effort: 'medium' },
    );

    expect(config.command).toBe('agy');
    expect(config.args).toEqual([
      '--model', 'claude-sonnet-4-6',
      '--effort', 'medium',
      '--dangerously-skip-permissions',
      '--print',
    ]);
    expect(config.args[config.args.length - 1]).toBe('--print');
  });

  it('runs `opencode run -m ollama/<model>` for a headless OpenCode Ollama agent', () => {
    const config = buildCliSpawnConfig(
      { id: 'opencode-ollama', command: 'opencode', args: ['run'], ollamaBacked: true },
      'qwen2.5:7b',
    );

    expect(config.command).toBe('opencode');
    expect(config.args).toEqual(['run', '-m', 'ollama/qwen2.5:7b']);
    expect(config.stdinMode).toBe('prompt');
    // OpenCode emits plain text, so no stream-json format is requested.
    expect(config.streamFormat).toBeUndefined();
  });

  it('runs `opencode run -m mtplx/<model>` for a headless OpenCode MTPLX agent', () => {
    const config = buildCliSpawnConfig(
      { id: 'opencode-mtplx', command: 'opencode', args: ['run'], mtplxBacked: true },
      'mtplx',
    );

    expect(config.command).toBe('opencode');
    expect(config.args).toEqual(['run', '-m', 'mtplx/mtplx']);
    expect(config.stdinMode).toBe('prompt');
  });

  it('prepends the run subcommand for OpenCode even if saved args dropped it', () => {
    const config = buildCliSpawnConfig({ id: 'opencode-ollama', command: 'opencode', args: [], ollamaBacked: true }, 'qwen2.5:7b');

    expect(config.args).toEqual(['run', '-m', 'ollama/qwen2.5:7b']);
  });

  it('respects a user-baked -m pin on an OpenCode provider and does not duplicate it', () => {
    const config = buildCliSpawnConfig(
      { id: 'opencode-ollama', command: 'opencode', args: ['run', '-m', 'ollama/custom'], ollamaBacked: true },
      'qwen2.5:7b',
    );

    expect(config.args).toEqual(['run', '-m', 'ollama/custom']);
  });

  it('runs `grok` headless with plain output, permission bypass, and stdin prompt file (no --model for configured-default)', () => {
    const config = buildCliSpawnConfig({ id: 'grok-cli', command: 'grok', args: [] }, 'grok-configured-default');
    expect(config.command).toBe('grok');
    expect(config.stdinMode).toBe('prompt');
    expect(config.args).toEqual([
      '--output-format', 'plain',
      '--permission-mode', 'bypassPermissions',
      '--prompt-file', '/dev/stdin',
    ]);
    expect(config.args).not.toContain('--model');
    // Grok is non-Claude, so no claude-only flags leak in.
    expect(config.args).not.toContain('--dangerously-skip-permissions');
    expect(config.args).not.toContain('--print');
    expect(config.args).not.toContain('--append-system-prompt-file');
  });

  it('runs `kimi` headless with --print, no --model for the configured-default sentinel', () => {
    const config = buildCliSpawnConfig({ id: 'kimi-cli', command: 'kimi', args: ['--print'] }, 'kimi-configured-default');
    expect(config.command).toBe('kimi');
    expect(config.stdinMode).toBe('prompt');
    expect(config.args).toEqual(['--print']);
    expect(config.args).not.toContain('--model');
    // Kimi is non-Claude, so no claude-only flags leak in.
    expect(config.args).not.toContain('--dangerously-skip-permissions');
    expect(config.args).not.toContain('--append-system-prompt-file');
  });

  it('injects --model for a concrete kimi model id', () => {
    const config = buildCliSpawnConfig({ id: 'kimi-cli', command: 'kimi', args: ['--print'] }, 'kimi-k2');
    expect(config.command).toBe('kimi');
    expect(config.args).toEqual(['--print', '--model', 'kimi-k2']);
  });

  it('runs `cursor-agent` headless with --print --force and the model on stdin', () => {
    const config = buildCliSpawnConfig({ id: 'cursor-cli', command: 'cursor-agent', args: ['--print', '--force'] }, 'auto');
    expect(config.command).toBe('cursor-agent');
    expect(config.stdinMode).toBe('prompt');
    expect(config.args).toEqual(['--print', '--force', '--model', 'auto']);
    // Cursor is non-Claude, so no claude-only flags leak in.
    expect(config.args).not.toContain('--dangerously-skip-permissions');
    expect(config.args).not.toContain('--append-system-prompt-file');
    // Plain text output — no stream-json parser is claimed for cursor (see cursor.js).
    expect(config.streamFormat).toBeUndefined();
  });

  it('adds --force to a cursor provider whose saved args dropped it (trust gate is fatal without it)', () => {
    const config = buildCliSpawnConfig({ id: 'cursor-cli', command: 'cursor-agent', args: [] }, null);
    expect(config.args).toEqual(['--print', '--force']);
  });

  it('does not Bedrock-map a cursor model id that merely contains "claude"', () => {
    const config = buildCliSpawnConfig(
      { id: 'cursor-cli', command: 'cursor-agent', args: ['--print', '--force'] },
      'claude-opus-5-thinking-high',
      { CLAUDE_CODE_USE_BEDROCK: '1' },
    );
    expect(config.args).toEqual(['--print', '--force', '--model', 'claude-opus-5-thinking-high']);
    expect(config.args.join(' ')).not.toContain('anthropic.');
  });

  it('adds lean-mode flags and the system-prompt file for an Ollama-backed claude CLI', () => {
    const config = buildCliSpawnConfig(
      { id: 'claude-ollama', command: 'claude', ollamaBacked: true },
      'qwen3.6:35b',
      {},
      { systemPromptFile: '/data/cos/agents/agent-1/system-prompt.md' },
    );

    expect(config.args).toContain('--bare');
    expect(config.args).toContain('--strict-mcp-config');
    const idx = config.args.indexOf('--append-system-prompt-file');
    expect(config.args[idx + 1]).toBe('/data/cos/agents/agent-1/system-prompt.md');
    // Lean flags must not disturb the model injection.
    expect(config.args[config.args.indexOf('--model') + 1]).toBe('qwen3.6:35b');
  });

  it('does NOT add lean flags to the standard claude CLI provider', () => {
    const config = buildCliSpawnConfig({ id: 'claude-code', command: 'claude' }, 'claude-opus-4-8');
    expect(config.args).not.toContain('--bare');
    expect(config.args).not.toContain('--strict-mcp-config');
    expect(config.args).not.toContain('--append-system-prompt-file');
  });

  it('adds the system-prompt file to a STANDARD claude CLI WITHOUT lean flags', () => {
    const config = buildCliSpawnConfig(
      { id: 'claude-code', command: 'claude' },
      'claude-opus-4-8',
      {},
      { systemPromptFile: '/data/cos/agents/agent-2/system-prompt.md' },
    );
    expect(config.args).not.toContain('--bare');
    const idx = config.args.indexOf('--append-system-prompt-file');
    expect(config.args[idx + 1]).toBe('/data/cos/agents/agent-2/system-prompt.md');
  });

  describe('reasoning-effort override', () => {
    it('adds a -c model_reasoning_effort pair for codex', () => {
      const config = buildCliSpawnConfig({ id: 'codex', command: 'codex' }, 'gpt-5.4', {}, { effort: 'xhigh' });
      expect(config.args).toContain('model_reasoning_effort=xhigh');
    });

    it('passes Ultra to supported Codex models and clamps it elsewhere', () => {
      const codex = { id: 'codex', command: 'codex' };
      const maxConfig = buildCliSpawnConfig(codex, 'gpt-5.4', {}, { effort: 'max' });
      expect(maxConfig.args).toContain('model_reasoning_effort=max');
      const ultraConfig = buildCliSpawnConfig(codex, 'gpt-5.6-sol', {}, { effort: 'ultra' });
      expect(ultraConfig.args).toContain('model_reasoning_effort=ultra');
      const clampedConfig = buildCliSpawnConfig(codex, 'gpt-5.4', {}, { effort: 'ultra' });
      expect(clampedConfig.args).toContain('model_reasoning_effort=max');
    });

    it('adds --effort for claude', () => {
      const config = buildCliSpawnConfig({ id: 'claude-code', command: 'claude' }, 'claude-opus-4-8', {}, { effort: 'high' });
      expect(config.args[config.args.indexOf('--effort') + 1]).toBe('high');
    });

    it('clamps codex-only values on a claude provider', () => {
      const config = buildCliSpawnConfig({ id: 'claude-code', command: 'claude' }, null, {}, { effort: 'ultra' });
      expect(config.args[config.args.indexOf('--effort') + 1]).toBe('max');
    });

    it('omits the flag entirely when no effort is set or the provider has no effort control', () => {
      // Codex always carries `-c check_for_update_on_startup=false`, so assert the
      // absence of the EFFORT config pair specifically, not any `-c`.
      expect(buildCliSpawnConfig({ id: 'codex', command: 'codex' }, 'gpt-5.4').args.join(' ')).not.toContain('model_reasoning_effort');
      expect(buildCliSpawnConfig({ id: 'claude-code', command: 'claude' }, null).args).not.toContain('--effort');
      const grok = buildCliSpawnConfig({ id: 'grok-cli', command: 'grok', args: [] }, null, {}, { effort: 'high' });
      expect(grok.args.join(' ')).not.toContain('effort');
    });

    it('keys effort on the RESOLVED command, so a blank-command claude provider still qualifies', () => {
      // id gives no claude-code* hint and command is blank; the builder resolves
      // the launch command to `claude`, so the effort pin must apply — matching
      // the TUI builder's re-keying (same pin, same behavior per execution mode).
      const config = buildCliSpawnConfig({ id: 'whatever' }, null, {}, { effort: 'high' });
      expect(config.args[config.args.indexOf('--effort') + 1]).toBe('high');
    });

    it('never emits the claude-shaped --effort for a renamed codex provider (detection and emission agree)', () => {
      // id !== 'codex' routes this into the default (claude-style) branch, but
      // the effort arg shape must still follow the binary, not the branch.
      const config = buildCliSpawnConfig(
        { id: 'my-codex', command: '/opt/homebrew/bin/codex' },
        null,
        {},
        { effort: 'xhigh' },
      );
      expect(config.args).not.toContain('--effort');
      expect(config.args[config.args.indexOf('-c') + 1]).toBe('model_reasoning_effort=xhigh');
    });

    it('respects a user-baked --effort pin in provider args (mirrors the --model rule)', () => {
      const config = buildCliSpawnConfig(
        { id: 'claude-code', command: 'claude', args: ['--effort', 'low'] },
        null,
        {},
        { effort: 'max' },
      );
      const effortArgs = config.args.filter(a => a === '--effort');
      expect(effortArgs).toHaveLength(1);
      expect(config.args[config.args.indexOf('--effort') + 1]).toBe('low');
    });
  });

  describe('Bedrock model-id mapping', () => {
    // buildCliSpawnConfig reads process.env for the Bedrock signal; isolate the
    // tests from whatever the host/CI environment happens to set.
    let savedBedrock;
    beforeEach(() => {
      savedBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
      delete process.env.CLAUDE_CODE_USE_BEDROCK;
    });
    afterEach(() => {
      if (savedBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
      else process.env.CLAUDE_CODE_USE_BEDROCK = savedBedrock;
    });

    const modelOf = (args) => args[args.indexOf('--model') + 1];

    it('passes a bare Claude model through unchanged when Bedrock mode is off', () => {
      const config = buildCliSpawnConfig({ id: 'claude-code', command: 'claude' }, 'claude-opus-4-8');
      expect(modelOf(config.args)).toBe('claude-opus-4-8');
    });

    it('maps a bare Claude model when Bedrock comes ONLY from settings.json env (regression: #1521 blocking)', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // provider.envVars empty (plain claude-code), Bedrock supplied via the
      // ~/.claude/settings.json env block — the case the original fix missed.
      const config = buildCliSpawnConfig(
        { id: 'claude-code', command: 'claude', envVars: {} },
        'claude-opus-4-8',
        { CLAUDE_CODE_USE_BEDROCK: '1' },
      );
      expect(modelOf(config.args)).toBe('global.anthropic.claude-opus-4-8');
      spy.mockRestore();
    });

    it('maps a bare Claude model when Bedrock comes from provider.envVars', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const config = buildCliSpawnConfig(
        { id: 'claude-code', command: 'claude', envVars: { CLAUDE_CODE_USE_BEDROCK: '1' } },
        'claude-opus-4-8',
      );
      expect(modelOf(config.args)).toBe('global.anthropic.claude-opus-4-8');
      spy.mockRestore();
    });
  });
});

describe('stream error containment', () => {
  // Build a minimal fake process with stdin/stdout/stderr EventEmitters.
  function makeFakeProcess({ failWith = null, noStdin = false } = {}) {
    const proc = new EventEmitter();
    if (!noStdin) {
      proc.pid = 12345;
      // A real ChildProcess stdin is a stream, so the fake is one too — otherwise
      // the production `guardChildStdin` listener has nothing to attach to and the
      // stdin-EPIPE path below would be tested against a shape that can't occur.
      proc.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
    }
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    if (failWith) setImmediate(() => proc.emit('error', failWith));
    return proc;
  }

  const minimalArgs = {
    agentId: 'agent-test',
    task: { id: 'task-1', description: 'do stuff' },
    prompt: 'Hello',
    workspacePath: '/tmp',
    model: 'claude-3',
    provider: { id: 'claude-code', type: 'cli', command: 'claude', args: [], envVars: {} },
    runId: 'run-1',
    cliConfig: {
      command: 'claude',
      args: ['--dangerously-skip-permissions', '--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'],
      stdinMode: 'prompt',
      streamFormat: 'stream-json',
    },
    agentDir: '/tmp',
    executionId: null,
    laneName: null,
    cleanupWorktreeFn: vi.fn().mockResolvedValue(undefined),
    isTruthyMetaFn: vi.fn().mockReturnValue(false),
  };

  // Re-import the mocked cosAgentLifecycle module reference once — mocking is module-scoped.
  let agentStateMocks;
  beforeEach(async () => {
    fakeProcess = makeFakeProcess();
    // Fresh mocked module reference for each test so mockRejectedValueOnce is clean.
    agentStateMocks = await import('./cosAgentLifecycle.js');
    // Reset all implementations to their default "resolve" state before each test.
    agentStateMocks.updateAgent.mockResolvedValue(undefined);
    agentStateMocks.completeAgent.mockResolvedValue(undefined);
    agentStateMocks.appendAgentOutput.mockResolvedValue(undefined);
    agentStateMocks.appendAgentOutputLines.mockResolvedValue(undefined);
    (await import('./agentRunTracking.js')).completeAgentRun.mockResolvedValue(undefined);
    (await import('./agentFinalization.js')).finalizeAgent.mockResolvedValue(undefined);
    minimalArgs.cleanupWorktreeFn.mockResolvedValue(undefined);
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(isOllamaBackedProvider).mockReturnValue(false);
    vi.mocked(ensureOllamaAgentContext).mockResolvedValue({ skipped: true });
    // Reset the resolve+wrap helper to its POSIX passthrough before each test
    // (afterEach's restoreAllMocks can clear the factory implementation).
    vi.mocked(prepareCliSpawn).mockImplementation((command, args) => ({ command, args }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('spawn failure containment', () => {
    const failedSpawn = () => makeFakeProcess({
      noStdin: true,
      failWith: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }),
    });

    const waitForSpawnFailure = async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    };

    it('the failing fake really has no stdin (bypass probe)', () => {
      expect(makeFakeProcess({ noStdin: true }).stdin).toBeUndefined();
    });

    it('settles with a startup failure when the provider CLI is missing', async () => {
      fakeProcess = failedSpawn();

      await expect(spawnDirectly(minimalArgs)).resolves.toBe('agent-test');
      await waitForSpawnFailure();

      expect(agentStateMocks.completeAgent).toHaveBeenCalledWith(
        'agent-test',
        expect.objectContaining({ success: false, error: expect.stringContaining('ENOENT') }),
      );
    });

    it('does not leave the agent registered in activeAgents after a failed spawn', async () => {
      const { activeAgents, registerSpawnedAgent } = await import('./agentState.js');
      activeAgents.clear();
      registerSpawnedAgent.mockClear();
      agentStateMocks.updateAgent.mockClear();
      fakeProcess = failedSpawn();

      await spawnDirectly(minimalArgs);
      await waitForSpawnFailure();

      expect(activeAgents.has('agent-test')).toBe(false);
      expect(registerSpawnedAgent).not.toHaveBeenCalled();
      expect(agentStateMocks.updateAgent).not.toHaveBeenCalled();
    });

    it('surfaces the spawn error message to the run log', async () => {
      agentStateMocks.appendAgentOutputLines.mockClear();
      fakeProcess = failedSpawn();

      await spawnDirectly(minimalArgs);
      await waitForSpawnFailure();

      const lines = agentStateMocks.appendAgentOutputLines.mock.calls.flatMap(([, batch]) => batch);
      expect(lines.some((line) => line.includes('ENOENT'))).toBe(true);
    });

    it('contains an EPIPE on stdin from a child that died before reading the prompt', async () => {
      // Two hazards in one shape, both fatal to the WHOLE server process because
      // this runs outside the Express request lifecycle (no next(err) to bubble to):
      //   1. a synchronous throw from stdin.write on an already-destroyed pipe, and
      //   2. an 'error' emitted on the stdin stream with no listener, which Node re-throws.
      // Regression guard for the listener drifting back below the write.
      const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      fakeProcess = makeFakeProcess();
      // Captured INSIDE write so the assertion is about ordering, not just
      // eventual presence — a guard moved below the write would read 0 here.
      let listenersAtWriteTime = null;
      fakeProcess.stdin = Object.assign(new EventEmitter(), {
        write: vi.fn(function () {
          listenersAtWriteTime = fakeProcess.stdin.listenerCount('error');
          throw epipe();
        }),
        end: vi.fn(),
        destroy: vi.fn(),
      });

      const spawnPromise = spawnDirectly(minimalArgs);
      await new Promise((r) => setTimeout(r, 10));

      // The guard was already in place when the write ran…
      expect(listenersAtWriteTime).toBe(1);
      // …so a late pipe error is swallowed instead of thrown.
      expect(() => fakeProcess.stdin.emit('error', epipe())).not.toThrow();
      // …and the pipe was closed anyway, so a child still reading stdin sees EOF.
      expect(fakeProcess.stdin.destroy).toHaveBeenCalled();

      fakeProcess.emit('close', 0);
      // The synchronous write throw did not escape as a rejected spawn either.
      await expect(spawnPromise).resolves.toBe('agent-test');
    });
  });

  // ─── Fast-exiting child: events emitted during the post-spawn await (#5791) ─

  it('does not drop stdout or close emitted while the post-spawn await is still yielding', async () => {
    // The child's whole life cycle can land between spawn() and the point where
    // the real stdout/stderr/close handler bodies are installed: the
    // `updateAgent(agentId, { pid })` in between is real state-file I/O, so it
    // yields for a macrotask, not just a microtask. A CLI that dies instantly
    // (bad flag, instant auth refusal) exits inside that window — before the fix
    // its output was lost and its `close` landed on nothing, leaving the run
    // record, the execution lane and the activeAgents entry non-terminal until
    // the orphan reaper eventually noticed.
    const { activeAgents } = await import('./agentState.js');
    const { finalizeAgent } = await import('./agentFinalization.js');
    activeAgents.clear();
    finalizeAgent.mockClear();
    agentStateMocks.updateAgent.mockImplementationOnce(async () => {
      // Emit from inside the same macrotask yield the real updateAgent creates.
      await new Promise((r) => setImmediate(r));
      fakeProcess.stdout.emit('data', Buffer.from(
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"unknown flag --nope\\n"}}}\n'
      ));
      fakeProcess.emit('close', 2);
    });

    await expect(spawnDirectly(minimalArgs)).resolves.toBe('agent-test');
    await new Promise((r) => setTimeout(r, 30));

    expect(finalizeAgent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-test',
      exitCode: 2,
      success: false,
      // The output the child managed to write before exiting is exactly what
      // explains the failure, so it has to survive the buffering too.
      outputBuffer: expect.stringContaining('unknown flag --nope'),
    }));
    expect(activeAgents.has('agent-test')).toBe(false);
  });

  // ─── Lifecycle ledger — the first-output boundary (#4540) ─────────────────

  it('records ONE run.output on the first real byte, and never again', async () => {
    // Bounded on purpose: a per-chunk event would make the ledger a copy of the
    // output it deliberately redacts. What one event buys is time-to-first-output
    // — the only thing that separates a run that stalled after speaking from one
    // that never spoke at all.
    appendRunEvent.mockClear();
    const spawnPromise = spawnDirectly(minimalArgs);
    await new Promise((r) => setTimeout(r, 10));

    fakeProcess.stdout.emit('data', Buffer.from('{\"type\":\"result\",\"result\":\"one\"}\n'));
    fakeProcess.stdout.emit('data', Buffer.from('{\"type\":\"result\",\"result\":\"two\"}\n'));
    await new Promise((r) => setTimeout(r, 20));

    const outputs = appendRunEvent.mock.calls.map(([e]) => e).filter((e) => e.kind === 'run.output');
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ runId: 'run-1', agentId: 'agent-test', taskId: 'task-1', data: { source: 'cli-stdout' } });

    fakeProcess.emit('close', 0);
    await spawnPromise.catch(() => {});
  });

  it('counts stderr-only output too — several providers say everything there', async () => {
    // codex's entire progress feed is stderr and lands in the same transcript.
    // A stdout-only recorder would file those runs as having produced nothing.
    appendRunEvent.mockClear();
    const spawnPromise = spawnDirectly(minimalArgs);
    await new Promise((r) => setTimeout(r, 10));

    fakeProcess.stderr.emit('data', Buffer.from('thinking...\n'));
    await new Promise((r) => setTimeout(r, 20));

    const outputs = appendRunEvent.mock.calls.map(([e]) => e).filter((e) => e.kind === 'run.output');
    expect(outputs).toHaveLength(1);
    expect(outputs[0].data).toMatchObject({ source: 'cli-stderr' });

    fakeProcess.emit('close', 0);
    await spawnPromise.catch(() => {});
  });

  it('records no run.output for a run that never produced any', async () => {
    // The 3s initialization timer flips the record to "working" with nothing
    // behind it, which is exactly the run this boundary must NOT vouch for.
    appendRunEvent.mockClear();
    const spawnPromise = spawnDirectly(minimalArgs);
    await new Promise((r) => setTimeout(r, 10));

    fakeProcess.emit('close', 1);
    await spawnPromise.catch(() => {});

    expect(appendRunEvent.mock.calls.map(([e]) => e.kind)).not.toContain('run.output');
  });

  it('drains stdout output on close and a failed batch flush is logged, not leaked as an unhandled rejection', async () => {
    // stdout output is now batched: the data handler pushes lines to the output
    // batcher and the close handler drains it. Make the drain's state write fail
    // and assert the batcher swallows+logs it with a ❌ prefix — no escape.
    agentStateMocks.appendAgentOutputLines.mockRejectedValueOnce(new Error('db write failed'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unhandledRejections = [];
    const onUnhandled = (reason) => unhandledRejections.push(reason);
    process.on('unhandledRejection', onUnhandled);


    // Act: start spawnDirectly. Note: spawnDirectly awaits getClaudeSettingsEnv()
    // before registering stdout/stderr listeners, so we must yield before emitting.
    const spawnPromise = spawnDirectly(minimalArgs);

    // Yield to let the await inside spawnDirectly resolve so listeners are registered.
    await new Promise((r) => setTimeout(r, 10));

    // Emit a stream-json text delta on stdout so the parser yields a line the
    // handler enqueues into the batcher.
    fakeProcess.stdout.emit('data', Buffer.from(
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello\\n"}}}\n'
    ));

    // Give the microtask queue a chance to drain so the async handler runs.
    await new Promise((r) => setTimeout(r, 50));

    // Trigger close so the batcher drains and spawnDirectly resolves.
    fakeProcess.emit('close', 0);
    await spawnPromise.catch(() => {});

    process.off('unhandledRejection', onUnhandled);

    // Assert: error was swallowed into console.error, not an unhandled rejection
    expect(unhandledRejections).toHaveLength(0);
    const logged = consoleSpy.mock.calls.some(
      (args) => typeof args[0] === 'string' && args[0].startsWith('❌ agent agent-test output batch flush failed:')
    );
    expect(logged).toBe(true);
  });

  it('prepares the configured Ollama context before a direct CLI agent spawns', async () => {
    vi.mocked(spawn).mockClear();
    vi.mocked(ensureOllamaAgentContext).mockClear();
    vi.mocked(isOllamaBackedProvider).mockReturnValue(true);
    vi.mocked(ensureOllamaAgentContext).mockResolvedValue({
      skipped: false,
      applied: true,
      contextLength: 131072,
      warning: '⚠️ Example context warning',
    });

    const spawnPromise = spawnDirectly({
      ...minimalArgs,
      provider: { ...minimalArgs.provider, id: 'claude-ollama', ollamaBacked: true },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(ensureOllamaAgentContext).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'claude-ollama' }),
      { model: 'claude-3' },
    );
    expect(ensureOllamaAgentContext.mock.invocationCallOrder[0]).toBeLessThan(spawn.mock.invocationCallOrder[0]);

    fakeProcess.emit('close', 0);
    await spawnPromise;
    await new Promise((r) => setTimeout(r, 20));

    expect(agentStateMocks.appendAgentOutputLines).toHaveBeenCalledWith('agent-test', [
      '⚠️ Example context warning',
      '🪟 Reloaded Ollama at a 131072-token context window',
    ]);
  });

  it('drains stderr output on close and a failed batch flush is logged, not leaked as an unhandled rejection', async () => {
    agentStateMocks.appendAgentOutputLines.mockRejectedValueOnce(new Error('stderr db write failed'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unhandledRejections = [];
    const onUnhandled = (reason) => unhandledRejections.push(reason);
    process.on('unhandledRejection', onUnhandled);

    const spawnPromise = spawnDirectly(minimalArgs);

    // Yield to let the await inside spawnDirectly resolve so listeners are registered.
    await new Promise((r) => setTimeout(r, 10));

    // Emit data on stderr to enqueue a batched `[stderr] …` line.
    fakeProcess.stderr.emit('data', Buffer.from('some stderr output\n'));

    await new Promise((r) => setTimeout(r, 50));

    fakeProcess.emit('close', 0);
    await spawnPromise.catch(() => {});

    process.off('unhandledRejection', onUnhandled);

    expect(unhandledRejections).toHaveLength(0);
    const logged = consoleSpy.mock.calls.some(
      (args) => typeof args[0] === 'string' && args[0].startsWith('❌ agent agent-test output batch flush failed:')
    );
    expect(logged).toBe(true);
  });

  it('detects a fallback signal and terminates immediately even while an earlier transcript write is blocked, keeping output ordered (#2384)', async () => {
    killProcessTree.mockClear();

    // Block the FIRST chunk's serialized transcript body at its phase-working
    // updateAgent await (the pid updateAgent at spawn time carries no
    // metadata.phase, so it resolves normally and lets spawn finish).
    let releaseFirstWrite;
    const firstWriteGate = new Promise((r) => { releaseFirstWrite = r; });
    agentStateMocks.updateAgent.mockImplementation((id, patch) => {
      if (patch?.metadata?.phase === 'working') return firstWriteGate;
      return Promise.resolve(undefined);
    });

    // Non-stream provider so outputBuffer is raw text and ordering is trivial to assert.
    const args = {
      ...minimalArgs,
      cliConfig: { command: 'claude', args: [], stdinMode: 'prompt', streamFormat: 'text' },
    };

    const spawnPromise = spawnDirectly(args);
    // Yield so spawnDirectly's awaits resolve and the stdout listener registers.
    await new Promise((r) => setTimeout(r, 10));

    // Chunk 1: ordinary output → its serialized write body blocks on the gate.
    fakeProcess.stdout.emit('data', Buffer.from('first output line\n'));
    await new Promise((r) => setTimeout(r, 10));

    // Chunk 2: a usage-limit fallback signal arrives WHILE chunk 1 is blocked.
    // The synchronous detector must fire the kill without waiting for the gate.
    fakeProcess.stdout.emit('data', Buffer.from('Now using extra usage\n'));

    // Assert: termination was immediate — killProcessTree fired synchronously in
    // the data listener, before the blocked first write could settle.
    expect(killProcessTree).toHaveBeenCalledTimes(1);
    expect(killProcessTree.mock.calls[0][1]).toBe('SIGTERM');
    fakeProcess.killed = true;

    // Release the gate, let the serialized chain drain, then close.
    releaseFirstWrite();
    await new Promise((r) => setTimeout(r, 20));
    fakeProcess.emit('close', 143);
    await spawnPromise.catch(() => {});

    // Assert: the two chunks landed in emission order (serialized, not reordered
    // by the blocked first write racing the second).
    const allLines = agentStateMocks.appendAgentOutputLines.mock.calls.flatMap((c) => c[1]);
    const firstIdx = allLines.findIndex((l) => l.includes('first output line'));
    const usageIdx = allLines.findIndex((l) => l.includes('Now using extra usage'));
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(usageIdx).toBeGreaterThan(firstIdx);
  });

  it('routes the CLI command through prepareCliSpawn and spawns its resolved+wrapped result (#2243)', async () => {
    // The reported bug: on Windows a bare `opencode`/`claude` .cmd shim can't be
    // spawned directly under shell:false → ENOENT (-4058) → startup-failure.
    // spawnDirectly must hand the command through prepareCliSpawn (resolve +
    // cmd.exe wrap) and spawn WHATEVER it returns — asserted here with a sentinel.
    vi.mocked(prepareCliSpawn).mockReturnValueOnce({
      command: 'cmd.exe',
      args: ['/c', 'C:\\npm\\claude.cmd', '--print'],
    });

    const spawnPromise = spawnDirectly(minimalArgs);
    await new Promise((r) => setTimeout(r, 10)); // let the getClaudeSettingsEnv await settle

    // Called with the logical command + args and the child env (PATH-bearing) so
    // a provider PATH override is honored.
    expect(prepareCliSpawn).toHaveBeenCalledWith(
      minimalArgs.cliConfig.command,
      minimalArgs.cliConfig.args,
      expect.objectContaining({ PATH: expect.anything() }),
    );
    // spawn() received the resolved+wrapped pair, NOT the bare command.
    expect(spawn).toHaveBeenCalledWith(
      'cmd.exe',
      ['/c', 'C:\\npm\\claude.cmd', '--print'],
      expect.objectContaining({ shell: false }),
    );

    fakeProcess.emit('close', 0);
    await spawnPromise.catch(() => {});
  });

  it('injects the repo-owner-pinned GH_TOKEN into the spawn env so the agent\'s own `gh` uses the right account', async () => {
    const { resolveForgeTokenEnv } = await import('./git.js');
    vi.mocked(resolveForgeTokenEnv).mockResolvedValueOnce({ GH_TOKEN: 'ghp_pinned_owner_token' });

    const spawnPromise = spawnDirectly(minimalArgs);
    await new Promise((r) => setTimeout(r, 10)); // let the resolveForgeTokenEnv await settle

    // Resolved against the workspace dir (the worktree the agent will PR from).
    expect(resolveForgeTokenEnv).toHaveBeenCalledWith('/tmp');
    expect(spawn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ env: expect.objectContaining({ GH_TOKEN: 'ghp_pinned_owner_token' }) }),
    );

    fakeProcess.emit('close', 0);
    await spawnPromise.catch(() => {});
  });

  it('spawns a Creative Director task in an isolated scratch cwd, not the PortOS root (#4650)', async () => {
    const { creativeDirectorScratchCwd } = await import('../lib/spawnCwd.js');
    const args = {
      ...minimalArgs,
      task: {
        id: 'task-cd',
        description: 'Evaluate scene',
        metadata: { creativeDirector: { projectId: 'p', kind: 'evaluate' }, useWorktree: false },
      },
      workspacePath: '/tmp', // the previous default — must not win over the scratch path
    };
    const spawnPromise = spawnDirectly(args);
    await new Promise((r) => setTimeout(r, 10));
    const expectedCwd = creativeDirectorScratchCwd('agent-test');
    expect(spawn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ cwd: expectedCwd }),
    );
    fakeProcess.emit('close', 0);
    await spawnPromise.catch(() => {});
  });

  it('leaves the spawn env\'s ambient GH_TOKEN untouched when there is no owner match', async () => {
    const { resolveForgeTokenEnv } = await import('./git.js');
    vi.mocked(resolveForgeTokenEnv).mockResolvedValueOnce({});
    const prev = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'ghp_ambient';

    const spawnPromise = spawnDirectly(minimalArgs);
    await new Promise((r) => setTimeout(r, 10));

    expect(spawn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ env: expect.objectContaining({ GH_TOKEN: 'ghp_ambient' }) }),
    );

    if (prev === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = prev;
    fakeProcess.emit('close', 0);
    await spawnPromise.catch(() => {});
  });

  it('skips the owner-token probe when the provider supplies its own GITHUB_TOKEN', async () => {
    const { resolveForgeTokenEnv } = await import('./git.js');
    vi.mocked(resolveForgeTokenEnv).mockClear();
    vi.mocked(spawn).mockClear();

    const args = { ...minimalArgs, provider: { ...minimalArgs.provider, envVars: { GITHUB_TOKEN: 'ghp_provider_bot' } } };
    const spawnPromise = spawnDirectly(args);
    await new Promise((r) => setTimeout(r, 10));

    // gh prefers GH_TOKEN over GITHUB_TOKEN — injecting the owner GH_TOKEN would
    // shadow the provider's explicit bot credential, so the probe is skipped.
    expect(resolveForgeTokenEnv).not.toHaveBeenCalled();
    const env = vi.mocked(spawn).mock.calls.at(-1)[2].env;
    expect(env.GITHUB_TOKEN).toBe('ghp_provider_bot');

    fakeProcess.emit('close', 0);
    await spawnPromise.catch(() => {});
  });

  describe('initialization timeout — 3-second phase transition', () => {
    it('calls updateAgent with working phase after 3s when agent has not started working', async () => {
      vi.useFakeTimers();
      const { activeAgents } = await import('./agentState.js');
      const agents = agentStateMocks;

      const spawnPromise = spawnDirectly(minimalArgs);
      // Yield two microtask rounds so the getClaudeSettingsEnv await resolves and
      // the setTimeout is registered before we seed activeAgents.
      await vi.advanceTimersByTimeAsync(10);

      // Manually seed the activeAgents map so the guard inside the timeout passes.
      activeAgents.set(minimalArgs.agentId, { process: fakeProcess });

      await vi.advanceTimersByTimeAsync(3000);

      expect(agents.updateAgent).toHaveBeenCalledWith(
        minimalArgs.agentId,
        { metadata: { phase: 'working' } }
      );

      // Clean up: close the fake process so spawnDirectly can settle.
      activeAgents.delete(minimalArgs.agentId);
      fakeProcess.emit('close', 0);
      await spawnPromise.catch(() => {});
    });

    it('does NOT crash when updateAgent rejects inside the timeout callback', async () => {
      vi.useFakeTimers();
      const { activeAgents } = await import('./agentState.js');
      // spawnDirectly calls updateAgent once synchronously (PID update at line ~406)
      // before the 3-second setTimeout fires. Allow that first call to resolve
      // normally so spawnDirectly doesn't throw before the timeout test begins;
      // then reject the SECOND call (the phase-transition inside the timeout).
      agentStateMocks.updateAgent
        .mockResolvedValueOnce(undefined)     // PID update — let it pass
        .mockRejectedValueOnce(new Error('db write failed')); // timeout update — reject

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const unhandledRejections = [];
      const onUnhandled = (reason) => unhandledRejections.push(reason);
      process.on('unhandledRejection', onUnhandled);

      const spawnPromise = spawnDirectly(minimalArgs);
      await vi.advanceTimersByTimeAsync(10);

      activeAgents.set(minimalArgs.agentId, { process: fakeProcess });

      // Advance the initialization threshold and let the callback's rejected
      // update settle without burning three seconds of wall clock.
      await vi.advanceTimersByTimeAsync(3000);

      process.off('unhandledRejection', onUnhandled);

      expect(unhandledRejections).toHaveLength(0);
      const logged = consoleSpy.mock.calls.some(
        (args) => typeof args[0] === 'string' && args[0].startsWith('❌ agentCliSpawning init timeout failed')
      );
      expect(logged).toBe(true);

      activeAgents.delete(minimalArgs.agentId);
      fakeProcess.emit('close', 0);
      await spawnPromise.catch(() => {});
      consoleSpy.mockRestore();
    });
  });

  it('threads the ordered reviewer list while forcing public review into non-applying mode', async () => {
    const cleanupWorktreeFn = vi.fn().mockResolvedValue(undefined);
    const args = {
      ...minimalArgs,
      task: {
        id: 'task-rv',
        description: 'do stuff',
        metadata: { reviewers: ['codex', 'antigravity'], reviewStopMode: 'on-clean', reviewerApplies: true },
      },
      cleanupWorktreeFn,
      isTruthyMetaFn: (v) => v === true,
    };

    spawnDirectly(args);
    await new Promise((r) => setTimeout(r, 10));
    fakeProcess.stdout.emit('data', Buffer.from('{"type":"result","result":"ok"}\n'));
    await new Promise((r) => setTimeout(r, 50));
    fakeProcess.emit('close', 0);
    // The close handler is fire-and-forget (spawnDirectly returns agentId
    // synchronously) — wait for the async handler's finally block to run.
    await new Promise((r) => setTimeout(r, 80));

    expect(cleanupWorktreeFn).toHaveBeenCalledTimes(1);
    const opts = cleanupWorktreeFn.mock.calls[0][2];
    expect(opts.reviewers).toEqual(['codex', 'antigravity']);
    expect(opts.reviewStopMode).toBe('on-clean');
    expect(opts.reviewerApplies).toBe(false);
    // The removed singular key must NOT be passed.
    expect(opts.reviewer).toBeUndefined();
  });

  // A failed direct-CLI run's branch is preserved by cleanup when it holds commits;
  // without this call nothing ever points the retry at it and the work is redone
  // from scratch (#3368). Runs after cleanup so it reflects what actually survived.
  it('records a resume pointer after cleanup when the run failed', async () => {
    releaseRetryHold.mockClear();
    const cleanupWorktreeFn = vi.fn().mockResolvedValue(undefined);
    const task = { id: 'task-rp', description: 'do stuff', metadata: {} };

    spawnDirectly({ ...minimalArgs, task, cleanupWorktreeFn, isTruthyMetaFn: (v) => v === true });
    await new Promise((r) => setTimeout(r, 10));
    fakeProcess.emit('close', 1);
    await new Promise((r) => setTimeout(r, 80));

    expect(releaseRetryHold).toHaveBeenCalledWith({
      agentId: minimalArgs.agentId, task, success: false,
    });
    expect(cleanupWorktreeFn.mock.invocationCallOrder[0])
      .toBeLessThan(releaseRetryHold.mock.invocationCallOrder[0]);
  });

  // The helper no-ops on success (unit-tested in cleanupAgentWorktree.test.js) —
  // what this pins is that the close handler hands it the real verdict, not a
  // hardcoded false that would stamp pointers on every completed run.
  it('passes the success verdict through on a clean run', async () => {
    releaseRetryHold.mockClear();
    const task = { id: 'task-rp-ok', description: 'do stuff', metadata: {} };

    spawnDirectly({ ...minimalArgs, task, cleanupWorktreeFn: vi.fn().mockResolvedValue(undefined), isTruthyMetaFn: (v) => v === true });
    await new Promise((r) => setTimeout(r, 10));
    fakeProcess.stdout.emit('data', Buffer.from('{"type":"result","result":"ok"}\n'));
    await new Promise((r) => setTimeout(r, 50));
    fakeProcess.emit('close', 0);
    await new Promise((r) => setTimeout(r, 80));

    expect(releaseRetryHold).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  // pm2's TreeKill takes direct-CLI children down with portos-server exactly as
  // it does TUI PTYs (#3202). Finalizing here would charge the task's failure
  // budget — and possibly file an investigation task — for a fault the agent
  // didn't have, and hand its worktree to cleanup, discarding the state a resume
  // needs. The run is abandoned instead, leaving the record `running` for the
  // next boot's orphan sweep to reconcile from the host-shutdown marker.
  describe('pipeline progression on close', () => {
    // The runner/TUI completion path advances a staged pipeline through
    // runAgentCompletionCleanup; this direct path only ran finalize + worktree
    // cleanup, so every directly-spawned stage (all public-review stages)
    // completed without queuing its successor.
    it('advances the pipeline before the worktree is cleaned up', async () => {
      const { handlePipelineProgression } = await import('./agentCompletionCleanup.js');
      handlePipelineProgression.mockClear();
      const order = [];
      handlePipelineProgression.mockImplementation(async () => { order.push('pipeline'); });
      minimalArgs.cleanupWorktreeFn.mockImplementation(async () => { order.push('worktree'); });
      const task = { id: 'task-1', description: 'stage', metadata: { pipeline: { status: 'running', currentStage: 1, stages: [{}, {}, {}] } } };

      const spawnPromise = spawnDirectly({ ...minimalArgs, task });
      await new Promise((r) => setTimeout(r, 10));
      fakeProcess.emit('close', 0);
      await spawnPromise.catch(() => {});
      await new Promise((r) => setTimeout(r, 30));

      expect(handlePipelineProgression).toHaveBeenCalledWith(task, 'agent-test', true);
      expect(order).toEqual(['pipeline', 'worktree']);
    });

    it('does not touch pipeline progression for an ordinary task', async () => {
      const { handlePipelineProgression } = await import('./agentCompletionCleanup.js');
      handlePipelineProgression.mockClear();
      const spawnPromise = spawnDirectly(minimalArgs);
      await new Promise((r) => setTimeout(r, 10));
      fakeProcess.emit('close', 0);
      await spawnPromise.catch(() => {});
      await new Promise((r) => setTimeout(r, 30));
      expect(handlePipelineProgression).not.toHaveBeenCalled();
    });
  });

  describe('host restart (#3202)', () => {
    // The outer beforeEach re-sets implementations but not call history, and the
    // mocks are module-scoped — clear so "was it called" reads only this test.
    beforeEach(async () => {
      const { finalizeAgent } = await import('./agentFinalization.js');
      finalizeAgent.mockClear();
      agentStateMocks.updateAgent.mockClear();
    });

    afterEach(() => resetHostShutdownFlagForTests());

    const runToClose = async (args, code = 0) => {
      spawnDirectly(args);
      await new Promise((r) => setTimeout(r, 10));
      markHostShuttingDown();
      fakeProcess.emit('close', code);
      await new Promise((r) => setTimeout(r, 80));
    };

    it('abandons without finalizing or cleaning up the worktree', async () => {
      const cleanupWorktreeFn = vi.fn().mockResolvedValue(undefined);
      const { finalizeAgent } = await import('./agentFinalization.js');

      await runToClose({ ...minimalArgs, cleanupWorktreeFn });

      expect(finalizeAgent).not.toHaveBeenCalled();
      expect(cleanupWorktreeFn).not.toHaveBeenCalled();
      // The breadcrumb the orphan sweep falls back on when no marker names the agent.
      expect(agentStateMocks.updateAgent).toHaveBeenCalledWith(
        minimalArgs.agentId,
        { metadata: { phase: 'interrupted', interruptedBy: 'host-shutdown' } },
      );
    });

    it('still finalizes a user-terminated run so it is recorded as terminated, not resurrected', async () => {
      const { userTerminatedAgents } = await import('./agentState.js');
      const { finalizeAgent } = await import('./agentFinalization.js');
      userTerminatedAgents.add(minimalArgs.agentId);

      await runToClose({ ...minimalArgs });

      expect(finalizeAgent).toHaveBeenCalledWith(
        expect.objectContaining({ terminatedByUser: true, success: false }),
      );
      userTerminatedAgents.delete(minimalArgs.agentId);
    });

    it('still finalizes when the agent already wrote its completion sentinel', async () => {
      const { finalizeAgent } = await import('./agentFinalization.js');
      // The sentinel is named per agent instance so two worktree-less runs
      // sharing one workspace can't be finalized on each other's signal.
      vi.mocked(existsSync).mockImplementation((path) =>
        path === join(minimalArgs.workspacePath, '.agent-done-agent-test'));

      await runToClose({ ...minimalArgs }, null);

      expect(finalizeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: minimalArgs.agentId,
          success: true,
          workspacePath: minimalArgs.workspacePath,
        }),
      );
    });
  });
});
