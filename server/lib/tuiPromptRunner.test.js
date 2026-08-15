import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// executeTuiRun validates that a requested workspace actually exists before
// spawning (#3180 — a bad repoPath used to silently run in the PortOS root), so
// these tests need a real directory rather than a synthetic '/cwd' sentinel.
const TEST_WORKSPACE = process.cwd();

// node-pty + runner hooks are mocked so executeTuiRun can be driven
// synchronously from the test without spawning a real terminal. fileUtils
// stays real except for `ensureDir` (which would otherwise create real run
// directories the SUT never needs in these tests) and `tryReadFile` (which
// serves seeded response files from memory — see below). Mocks live
// inside vi.hoisted so the vi.mock factories (which are themselves hoisted
// to the top of the file) can reference them.
const { ptyInstances, ptySpawnMock, runnerMocks, shellMocks, runsTmpDirRef, responseFiles } = vi.hoisted(() => ({
  ptyInstances: [],
  ptySpawnMock: vi.fn(),
  runsTmpDirRef: { current: null },
  // Absolute response-file path → contents, for the runs driven under fake
  // timers (see the fileUtils mock below).
  responseFiles: new Map(),
  runnerMocks: {
    finalizeRunRecord: vi.fn(),
    emitRunStarted: vi.fn(),
    registerActiveRun: vi.fn(),
    unregisterActiveRun: vi.fn(),
    consumeRunStopRequested: vi.fn(() => false),
    getRunsPath: vi.fn(),
    // Real implementation (and its bad-workspace failure path) is covered by
    // lib/spawnCwd.test.js + services/runner.test.js; here it just needs to
    // hand back the cwd so the PTY spawn assertions below still see it.
    resolveRunCwd: vi.fn(async ({ workspacePath }) => ({ cwd: workspacePath })),
  },
  // shell.js is mocked so the runner's Shell-view registration is observable
  // here without dragging in the real session registry singleton.
  // isExternalSessionAttached defaults to "no viewer" so idle/timeout fire as
  // they would for an unattended pipeline run; tests flip it to assert the pause.
  shellMocks: {
    registerExternalSession: vi.fn(),
    unregisterExternalSession: vi.fn(),
    isExternalSessionAttached: vi.fn(() => false),
    // The run registers its own PTY as an external session, so a paste routed
    // through the session registry lands back on that PTY. Modelled faithfully
    // (bracketed paste, then the submit Enter, then an interval handle for the
    // caller to cancel) so assertions can read pty.write like the direct path.
    pasteToSession: vi.fn((_sessionId, text) => {
      const pty = ptyInstances[ptyInstances.length - 1];
      if (!pty) return false;
      pty.write(`\x1b[200~${text}\x1b[201~`);
      pty.write('\r');
      return setInterval(() => {}, 60000);
    }),
  },
}));
runnerMocks.getRunsPath.mockImplementation(() => runsTmpDirRef.current);

vi.mock('node-pty', () => ({ spawn: (...args) => ptySpawnMock(...args) }));
vi.mock('../services/runner.js', () => runnerMocks);
vi.mock('../services/shell.js', () => shellMocks);
vi.mock('./fileUtils.js', async () => {
  const actual = await vi.importActual('./fileUtils.js');
  // Imported here rather than relied on from the module scope: vi.mock
  // factories are hoisted above the import list.
  const { resolve: resolvePath } = await import('path');
  return {
    ...actual,
    ensureDir: vi.fn(async () => {}),
    // Response-file reads resolve from `responseFiles` when the test seeded
    // that path, and fall through to the real read otherwise (the
    // resolveTuiResponseText suite below drives real temp files directly).
    //
    // Why in-memory (#3874): executeTuiRun's size-stability window is polled
    // on a 1s interval that these suites drive with fake timers, but a REAL
    // `readFile` resolves on the libuv threadpool — advancing fake timers
    // does not wait for it. Under load a poll's read could land after the
    // test moved on, so the baseline was never seeded and the run took the
    // timeout/fallback path instead of the response-file path. A seeded read
    // settles as a microtask, which timer advancement always drains.
    // Keys are normalized on both sides so a relative or unnormalized path
    // from the SUT still hits the seeded entry rather than silently falling
    // through to a real (missing-file) read.
    //
    // The UNSEEDED reads under the runs dir have to be served from memory too,
    // for the same reason. Those are the polls that fire before a test seeds
    // its file; letting them hit the real threadpool means one can still be
    // in flight when the seed lands, and its late `null` resets the
    // size-stability baseline that the post-seed poll just established — so
    // the salvage path sees an unsettled file and finishes as a plain
    // fallback. That reproduces about one run in three. Everything outside the
    // runs dir still falls through: the resolveTuiResponseText suite below
    // drives real files in a temp dir of its own.
    tryReadFile: vi.fn(async (filePath, ...rest) => {
      const key = resolvePath(filePath);
      if (responseFiles.has(key)) return responseFiles.get(key);
      const runsDir = runsTmpDirRef.current;
      if (runsDir && key.startsWith(resolvePath(runsDir))) return null;
      return actual.tryReadFile(filePath, ...rest);
    }),
  };
});

import { cleanTuiResponse, resolveTuiResponseText, executeTuiRun } from './tuiPromptRunner.js';
import { markHostShuttingDown, resetHostShutdownFlagForTests } from './hostShutdown.js';
import { SELF_CLEARING_RESUBMIT_INTERVAL_MS, SELF_CLEARING_RESUBMIT_ECHO_MS, TUI_INPUT_READY_DEADLINE_MS } from './tuiHandshake.js';

const makeFakePty = () => {
  const fake = {
    _dataHandler: null,
    _exitHandler: null,
    killed: false,
    onData: vi.fn((fn) => { fake._dataHandler = fn; }),
    onExit: vi.fn((fn) => { fake._exitHandler = fn; }),
    write: vi.fn(),
    kill: vi.fn(() => { fake.killed = true; }),
    emitData: (chunk) => fake._dataHandler?.(chunk),
    emitExit: (payload) => fake._exitHandler?.(payload),
  };
  ptyInstances.push(fake);
  return fake;
};

const flushAsync = () => new Promise((res) => setImmediate(res));

// Stands in for "the model wrote its complete response to the file the runner
// directed it to" — same absolute path executeTuiRun derives (getRunsPath() →
// runId → tui-response.txt), served from memory so the read is deterministic
// under fake timers.
const seedResponseFile = (runId, text) => {
  responseFiles.set(resolve(runsTmpDirRef.current, runId, 'tui-response.txt'), text);
};

// Targeted coverage for the cleanTuiResponse helper — it shapes what every
// TUI-provider caller sees as the model response (paste-marker removal,
// prompt-echo strip). Bugs here would silently corrupt prose generation
// and JSON parsing downstream.

describe('cleanTuiResponse', () => {
  describe('empty / non-string inputs', () => {
    it('returns empty string for empty input', () => {
      expect(cleanTuiResponse('', 'anything')).toBe('');
    });
    it('returns empty string for non-string raw', () => {
      expect(cleanTuiResponse(null, 'anything')).toBe('');
      expect(cleanTuiResponse(undefined, 'anything')).toBe('');
      expect(cleanTuiResponse(42, 'anything')).toBe('');
    });
  });

  describe('paste-marker removal', () => {
    it('drops the Claude Code [Pasted text #N +M lines] marker', () => {
      const raw = 'before\n[Pasted text #1 +42 lines]\nresponse body';
      expect(cleanTuiResponse(raw, '')).toBe('before\n\nresponse body');
    });

    it('drops multiple paste markers from the same buffer', () => {
      const raw = '[Pasted text #1 +3 lines] reply A [Pasted text #2 +5 lines] reply B';
      expect(cleanTuiResponse(raw, '')).toBe('reply A  reply B');
    });

    it('leaves text that resembles but does not match the marker pattern alone', () => {
      const raw = 'Look at [Pasted text without number] and continue';
      expect(cleanTuiResponse(raw, '')).toBe('Look at [Pasted text without number] and continue');
    });
  });

  describe('prompt echo elision', () => {
    it('strips a verbatim prompt that the TUI echoes back', () => {
      const prompt = 'Write a sonnet about an ocelot wearing a crown of starlight';
      const raw = `${prompt}\n\nShall I compare thee to a summer's ocelot?`;
      expect(cleanTuiResponse(raw, prompt)).toBe(`Shall I compare thee to a summer's ocelot?`);
    });

    it('strips every echoed occurrence (some TUIs render the prompt twice)', () => {
      const prompt = 'Generate a six-word science fiction story about regret';
      const raw = `${prompt}\nresponse 1\n${prompt}\nresponse 2`;
      const out = cleanTuiResponse(raw, prompt);
      expect(out).not.toContain(prompt);
      expect(out).toContain('response 1');
      expect(out).toContain('response 2');
    });

    it('skips prompt-echo elision when the prompt is shorter than the 16-char guard', () => {
      // Short prompts could appear naturally inside the model's response
      // (e.g. prompt="ok" appearing in "okay, here is..."). The guard
      // keeps the response intact instead of mass-deleting bigrams.
      const prompt = 'Write?';
      const raw = `Write? Sure, here is my best Writeful Writeup`;
      expect(cleanTuiResponse(raw, prompt)).toBe(raw);
    });

    it('does NOT strip prompt-substring matches inside the response — only exact full-prompt matches', () => {
      // split-join uses the full prompt as the splitter, so a substring
      // of the prompt that appears in the model's reply survives. This
      // is the right behavior: a model often refers back to phrases
      // from the prompt without echoing the whole thing.
      const prompt = 'Continue the story: The cat sat on the mat';
      const raw = `${prompt}\nThe cat sat on the mat for many hours.`;
      const out = cleanTuiResponse(raw, prompt);
      // First occurrence (the full prompt echo) elided; the substring
      // reference in the reply is preserved.
      expect(out).toBe('The cat sat on the mat for many hours.');
    });

    it('handles undefined/non-string prompt without throwing', () => {
      expect(cleanTuiResponse('plain response', undefined)).toBe('plain response');
      expect(cleanTuiResponse('plain response', null)).toBe('plain response');
      expect(cleanTuiResponse('plain response', 12345)).toBe('plain response');
    });
  });

  describe('integration — marker + prompt + trim together', () => {
    it('removes paste marker AND prompt echo AND trims surrounding whitespace', () => {
      const prompt = 'Summarize the plot of Aster of Pan in a single sentence';
      const raw = `\n\n[Pasted text #7 +1 lines]\n${prompt}\n\nA child rebuilds wonder in a green ruin.\n\n`;
      expect(cleanTuiResponse(raw, prompt)).toBe('A child rebuilds wonder in a green ruin.');
    });
  });
});

// resolveTuiResponseText is the file-or-fallback chooser called from
// executeTuiRun.finish. The PTY path is irreplicable in a unit test, so the
// helper was extracted to make this decision (which is the actual new
// behavior of the PR) testable in isolation.

describe('resolveTuiResponseText', () => {
  let tmpDir;
  let responseFilePath;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tui-response-test-'));
    responseFilePath = join(tmpDir, 'tui-response.txt');
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => null);
  });

  it('returns the response file contents trimmed and flags usedResponseFile=true on success', async () => {
    await writeFile(responseFilePath, '\n  the prose body  \n');
    const out = await resolveTuiResponseText({
      success: true,
      responseFilePath,
      outputBuffer: 'screen chrome',
      wrappedPrompt: 'wrapped',
    });
    expect(out).toEqual({ text: 'the prose body', usedResponseFile: true });
  });

  it('falls back to cleanTuiResponse(outputBuffer) when the file does not exist', async () => {
    const out = await resolveTuiResponseText({
      success: true,
      responseFilePath: join(tmpDir, 'does-not-exist.txt'),
      outputBuffer: '[Pasted text #1 +0 lines]\nfallback body',
      wrappedPrompt: 'wrapped',
    });
    expect(out).toEqual({ text: 'fallback body', usedResponseFile: false });
  });

  it('falls back to cleanTuiResponse when the file exists but is empty', async () => {
    await writeFile(responseFilePath, '');
    const out = await resolveTuiResponseText({
      success: true,
      responseFilePath,
      outputBuffer: 'fallback body',
      wrappedPrompt: 'wrapped',
    });
    expect(out).toEqual({ text: 'fallback body', usedResponseFile: false });
  });

  it('falls back to cleanTuiResponse when the file is whitespace-only', async () => {
    await writeFile(responseFilePath, '   \n\t  \n');
    const out = await resolveTuiResponseText({
      success: true,
      responseFilePath,
      outputBuffer: 'fallback body',
      wrappedPrompt: 'wrapped',
    });
    expect(out).toEqual({ text: 'fallback body', usedResponseFile: false });
  });

  it('does NOT read the file when success=false — falls back unconditionally', async () => {
    // A failed run shouldn't trust a partial file the model may have started
    // writing. Even if the file exists with usable content, the caller
    // rejects with an error and the response text path doesn't matter much
    // — but the contract is: success=false ⇒ usedResponseFile=false.
    await writeFile(responseFilePath, 'partial response that should not be used');
    const out = await resolveTuiResponseText({
      success: false,
      responseFilePath,
      outputBuffer: 'partial screen scrape',
      wrappedPrompt: 'wrapped',
    });
    expect(out).toEqual({ text: 'partial screen scrape', usedResponseFile: false });
  });

  it('passes wrappedPrompt into cleanTuiResponse on the fallback path so prompt-echo elision strips the directive-wrapped prompt', async () => {
    const wrappedPrompt = 'WRITE TO FILE INSTRUCTIONS AND TASK BODY — a long enough string to clear the 16-char guard';
    const out = await resolveTuiResponseText({
      success: true,
      responseFilePath: join(tmpDir, 'absent.txt'),
      outputBuffer: `${wrappedPrompt}\nthe model reply`,
      wrappedPrompt,
    });
    expect(out).toEqual({ text: 'the model reply', usedResponseFile: false });
  });
});

// executeTuiRun owns the PTY lifecycle — spawn, ready-watch, paste, idle
// detection, hard timeout, command-not-found probe, exit/signal handling.
// The PTY is mocked so each behavior can be triggered deterministically
// from the test without spawning a real terminal.

describe('executeTuiRun', () => {
  beforeEach(async () => {
    runsTmpDirRef.current = await mkdtemp(join(tmpdir(), 'tui-runner-test-'));
    responseFiles.clear();
    ptyInstances.length = 0;
    ptySpawnMock.mockReset();
    ptySpawnMock.mockImplementation(() => makeFakePty());
    runnerMocks.finalizeRunRecord.mockReset();
    runnerMocks.finalizeRunRecord.mockImplementation(
      async ({ runId, output, exitCode, success, error, startTime, extras }) => ({
        runId,
        output,
        exitCode,
        success,
        error,
        duration: Date.now() - startTime,
        ...extras,
      }),
    );
    runnerMocks.emitRunStarted.mockClear();
    runnerMocks.registerActiveRun.mockClear();
    runnerMocks.unregisterActiveRun.mockClear();
    runnerMocks.consumeRunStopRequested.mockReset();
    runnerMocks.consumeRunStopRequested.mockReturnValue(false);
    runnerMocks.getRunsPath.mockClear();
    resetHostShutdownFlagForTests();
    shellMocks.registerExternalSession.mockClear();
    shellMocks.unregisterExternalSession.mockClear();
    shellMocks.isExternalSessionAttached.mockReset();
    shellMocks.isExternalSessionAttached.mockReturnValue(false);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.useRealTimers();
    resetHostShutdownFlagForTests();
    vi.restoreAllMocks();
    await rm(runsTmpDirRef.current, { recursive: true, force: true }).catch(() => null);
  });

  describe('input validation', () => {
    it('throws when provider is missing', async () => {
      await expect(executeTuiRun({ runId: 'run-x', provider: null, prompt: 'prompt', workspacePath: '/tmp' }))
        .rejects.toThrow(/provider is required/);
      expect(ptySpawnMock).not.toHaveBeenCalled();
    });

    it('throws when prompt is empty', async () => {
      const provider = { id: 'claude', type: 'tui', command: 'echo' };
      await expect(executeTuiRun({ runId: 'run-x', provider, prompt: '', workspacePath: '/tmp' }))
        .rejects.toThrow(/non-empty string/);
      expect(ptySpawnMock).not.toHaveBeenCalled();
    });

    it('throws when prompt is non-string', async () => {
      const provider = { id: 'claude', type: 'tui', command: 'echo' };
      await expect(executeTuiRun({ runId: 'run-x', provider, prompt: 12345, workspacePath: '/tmp' }))
        .rejects.toThrow(/non-empty string/);
    });
  });

  describe('spawn failure', () => {
    it('wraps node-pty spawn errors with the offending command name', async () => {
      ptySpawnMock.mockImplementation(() => { throw new Error('ENOENT'); });
      const provider = { id: 'codex', type: 'tui', command: 'nonexistent-cli' };
      await expect(executeTuiRun({ runId: 'run-x', provider, prompt: 'do thing', workspacePath: '/tmp' }))
        .rejects.toThrow(/Failed to spawn TUI 'nonexistent-cli': ENOENT/);
    });
  });

  describe('startup hooks', () => {
    it('disables Codex multi-agent fan-out for one-shot prompt runs', async () => {
      const provider = {
        id: 'codex-tui', type: 'tui', command: '/opt/homebrew/bin/codex', defaultModel: 'gpt-x',
      };
      const promise = executeTuiRun({
        runId: 'run-codex-one-shot', provider, prompt: 'return one structured response',
        workspacePath: TEST_WORKSPACE,
      });
      await flushAsync();

      const args = ptySpawnMock.mock.calls[0][1];
      expect(args).toContain('--disable');
      expect(args[args.indexOf('--disable') + 1]).toBe('multi_agent');

      ptyInstances[0].emitExit({ exitCode: 0 });
      await promise;
    });

    it('does not add Codex feature flags to other one-shot TUI providers', async () => {
      const provider = {
        id: 'claude-tui', type: 'tui', command: 'claude', defaultModel: 'claude-fable-5',
      };
      const promise = executeTuiRun({
        runId: 'run-claude-one-shot', provider, prompt: 'return one structured response',
        workspacePath: TEST_WORKSPACE,
      });
      await flushAsync();

      expect(ptySpawnMock.mock.calls[0][1]).not.toContain('--disable');

      ptyInstances[0].emitExit({ exitCode: 0 });
      await promise;
    });

    it('registers the PTY in the active-runs map and fires emitRunStarted with provider + defaultModel', async () => {
      const provider = {
        id: 'claude', type: 'tui', command: 'echo', defaultModel: 'claude-3.5',
      };
      const promise = executeTuiRun({ runId: 'run-A', provider, prompt: 'do thing big enough', workspacePath: TEST_WORKSPACE, onData: undefined, onComplete: undefined, timeout: 60000 });
      await flushAsync();

      expect(ptySpawnMock).toHaveBeenCalledTimes(1);
      const pty = ptyInstances[0];
      expect(runnerMocks.registerActiveRun).toHaveBeenCalledWith('run-A', pty);
      expect(runnerMocks.emitRunStarted).toHaveBeenCalledWith({
        runId: 'run-A',
        provider,
        model: 'claude-3.5',
      });

      // Drive a clean exit so the run-Promise resolves.
      pty.emitExit({ exitCode: 0 });
      await promise;
    });

    it('registers a read-only Shell view (labelled by source) and tears it down on finish', async () => {
      const provider = { id: 'claude', type: 'tui', command: 'claude', defaultModel: 'claude-fable-5' };
      const promise = executeTuiRun({
        runId: 'run-view', provider, prompt: 'review this manuscript', workspacePath: TEST_WORKSPACE,
        label: 'pipeline-manuscript-completeness',
      });
      await flushAsync();

      expect(shellMocks.registerExternalSession).toHaveBeenCalledWith(
        'run-view',
        ptyInstances[0],
        expect.objectContaining({
          label: 'pipeline-manuscript-completeness',
          kind: 'tui-run',
          cwd: TEST_WORKSPACE,
        }),
      );
      expect(shellMocks.unregisterExternalSession).not.toHaveBeenCalled();

      ptyInstances[0].emitExit({ exitCode: 0 });
      await promise;
      expect(shellMocks.unregisterExternalSession).toHaveBeenCalledWith('run-view', { exitCode: 0 });
    });

    it('falls back to a command·model label when no source label is supplied', async () => {
      const provider = { id: 'codex', type: 'tui', command: 'codex', defaultModel: 'gpt-x' };
      const promise = executeTuiRun({ runId: 'run-nolabel', provider, prompt: 'do the thing', workspacePath: TEST_WORKSPACE });
      await flushAsync();
      expect(shellMocks.registerExternalSession).toHaveBeenCalledWith(
        'run-nolabel', ptyInstances[0], expect.objectContaining({ label: 'codex · gpt-x' }),
      );
      ptyInstances[0].emitExit({ exitCode: 0 });
      await promise;
    });

    it('merges provider.envVars and strips CLAUDECODE from the child env so a nested Claude Code TUI is not detected as nested', async () => {
      // Save + restore the original value: a PortOS-inside-Claude-Code dev
      // run starts the worker with CLAUDECODE already set, and an
      // unconditional `delete` would clobber the test of a sibling test.
      const originalClaudecode = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDECODE')
        ? process.env.CLAUDECODE
        : undefined;
      process.env.CLAUDECODE = '1';
      try {
        const provider = {
          id: 'claude', type: 'tui', command: 'echo',
          envVars: { CUSTOM_PROVIDER_VAR: 'on' },
        };
        const promise = executeTuiRun({ runId: 'run-B', provider, prompt: 'p large enough to clear the guard', workspacePath: TEST_WORKSPACE, onData: undefined, onComplete: undefined, timeout: 60000 });
        await flushAsync();

        const env = ptySpawnMock.mock.calls[0][2].env;
        expect(env.CLAUDECODE).toBeUndefined();
        expect(env.CUSTOM_PROVIDER_VAR).toBe('on');
        expect(env.TERM).toBe('xterm-256color');
        expect(env.COLORTERM).toBe('truecolor');

        ptyInstances[0].emitExit({ exitCode: 0 });
        await promise;
      } finally {
        if (originalClaudecode === undefined) delete process.env.CLAUDECODE;
        else process.env.CLAUDECODE = originalClaudecode;
      }
    });
  });

  describe('startup dialogs', () => {
    it('confirms the Claude folder-trust gate and waits for input readiness before pasting', async () => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      const provider = { id: 'claude', type: 'tui', command: 'claude', tuiPromptDelayMs: 50 };
      const promise = executeTuiRun({
        runId: 'run-claude-trust-gate', provider, prompt: 'return one structured response',
        workspacePath: TEST_WORKSPACE, timeout: 60000,
      });
      await flushAsync();

      const pty = ptyInstances[0];
      pty.emitData('Is this a project you trust?\n1. Yes, I trust this folder\n2. No, exit\n');
      await vi.advanceTimersByTimeAsync(400);

      expect(pty.write).toHaveBeenCalledWith('\r');
      expect(pty.write).not.toHaveBeenCalledWith(expect.stringContaining('\x1b[200~'));

      // A blind fallback must not paste into a known startup dialog.
      await vi.advanceTimersByTimeAsync(11000);
      expect(pty.write).not.toHaveBeenCalledWith(expect.stringContaining('\x1b[200~'));

      // Claude's own bracketed-paste mode is the positive direct-PTY signal.
      // node-pty may split its raw control sequence across callbacks.
      pty.emitData('\x1b[?2004');
      pty.emitData('h');
      await vi.advanceTimersByTimeAsync(400);
      expect(pty.write).toHaveBeenCalledWith(expect.stringContaining('\x1b[200~'));

      pty.emitExit({ exitCode: 0 });
      await promise;
    });

    it('declines Claude auto-mode and pastes only after dismissing the offer', async () => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      const provider = { id: 'claude', type: 'tui', command: 'claude', tuiPromptDelayMs: 50 };
      const promise = executeTuiRun({
        runId: 'run-claude-auto-mode', provider, prompt: 'return one structured response',
        workspacePath: TEST_WORKSPACE, timeout: 60000,
      });
      await flushAsync();

      const pty = ptyInstances[0];
      pty.emitData(
        '\x1b[?2004hMake auto mode your default permission mode?\n'
        + '1. Yes, set auto mode as my default permission mode\n'
        + "2. No, keep don't ask\n",
      );
      await vi.advanceTimersByTimeAsync(400);

      expect(pty.write).toHaveBeenCalledWith('\x1b[B\r');
      expect(pty.write).not.toHaveBeenCalledWith(expect.stringContaining('\x1b[200~'));

      await vi.advanceTimersByTimeAsync(400);
      expect(pty.write).toHaveBeenCalledWith(expect.stringContaining('\x1b[200~'));

      pty.emitExit({ exitCode: 0 });
      await promise;
    });

    it('keeps non-Claude TUIs on the existing idle fallback when startup output resembles Claude trust text', async () => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      const provider = { id: 'opencode', type: 'tui', command: 'opencode', tuiPromptDelayMs: 50 };
      const promise = executeTuiRun({
        runId: 'run-non-claude-trust-text', provider, prompt: 'return one structured response',
        workspacePath: TEST_WORKSPACE, timeout: 60000,
      });
      await flushAsync();

      const pty = ptyInstances[0];
      pty.emitData('Is this a project you trust?\n1. Yes, I trust this folder\n2. No, exit\n');
      await vi.advanceTimersByTimeAsync(2000);

      expect(pty.write).not.toHaveBeenCalledWith('\r');
      expect(pty.write).toHaveBeenCalledWith(expect.stringContaining('\x1b[200~'));

      pty.emitExit({ exitCode: 0 });
      await promise;
    });

    it('fails Claude startup after its input-readiness deadline instead of blind-pasting', async () => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      const provider = { id: 'claude', type: 'tui', command: 'claude', tuiPromptDelayMs: 50 };
      const runId = 'run-claude-not-ready';
      const promise = executeTuiRun({
        runId, provider, prompt: 'return one structured response',
        workspacePath: TEST_WORKSPACE, timeout: 60000,
      });
      await flushAsync();

      ptyInstances[0].emitData('Claude Code is still starting\n');
      await vi.advanceTimersByTimeAsync(TUI_INPUT_READY_DEADLINE_MS + 500);
      await promise;

      expect(ptyInstances[0].write).not.toHaveBeenCalledWith(expect.stringContaining('\x1b[200~'));
      expect(runnerMocks.finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({
        runId,
        success: false,
        exitCode: 1,
        error: expect.stringContaining('did not present an input prompt'),
        extras: expect.objectContaining({ completionReason: 'tui-not-ready' }),
      }));
    });
  });

  describe('completion paths', () => {
    it('finishes with reason "idle-complete" once output stays idle past tuiOneShotIdleMs after the first response chunk', async () => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      const provider = {
        id: 'claude', type: 'tui', command: 'echo',
        tuiPromptDelayMs: 50, tuiOneShotIdleMs: 500,
      };
      const onComplete = vi.fn();
      const promise = executeTuiRun({ runId: 'run-idle', provider, prompt: 'do thing big enough to clear the prompt guard', workspacePath: TEST_WORKSPACE, onData: undefined, onComplete, timeout: 60000 });
      await flushAsync();

      const pty = ptyInstances[0];

      // Banner output establishes firstOutputAt so the ready-watch can fire.
      pty.emitData('claude code ready> ');

      // Past tuiPromptDelayMs (50) + READY_IDLE_THRESHOLD_MS (1200) + readyTimer poll.
      await vi.advanceTimersByTimeAsync(2000);
      expect(pty.write).toHaveBeenCalledWith(expect.stringContaining('\x1b[200~'));

      // Past PASTE_TO_ENTER_FALLBACK_MS (3500) → '\r' submitted.
      await vi.advanceTimersByTimeAsync(4000);
      expect(pty.write).toHaveBeenCalledWith('\r');

      // First post-paste chunk arms idleWatchTimer (ticks every 1000ms).
      pty.emitData('model response chunk');
      await vi.advanceTimersByTimeAsync(1100);
      await flushAsync();

      await promise;
      expect(runnerMocks.unregisterActiveRun).toHaveBeenCalledWith('run-idle');
      expect(runnerMocks.finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-idle',
        success: true,
        exitCode: 0,
        extras: expect.objectContaining({ completionReason: 'idle-complete' }),
      }));
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        exitCode: 0,
      }));
    });

    it('does not reap a quiet Codex reasoning pass before its response file exists', async () => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      const provider = {
        id: 'codex-tui', type: 'tui', command: 'codex',
        tuiPromptDelayMs: 50, tuiOneShotIdleMs: 500,
      };
      const runId = 'run-codex-quiet-reasoning';
      const promise = executeTuiRun({
        runId,
        provider,
        prompt: 'reason carefully and write the complete structured response',
        workspacePath: TEST_WORKSPACE,
        timeout: 60000,
      });
      await flushAsync();

      const pty = ptyInstances[0];
      pty.emitData('OpenAI Codex ready> ');
      await vi.advanceTimersByTimeAsync(2000); // paste
      await vi.advanceTimersByTimeAsync(4000); // enter
      pty.emitData('Working (0s • esc to interrupt)');

      // This is well beyond the configured 500ms idle fallback. A generic TUI
      // would have completed from its screen scrape, but Codex is still doing
      // real work and has not written the authoritative response yet.
      await vi.advanceTimersByTimeAsync(5000);
      await flushAsync();
      expect(runnerMocks.finalizeRunRecord).not.toHaveBeenCalled();

      seedResponseFile(runId, '{"repaired":true}');
      await vi.advanceTimersByTimeAsync(1100);
      await vi.advanceTimersByTimeAsync(1100);
      await flushAsync();
      await promise;

      expect(runnerMocks.finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({
        runId,
        success: true,
        output: '{"repaired":true}',
        extras: expect.objectContaining({
          completionReason: 'response-file',
          usedResponseFile: true,
        }),
      }));
    });

    it('does NOT idle-complete while a Shell viewer is attached, then completes once they detach', async () => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      // A human is watching this run in the Shell page.
      shellMocks.isExternalSessionAttached.mockReturnValue(true);
      const provider = {
        id: 'claude', type: 'tui', command: 'echo',
        tuiPromptDelayMs: 50, tuiOneShotIdleMs: 500,
      };
      const onComplete = vi.fn();
      const promise = executeTuiRun({ runId: 'run-watched', provider, prompt: 'do thing big enough to clear the prompt guard', workspacePath: TEST_WORKSPACE, onComplete, timeout: 60000 });
      await flushAsync();

      const pty = ptyInstances[0];
      pty.emitData('claude code ready> ');
      await vi.advanceTimersByTimeAsync(2000); // paste
      await vi.advanceTimersByTimeAsync(4000); // enter
      pty.emitData('model response chunk');     // arms idleWatchTimer

      // Idle well past the threshold — but a viewer is attached, so the run must
      // NOT auto-complete.
      await vi.advanceTimersByTimeAsync(5000);
      await flushAsync();
      expect(onComplete).not.toHaveBeenCalled();
      expect(runnerMocks.unregisterActiveRun).not.toHaveBeenCalled();

      // Viewer detaches → next idle tick completes the run normally.
      shellMocks.isExternalSessionAttached.mockReturnValue(false);
      await vi.advanceTimersByTimeAsync(1100);
      await flushAsync();
      await promise;
      expect(runnerMocks.finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-watched',
        success: true,
        extras: expect.objectContaining({ completionReason: 'idle-complete' }),
      }));
    });

    it('completes with reason "response-file" once the model writes its response file — even while a viewer is attached', async () => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      // A human is watching — idle-completion is paused, but the response file
      // is the model's explicit "done" signal and must complete regardless.
      // This is the regression guard for the manuscript-completeness run that
      // wrote tui-response.txt yet rode to the hard timeout because it was watched.
      shellMocks.isExternalSessionAttached.mockReturnValue(true);
      const provider = {
        id: 'claude', type: 'tui', command: 'claude',
        tuiPromptDelayMs: 50, tuiOneShotIdleMs: 500,
      };
      const runId = 'run-respfile';
      const promise = executeTuiRun({ runId, provider, prompt: 'review this manuscript thoroughly enough to clear the guard', workspacePath: TEST_WORKSPACE, timeout: 60000 });
      await flushAsync();

      const pty = ptyInstances[0];
      pty.emitData('\x1b[?2004hclaude code ready> ');
      await vi.advanceTimersByTimeAsync(2000); // paste
      await vi.advanceTimersByTimeAsync(4000); // enter
      pty.emitData('model thinking…');          // arms idleWatchTimer

      // The model writes its COMPLETE response to the file the runner directed
      // it to (and, like Claude Code's TUI, does NOT exit afterward).
      seedResponseFile(runId, '{"issues":[]}');

      // First tick seeds the size-stability baseline; the second confirms it.
      await vi.advanceTimersByTimeAsync(1100);
      await vi.advanceTimersByTimeAsync(1100);
      await flushAsync();
      await promise;

      expect(runnerMocks.finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({
        runId,
        success: true,
        exitCode: 0,
        output: '{"issues":[]}',
        extras: expect.objectContaining({ completionReason: 'response-file', usedResponseFile: true }),
      }));
    });

    it('completes via the response file even when the TUI emits NO post-paste output (watcher is not gated on streamed output)', async () => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      // Regression guard: the response-file watcher must run independently of
      // idleWatchTimer (which only arms after the first POST-PASTE output chunk).
      // A model that writes its file silently would otherwise hang until the
      // hard-timeout salvage despite the result already being on disk.
      const provider = { id: 'claude', type: 'tui', command: 'claude', tuiPromptDelayMs: 50 };
      const runId = 'run-silent-respfile';
      const promise = executeTuiRun({ runId, provider, prompt: 'do the task quietly then write the file', workspacePath: TEST_WORKSPACE, timeout: 60000 });
      await flushAsync();

      const pty = ptyInstances[0];
      // Pre-paste banner lets the ready-watch paste — but NOTHING is emitted
      // after the paste, so idleWatchTimer never arms.
      pty.emitData('\x1b[?2004hclaude code ready> ');
      await vi.advanceTimersByTimeAsync(2000); // ready-watch pastes → response-file watcher starts
      await vi.advanceTimersByTimeAsync(4000); // enter submitted; still zero post-paste output

      seedResponseFile(runId, 'silent result body');

      await vi.advanceTimersByTimeAsync(1100); // poll 1: seed baseline
      await vi.advanceTimersByTimeAsync(1100); // poll 2: stable → complete
      await flushAsync();
      await promise;

      // Completed long before the 60s hard timeout, with no idle output to lean on.
      expect(runnerMocks.finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({
        runId,
        success: true,
        exitCode: 0,
        output: 'silent result body',
        extras: expect.objectContaining({ completionReason: 'response-file', usedResponseFile: true }),
      }));
    });

    it('salvages the response file on hard timeout → success with reason "timeout-response-file" instead of a false failure + fallback', async () => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      const provider = { id: 'claude', type: 'tui', command: 'echo' };
      const runId = 'run-tmo-salvage';
      // The model finished and wrote its file, but the TUI never exited and the
      // idle watcher was never armed (no post-paste chunk) — so only the hard
      // timeout remains to terminate the run. It must NOT throw the result away.
      seedResponseFile(runId, 'the completed review body');

      const promise = executeTuiRun({ runId, provider, prompt: 'a prompt long enough to clear the guard', workspacePath: TEST_WORKSPACE, timeout: 500 });
      await flushAsync();
      await vi.advanceTimersByTimeAsync(600); // hard timeout fires
      await flushAsync();
      await promise;

      expect(runnerMocks.finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({
        runId,
        success: true,
        exitCode: 0,
        output: 'the completed review body',
        extras: expect.objectContaining({ completionReason: 'timeout-response-file', usedResponseFile: true }),
      }));
    });

    it('finishes with reason "timeout" and exitCode 124 when the hard timeout fires before any completion', async () => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      const provider = { id: 'claude', type: 'tui', command: 'echo' };
      const promise = executeTuiRun({ runId: 'run-timeout', provider, prompt: 'a prompt long enough to clear the guard', workspacePath: TEST_WORKSPACE, onData: undefined, onComplete: undefined, timeout: 500 });
      await flushAsync();

      // No data emitted → no firstOutputAt → ready-watch never triggers paste
      // before the (short) hard timeout fires.
      await vi.advanceTimersByTimeAsync(600);
      await flushAsync();

      await promise;
      expect(runnerMocks.finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-timeout',
        success: false,
        exitCode: 124,
        error: expect.stringContaining('timed out'),
        extras: expect.objectContaining({ completionReason: 'timeout' }),
      }));
      // PTY was killed by finish() as part of cleanup.
      expect(ptyInstances[0].kill).toHaveBeenCalled();
    });

    it('still hard-times-out a watched run (the backstop is not paused while attached)', async () => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      shellMocks.isExternalSessionAttached.mockReturnValue(true); // a viewer is watching
      const provider = { id: 'claude', type: 'tui', command: 'echo' };
      const promise = executeTuiRun({ runId: 'run-tmo-watched', provider, prompt: 'a prompt long enough to clear the guard', workspacePath: TEST_WORKSPACE, timeout: 500 });
      await flushAsync();

      // The hard timeout fires even though a viewer is attached — only idle
      // auto-completion is paused while watched, not the max-time backstop.
      await vi.advanceTimersByTimeAsync(600);
      await flushAsync();
      await promise;
      expect(runnerMocks.finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-tmo-watched',
        success: false,
        exitCode: 124,
        extras: expect.objectContaining({ completionReason: 'timeout' }),
      }));
    });

    it('early-fails with reason "command-not-found" and exitCode 127 when "command not found" appears pre-paste', async () => {
      const provider = { id: 'codex', type: 'tui', command: 'no-such-tui' };
      const promise = executeTuiRun({ runId: 'run-missing', provider, prompt: 'a prompt long enough', workspacePath: TEST_WORKSPACE, onData: undefined, onComplete: undefined, timeout: 60000 });
      await flushAsync();

      // Shell banner echoing the missing-command error before paste.
      ptyInstances[0].emitData('zsh: command not found: no-such-tui');

      await promise;
      expect(runnerMocks.finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-missing',
        success: false,
        exitCode: 127,
        error: expect.stringContaining('TUI command not found: no-such-tui'),
        extras: expect.objectContaining({ completionReason: 'command-not-found' }),
      }));
    });

    it('early-fails with reason "fallback-signal" when Claude switches to extra usage', async () => {
      const provider = { id: 'claude', type: 'tui', command: 'claude' };
      const onComplete = vi.fn();
      const promise = executeTuiRun({ runId: 'run-extra-usage', provider, prompt: 'a prompt long enough', workspacePath: TEST_WORKSPACE, onData: undefined, onComplete, timeout: 60000 });
      await flushAsync();

      ptyInstances[0].emitData('Now using extra ');
      expect(ptyInstances[0].kill).not.toHaveBeenCalled();
      ptyInstances[0].emitData('usage\n');

      await promise;
      expect(ptyInstances[0].kill).toHaveBeenCalled();
      expect(runnerMocks.finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-extra-usage',
        success: false,
        exitCode: 1,
        error: expect.stringContaining('Now using extra usage'),
        extras: expect.objectContaining({ completionReason: 'fallback-signal' }),
      }));
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.stringContaining('Now using extra usage'),
        completionReason: 'fallback-signal',
      }));
    });

    // ── agy account-eligibility banner: a WAIT, not a verdict ─────────────────
    // The banner paints while agy's `loadCodeAssist` handshake is still retrying
    // and the CLI generates normally once it settles, so a self-clearing signal
    // arms a grace window instead of killing the PTY on sight.
    const ELIGIBILITY_BANNER =
      "We're finishing verifying your account eligibility. This usually takes a moment. Please try again shortly.";

    it('holds a run open for the eligibility banner and resumes when agy starts generating', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
      const provider = { id: 'antigravity', type: 'tui', command: 'agy', tuiPromptDelayMs: 50, tuiOneShotIdleMs: 500 };
      const onComplete = vi.fn();
      const promise = executeTuiRun({ runId: 'run-eligibility-ok', provider, prompt: 'do thing big enough to clear the prompt guard', workspacePath: TEST_WORKSPACE, onData: undefined, onComplete, timeout: 600000 });
      await flushAsync();

      const pty = ptyInstances[0];
      pty.emitData(ELIGIBILITY_BANNER);
      await vi.advanceTimersByTimeAsync(5000);
      // The old behavior killed the PTY within a second of the banner.
      expect(pty.kill).not.toHaveBeenCalled();

      // agy settles its handshake and paints its in-flight chrome.
      pty.emitData('Generating...\nesc to cancel');
      await vi.advanceTimersByTimeAsync(70000);
      await flushAsync();

      expect(runnerMocks.finalizeRunRecord).not.toHaveBeenCalledWith(expect.objectContaining({
        extras: expect.objectContaining({ completionReason: 'fallback-signal' }),
      }));
      vi.useRealTimers();
      pty.emitExit(0);
      await promise;
    });

    // The banner is the REJECTION of the submission — agy discards the prompt and
    // returns to an empty, idle composer — so a PASSIVE window can never see the
    // generation chrome it waits for, and its only reachable outcome is expiry.
    // Re-asking is both the only way out and what the banner itself instructs.
    it('re-submits the prompt while the eligibility window is open', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
      const provider = { id: 'antigravity', type: 'tui', command: 'agy', tuiPromptDelayMs: 50, tuiOneShotIdleMs: 500 };
      const prompt = 'do thing big enough to clear the prompt guard';
      const promise = executeTuiRun({ runId: 'run-eligibility-retry', provider, prompt, workspacePath: TEST_WORKSPACE, onData: undefined, onComplete: vi.fn(), timeout: 600000 });
      await flushAsync();

      const pty = ptyInstances[0];
      pty.emitData('agy ready> ');
      await vi.advanceTimersByTimeAsync(5000); // first delivery
      const pastes = () => pty.write.mock.calls.filter(([chunk]) => String(chunk).includes(prompt)).length;
      expect(pastes()).toBe(1);

      pty.emitData(ELIGIBILITY_BANNER);
      pty.emitData('> ? for shortcuts');
      await vi.advanceTimersByTimeAsync(SELF_CLEARING_RESUBMIT_INTERVAL_MS + 1000);
      await flushAsync();
      expect(pastes()).toBe(2);
      expect(pty.write).toHaveBeenCalledWith('\r');

      // …and it stops re-asking the moment agy actually answers. The first
      // repaint lands inside the echo window and is discounted (it could be the
      // prompt we just pasted echoing back); agy repaints continuously, so the
      // next one is what closes the window.
      pty.emitData('Generating...');
      await vi.advanceTimersByTimeAsync(SELF_CLEARING_RESUBMIT_ECHO_MS);
      pty.emitData('Generating...');
      await vi.advanceTimersByTimeAsync(3 * SELF_CLEARING_RESUBMIT_INTERVAL_MS);
      await flushAsync();
      expect(pastes()).toBe(2);

      vi.useRealTimers();
      pty.emitExit(0);
      await promise;
    });

    it('falls back once the eligibility banner outlasts its grace window with no generation', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
      const provider = { id: 'antigravity', type: 'tui', command: 'agy', tuiPromptDelayMs: 50, tuiOneShotIdleMs: 500 };
      const onComplete = vi.fn();
      const promise = executeTuiRun({ runId: 'run-eligibility-stuck', provider, prompt: 'do thing big enough to clear the prompt guard', workspacePath: TEST_WORKSPACE, onData: undefined, onComplete, timeout: 600000 });
      await flushAsync();

      const pty = ptyInstances[0];
      pty.emitData(ELIGIBILITY_BANNER);
      // Only idle composer chrome repaints — no sign of life. Notably this must
      // NOT idle-complete as success and scrape the banner as the response.
      pty.emitData('> ? for shortcuts');
      // Past the full grace window — every re-submission inside it went
      // unanswered too, so the fail-over is the correct verdict.
      await vi.advanceTimersByTimeAsync(130000);
      await flushAsync();

      await promise;
      expect(runnerMocks.finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-eligibility-stuck',
        success: false,
        exitCode: 1,
        error: expect.stringContaining('account eligibility'),
        extras: expect.objectContaining({ completionReason: 'fallback-signal' }),
      }));
    });

    it('early-fails with reason "fallback-signal" when the model id is rejected (Bedrock invalid identifier) instead of idling to a bogus-scrape success', async () => {
      const provider = { id: 'claude', type: 'tui', command: 'claude' };
      const onComplete = vi.fn();
      const promise = executeTuiRun({ runId: 'run-bad-model', provider, prompt: 'a prompt long enough', workspacePath: TEST_WORKSPACE, onData: undefined, onComplete, timeout: 60000 });
      await flushAsync();

      // Claude Code renders the terminal model-id rejection inline and then sits
      // idle — without the early-fail signal this would idle-complete as success
      // and scrape the error screen as the "response".
      ptyInstances[0].emitData('⏺ API Error (claude-opus-4-8): 400 The provided model identifier is invalid.. Try /model to switch to us.anthropic.claude-opus-4-1-20250805-v1:0.\n');

      await promise;
      expect(ptyInstances[0].kill).toHaveBeenCalled();
      expect(runnerMocks.finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-bad-model',
        success: false,
        exitCode: 1,
        error: expect.stringContaining('model identifier is invalid'),
        extras: expect.objectContaining({ completionReason: 'fallback-signal' }),
      }));
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        completionReason: 'fallback-signal',
      }));
    });

    it('fails as a timeout after Claude exhausts its internal request retries instead of parsing the error screen as output', async () => {
      const provider = { id: 'claude', type: 'tui', command: 'claude' };
      const onComplete = vi.fn();
      const promise = executeTuiRun({ runId: 'run-request-timeout', provider, prompt: 'a prompt long enough', workspacePath: TEST_WORKSPACE, onData: undefined, onComplete, timeout: 60000 });
      await flushAsync();

      // Retry banners are recoverable and must not be interrupted. The final
      // gutter-owned line is what Claude Code shows only after retry 10/10.
      ptyInstances[0].emitData('⎿ Request timed out · Retrying in 38s · attempt 9/10\n');
      expect(ptyInstances[0].kill).not.toHaveBeenCalled();
      ptyInstances[0].emitData('  ⎿\u00a0Requesttimedout\n');

      await promise;
      expect(ptyInstances[0].kill).toHaveBeenCalled();
      expect(runnerMocks.finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-request-timeout',
        success: false,
        exitCode: 124,
        error: expect.stringContaining('timed out'),
        extras: expect.objectContaining({ completionReason: 'fallback-signal' }),
      }));
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        exitCode: 124,
        completionReason: 'fallback-signal',
      }));
    });

    it('keeps retrying when a PTY chunk boundary splits the retry banner right after "Request timed out"', async () => {
      const provider = { id: 'claude', type: 'tui', command: 'claude' };
      const promise = executeTuiRun({ runId: 'run-split-retry', provider, prompt: 'a prompt long enough', workspacePath: TEST_WORKSPACE, timeout: 60000 });
      await flushAsync();

      const pty = ptyInstances[0];
      // Ink repaints the countdown on every tick and the tty delivers those
      // frames in sub-frame chunks, so a split inside the ~30-char window
      // between "out" and " · Retrying" is routine. Before #3715 this first
      // chunk ALONE finalized the run as exitCode 124 and burned a fallback
      // tier — killing the retry sequence the detector exists to protect.
      pty.emitData('  ⎿ Request timed out');
      await flushAsync();
      expect(pty.kill).not.toHaveBeenCalled();
      expect(runnerMocks.finalizeRunRecord).not.toHaveBeenCalled();

      pty.emitData(' · Retrying in 38s · attempt 3/10\n');
      await flushAsync();
      expect(pty.kill).not.toHaveBeenCalled();
      expect(runnerMocks.finalizeRunRecord).not.toHaveBeenCalled();

      // Retries do eventually exhaust — the genuinely terminal banner (its own
      // complete line) must still fail the run.
      pty.emitData('  ⎿ Request timed out\n');
      await promise;
      expect(runnerMocks.finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-split-retry',
        success: false,
        exitCode: 124,
        extras: expect.objectContaining({ completionReason: 'fallback-signal' }),
      }));
    });

    it('flushes a held terminal banner at PTY exit rather than scraping the error screen as a success', async () => {
      const provider = { id: 'claude', type: 'tui', command: 'claude' };
      const promise = executeTuiRun({ runId: 'run-exit-timeout', provider, prompt: 'a prompt long enough', workspacePath: TEST_WORKSPACE, timeout: 60000 });
      await flushAsync();

      const pty = ptyInstances[0];
      // No terminator yet, so the candidate is held rather than acted on.
      pty.emitData('  ⎿ Request timed out');
      await flushAsync();
      expect(runnerMocks.finalizeRunRecord).not.toHaveBeenCalled();

      // Claude Code exits 0 with the error screen still up. Process exit is the
      // terminator the held candidate was waiting for.
      pty.emitExit({ exitCode: 0, signal: undefined });
      await promise;
      expect(runnerMocks.finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-exit-timeout',
        success: false,
        exitCode: 124,
        extras: expect.objectContaining({ completionReason: 'fallback-signal' }),
      }));
    });

    it('salvages a settled response file when a fallback signal paints inside the size-stability window', async () => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      const provider = { id: 'claude', type: 'tui', command: 'claude', tuiPromptDelayMs: 50 };
      const runId = 'run-signal-salvage';
      const promise = executeTuiRun({ runId, provider, prompt: 'write the review then finish up properly', workspacePath: TEST_WORKSPACE, timeout: 60000 });
      await flushAsync();

      const pty = ptyInstances[0];
      pty.emitData('\x1b[?2004hclaude code ready> ');
      await vi.advanceTimersByTimeAsync(2000); // paste → response-file watcher armed
      await vi.advanceTimersByTimeAsync(4000); // enter

      seedResponseFile(runId, 'the finished review body');
      // Poll 1 only seeds the size-stability baseline — the run is NOT finalized
      // yet even though the complete answer is already on disk.
      await vi.advanceTimersByTimeAsync(1100);
      // Let the async interval callback commit its baseline before racing it
      // against the fallback signal below on a loaded CI worker.
      await flushAsync();
      expect(runnerMocks.finalizeRunRecord).not.toHaveBeenCalled();

      // A follow-up provider request times out and paints the terminal banner
      // inside that ≥1s window. Failing here would discard the finished
      // response (resolveTuiResponseText only reads the file on success) and
      // re-run an expensive stage on a fallback provider.
      pty.emitData('\n  ⎿ Request timed out\n');
      await flushAsync();
      await promise;

      expect(runnerMocks.finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({
        runId,
        success: true,
        exitCode: 0,
        output: 'the finished review body',
        extras: expect.objectContaining({
          completionReason: 'fallback-signal-response-file',
          usedResponseFile: true,
        }),
      }));
    });

    it('finishes with reason "exit" + exitCode 0 when the PTY closes cleanly', async () => {
      const provider = { id: 'claude', type: 'tui', command: 'echo' };
      const promise = executeTuiRun({ runId: 'run-exit', provider, prompt: 'a prompt long enough', workspacePath: TEST_WORKSPACE, onData: undefined, onComplete: undefined, timeout: 60000 });
      await flushAsync();

      ptyInstances[0].emitExit({ exitCode: 0 });

      await promise;
      expect(runnerMocks.finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-exit',
        success: true,
        exitCode: 0,
        error: null,
        extras: expect.objectContaining({ completionReason: 'exit' }),
      }));
    });

    it('still resolves the run promise exactly once when a step inside finish() throws synchronously', async () => {
      // unregisterExternalSession is invoked un-awaited inside finish()'s try
      // block, with no per-call try/catch of its own — unlike the PTY kill
      // (own try/catch) and finalizeRunRecord (own .catch()). If it throws,
      // finish()'s outer try/catch/finally must still guarantee `resolve()`
      // fires — otherwise executeTuiRun's promise hangs forever and any
      // caller awaiting it (pipeline stages, /runs) wedges.
      shellMocks.unregisterExternalSession.mockImplementationOnce(() => {
        throw new Error('boom: session registry corrupted');
      });
      const provider = { id: 'claude', type: 'tui', command: 'echo' };
      const onComplete = vi.fn();
      const promise = executeTuiRun({ runId: 'run-finish-throws', provider, prompt: 'a prompt long enough', workspacePath: TEST_WORKSPACE, onComplete, timeout: 60000 });
      await flushAsync();

      ptyInstances[0].emitExit({ exitCode: 0 });

      await expect(promise).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('finish() failed'));
      // The throw happens before onComplete is reached in finish()'s normal
      // path, but resolving the inner promise alone is not enough: the sole
      // caller (executeProviderRunOnce) settles its OUTER promise only via
      // onComplete (→ safeReject) or a rejected promise. Since finish() always
      // resolves, the catch must still surface the failure through onComplete
      // with failure metadata, or the pipeline/central-prompt caller hangs
      // forever despite the inner promise settling.
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.stringContaining('finish() failed'),
      }));
      expect(onComplete).toHaveBeenCalledTimes(1);
      // The PTY must still be torn down on the throw path — the failure we
      // report spins up a fallback provider in the real caller, and a
      // never-killed original PTY would run alongside it (two live runs).
      expect(ptyInstances[0].kill).toHaveBeenCalled();
    });

    it('does not re-invoke onComplete when onComplete itself throws inside finish()', async () => {
      // When the throw source is onComplete AFTER it has already been reached,
      // the catch must NOT call onComplete a second time — that would violate
      // the once-only completion contract and could emit a contradictory
      // success-then-failure. The run promise must still resolve exactly once.
      const provider = { id: 'claude', type: 'tui', command: 'echo' };
      const onComplete = vi.fn(() => { throw new Error('boom: caller onComplete blew up'); });
      const promise = executeTuiRun({ runId: 'run-oncomplete-throws', provider, prompt: 'a prompt long enough', workspacePath: TEST_WORKSPACE, onComplete, timeout: 60000 });
      await flushAsync();

      ptyInstances[0].emitExit({ exitCode: 0 });

      await expect(promise).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('finish() failed'));
      // Reached exactly once (the normal-path call), never re-invoked by the catch.
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it('finishes with reason "killed" and surfaces the signal in the error when the PTY is terminated', async () => {
      const provider = { id: 'claude', type: 'tui', command: 'echo' };
      const promise = executeTuiRun({ runId: 'run-killed', provider, prompt: 'a prompt long enough', workspacePath: TEST_WORKSPACE, onData: undefined, onComplete: undefined, timeout: 60000 });
      await flushAsync();

      ptyInstances[0].emitData('some screen output');
      ptyInstances[0].emitExit({ exitCode: null, signal: 'SIGTERM' });

      await promise;
      expect(runnerMocks.finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-killed',
        success: false,
        exitCode: 130,
        error: expect.stringContaining('SIGTERM'),
        extras: expect.objectContaining({ completionReason: 'killed' }),
      }));
    });

    it('finalizes an explicit stop as canceled instead of a provider failure', async () => {
      const provider = { id: 'claude', type: 'tui', command: 'echo' };
      const onComplete = vi.fn();
      runnerMocks.consumeRunStopRequested.mockReturnValueOnce(true);
      const promise = executeTuiRun({ runId: 'run-stopped', provider, prompt: 'a prompt long enough', workspacePath: TEST_WORKSPACE, onComplete, timeout: 60000 });
      await flushAsync();

      ptyInstances[0].emitExit({ exitCode: null, signal: 'SIGTERM' });

      await promise;
      expect(runnerMocks.finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-stopped',
        success: false,
        error: expect.stringContaining('canceled'),
        extras: expect.objectContaining({ completionReason: 'canceled', canceled: true }),
      }));
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ canceled: true }));
    });

    it('finalizes a host-shutdown signal as an interruption instead of a provider failure', async () => {
      const provider = { id: 'codex', type: 'tui', command: 'echo' };
      markHostShuttingDown();
      const promise = executeTuiRun({ runId: 'run-restart', provider, prompt: 'a prompt long enough', workspacePath: TEST_WORKSPACE, timeout: 60000 });
      await flushAsync();

      ptyInstances[0].emitExit({ exitCode: null, signal: 2 });

      await promise;
      expect(runnerMocks.finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-restart',
        success: false,
        error: expect.stringContaining('PortOS shutdown'),
        extras: expect.objectContaining({ completionReason: 'host-shutdown', canceled: true }),
      }));
    });

    it('finishes with a tail-bearing error message when the PTY exits non-zero with prior output', async () => {
      const provider = { id: 'claude', type: 'tui', command: 'echo' };
      const promise = executeTuiRun({ runId: 'run-nonzero', provider, prompt: 'a prompt long enough', workspacePath: TEST_WORKSPACE, onData: undefined, onComplete: undefined, timeout: 60000 });
      await flushAsync();

      ptyInstances[0].emitData('fatal: provider config malformed at line 42');
      ptyInstances[0].emitExit({ exitCode: 2 });

      await promise;
      expect(runnerMocks.finalizeRunRecord).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-nonzero',
        success: false,
        exitCode: 2,
        error: expect.stringMatching(/TUI exited with code 2.*malformed/),
      }));
    });
  });
});
