import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// node-pty + runner hooks are mocked so executeTuiRun can be driven
// synchronously from the test without spawning a real terminal. fileUtils
// stays real for everything except `ensureDir` (which would otherwise create
// real run directories the SUT never needs in these tests). Mocks live
// inside vi.hoisted so the vi.mock factories (which are themselves hoisted
// to the top of the file) can reference them.
const { ptyInstances, ptySpawnMock, runnerMocks, shellMocks, runsTmpDirRef } = vi.hoisted(() => ({
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
  // shell.js is mocked so the runner's Shell-view registration is observable
  // here without dragging in the real session registry singleton.
  // isExternalSessionAttached defaults to "no viewer" so idle/timeout fire as
  // they would for an unattended pipeline run; tests flip it to assert the pause.
  shellMocks: {
    registerExternalSession: vi.fn(),
    unregisterExternalSession: vi.fn(),
    isExternalSessionAttached: vi.fn(() => false),
  },
}));
runnerMocks.getRunsPath.mockImplementation(() => runsTmpDirRef.current);

vi.mock('node-pty', () => ({ spawn: (...args) => ptySpawnMock(...args) }));
vi.mock('../services/runner.js', () => runnerMocks);
vi.mock('../services/shell.js', () => shellMocks);
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
    shellMocks.registerExternalSession.mockClear();
    shellMocks.unregisterExternalSession.mockClear();
    shellMocks.isExternalSessionAttached.mockReset();
    shellMocks.isExternalSessionAttached.mockReturnValue(false);
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
    it('registers the PTY in the active-runs map and fires emitRunStarted with provider + defaultModel', async () => {
      const provider = {
        id: 'claude', type: 'tui', command: 'echo', defaultModel: 'claude-3.5',
      };
      const promise = executeTuiRun({ runId: 'run-A', provider, prompt: 'do thing big enough', workspacePath: '/cwd', onData: undefined, onComplete: undefined, timeout: 60000 });
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
        runId: 'run-view', provider, prompt: 'review this manuscript', workspacePath: '/work',
        label: 'pipeline-manuscript-completeness',
      });
      await flushAsync();

      expect(shellMocks.registerExternalSession).toHaveBeenCalledWith(
        'run-view',
        ptyInstances[0],
        expect.objectContaining({
          label: 'pipeline-manuscript-completeness',
          kind: 'tui-run',
          cwd: '/work',
        }),
      );
      expect(shellMocks.unregisterExternalSession).not.toHaveBeenCalled();

      ptyInstances[0].emitExit({ exitCode: 0 });
      await promise;
      expect(shellMocks.unregisterExternalSession).toHaveBeenCalledWith('run-view', { exitCode: 0 });
    });

    it('falls back to a command·model label when no source label is supplied', async () => {
      const provider = { id: 'codex', type: 'tui', command: 'codex', defaultModel: 'gpt-x' };
      const promise = executeTuiRun({ runId: 'run-nolabel', provider, prompt: 'do the thing', workspacePath: '/w' });
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
        const promise = executeTuiRun({ runId: 'run-B', provider, prompt: 'p large enough to clear the guard', workspacePath: '/cwd', onData: undefined, onComplete: undefined, timeout: 60000 });
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
      const promise = executeTuiRun({ runId: 'run-idle', provider, prompt: 'do thing big enough to clear the prompt guard', workspacePath: '/cwd', onData: undefined, onComplete, timeout: 60000 });
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
      const promise = executeTuiRun({ runId: 'run-watched', provider, prompt: 'do thing big enough to clear the prompt guard', workspacePath: '/cwd', onComplete, timeout: 60000 });
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
      const promise = executeTuiRun({ runId, provider, prompt: 'review this manuscript thoroughly enough to clear the guard', workspacePath: '/cwd', timeout: 60000 });
      await flushAsync();

      const pty = ptyInstances[0];
      pty.emitData('claude code ready> ');
      await vi.advanceTimersByTimeAsync(2000); // paste
      await vi.advanceTimersByTimeAsync(4000); // enter
      pty.emitData('model thinking…');          // arms idleWatchTimer

      // The model writes its COMPLETE response to the file the runner directed
      // it to (and, like Claude Code's TUI, does NOT exit afterward).
      const runDir = join(runsTmpDirRef.current, runId);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, 'tui-response.txt'), '{"issues":[]}');

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
      const promise = executeTuiRun({ runId, provider, prompt: 'do the task quietly then write the file', workspacePath: '/cwd', timeout: 60000 });
      await flushAsync();

      const pty = ptyInstances[0];
      // Pre-paste banner lets the ready-watch paste — but NOTHING is emitted
      // after the paste, so idleWatchTimer never arms.
      pty.emitData('claude code ready> ');
      await vi.advanceTimersByTimeAsync(2000); // ready-watch pastes → response-file watcher starts
      await vi.advanceTimersByTimeAsync(4000); // enter submitted; still zero post-paste output

      const runDir = join(runsTmpDirRef.current, runId);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, 'tui-response.txt'), 'silent result body');

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
      const runDir = join(runsTmpDirRef.current, runId);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, 'tui-response.txt'), 'the completed review body');

      const promise = executeTuiRun({ runId, provider, prompt: 'a prompt long enough to clear the guard', workspacePath: '/cwd', timeout: 500 });
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
      const promise = executeTuiRun({ runId: 'run-timeout', provider, prompt: 'a prompt long enough to clear the guard', workspacePath: '/cwd', onData: undefined, onComplete: undefined, timeout: 500 });
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
      const promise = executeTuiRun({ runId: 'run-tmo-watched', provider, prompt: 'a prompt long enough to clear the guard', workspacePath: '/cwd', timeout: 500 });
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
      const promise = executeTuiRun({ runId: 'run-missing', provider, prompt: 'a prompt long enough', workspacePath: '/cwd', onData: undefined, onComplete: undefined, timeout: 60000 });
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
      const promise = executeTuiRun({ runId: 'run-extra-usage', provider, prompt: 'a prompt long enough', workspacePath: '/cwd', onData: undefined, onComplete, timeout: 60000 });
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

    it('early-fails with reason "fallback-signal" when the model id is rejected (Bedrock invalid identifier) instead of idling to a bogus-scrape success', async () => {
      const provider = { id: 'claude', type: 'tui', command: 'claude' };
      const onComplete = vi.fn();
      const promise = executeTuiRun({ runId: 'run-bad-model', provider, prompt: 'a prompt long enough', workspacePath: '/cwd', onData: undefined, onComplete, timeout: 60000 });
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

    it('finishes with reason "exit" + exitCode 0 when the PTY closes cleanly', async () => {
      const provider = { id: 'claude', type: 'tui', command: 'echo' };
      const promise = executeTuiRun({ runId: 'run-exit', provider, prompt: 'a prompt long enough', workspacePath: '/cwd', onData: undefined, onComplete: undefined, timeout: 60000 });
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
      const promise = executeTuiRun({ runId: 'run-finish-throws', provider, prompt: 'a prompt long enough', workspacePath: '/cwd', onComplete, timeout: 60000 });
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
      const promise = executeTuiRun({ runId: 'run-oncomplete-throws', provider, prompt: 'a prompt long enough', workspacePath: '/cwd', onComplete, timeout: 60000 });
      await flushAsync();

      ptyInstances[0].emitExit({ exitCode: 0 });

      await expect(promise).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('finish() failed'));
      // Reached exactly once (the normal-path call), never re-invoked by the catch.
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it('finishes with reason "killed" and surfaces the signal in the error when the PTY is terminated', async () => {
      const provider = { id: 'claude', type: 'tui', command: 'echo' };
      const promise = executeTuiRun({ runId: 'run-killed', provider, prompt: 'a prompt long enough', workspacePath: '/cwd', onData: undefined, onComplete: undefined, timeout: 60000 });
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
      const promise = executeTuiRun({ runId: 'run-nonzero', provider, prompt: 'a prompt long enough', workspacePath: '/cwd', onData: undefined, onComplete: undefined, timeout: 60000 });
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
