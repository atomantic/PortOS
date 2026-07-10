import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Heavy modules needed only by spawnDirectly — mock them all before importing.
vi.mock('./cosEvents.js', () => ({ cosEvents: { emit: vi.fn() }, emitLog: vi.fn() }));
vi.mock('./cosAgents.js', () => {
  const appendAgentOutput = vi.fn().mockResolvedValue(undefined);
  const appendAgentOutputLines = vi.fn().mockResolvedValue(undefined);
  // Faithful stand-in for the real debounced batcher: accumulates pushed lines
  // and, on flush(), routes them through the mocked appendAgentOutputLines while
  // swallowing+logging failures (mirrors the real createAgentOutputBatcher in
  // cosAgents.js — whose error handling is unit-tested in cosAgents.test.js).
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
vi.mock('./agents.js', () => ({
  registerSpawnedAgent: vi.fn(),
  unregisterSpawnedAgent: vi.fn(),
}));
vi.mock('./executionLanes.js', () => ({ release: vi.fn() }));
vi.mock('./toolStateMachine.js', () => ({
  completeExecution: vi.fn(),
  errorExecution: vi.fn(),
}));
vi.mock('./agentErrorAnalysis.js', () => ({ analyzeAgentFailure: vi.fn().mockResolvedValue(null) }));
vi.mock('./agentRunTracking.js', () => ({ completeAgentRun: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./agentLifecycle.js', () => ({
  finalizeAgent: vi.fn().mockResolvedValue(undefined),
  releaseAgentLane: vi.fn(),
}));
vi.mock('./agentState.js', () => ({
  activeAgents: new Map(),
  userTerminatedAgents: new Set(),
  pausedAgents: new Map(),
  metaStringOr: (value, fallback) => (typeof value === 'string' && value) ? value : fallback,
}));
vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  safeJSONParse: (str, fallback) => { try { return JSON.parse(str); } catch { return fallback; } },
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
vi.mock('../lib/bufferedSpawn.js', () => ({
  prepareCliSpawn: vi.fn((command, args) => ({ command, args })),
}));

// Mock child_process.spawn to return a controllable fake process
let fakeProcess;
vi.mock('child_process', () => ({
  spawn: vi.fn(() => fakeProcess),
  // `execFile` is pulled in transitively by codeReview.js → lmStudioManager
  // (via `resolveReviewLoopOptions`'s dependency graph), even though this
  // test never spawns one directly.
  execFile: vi.fn(),
}));

import { buildCliSpawnConfig, createStreamJsonParser, spawnDirectly } from './agentCliSpawning.js';
import { spawn } from 'child_process';
import { prepareCliSpawn } from '../lib/bufferedSpawn.js';

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
    expect(config.args).toEqual(['exec', '--dangerously-bypass-approvals-and-sandbox']);
  });

  it('passes explicit Codex model selections through alongside the sandbox bypass', () => {
    const config = buildCliSpawnConfig({ id: 'codex', command: 'codex' }, 'gpt-5.4');

    expect(config.args).toEqual(['exec', '--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-5.4']);
  });

  it('uses agy print mode for Antigravity without model flags', () => {
    const config = buildCliSpawnConfig({ id: 'antigravity-cli', command: 'agy', args: [] }, 'antigravity-configured-default');

    expect(config.command).toBe('agy');
    expect(config.args).toEqual(['--print', '--dangerously-skip-permissions']);
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
  function makeFakeProcess() {
    const proc = new EventEmitter();
    proc.pid = 12345;
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
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

  // Re-import the mocked cosAgents module reference once — mocking is module-scoped.
  let cosAgentsMocks;
  beforeEach(async () => {
    fakeProcess = makeFakeProcess();
    // Fresh mocked module reference for each test so mockRejectedValueOnce is clean.
    cosAgentsMocks = await import('./cosAgents.js');
    // Reset all implementations to their default "resolve" state before each test.
    cosAgentsMocks.updateAgent.mockResolvedValue(undefined);
    cosAgentsMocks.completeAgent.mockResolvedValue(undefined);
    cosAgentsMocks.appendAgentOutput.mockResolvedValue(undefined);
    cosAgentsMocks.appendAgentOutputLines.mockResolvedValue(undefined);
    (await import('./agentRunTracking.js')).completeAgentRun.mockResolvedValue(undefined);
    (await import('./agentLifecycle.js')).finalizeAgent.mockResolvedValue(undefined);
    minimalArgs.cleanupWorktreeFn.mockResolvedValue(undefined);
    // Reset the resolve+wrap helper to its POSIX passthrough before each test
    // (afterEach's restoreAllMocks can clear the factory implementation).
    vi.mocked(prepareCliSpawn).mockImplementation((command, args) => ({ command, args }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drains stdout output on close and a failed batch flush is logged, not leaked as an unhandled rejection', async () => {
    // stdout output is now batched: the data handler pushes lines to the output
    // batcher and the close handler drains it. Make the drain's state write fail
    // and assert the batcher swallows+logs it with a ❌ prefix — no escape.
    cosAgentsMocks.appendAgentOutputLines.mockRejectedValueOnce(new Error('db write failed'));

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

  it('drains stderr output on close and a failed batch flush is logged, not leaked as an unhandled rejection', async () => {
    cosAgentsMocks.appendAgentOutputLines.mockRejectedValueOnce(new Error('stderr db write failed'));

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

  describe('initialization timeout — 3-second phase transition', () => {
    it('calls updateAgent with working phase after 3s when agent has not started working', async () => {
      const { activeAgents } = await import('./agentState.js');
      const agents = cosAgentsMocks;

      const spawnPromise = spawnDirectly(minimalArgs);
      // Yield two microtask rounds so the getClaudeSettingsEnv await resolves and
      // the setTimeout is registered before we seed activeAgents.
      await new Promise((r) => setTimeout(r, 10));

      // Manually seed the activeAgents map so the guard inside the timeout passes.
      activeAgents.set(minimalArgs.agentId, { process: fakeProcess });

      // Wait past the 3-second threshold using real timers.
      await new Promise((r) => setTimeout(r, 3100));

      expect(agents.updateAgent).toHaveBeenCalledWith(
        minimalArgs.agentId,
        { metadata: { phase: 'working' } }
      );

      // Clean up: close the fake process so spawnDirectly can settle.
      activeAgents.delete(minimalArgs.agentId);
      fakeProcess.emit('close', 0);
      await spawnPromise.catch(() => {});
    }, 10000);

    it('does NOT crash when updateAgent rejects inside the timeout callback', async () => {
      const { activeAgents } = await import('./agentState.js');
      // spawnDirectly calls updateAgent once synchronously (PID update at line ~406)
      // before the 3-second setTimeout fires. Allow that first call to resolve
      // normally so spawnDirectly doesn't throw before the timeout test begins;
      // then reject the SECOND call (the phase-transition inside the timeout).
      cosAgentsMocks.updateAgent
        .mockResolvedValueOnce(undefined)     // PID update — let it pass
        .mockRejectedValueOnce(new Error('db write failed')); // timeout update — reject

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const unhandledRejections = [];
      const onUnhandled = (reason) => unhandledRejections.push(reason);
      process.on('unhandledRejection', onUnhandled);

      const spawnPromise = spawnDirectly(minimalArgs);
      await new Promise((r) => setTimeout(r, 10));

      activeAgents.set(minimalArgs.agentId, { process: fakeProcess });

      // Wait for the timeout to fire and its async body to finish.
      await new Promise((r) => setTimeout(r, 3100));

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
    }, 10000);
  });

  it('threads the ordered reviewers list (not a stale singular `reviewer`) into worktree cleanup', async () => {
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
    expect(opts.reviewerApplies).toBe(true);
    // The removed singular key must NOT be passed.
    expect(opts.reviewer).toBeUndefined();
  });
});
