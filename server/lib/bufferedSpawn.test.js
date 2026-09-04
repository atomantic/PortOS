import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { ChildProcess } from './childProcess.js';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock child_process.spawn so we can drive the buffered-spawn machinery without
// launching real processes. Pass the real module through (importOriginal) and
// override only `spawn` — killProcessTree's `instanceof ChildProcess` guard
// needs the real `ChildProcess` export; a from-scratch replacement object
// (no `ChildProcess` key) would make that check throw on an actual win32 run.
const spawnMock = vi.fn();
vi.mock('./childProcess.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: (...a) => spawnMock(...a) };
});

// Re-imported after the mock is registered.
const {
  bufferedSpawn,
  bufferedSpawnOrThrow,
  killProcessTree,
  needsShell,
  resolveWindowsExecutable,
  prepareWindowsSafeSpawn,
  prepareCliSpawn,
  IS_WIN32,
  WIN_CMD_SHIMS,
  MAX_OUTPUT_BYTES,
  spawnFailureDetail,
  guardChildStdin,
  deliverChildStdin,
} = await import('./bufferedSpawn.js');

/**
 * Build a fake child process with stdout/stderr emitters and a kill spy.
 * Its prototype is swapped to ChildProcess.prototype so it passes
 * killProcessTree's `instanceof ChildProcess` guard exactly like a real
 * spawn() result would — without this, the "spawns taskkill" test below
 * would silently take the SIGTERM fallback branch on an actual win32 run.
 */
function makeFakeChild({ pid = 1234 } = {}) {
  const child = new EventEmitter();
  Object.setPrototypeOf(child, ChildProcess.prototype);
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.unref = vi.fn();
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
  // Default: any spawn returns a fresh fake child. On a Windows test runner the
  // timeout path also spawns `taskkill` via killProcessTree — without a default
  // it would get `undefined` and crash on `.on(...)`. Tests that need to drive a
  // specific child queue it explicitly with mockReturnValueOnce.
  spawnMock.mockImplementation(() => makeFakeChild());
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('needsShell / constants', () => {
  it('only treats npm/npx as shell shims, and only on Windows', () => {
    expect(WIN_CMD_SHIMS.has('npm')).toBe(true);
    expect(WIN_CMD_SHIMS.has('npx')).toBe(true);
    expect(WIN_CMD_SHIMS.has('git')).toBe(false);
    // needsShell mirrors IS_WIN32 — false on non-Windows test runners.
    expect(needsShell('npm')).toBe(IS_WIN32);
    expect(needsShell('git')).toBe(false);
  });

  it('caps buffered output at 64KiB', () => {
    expect(MAX_OUTPUT_BYTES).toBe(64 * 1024);
  });
});

describe('killProcessTree', () => {
  it('on non-Windows sends SIGTERM to the child', () => {
    if (IS_WIN32) return; // platform-gated behavior
    const child = makeFakeChild();
    killProcessTree(child);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('on non-Windows forwards an explicit signal to the child (e.g. SIGKILL escalation) — #2243', () => {
    if (IS_WIN32) return; // platform-gated behavior
    const child = makeFakeChild();
    killProcessTree(child, 'SIGKILL');
    // POSIX callers keep their SIGTERM→SIGKILL escalation semantics — the
    // signal arg must reach child.kill, not be hardcoded to SIGTERM.
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('on Windows spawns taskkill /T /F against the pid and marks the child killed', () => {
    if (!IS_WIN32) return; // can't simulate platform branch from outside
    const child = makeFakeChild({ pid: 999 });
    const tk = makeFakeChild();
    tk.unref = vi.fn();
    spawnMock.mockReturnValueOnce(tk);
    killProcessTree(child);
    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill', ['/T', '/F', '/PID', '999'],
      expect.objectContaining({ stdio: 'ignore' })
    );
    // taskkill runs in a detached process that never touches `child` itself —
    // .killed must be set synchronously here so re-entrant kill/abort guards
    // elsewhere (gated on `!child.killed`) actually engage on Windows.
    expect(child.killed).toBe(true);
  });

  it('on non-Windows with processGroup signals the whole group, so a detached shell takes its children with it', () => {
    if (IS_WIN32) return; // platform-gated behavior
    const child = makeFakeChild({ pid: 555 });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killProcessTree(child, undefined, { processGroup: true });
    expect(killSpy).toHaveBeenCalledWith(-555, 'SIGTERM');
    expect(child.kill).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('on non-Windows falls back to the single pid when the group is already gone (ESRCH)', () => {
    if (IS_WIN32) return; // platform-gated behavior
    const child = makeFakeChild();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH'); });
    killProcessTree(child, 'SIGKILL', { processGroup: true });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    killSpy.mockRestore();
  });

  it('on Windows ignores processGroup — taskkill /T is already the tree', () => {
    if (!IS_WIN32) return; // platform-gated behavior
    const child = makeFakeChild({ pid: 777 });
    const tk = makeFakeChild();
    tk.unref = vi.fn();
    spawnMock.mockReturnValueOnce(tk);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killProcessTree(child, undefined, { processGroup: true });
    expect(spawnMock).toHaveBeenCalledWith('taskkill', ['/T', '/F', '/PID', '777'], expect.anything());
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  // A killable that exposes .kill()/.pid like a ChildProcess but isn't one
  // (node-pty's IPty, registered via registerExternalRun for TUI runs). taskkill
  // against its pid would bypass node-pty's own native teardown (releasing a
  // Windows ConPTY handle) and leak it.
  //
  // The platform is INJECTED on these, not read from the host: the branch below
  // is Windows-only, and a `if (!IS_WIN32) return` guard would assert nothing on
  // a Linux CI runner — leaving the fix free to regress everywhere but a
  // developer's Windows box.
  const ptyLike = (onSignal) => ({ pid: 4321, kill: vi.fn(onSignal) });
  // node-pty's Windows backend throws for ANY signal argument. A signalled kill
  // there therefore killed nothing and threw past the caller, which logged it
  // and moved on — which is how every CoS Runner TUI kill became a silent no-op
  // on Windows, stranding the process and pinning the Update page on
  // "N CoS agents running".
  const rejectsSignals = (signal) => { if (signal) throw new Error('Signals not supported on windows.'); };

  it('falls back to a signal-free kill on Windows for a handle that rejects signals', () => {
    const pty = ptyLike(rejectsSignals);
    killProcessTree(pty, 'SIGKILL', {}, true);
    expect(pty.kill.mock.calls).toEqual([['SIGKILL'], []]);
    // Never taskkill — that bypasses node-pty's ConPTY teardown and leaks the handle.
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('keeps the signal on Windows for a non-ChildProcess killable that accepts one', () => {
    // cosRunnerClient's TUI proxy relays { signal } over a socket. Dropping the
    // signal unconditionally would silently downgrade a force-kill to graceful.
    const proxy = ptyLike(undefined);
    killProcessTree(proxy, 'SIGKILL', {}, true);
    expect(proxy.kill.mock.calls).toEqual([['SIGKILL']]);
  });

  it('forwards the signal to a node-pty handle off Windows, where node-pty honors it', () => {
    const pty = ptyLike(undefined);
    killProcessTree(pty, 'SIGKILL', {}, false);
    expect(pty.kill.mock.calls).toEqual([['SIGKILL']]);
  });

  it('on Windows ignores processGroup — taskkill /T is already the tree', () => {
    if (!IS_WIN32) return; // platform-gated behavior
    const child = makeFakeChild({ pid: 777 });
    const tk = makeFakeChild();
    tk.unref = vi.fn();
    spawnMock.mockReturnValueOnce(tk);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killProcessTree(child, undefined, { processGroup: true });
    expect(spawnMock).toHaveBeenCalledWith('taskkill', ['/T', '/F', '/PID', '777'], expect.anything());
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('on Windows kills a non-ChildProcess killable (a node-pty session) with .kill() and NO signal', () => {
    if (!IS_WIN32) return; // can't simulate platform branch from outside
    // A killable that exposes .kill()/.pid like a ChildProcess but isn't one
    // (e.g. node-pty's IPty, registered via registerExternalRun for TUI
    // runs) — taskkill against its pid would bypass its own native teardown
    // (releasing a Windows ConPTY handle) and leak it.
    //
    // The signal must be DROPPED: node-pty's Windows backend throws
    // "Signals not supported on windows." for any signal argument, so a
    // signalled kill there killed nothing and threw past the caller — which is
    // how every CoS Runner TUI kill became a silent no-op on Windows.
    const ptyLike = { pid: 4321, kill: vi.fn((signal) => { if (signal) throw new Error('Signals not supported on windows.'); }) };
    killProcessTree(ptyLike, 'SIGKILL');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(ptyLike.kill).toHaveBeenCalledWith();
  });

  it('on non-Windows still forwards the signal to a node-pty session', () => {
    if (IS_WIN32) return; // platform-gated behavior
    const ptyLike = { pid: 4321, kill: vi.fn() };
    killProcessTree(ptyLike, 'SIGKILL');
    expect(ptyLike.kill).toHaveBeenCalledWith('SIGKILL');
  });

  // A bare `{ pid }` — a detached job this process holds no handle to at all
  // (spawnDetached's reparented job, reapDetached's pid-file orphan). The
  // platform is INJECTED, so both branches are asserted on any host.
  it('tree-kills a bare { pid } target on Windows', () => {
    const tk = makeFakeChild();
    spawnMock.mockReturnValueOnce(tk);
    killProcessTree({ pid: 8080 }, 'SIGKILL', {}, true);
    // Without this, a pid-only cancel fell through to the node-pty branch and
    // threw `child.kill is not a function` — or, worse, silently killed only
    // the job leaf and orphaned everything it spawned (#6170).
    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill', ['/T', '/F', '/PID', '8080'],
      expect.objectContaining({ stdio: 'ignore' })
    );
  });

  it('maps processGroup onto the same tree-kill on Windows, which has no process groups', () => {
    const tk = makeFakeChild();
    spawnMock.mockReturnValueOnce(tk);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killProcessTree({ pid: 8081 }, 'SIGTERM', { processGroup: true }, true);
    expect(spawnMock).toHaveBeenCalledWith('taskkill', ['/T', '/F', '/PID', '8081'], expect.anything());
    // `process.kill(-pid)` means nothing on Windows — the win32 branch has to
    // win the race with the process-group branch, whatever the flag says.
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('signals a bare { pid } target off Windows, group first then the pid', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killProcessTree({ pid: 8082 }, 'SIGKILL', { processGroup: true }, false);
    expect(killSpy).toHaveBeenCalledWith(-8082, 'SIGKILL');
    killSpy.mockReset();
    killProcessTree({ pid: 8083 }, 'SIGKILL', {}, false);
    expect(killSpy).toHaveBeenCalledWith(8083, 'SIGKILL');
    killSpy.mockRestore();
  });

  it('swallows ESRCH for a bare { pid } target that already exited', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH'); });
    expect(() => killProcessTree({ pid: 8084 }, 'SIGKILL', {}, false)).not.toThrow();
    killSpy.mockRestore();
  });
});

describe('resolveWindowsExecutable', () => {
  // isWin32 is passed explicitly so these tests are deterministic regardless
  // of the host platform actually running them.
  let fakePathDir;
  let originalPath;

  beforeEach(async () => {
    fakePathDir = await mkdtemp(join(tmpdir(), 'resolve-win-exe-'));
    originalPath = process.env.PATH;
    process.env.PATH = fakePathDir;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await rm(fakePathDir, { recursive: true, force: true });
  });

  it('returns null when isWin32 is false, regardless of what is on PATH', async () => {
    await writeFile(join(fakePathDir, 'opencode.cmd'), '@echo off\n');
    expect(resolveWindowsExecutable('opencode', false)).toBeNull();
  });

  it('resolves a bare command to its .cmd shim on PATH', async () => {
    await writeFile(join(fakePathDir, 'opencode.cmd'), '@echo off\n');
    expect(resolveWindowsExecutable('opencode', true)).toBe(join(fakePathDir, 'opencode.cmd'));
  });

  it('prefers a real .exe over a .cmd shim when both exist', async () => {
    await writeFile(join(fakePathDir, 'tool.cmd'), '@echo off\n');
    await writeFile(join(fakePathDir, 'tool.exe'), '');
    expect(resolveWindowsExecutable('tool', true)).toBe(join(fakePathDir, 'tool.exe'));
  });

  it('never matches an extension-less POSIX shim stub (the actual #1865 root cause)', async () => {
    // npm ships a bare POSIX shell-script stub alongside the .cmd/.bat/.ps1
    // Windows wrappers for Git Bash/WSL — it is not natively launchable.
    await writeFile(join(fakePathDir, 'opencode'), '#!/bin/sh\n');
    expect(resolveWindowsExecutable('opencode', true)).toBeNull();
  });

  it('returns null when nothing matches on PATH', () => {
    expect(resolveWindowsExecutable('does-not-exist', true)).toBeNull();
  });

  it('returns null for an already-absolute path (nothing to resolve)', () => {
    expect(resolveWindowsExecutable('C:\\tools\\opencode.cmd', true)).toBeNull();
  });

  it('returns null for a relative path containing a separator', () => {
    expect(resolveWindowsExecutable('./bin/opencode', true)).toBeNull();
  });

  it('searches the given searchEnv.PATH, not bare process.env, honoring a provider-configured PATH override', async () => {
    // A provider's envVars can override PATH for the child process — the CLI
    // may live somewhere the PARENT process.env.PATH never points to.
    const customDir = await mkdtemp(join(tmpdir(), 'resolve-win-exe-custom-'));
    try {
      await writeFile(join(customDir, 'opencode.cmd'), '@echo off\n');
      // process.env.PATH (set in beforeEach) does NOT include customDir.
      expect(resolveWindowsExecutable('opencode', true)).toBeNull();
      expect(resolveWindowsExecutable('opencode', true, { PATH: customDir })).toBe(join(customDir, 'opencode.cmd'));
    } finally {
      await rm(customDir, { recursive: true, force: true });
    }
  });

  it('falls back to searchEnv.Path (capital-P-lowercase, the Windows convention) when PATH is absent', async () => {
    const customDir = await mkdtemp(join(tmpdir(), 'resolve-win-exe-capital-'));
    try {
      await writeFile(join(customDir, 'opencode.cmd'), '@echo off\n');
      expect(resolveWindowsExecutable('opencode', true, { Path: customDir })).toBe(join(customDir, 'opencode.cmd'));
    } finally {
      await rm(customDir, { recursive: true, force: true });
    }
  });
});

describe('prepareWindowsSafeSpawn', () => {
  // isWin32 is passed explicitly so these tests are deterministic regardless
  // of the host platform actually running them.
  it('wraps a .cmd target in cmd.exe /c on Windows (the actual #1865 fix)', () => {
    const result = prepareWindowsSafeSpawn('C:\\npm\\opencode.cmd', ['exec', '-'], true);
    expect(result).toEqual({ command: 'cmd.exe', args: ['/c', 'C:\\npm\\opencode.cmd', 'exec', '-'] });
  });

  it('wraps a .bat target in cmd.exe /c on Windows, case-insensitively', () => {
    const result = prepareWindowsSafeSpawn('C:\\tools\\thing.BAT', ['x'], true);
    expect(result).toEqual({ command: 'cmd.exe', args: ['/c', 'C:\\tools\\thing.BAT', 'x'] });
  });

  it('leaves a resolved .exe target unwrapped on Windows — directly launchable, no batch interpreter needed', () => {
    const result = prepareWindowsSafeSpawn('C:\\tools\\claude.exe', ['-p', '-'], true);
    expect(result).toEqual({ command: 'C:\\tools\\claude.exe', args: ['-p', '-'] });
  });

  it('never wraps off Windows, even for a .cmd-looking path', () => {
    const result = prepareWindowsSafeSpawn('/usr/local/bin/opencode.cmd', ['exec', '-'], false);
    expect(result).toEqual({ command: '/usr/local/bin/opencode.cmd', args: ['exec', '-'] });
  });

  it('passes through a bare unresolved command unchanged (resolution-failure fallback)', () => {
    const result = prepareWindowsSafeSpawn('opencode', ['exec', '-'], true);
    expect(result).toEqual({ command: 'opencode', args: ['exec', '-'] });
  });

  it('caret-escapes a cmd.exe metacharacter in an arg with NO whitespace (Node would leave it unquoted)', () => {
    // foo&calc has no whitespace, so Node's own argv quoting would NOT wrap
    // it in literal quotes — the bare `&` would reach cmd.exe's raw command
    // line and be interpreted as a command separator without this.
    const result = prepareWindowsSafeSpawn('C:\\npm\\opencode.cmd', ['foo&calc'], true);
    expect(result.args).toEqual(['/c', 'C:\\npm\\opencode.cmd', 'foo^&calc']);
  });

  it('does NOT escape metacharacters in an arg that already contains whitespace (Node will quote it)', () => {
    // An arg with a space is already wrapped in literal double quotes by
    // Node's own argv escaping — caret-escaping it too would inject literal
    // `^` characters into the value the target program receives.
    const result = prepareWindowsSafeSpawn('C:\\npm\\codex.cmd', ['describe this & list colors'], true);
    expect(result.args).toEqual(['/c', 'C:\\npm\\codex.cmd', 'describe this & list colors']);
  });

  it('escapes multiple metacharacters in an unquoted arg', () => {
    const result = prepareWindowsSafeSpawn('C:\\npm\\tool.cmd', ['a|b>c<d'], true);
    expect(result.args).toEqual(['/c', 'C:\\npm\\tool.cmd', 'a^|b^>c^<d']);
  });

  it('never escapes off Windows, even for an unquoted metacharacter arg', () => {
    const result = prepareWindowsSafeSpawn('/usr/local/bin/tool.cmd', ['foo&bar'], false);
    expect(result.args).toEqual(['foo&bar']);
  });

  it('also caret-escapes a metacharacter in the resolved command path itself (e.g. a custom install dir)', () => {
    // A custom npm prefix directory containing a metacharacter, with no
    // whitespace, would reach cmd.exe unquoted just like an unquoted arg.
    const result = prepareWindowsSafeSpawn('C:\\Tools&CLIs\\npm\\codex.cmd', ['exec'], true);
    expect(result).toEqual({ command: 'cmd.exe', args: ['/c', 'C:\\Tools^&CLIs\\npm\\codex.cmd', 'exec'] });
  });
});

describe('prepareCliSpawn (composed resolve+wrap — the CoS spawn fix, #2243)', () => {
  // isWin32 is passed explicitly so these tests are deterministic regardless of
  // the host platform actually running them. A real fakePathDir on PATH lets
  // resolveWindowsExecutable find the shim.
  let fakePathDir;

  beforeEach(async () => {
    fakePathDir = await mkdtemp(join(tmpdir(), 'prepare-cli-spawn-'));
  });

  afterEach(async () => {
    await rm(fakePathDir, { recursive: true, force: true });
  });

  it('resolves a bare .cmd shim on PATH AND wraps it in cmd.exe /c (the end-to-end Windows fix)', async () => {
    // This is exactly the CoS bug: on Windows a bare `opencode` can neither be
    // resolved nor spawned directly — prepareCliSpawn turns it into a
    // launchable `cmd.exe /c <opencode.cmd> ...` pair. The env override is what
    // the CoS spawners pass (childEnv) so a provider PATH is honored.
    await writeFile(join(fakePathDir, 'opencode.cmd'), '@echo off\n');
    const result = prepareCliSpawn('opencode', ['run', '-m', 'ollama/qwen2.5:7b-instruct'], { PATH: fakePathDir }, true);
    expect(result).toEqual({
      command: 'cmd.exe',
      args: ['/c', join(fakePathDir, 'opencode.cmd'), 'run', '-m', 'ollama/qwen2.5:7b-instruct'],
    });
  });

  it('resolves a bare command to a real .exe and leaves it unwrapped on Windows', async () => {
    await writeFile(join(fakePathDir, 'opencode.exe'), '');
    const result = prepareCliSpawn('opencode', ['run'], { PATH: fakePathDir }, true);
    expect(result).toEqual({ command: join(fakePathDir, 'opencode.exe'), args: ['run'] });
  });

  it('keeps the bare command when nothing resolves on PATH (Windows fallback)', () => {
    const result = prepareCliSpawn('opencode', ['run'], { PATH: fakePathDir }, true);
    expect(result).toEqual({ command: 'opencode', args: ['run'] });
  });

  it('is a no-op off Windows — passes the bare command + args straight through (POSIX unaffected)', async () => {
    // Even with a matching .cmd on PATH, the POSIX branch never resolves or
    // wraps: spawn() resolves `opencode` from PATH itself under shell:false.
    await writeFile(join(fakePathDir, 'opencode.cmd'), '@echo off\n');
    const result = prepareCliSpawn('opencode', ['run', '-m', 'ollama/x'], { PATH: fakePathDir }, false);
    expect(result).toEqual({ command: 'opencode', args: ['run', '-m', 'ollama/x'] });
  });
});

describe('bufferedSpawn — structured result', () => {
  it('resolves success on a clean (code 0) exit and captures stdout/stderr', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawn('echo', ['hi'], { cwd: '/tmp' });
    child.stdout.emit('data', 'out-data');
    child.stderr.emit('data', 'err-data');
    child.emit('close', 0, null);
    const result = await p;
    expect(result).toEqual({
      success: true, code: 0, signal: null,
      stdout: 'out-data', stderr: 'err-data', timedOut: false,
    });
    // cwd passed through; shell defaults to needsShell(cmd). windowsHide is the
    // wrapper's job now, so it isn't in what bufferedSpawn itself passes.
    expect(spawnMock).toHaveBeenCalledWith('echo', ['hi'], expect.objectContaining({ cwd: '/tmp' }));
  });

  it('resolves failure (not throw) on a non-zero exit', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawn('false', []);
    child.emit('close', 2, 'SIGABRT');
    const result = await p;
    expect(result.success).toBe(false);
    expect(result.code).toBe(2);
    expect(result.signal).toBe('SIGABRT');
    expect(result.timedOut).toBe(false);
  });

  it('resolves with the error attached on a spawn error', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawn('nope', []);
    const err = new Error('ENOENT');
    child.emit('error', err);
    const result = await p;
    expect(result.success).toBe(false);
    expect(result.code).toBe(-1);
    expect(result.error).toBe(err);
    expect(result.timedOut).toBe(false);
  });

  it('caps stdout to MAX_OUTPUT_BYTES (keeps the tail)', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawn('big', []);
    child.stdout.emit('data', 'a'.repeat(MAX_OUTPUT_BYTES));
    child.stdout.emit('data', 'TAIL');
    child.emit('close', 0, null);
    const result = await p;
    expect(result.stdout.length).toBe(MAX_OUTPUT_BYTES);
    expect(result.stdout.endsWith('TAIL')).toBe(true);
    expect(result.stdout.startsWith('a')).toBe(true);
  });

  it('times out: resolves at the deadline, then SIGKILLs a child that ignores SIGTERM after its grace period', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawn('hang', [], { timeoutMs: 1000, killGraceMs: 80 });
    child.stdout.emit('data', 'partial');
    vi.advanceTimersByTime(1000);
    const result = await p;
    expect(result.timedOut).toBe(true);
    expect(result.success).toBe(false);
    expect(result.code).toBe(-1);
    expect(result.stdout).toBe('partial');
    if (!IS_WIN32) expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    vi.advanceTimersByTime(80);
    if (!IS_WIN32) expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
  });

  it('does not escalate when the child exits during the SIGTERM grace period', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawn('hang', [], { timeoutMs: 1000, killGraceMs: 80 });
    vi.advanceTimersByTime(1000);
    await p;
    child.exitCode = 0;
    child.signalCode = 'SIGTERM';
    vi.advanceTimersByTime(80);
    if (!IS_WIN32) expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('a close after timeout does not double-resolve (settled guard)', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawn('hang', [], { timeoutMs: 500 });
    vi.advanceTimersByTime(500);
    child.emit('close', 0, null); // late close — must be ignored
    const result = await p;
    expect(result.timedOut).toBe(true);
  });

  it('respects an explicit shell override', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawn('cmd', [], { shell: true });
    child.emit('close', 0, null);
    await p;
    expect(spawnMock).toHaveBeenCalledWith('cmd', [], expect.objectContaining({ shell: true }));
  });
});

describe('bufferedSpawnOrThrow — throwing adapter', () => {
  it('resolves { stdout, stderr } on a clean exit', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawnOrThrow('git', ['pull'], { cwd: '/repo' });
    child.stdout.emit('data', 'Already up to date.');
    child.emit('close', 0, null);
    await expect(p).resolves.toEqual({ stdout: 'Already up to date.', stderr: '' });
  });

  it('throws the spawn error', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawnOrThrow('nope', []);
    const err = new Error('boom');
    child.emit('error', err);
    await expect(p).rejects.toBe(err);
  });

  it('throws using stderr on a non-zero exit', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawnOrThrow('npm', ['install']);
    child.stderr.emit('data', '  npm ERR! failed  ');
    child.emit('close', 1, null);
    await expect(p).rejects.toThrow('npm ERR! failed');
  });

  it('throws "exited with code" when stderr is empty', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawnOrThrow('make', []);
    child.emit('close', 7, null);
    await expect(p).rejects.toThrow('make exited with code 7');
  });

  it('throws a timeout message using the command name', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawnOrThrow('npm', ['install'], { timeoutMs: 2000 });
    const assertion = expect(p).rejects.toThrow('npm timed out after 2s');
    vi.advanceTimersByTime(2000);
    await assertion;
  });

  it('uses timeoutLabel when provided', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = bufferedSpawnOrThrow('npm', ['run', 'setup'], { timeoutMs: 3000, timeoutLabel: 'Setup' });
    const assertion = expect(p).rejects.toThrow('Setup timed out after 3s');
    vi.advanceTimersByTime(3000);
    await assertion;
  });
});

describe('spawnFailureDetail', () => {
  const fallback = 'mtplx exited with code 1';

  it('prefers the spawn error, which is the only stream a failed spawn writes to', () => {
    expect(spawnFailureDetail({ error: new Error('EACCES'), stderr: 'noise' }, fallback)).toBe('EACCES');
  });

  it('falls back to the last stderr line', () => {
    expect(spawnFailureDetail({ stderr: 'warning: slow\nerror: not cached\n' }, fallback)).toBe('error: not cached');
  });

  it('ignores a stdout tail that is only JSON punctuation', () => {
    // A `--json` CLI prints its payload to stdout even when it exits non-zero,
    // so the naive last-stdout-line walk surfaces a bare closing brace.
    expect(spawnFailureDetail({ stdout: '{\n  "removed": false\n}' }, fallback)).toBe(fallback);
    expect(spawnFailureDetail({ stdout: '{\n  "removed": false\n},' }, fallback)).toBe(fallback);
  });

  it('still uses a meaningful stdout line when stderr is empty', () => {
    expect(spawnFailureDetail({ stderr: '', stdout: 'error: pull failed' }, fallback)).toBe('error: pull failed');
  });

  it('returns the fallback when the command failed without saying anything', () => {
    expect(spawnFailureDetail({}, fallback)).toBe(fallback);
    expect(spawnFailureDetail(null, fallback)).toBe(fallback);
  });
});

describe('guardChildStdin', () => {
  // An 'error' on a stream with no listener is re-thrown by Node. Every CLI-agent
  // spawn site runs outside the Express request lifecycle, so that throw takes the
  // whole server process down — with every live agent run, PTY shell and socket on
  // it. This is the contract every CLI spawn site that writes stdin relies on.
  it('swallows an EPIPE emitted on the child stdin pipe', () => {
    const child = { stdin: new EventEmitter() };
    guardChildStdin(child);
    expect(() => child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
  });

  it('proves the fake really is unguarded without it (bypass probe)', () => {
    const child = { stdin: new EventEmitter() };
    expect(() => child.stdin.emit('error', new Error('write EPIPE'))).toThrow('write EPIPE');
  });

  it('is a no-op for a spawn that failed command lookup and has no stdio at all', () => {
    expect(() => guardChildStdin({})).not.toThrow();
    expect(() => guardChildStdin(null)).not.toThrow();
  });

  it('returns the child so it can be chained at a spawn site', () => {
    const child = { stdin: new EventEmitter() };
    expect(guardChildStdin(child)).toBe(child);
  });
});

describe('deliverChildStdin', () => {
  const streamStdin = (overrides = {}) => Object.assign(new EventEmitter(), {
    write: vi.fn(), end: vi.fn(), destroy: vi.fn(), ...overrides,
  });

  it('writes the payload and closes the pipe', () => {
    const child = { stdin: streamStdin() };
    expect(deliverChildStdin(child, 'prompt', 'run r1')).toBe(true);
    expect(child.stdin.write).toHaveBeenCalledWith('prompt');
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it('closes the pipe without writing when the prompt already went out by argv', () => {
    const child = { stdin: streamStdin() };
    expect(deliverChildStdin(child, null, 'run r1')).toBe(true);
    expect(child.stdin.write).not.toHaveBeenCalled();
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it('destroys the pipe and logs when write throws, instead of letting it escape', () => {
    // A bare swallow would leave a child that IS reading stdin waiting on a
    // write that never lands, and file the resulting empty run as clean (#5655).
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const child = { stdin: streamStdin({ write: vi.fn(() => { throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }); }) }) };

    expect(deliverChildStdin(child, 'prompt', 'run r1')).toBe(false);

    expect(child.stdin.destroy).toHaveBeenCalled();
    expect(consoleSpy.mock.calls[0][0]).toContain('❌ run r1 stdin write failed');
    expect(consoleSpy.mock.calls[0][0]).toContain('EPIPE');
    consoleSpy.mockRestore();
  });

  it('survives a spawn that failed command lookup and has no stdio at all', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(deliverChildStdin({}, 'prompt', 'run r1')).toBe(false);
    consoleSpy.mockRestore();
  });
});
