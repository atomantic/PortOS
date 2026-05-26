import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// node-pty + runner hooks are mocked so executeTuiRun can be driven
// synchronously from the test without spawning a real terminal. fileUtils
// stays real for everything except `ensureDir` (which would otherwise create
// real run directories the SUT never needs in these tests). Mocks live
// inside vi.hoisted so the vi.mock factories (which are themselves hoisted
// to the top of the file) can reference them.
const { ptyInstances, ptySpawnMock, runnerMocks, runsTmpDirRef } = vi.hoisted(() => ({
  ptyInstances: [],
  ptySpawnMock: vi.fn(),
  runsTmpDirRef: { current: null },
  runnerMocks: {
    finalizeRunRecord: vi.fn(),
    emitRunStarted: vi.fn(),
    registerActiveRun: vi.fn(),
    unregisterActiveRun: vi.fn(),
    getRunsPath: vi.fn(),
  },
}));
runnerMocks.getRunsPath.mockImplementation(() => runsTmpDirRef.current);

vi.mock('node-pty', () => ({ spawn: (...args) => ptySpawnMock(...args) }));
vi.mock('../services/runner.js', () => runnerMocks);
vi.mock('./fileUtils.js', async () => {
  const actual = await vi.importActual('./fileUtils.js');
  return { ...actual, ensureDir: vi.fn(async () => {}) };
});

import { cleanTuiResponse, resolveTuiResponseText, executeTuiRun } from './tuiPromptRunner.js';

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

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

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
    runnerMocks.getRunsPath.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(runsTmpDirRef.current, { recursive: true, force: true }).catch(() => null);
  });

  describe('input validation', () => {
    it('throws when provider is missing', async () => {
      await expect(executeTuiRun('run-x', null, 'prompt', '/tmp'))
        .rejects.toThrow(/provider is required/);
      expect(ptySpawnMock).not.toHaveBeenCalled();
    });

    it('throws when prompt is empty', async () => {
      const provider = { id: 'claude', type: 'tui', command: 'echo' };
      await expect(executeTuiRun('run-x', provider, '', '/tmp'))
        .rejects.toThrow(/non-empty string/);
      expect(ptySpawnMock).not.toHaveBeenCalled();
    });

    it('throws when prompt is non-string', async () => {
      const provider = { id: 'claude', type: 'tui', command: 'echo' };
      await expect(executeTuiRun('run-x', provider, 12345, '/tmp'))
        .rejects.toThrow(/non-empty string/);
    });
  });

  describe('spawn failure', () => {
    it('wraps node-pty spawn errors with the offending command name', async () => {
      ptySpawnMock.mockImplementation(() => { throw new Error('ENOENT'); });
      const provider = { id: 'codex', type: 'tui', command: 'nonexistent-cli' };
      await expect(executeTuiRun('run-x', provider, 'do thing', '/tmp'))
        .rejects.toThrow(/Failed to spawn TUI 'nonexistent-cli': ENOENT/);
    });
  });

  describe('startup hooks', () => {
    it('registers the PTY in the active-runs map and fires emitRunStarted with provider + defaultModel', async () => {
      const provider = {
        id: 'claude', type: 'tui', command: 'echo', defaultModel: 'claude-3.5',
      };
      const promise = executeTuiRun('run-A', provider, 'do thing big enough', '/cwd', undefined, undefined, 60000);
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
        const promise = executeTuiRun('run-B', provider, 'p large enough to clear the guard', '/cwd', undefined, undefined, 60000);
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
      const promise = executeTuiRun('run-idle', provider, 'do thing big enough to clear the prompt guard', '/cwd', undefined, onComplete, 60000);
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

    it('finishes with reason "timeout" and exitCode 124 when the hard timeout fires before any completion', async () => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      const provider = { id: 'claude', type: 'tui', command: 'echo' };
      const promise = executeTuiRun('run-timeout', provider, 'a prompt long enough to clear the guard', '/cwd', undefined, undefined, 500);
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

    it('early-fails with reason "command-not-found" and exitCode 127 when "command not found" appears pre-paste', async () => {
      const provider = { id: 'codex', type: 'tui', command: 'no-such-tui' };
      const promise = executeTuiRun('run-missing', provider, 'a prompt long enough', '/cwd', undefined, undefined, 60000);
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
      const promise = executeTuiRun('run-extra-usage', provider, 'a prompt long enough', '/cwd', undefined, onComplete, 60000);
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

    it('finishes with reason "exit" + exitCode 0 when the PTY closes cleanly', async () => {
      const provider = { id: 'claude', type: 'tui', command: 'echo' };
      const promise = executeTuiRun('run-exit', provider, 'a prompt long enough', '/cwd', undefined, undefined, 60000);
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

    it('finishes with reason "killed" and surfaces the signal in the error when the PTY is terminated', async () => {
      const provider = { id: 'claude', type: 'tui', command: 'echo' };
      const promise = executeTuiRun('run-killed', provider, 'a prompt long enough', '/cwd', undefined, undefined, 60000);
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

    it('finishes with a tail-bearing error message when the PTY exits non-zero with prior output', async () => {
      const provider = { id: 'claude', type: 'tui', command: 'echo' };
      const promise = executeTuiRun('run-nonzero', provider, 'a prompt long enough', '/cwd', undefined, undefined, 60000);
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
