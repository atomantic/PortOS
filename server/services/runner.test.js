import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventEmitter from 'events';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: vi.fn() };
});

// Keep the real killProcessTree (existing tests below rely on its real
// non-Windows SIGTERM branch) but stub resolveWindowsExecutable AND
// prepareWindowsSafeSpawn so the Windows command-resolution/wrap path can be
// driven deterministically regardless of the host platform actually running
// the suite (prepareWindowsSafeSpawn's own win32 check is bound to the real
// platform by default, which is never win32 in CI).
vi.mock('../lib/bufferedSpawn.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveWindowsExecutable: vi.fn(() => null),
    prepareWindowsSafeSpawn: vi.fn((command, args) => ({ command, args })),
  };
});

vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  // atomicWrite replaced the raw writeFile(JSON.stringify) metadata sites (#1837);
  // route it through the mocked fs/promises.writeFile so it resolves cleanly.
  atomicWrite: vi.fn(async (filePath, data) => {
    const payload = (typeof data === 'string' || Buffer.isBuffer(data)) ? data : JSON.stringify(data, null, 2);
    const { writeFile } = await import('fs/promises');
    return writeFile(filePath, payload);
  }),
}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue('{}'),
}));

const { spawn } = await import('child_process');
const { writeFile, readFile } = await import('fs/promises');
const { atomicWrite } = await import('../lib/fileUtils.js');
const runner = await import('./runner.js');
const { analyzeError, ERROR_CATEGORIES } = await import('../lib/aiToolkit/errorDetection.js');
const { setAIToolkit, executeCliRun, buildCliArgs, hasModelFlag, extractBakedModel, emitRunStarted } = runner;

// Minimal toolkit stub that satisfies executeCliRun's expectations. Mirrors the
// real toolkit runner's declared external-run registry (registerExternalRun /
// unregisterExternalRun) that the override now drives instead of poking a
// private `_portosActiveRuns` map.
function fakeToolkit(errorDetection = null) {
  const externalRuns = new Map();
  return {
    services: {
      runner: {
        registerExternalRun: (runId, killable) => externalRuns.set(runId, killable),
        unregisterExternalRun: (runId) => externalRuns.delete(runId),
        hasExternalRun: (runId) => externalRuns.has(runId),
        _externalRuns: externalRuns,
      },
      errorDetection,
    },
  };
}

function makeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.kill = vi.fn();
  child.killed = false;
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
  setAIToolkit(fakeToolkit(), { dataDir: '/tmp/test-runner' });
});

describe('executeCliRun — Codex sentinel suppression', () => {
  it('omits --model when defaultModel is codex-configured-default', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);

    const provider = {
      id: 'codex',
      command: 'codex',
      args: [],
      defaultModel: 'codex-configured-default',
      timeout: 5000,
    };

    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('output'));
      child.emit('close', 0);
    });

    await executeCliRun({ runId: 'run-1', provider, prompt: 'test prompt', workspacePath: '/workspace' });

    const [, capturedArgs] = spawn.mock.calls.at(-1);
    expect(capturedArgs).not.toContain('--model');
    expect(capturedArgs).not.toContain('codex-configured-default');
    // Should still have the exec subcommand and stdin marker
    expect(capturedArgs).toContain('exec');
    expect(capturedArgs).toContain('-');
  });

  it('passes --model when a real model name is provided', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);

    const provider = {
      id: 'codex',
      command: 'codex',
      args: [],
      defaultModel: 'o4-mini',
      timeout: 5000,
    };

    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('output'));
      child.emit('close', 0);
    });

    await executeCliRun({ runId: 'run-2', provider, prompt: 'test prompt', workspacePath: '/workspace' });

    const [, capturedArgs] = spawn.mock.calls.at(-1);
    const modelIdx = capturedArgs.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(capturedArgs[modelIdx + 1]).toBe('o4-mini');
  });

  it('stops the CLI immediately when Claude switches to extra usage', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    setAIToolkit(fakeToolkit({ analyzeError }), { dataDir: '/tmp/test-runner' });

    const provider = {
      id: 'claude-code',
      name: 'Claude Code',
      command: 'claude',
      args: [],
      defaultModel: 'claude-opus-4-7',
      timeout: 60000,
    };

    const completed = new Promise((resolve) => {
      executeCliRun({ runId: 'run-extra-usage', provider, prompt: 'test prompt', workspacePath: '/workspace', onData: undefined, onComplete: resolve, timeout: 60000 });
    });

    await Promise.resolve();
    child.stderr.emit('data', Buffer.from('Now using extra '));
    expect(child.kill).not.toHaveBeenCalled();
    child.stderr.emit('data', Buffer.from('usage\n'));
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    child.emit('close', null);
    const metadata = await completed;
    expect(metadata).toMatchObject({
      success: false,
      errorCategory: ERROR_CATEGORIES.USAGE_LIMIT,
      errorAnalysis: expect.objectContaining({
        category: ERROR_CATEGORIES.USAGE_LIMIT,
        requiresFallback: true,
      }),
    });
  });

  it('records failure (not success) when the fallback-killed child exits 0 in the race', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    setAIToolkit(fakeToolkit({ analyzeError }), { dataDir: '/tmp/test-runner' });

    const provider = {
      id: 'claude-code', name: 'Claude Code', command: 'claude', args: [],
      defaultModel: 'claude-opus-4-7', timeout: 60000,
    };

    const completed = new Promise((resolve) => {
      executeCliRun({ runId: 'run-fallback-exit0', provider, prompt: 'test prompt', workspacePath: '/workspace', onData: undefined, onComplete: resolve, timeout: 60000 });
    });

    await Promise.resolve();
    child.stderr.emit('data', Buffer.from('Now using extra usage\n'));
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    // SIGTERM races and the child happens to exit 0 — must NOT be recorded as
    // success, or the usage-limit fallback (onRunFailed) silently never fires.
    child.emit('close', 0);
    const metadata = await completed;
    expect(metadata.success).toBe(false);
    expect(metadata.errorAnalysis).toMatchObject({ requiresFallback: true });
  });
});

describe('executeCliRun — Windows .cmd/.bat shim spawning (#1865)', () => {
  it('wraps a resolved .cmd shim via cmd.exe /c — the actual #1865 fix (never shell:true)', async () => {
    const { resolveWindowsExecutable, prepareWindowsSafeSpawn } = await import('../lib/bufferedSpawn.js');
    const resolvedPath = 'C:\\Users\\Joe\\AppData\\Roaming\\npm\\opencode.cmd';
    vi.mocked(resolveWindowsExecutable).mockReturnValueOnce(resolvedPath);
    // Exercise the REAL wrap logic (not the describe-level identity stub) so
    // this test pins the actual cmd.exe /c contract, with isWin32 forced true
    // since the host running this suite is never win32.
    const { prepareWindowsSafeSpawn: realPrepare } = await vi.importActual('../lib/bufferedSpawn.js');
    vi.mocked(prepareWindowsSafeSpawn).mockImplementationOnce((cmd, args) => realPrepare(cmd, args, true));

    const child = makeChild();
    spawn.mockReturnValue(child);

    const provider = { id: 'codex', command: 'codex', args: ['exec', '-'], timeout: 5000 };

    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('output'));
      child.emit('close', 0);
    });

    await executeCliRun({ runId: 'run-resolved', provider, prompt: 'test prompt', workspacePath: '/workspace' });

    const [command, args, options] = spawn.mock.calls.at(-1);
    expect(command).toBe('cmd.exe');
    // buildCliArgs injects/transforms provider.args per-provider convention —
    // assert the WRAPPING contract (/c + resolved path prepended), not the
    // exact downstream arg list.
    expect(args[0]).toBe('/c');
    expect(args[1]).toBe(resolvedPath);
    // Never set shell:true — DEP0190's unescaped-join hazard. The cmd.exe
    // wrapper relies on Node's own correct non-shell argv escaping instead.
    expect(options.shell).toBeFalsy();
  });

  it('falls back to the bare command when resolution finds nothing (e.g. off win32, or not on PATH)', async () => {
    const { resolveWindowsExecutable } = await import('../lib/bufferedSpawn.js');
    vi.mocked(resolveWindowsExecutable).mockReturnValueOnce(null);

    const child = makeChild();
    spawn.mockReturnValue(child);

    const provider = { id: 'codex', command: 'codex', args: [], timeout: 5000 };

    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('output'));
      child.emit('close', 0);
    });

    await executeCliRun({ runId: 'run-unresolved', provider, prompt: 'test prompt', workspacePath: '/workspace' });

    const [command, , options] = spawn.mock.calls.at(-1);
    expect(command).toBe('codex');
    expect(options.shell).toBeFalsy();
  });
});

describe('executeCliRun — close handler crash guard', () => {
  // Drive a codex run whose first write (output) succeeds and second write
  // (metadata) rejects, so the close handler's recovery path runs. Returns the
  // onComplete spy + console.error spy for assertions.
  async function runWithMetadataWriteFailure(runId, { hooks } = {}) {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('ENOSPC: disk full'));
    if (hooks) setAIToolkit(fakeToolkit(), { dataDir: '/tmp/test-runner', hooks });

    const provider = {
      id: 'codex', command: 'codex', args: [],
      defaultModel: 'codex-configured-default', timeout: 5000,
    };
    const onComplete = vi.fn();
    await executeCliRun({ runId, provider, prompt: 'test prompt', workspacePath: '/workspace', onComplete });

    child.stdout.emit('data', Buffer.from('output'));
    child.emit('close', 0);
    await new Promise((resolve) => setImmediate(resolve)); // let the detached handler settle
    return { onComplete, errorSpy };
  }

  it('does not crash and still settles the caller when a metadata write fails on close', async () => {
    const { onComplete, errorSpy } = await runWithMetadataWriteFailure('run-write-fail');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('run-write-fail close handler error'));
    // The caller must still be settled with failure metadata, not left hanging.
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toMatchObject({ success: false, errorCategory: 'finalization_error' });
    errorSpy.mockRestore();
  });

  it('still settles onComplete when the recovery onRunFailed hook itself throws', async () => {
    // Metadata write fails AND the recovery onRunFailed hook throws — the
    // caller must STILL be settled (the hook must not block onComplete).
    const { onComplete, errorSpy } = await runWithMetadataWriteFailure('run-hook-throws', {
      hooks: { onRunFailed: () => { throw new Error('hook boom'); } },
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toMatchObject({ success: false, errorCategory: 'finalization_error' });
    errorSpy.mockRestore();
  });

  it('does not flip a successful run to failed when onRunCompleted throws', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Writes succeed (success path runs); the success hook throws — the caller
    // must still receive success:true, not a finalization-failure flip.
    writeFile.mockResolvedValue(undefined);
    setAIToolkit(fakeToolkit(), {
      dataDir: '/tmp/test-runner',
      hooks: { onRunCompleted: () => { throw new Error('hook boom'); } },
    });

    const provider = {
      id: 'codex', command: 'codex', args: [],
      defaultModel: 'codex-configured-default', timeout: 5000,
    };
    const onComplete = vi.fn();
    await executeCliRun({ runId: 'run-success-hook-throws', provider, prompt: 'test prompt', workspacePath: '/workspace', onComplete });

    child.stdout.emit('data', Buffer.from('output'));
    child.emit('close', 0);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toMatchObject({ success: true });
    errorSpy.mockRestore();
  });

  it('observes a rejected promise from an async completion hook (no unhandled rejection)', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFile.mockResolvedValue(undefined);
    // An async hook that REJECTS — safeSettle must attach a .catch so it does
    // not escape as an unhandled rejection, and onComplete must still settle.
    setAIToolkit(fakeToolkit(), {
      dataDir: '/tmp/test-runner',
      hooks: { onRunCompleted: () => Promise.reject(new Error('async hook boom')) },
    });

    const provider = {
      id: 'codex', command: 'codex', args: [],
      defaultModel: 'codex-configured-default', timeout: 5000,
    };
    const onComplete = vi.fn();
    await executeCliRun({ runId: 'run-async-hook-rejects', provider, prompt: 'test prompt', workspacePath: '/workspace', onComplete });

    child.stdout.emit('data', Buffer.from('output'));
    child.emit('close', 0);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toMatchObject({ success: true });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('onRunCompleted hook threw during recovery'));
    errorSpy.mockRestore();
  });

  it('finalizes a spawn error exactly once when error is followed by close', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onRunFailed = vi.fn();
    const onComplete = vi.fn();
    setAIToolkit(fakeToolkit(), {
      dataDir: '/tmp/test-runner',
      hooks: { onRunFailed },
    });
    readFile.mockResolvedValueOnce(JSON.stringify({
      id: 'run-spawn-error',
      providerId: 'configured-provider',
      providerName: 'Configured Provider',
      model: 'configured-model',
      workspacePath: '/configured/workspace',
      workspaceName: 'configured-workspace',
      source: 'test-source',
      startTime: '2026-07-10T00:00:00.000Z',
    }));

    const provider = {
      id: 'codex', name: 'Codex', command: 'codex', args: [],
      defaultModel: 'codex-configured-default', timeout: 5000,
    };
    await executeCliRun({
      runId: 'run-spawn-error',
      provider,
      prompt: 'test prompt',
      workspacePath: '/workspace',
      onComplete,
    });

    child.emit('error', new Error('spawn ENOENT'));
    child.emit('close', -1);

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onRunFailed).toHaveBeenCalledTimes(1);
    expect(atomicWrite).toHaveBeenCalledTimes(1);

    const persisted = atomicWrite.mock.calls[0][1];
    expect(persisted).toMatchObject({
      id: 'run-spawn-error',
      providerId: 'configured-provider',
      providerName: 'Configured Provider',
      model: 'configured-model',
      workspacePath: '/configured/workspace',
      workspaceName: 'configured-workspace',
      source: 'test-source',
      exitCode: -1,
      success: false,
      error: 'Spawn failed: spawn ENOENT',
      errorCategory: 'spawn_error',
    });
    expect(onComplete).toHaveBeenCalledWith(persisted);
    errorSpy.mockRestore();
  });
});

describe('buildCliArgs — claude-code defaultModel honoring', () => {
  it('appends --model <id> after `-p -` for claude-code', () => {
    const provider = { id: 'claude-code', command: 'claude', args: [], defaultModel: 'claude-opus-4-7' };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['-p', '-', '--model', 'claude-opus-4-7']);
  });

  it('omits --model when defaultModel is unset', () => {
    const provider = { id: 'claude-code', command: 'claude', args: [], defaultModel: null };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['-p', '-']);
  });

  it('respects a user-baked --model in provider.args and does NOT duplicate', () => {
    const provider = {
      id: 'claude-code',
      command: 'claude',
      args: ['--model', 'claude-sonnet-4-5'],
      defaultModel: 'claude-opus-4-7',
    };
    const args = buildCliArgs(provider);
    // baked model wins, no extra trailing flag
    expect(args).toEqual(['--model', 'claude-sonnet-4-5', '-p', '-']);
    expect(args.filter((a) => a === '--model').length).toBe(1);
  });

  it('respects a user-baked --model=value joined form', () => {
    const provider = {
      id: 'claude-code',
      command: 'claude',
      args: ['--model=claude-sonnet-4-5'],
      defaultModel: 'claude-opus-4-7',
    };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['--model=claude-sonnet-4-5', '-p', '-']);
  });
});

describe('buildCliArgs — gemini-cli defaultModel honoring', () => {
  it('appends -m <id> for legacy gemini-cli', () => {
    const provider = { id: 'gemini-cli', command: 'gemini', args: [], defaultModel: 'gemini-2.5-pro' };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['-m', 'gemini-2.5-pro']);
  });

  it('omits -m when defaultModel is unset', () => {
    const provider = { id: 'gemini-cli', command: 'gemini', args: [], defaultModel: null };
    const args = buildCliArgs(provider);
    expect(args).toEqual([]);
  });

  it('respects a user-baked -m in provider.args', () => {
    const provider = {
      id: 'gemini-cli',
      command: 'gemini',
      args: ['-m', 'gemini-2.0-flash'],
      defaultModel: 'gemini-2.5-pro',
    };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['-m', 'gemini-2.0-flash']);
    expect(args.filter((a) => a === '-m').length).toBe(1);
  });

  it('respects a user-baked --model in provider.args (long-form)', () => {
    const provider = {
      id: 'gemini-cli',
      command: 'gemini',
      args: ['--model', 'gemini-2.0-flash'],
      defaultModel: 'gemini-2.5-pro',
    };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['--model', 'gemini-2.0-flash']);
  });
});

describe('buildCliArgs — antigravity-cli headless mode', () => {
  it('uses agy print mode and does not pass model flags', () => {
    const provider = { id: 'antigravity-cli', command: 'agy', args: [], defaultModel: 'antigravity-configured-default' };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['--print', '--dangerously-skip-permissions']);
  });

  it('strips legacy Gemini flags during invocation', () => {
    const provider = { id: 'antigravity-cli', command: 'agy', args: ['--yolo', '-m', 'gemini-2.5-pro', '--output-format', 'text'], defaultModel: 'antigravity-configured-default' };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['--print', '--dangerously-skip-permissions']);
  });
});

describe('buildCliArgs — codex (regression coverage for the existing logic)', () => {
  it('omits --model when defaultModel is the sentinel', () => {
    const provider = { id: 'codex', command: 'codex', args: [], defaultModel: 'codex-configured-default' };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['exec', '-c', 'check_for_update_on_startup=false', '-']);
  });

  it('appends --model when a real model is given', () => {
    const provider = { id: 'codex', command: 'codex', args: [], defaultModel: 'o4-mini' };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['exec', '-c', 'check_for_update_on_startup=false', '--model', 'o4-mini', '-']);
  });
});

describe('buildCliArgs — strips dangling --model from baseArgs before injecting', () => {
  it('drops a bare --model at end of args (claude-code) and appends the valid one', () => {
    const provider = { id: 'claude-code', command: 'claude', args: ['--model'], defaultModel: 'sonnet-3.7' };
    const args = buildCliArgs(provider);
    // Bare --model would survive into argv and conflict with our injected
    // --model sonnet-3.7. The sanitizer drops it so only the valid pair remains.
    expect(args).toEqual(['-p', '-', '--model', 'sonnet-3.7']);
  });

  it('drops a --model followed by another flag (gemini-cli) and appends the valid one', () => {
    const provider = { id: 'gemini-cli', command: 'gemini', args: ['-m', '--other'], defaultModel: 'gemini-flash' };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['--other', '-m', 'gemini-flash']);
  });

  it('drops an empty joined model flag (--model=) and appends the valid one', () => {
    const provider = { id: 'claude-code', command: 'claude', args: ['--model='], defaultModel: 'sonnet-3.7' };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['-p', '-', '--model', 'sonnet-3.7']);
  });

  it('drops dangling --model on codex too (regression)', () => {
    const provider = { id: 'codex', command: 'codex', args: ['--model'], defaultModel: 'o4-mini' };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['exec', '-c', 'check_for_update_on_startup=false', '--model', 'o4-mini', '-']);
  });

  it('preserves a properly-pinned --model and does NOT inject our own', () => {
    const provider = { id: 'claude-code', command: 'claude', args: ['--model', 'baked-in'], defaultModel: 'would-be-ignored' };
    const args = buildCliArgs(provider);
    expect(args).toEqual(['--model', 'baked-in', '-p', '-']);
  });
});

describe('hasModelFlag', () => {
  it('detects separated long form (--model X)', () => {
    expect(hasModelFlag(['--model', 'foo'])).toBe(true);
  });
  it('detects separated short form (-m X)', () => {
    expect(hasModelFlag(['-m', 'foo'])).toBe(true);
  });
  it('detects joined long form (--model=X)', () => {
    expect(hasModelFlag(['--model=foo'])).toBe(true);
  });
  it('detects joined short form (-m=X)', () => {
    expect(hasModelFlag(['-m=foo'])).toBe(true);
  });
  it('returns false when no model flag is present', () => {
    expect(hasModelFlag(['--other', 'foo'])).toBe(false);
    expect(hasModelFlag([])).toBe(false);
  });
  it('returns false for non-array input', () => {
    expect(hasModelFlag(null)).toBe(false);
    expect(hasModelFlag(undefined)).toBe(false);
    expect(hasModelFlag('--model foo')).toBe(false);
  });
  it('returns false for a separated flag at end of argv (no value follows)', () => {
    expect(hasModelFlag(['--model'])).toBe(false);
    expect(hasModelFlag(['-m'])).toBe(false);
    expect(hasModelFlag(['--other', '--model'])).toBe(false);
  });
  it('returns false when the value following looks like another flag', () => {
    expect(hasModelFlag(['--model', '--other'])).toBe(false);
    expect(hasModelFlag(['-m', '-x'])).toBe(false);
  });
  it('returns false for an empty joined value (--model= / -m=)', () => {
    expect(hasModelFlag(['--model='])).toBe(false);
    expect(hasModelFlag(['-m='])).toBe(false);
  });
});

describe('extractBakedModel', () => {
  it('extracts from separated long form', () => {
    expect(extractBakedModel(['--model', 'sonnet-3.7'])).toBe('sonnet-3.7');
  });
  it('extracts from separated short form', () => {
    expect(extractBakedModel(['-m', 'gemini-2.5-pro'])).toBe('gemini-2.5-pro');
  });
  it('extracts from joined long form', () => {
    expect(extractBakedModel(['--model=opus-4.7'])).toBe('opus-4.7');
  });
  it('extracts from joined short form', () => {
    expect(extractBakedModel(['-m=gemini-flash'])).toBe('gemini-flash');
  });
  it('returns null when separated form has no value following the flag', () => {
    expect(extractBakedModel(['--model'])).toBe(null);
  });
  it('returns null when the value following looks like another flag (matches hasModelFlag)', () => {
    // Without this guard, extractBakedModel would extract '--other' as the
    // model id while hasModelFlag returned false, leaving the two functions
    // out of sync. Both must agree on what counts as a real pin.
    expect(extractBakedModel(['--model', '--other'])).toBe(null);
    expect(extractBakedModel(['-m', '-x'])).toBe(null);
  });
  it('returns null when no model flag is present', () => {
    expect(extractBakedModel(['--other', 'foo'])).toBe(null);
    expect(extractBakedModel([])).toBe(null);
  });
  it('returns null for non-array input', () => {
    expect(extractBakedModel(null)).toBe(null);
    expect(extractBakedModel(undefined)).toBe(null);
  });
  it('returns the FIRST baked flag when more than one is present', () => {
    expect(extractBakedModel(['--model', 'first', '-m', 'second'])).toBe('first');
  });
});

// emitRunStarted's payload-flattening contract is consumed by tuiPromptRunner.js
// (and any future non-toolkit execution path) — the TUI tests mock emitRunStarted
// itself, so this is the only place the `name || id` and `model ?? defaultModel`
// fallbacks are pinned. A regression here would silently break run-tracking
// attribution without any other suite catching it.
describe('emitRunStarted — payload-flattening contract', () => {
  function captureHook() {
    const onRunStarted = vi.fn();
    setAIToolkit(fakeToolkit(), { dataDir: '/tmp/test-runner', hooks: { onRunStarted } });
    return onRunStarted;
  }

  it('prefers provider.name over provider.id when both are present', () => {
    const onRunStarted = captureHook();
    emitRunStarted({
      runId: 'r1',
      provider: { name: 'codex', id: 'codex-id', defaultModel: 'gpt-5' },
      model: 'gpt-4o',
    });
    expect(onRunStarted).toHaveBeenCalledWith({ runId: 'r1', provider: 'codex', model: 'gpt-4o' });
  });

  it('falls back to provider.id when provider.name is missing', () => {
    const onRunStarted = captureHook();
    emitRunStarted({
      runId: 'r2',
      provider: { id: 'gemini-cli', defaultModel: 'gemini-2.5-pro' },
      model: 'gemini-2.0-flash',
    });
    expect(onRunStarted).toHaveBeenCalledWith({ runId: 'r2', provider: 'gemini-cli', model: 'gemini-2.0-flash' });
  });

  it('uses the explicit model argument when given (overrides provider.defaultModel)', () => {
    const onRunStarted = captureHook();
    emitRunStarted({
      runId: 'r3',
      provider: { name: 'claude-code', defaultModel: 'claude-opus-4-7' },
      model: 'claude-sonnet-4-6',
    });
    expect(onRunStarted).toHaveBeenCalledWith({ runId: 'r3', provider: 'claude-code', model: 'claude-sonnet-4-6' });
  });

  it('falls back to provider.defaultModel when model is undefined', () => {
    const onRunStarted = captureHook();
    emitRunStarted({
      runId: 'r4',
      provider: { name: 'codex', defaultModel: 'codex-configured-default' },
      model: undefined,
    });
    expect(onRunStarted).toHaveBeenCalledWith({
      runId: 'r4',
      provider: 'codex',
      model: 'codex-configured-default',
    });
  });

  it('falls back to provider.defaultModel when model is null (?? semantics)', () => {
    const onRunStarted = captureHook();
    emitRunStarted({
      runId: 'r5',
      provider: { name: 'codex', defaultModel: 'o4-mini' },
      model: null,
    });
    expect(onRunStarted).toHaveBeenCalledWith({ runId: 'r5', provider: 'codex', model: 'o4-mini' });
  });

  it('keeps an empty-string model rather than falling back (?? treats "" as defined)', () => {
    // Guards the ?? semantics — if this ever flips to ||, intentionally-empty
    // models would be silently rewritten to defaultModel.
    const onRunStarted = captureHook();
    emitRunStarted({
      runId: 'r6',
      provider: { name: 'codex', defaultModel: 'o4-mini' },
      model: '',
    });
    expect(onRunStarted).toHaveBeenCalledWith({ runId: 'r6', provider: 'codex', model: '' });
  });

  it('emits undefined provider/model when provider is missing entirely', () => {
    const onRunStarted = captureHook();
    emitRunStarted({ runId: 'r7', provider: undefined, model: undefined });
    expect(onRunStarted).toHaveBeenCalledWith({ runId: 'r7', provider: undefined, model: undefined });
  });

  it('is a no-op when no onRunStarted hook is registered', () => {
    setAIToolkit(fakeToolkit(), { dataDir: '/tmp/test-runner' });
    expect(() => emitRunStarted({
      runId: 'r8',
      provider: { name: 'codex', defaultModel: 'o4-mini' },
      model: 'gpt-4',
    })).not.toThrow();
  });
});
