import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';

// Mock child_process so testProvider's command-resolution branch runs against a
// controllable `which`/`where` + version probe instead of the host's real PATH.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFile: vi.fn(), spawn: vi.fn() };
});

import { execFile, spawn } from 'child_process';
import { createProviderService } from './providers.js';
import { pinPlatform } from '../testHelper.js';

// Temp dir, NOT a cwd-rooted one — see providerStatus.test.js (#3823).
let TEST_DATA_DIR;

describe('testProvider — cli command resolution (cross-platform PATH)', () => {
  let providerService;
  // Captured before any pin so the restore is the pristine descriptor, whether
  // or not a given case pinned.
  let restorePlatform = () => {};
  let originalPath;
  let fakePathDir;
  let nextFakePid = 10_000;

  beforeEach(async () => {
    restorePlatform = pinPlatform(process.platform);
    TEST_DATA_DIR = await mkdtemp(join(tmpdir(), 'portos-cli-resolve-'));
    providerService = createProviderService({ dataDir: TEST_DATA_DIR, providersFile: 'providers.json' });
    vi.mocked(spawn).mockImplementation(() => {
      const child = new EventEmitter();
      child.kill = vi.fn();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    // testProvider's win32 path now ALSO does its own filesystem-based
    // re-resolution (resolveWindowsExecutable) independent of the mocked
    // `where`/`which` lookup below — point PATH at a controlled, normally-empty
    // temp dir so that re-resolution can't accidentally match something on the
    // real host running this suite, and so tests can opt in to a match by
    // writing a file into it.
    originalPath = process.env.PATH;
    fakePathDir = await mkdtemp(join(tmpdir(), 'provider-test-path-'));
    process.env.PATH = fakePathDir;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    restorePlatform();
    process.env.PATH = originalPath;
    if (fakePathDir) await rm(fakePathDir, { recursive: true, force: true });
    vi.mocked(execFile).mockReset();
    if (TEST_DATA_DIR) await rm(TEST_DATA_DIR, { recursive: true, force: true });
  });

  // execFile's callback is always its last argument; options vary between the
  // lookup and version calls, so find the callback positionally.
  const lastCallback = (args) => args[args.length - 1];

  const mockOwnedGroupCleanup = (pid) => {
    vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target === -pid && signal === 0) {
        const error = new Error('process group is gone');
        error.code = 'ESRCH';
        throw error;
      }
      if (target === -pid && signal === 'SIGKILL') return true;
      throw new Error(`Unexpected process.kill(${target}, ${signal})`);
    });
  };

  const makeProbeChild = () => {
    const pid = nextFakePid++;
    if (process.platform !== 'win32') mockOwnedGroupCleanup(pid);
    return {
      pid,
      kill: vi.fn(),
      stdin: { destroy: vi.fn() },
      stdout: { destroy: vi.fn() },
      stderr: { destroy: vi.fn() },
      once: vi.fn(),
    };
  };

  // Drive the mocked execFile: `lookup` is the stdout the which/where call emits,
  // `version` is the stdout the resolved-binary --version probe emits.
  const stubExec = ({ lookup, version = 'claude 1.0.0\n' }) => {
    vi.mocked(execFile).mockImplementation((cmd, ...rest) => {
      const cb = lastCallback(rest);
      if (cmd === 'which' || cmd === 'where') {
        if (lookup === null) return cb(new Error('not found'));
        return cb(null, lookup, '');
      }
      // version probe against the resolved path
      const child = makeProbeChild();
      cb(null, version, '');
      return child;
    });
  };

  const makeCliProvider = (command = 'claude') =>
    providerService.createProvider({ name: 'Claude CLI', type: 'cli', command });

  it('uses `where` (not `which`) on win32 and reports success when the command resolves', async () => {
    pinPlatform('win32');
    stubExec({ lookup: 'C:\\Users\\Joe\\.local\\bin\\claude.exe\r\n' });
    const p = await makeCliProvider();

    const result = await providerService.testProvider(p.id);

    expect(result.success).toBe(true);
    expect(result.path).toBe('C:\\Users\\Joe\\.local\\bin\\claude.exe');
    expect(result.version).toBe('claude 1.0.0');
    // The lookup must have gone through `where`, never `which`, on Windows.
    const lookupCmds = vi.mocked(execFile).mock.calls.map((c) => c[0]);
    expect(lookupCmds).toContain('where');
    expect(lookupCmds).not.toContain('which');
    const lookupCall = vi.mocked(execFile).mock.calls.find((c) => c[0] === 'where');
    expect(lookupCall?.[2]).toMatchObject({ timeout: 0, windowsHide: true });
    expect(lookupCall?.[2]).not.toHaveProperty('killSignal');
    // Successful completion means the direct process has exited. Do not run
    // taskkill against its possibly reused PID on the normal path.
    expect(spawn).not.toHaveBeenCalled();
  });

  it('takes the first line when `where` returns multiple matches', async () => {
    pinPlatform('win32');
    stubExec({ lookup: 'C:\\a\\claude.exe\r\nC:\\b\\claude.exe\r\n' });
    const p = await makeCliProvider();

    const result = await providerService.testProvider(p.id);

    expect(result.success).toBe(true);
    expect(result.path).toBe('C:\\a\\claude.exe');
  });

  it('re-resolves to the real .cmd shim when `where`s first match is an unspawnable extension-less stub (#1865 root cause)', async () => {
    pinPlatform('win32');
    // npm ships a bare POSIX shell-script stub (for Git Bash/WSL) alongside
    // the real `.cmd` wrapper — `where` can return the stub first, which is
    // exactly the literal scenario from the issue's reported error text.
    await writeFile(join(fakePathDir, 'opencode'), '#!/bin/sh\n');
    await writeFile(join(fakePathDir, 'opencode.cmd'), '@echo off\n');
    stubExec({ lookup: `${join(fakePathDir, 'opencode')}\r\n`, version: 'opencode 1.0.0\n' });
    const p = await makeCliProvider('opencode');

    const result = await providerService.testProvider(p.id);

    expect(result.success).toBe(true);
    expect(result.path).toBe(join(fakePathDir, 'opencode.cmd'));
    const versionCall = vi.mocked(execFile).mock.calls.find((c) => c[0] !== 'where' && c[0] !== 'which');
    // The re-resolved .cmd target can't be launched directly under
    // shell:false even with the explicit extension (Node refuses it
    // outright post-CVE-2024-27980) — it's wrapped through cmd.exe /c,
    // Node's documented safe pattern (no shell:true, no DEP0190 hazard).
    expect(versionCall?.[0]).toBe('cmd.exe');
    expect(versionCall?.[1]).toEqual(['/c', join(fakePathDir, 'opencode.cmd'), '--version']);
    // (file, args, options, callback) — the options slot carries windowsHide so
    // this probe can't pop a console window out of a PM2 fork on Windows.
    expect(versionCall?.length).toBe(4);
    expect(versionCall?.[2]).toMatchObject({
      windowsHide: true,
      timeout: 0,
    });
    expect(versionCall?.[2]).not.toHaveProperty('killSignal');
    expect(typeof versionCall?.[3]).toBe('function');
  });

  it('falls back to the where-resolved path when no extension-bearing match exists on PATH', async () => {
    pinPlatform('win32');
    // fakePathDir intentionally has no claude.* files — resolveWindowsExecutable
    // finds nothing, so testProvider must fall back to the `where` result.
    stubExec({ lookup: 'C:\\Users\\Joe\\.local\\bin\\claude.exe\r\n' });
    const p = await makeCliProvider();

    const result = await providerService.testProvider(p.id);

    expect(result.success).toBe(true);
    expect(result.path).toBe('C:\\Users\\Joe\\.local\\bin\\claude.exe');
  });

  it('invokes the resolved path for the version probe (so win32 runs the exact .exe)', async () => {
    pinPlatform('win32');
    stubExec({ lookup: 'C:\\Users\\Joe\\.local\\bin\\claude.exe\r\n' });
    const p = await makeCliProvider();

    await providerService.testProvider(p.id);

    const versionCall = vi.mocked(execFile).mock.calls.find((c) => c[0] !== 'where' && c[0] !== 'which');
    expect(versionCall?.[0]).toBe('C:\\Users\\Joe\\.local\\bin\\claude.exe');
    expect(versionCall?.[1]).toEqual(['--version']);
  });

  it('uses `which` on non-win32 platforms', async () => {
    pinPlatform('linux');
    stubExec({ lookup: '/usr/local/bin/claude\n' });
    const p = await makeCliProvider();

    const result = await providerService.testProvider(p.id);

    expect(result.success).toBe(true);
    expect(result.path).toBe('/usr/local/bin/claude');
    const lookupCmds = vi.mocked(execFile).mock.calls.map((c) => c[0]);
    expect(lookupCmds).toContain('which');
    expect(lookupCmds).not.toContain('where');
  });

  it('reports not-found when the lookup resolves nothing', async () => {
    pinPlatform('win32');
    stubExec({ lookup: null });
    const p = await makeCliProvider('claude');

    const result = await providerService.testProvider(p.id);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Command 'claude' not found in PATH");
  });

  it('reports a timed-out command lookup separately from a missing command', async () => {
    pinPlatform('linux');
    vi.mocked(execFile).mockImplementation((cmd, ...rest) => {
      const cb = lastCallback(rest);
      if (cmd !== 'which') throw new Error(`Unexpected command: ${cmd}`);
      // Node's execFile timeout callback has code=null and exposes `killed`
      // plus the signal; it does not set code=ETIMEDOUT.
      const err = Object.assign(new Error('Command failed: which slow-which'), {
        code: null,
        killed: true,
        signal: 'SIGKILL',
      });
      return cb(err);
    });
    const p = await makeCliProvider('slow-which');

    const result = await providerService.testProvider(p.id);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Timed out looking up command 'slow-which'/);
    expect(result.error).not.toMatch(/not found/);
    expect(vi.mocked(execFile).mock.calls[0][2]).toMatchObject({ timeout: 0 });
    expect(vi.mocked(execFile).mock.calls).toHaveLength(1);
  });

  it('does not start the version probe when lookup cleanup is unconfirmed', async () => {
    pinPlatform('linux');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('permission denied');
      error.code = 'EPERM';
      throw error;
    });
    vi.mocked(execFile).mockImplementation((cmd, ...rest) => {
      const cb = lastCallback(rest);
      if (cmd !== 'which') throw new Error(`Unexpected command after unsafe lookup: ${cmd}`);
      cb(null, '/usr/local/bin/slow-which\n', '');
      return {
        pid: 2468,
        kill: vi.fn(),
        stdin: { destroy: vi.fn() },
        stdout: { destroy: vi.fn() },
        stderr: { destroy: vi.fn() },
        once: vi.fn(),
      };
    });
    const p = await makeCliProvider('slow-which');

    const result = await providerService.testProvider(p.id);

    expect(result).toMatchObject({ success: false });
    expect(result.error).toMatch(/cleanup after looking up/);
    expect(vi.mocked(execFile).mock.calls).toHaveLength(1);
  });

  it('treats Node execFile timeout results as a spawned CLI with no version', async () => {
    pinPlatform('linux');
    vi.mocked(execFile).mockImplementation((cmd, ...rest) => {
      const cb = lastCallback(rest);
      if (cmd === 'which') return cb(null, '/usr/local/bin/slow-cli\n', '');
      mockOwnedGroupCleanup(4321);
      const err = Object.assign(new Error('Command failed: slow-cli --version'), {
        code: null,
        killed: true,
        signal: 'SIGKILL',
      });
      cb(err);
      return {
        pid: 4321,
        kill: vi.fn(),
        stdin: { destroy: vi.fn() },
        stdout: { destroy: vi.fn() },
        stderr: { destroy: vi.fn() },
        once: vi.fn(),
      };
    });
    const p = await makeCliProvider('slow-cli');

    const result = await providerService.testProvider(p.id);

    expect(result).toMatchObject({ success: true, path: '/usr/local/bin/slow-cli', version: 'available' });
    const versionCalls = vi.mocked(execFile).mock.calls.filter(([cmd]) => cmd !== 'which' && cmd !== 'where');
    expect(versionCalls).toHaveLength(1);
    expect(versionCalls[0][1]).toEqual(['--version']);
  });

  it('does not report a timed-out CLI as available when cleanup cannot be confirmed', async () => {
    pinPlatform('linux');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('permission denied');
      error.code = 'EPERM';
      throw error;
    });
    vi.mocked(execFile).mockImplementation((cmd, ...rest) => {
      const cb = lastCallback(rest);
      if (cmd === 'which') return cb(null, '/usr/local/bin/slow-cli\n', '');
      cb(Object.assign(new Error('Command failed: slow-cli --version'), {
        code: null,
        killed: true,
        signal: 'SIGKILL',
      }));
      return {
        pid: 9876,
        kill: vi.fn(),
        stdin: { destroy: vi.fn() },
        stdout: { destroy: vi.fn() },
        stderr: { destroy: vi.fn() },
        once: vi.fn(),
      };
    });
    const p = await makeCliProvider('slow-cli');

    const result = await providerService.testProvider(p.id);

    expect(result).toMatchObject({ success: false });
    expect(result.error).toMatch(/process cleanup could not be confirmed/);
    expect(result.version).toBeUndefined();
  });

  it('kills and settles a CLI that never closes at the version-probe deadline', async () => {
    pinPlatform('linux');
    vi.useFakeTimers();
    mockOwnedGroupCleanup(1234);
    let versionProbeStarted;
    let hangingChild;
    const started = new Promise((resolve) => { versionProbeStarted = resolve; });
    vi.mocked(execFile).mockImplementation((cmd, ...rest) => {
      const cb = lastCallback(rest);
      const options = rest[rest.length - 2];
      if (cmd === 'which') return cb(null, '/usr/local/bin/never-exits\n', '');
      hangingChild = {
        pid: 1234,
        kill: vi.fn(),
        stdin: { destroy: vi.fn() },
        stdout: { destroy: vi.fn() },
        stderr: { destroy: vi.fn() },
        once: vi.fn(),
      };
      versionProbeStarted(options);
      // This simulated ChildProcess deliberately never calls its callback.
      return hangingChild;
    });
    const p = await makeCliProvider('never-exits');

    const testPromise = providerService.testProvider(p.id);
    const versionOptions = await started;
    expect(versionOptions).toMatchObject({ timeout: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await testPromise;

    expect(result).toMatchObject({ success: true, path: '/usr/local/bin/never-exits', version: 'available' });
    expect(process.kill).toHaveBeenCalledWith(-1234, 'SIGKILL');
    expect(hangingChild.stdin.destroy).toHaveBeenCalledOnce();
    expect(hangingChild.stdout.destroy).toHaveBeenCalledOnce();
    expect(hangingChild.stderr.destroy).toHaveBeenCalledOnce();
    const versionCalls = vi.mocked(execFile).mock.calls.filter(([cmd]) => cmd !== 'which' && cmd !== 'where');
    expect(versionCalls).toHaveLength(1);
  });

  it('does not taskkill a Windows probe PID after its parent exited before timeout', async () => {
    pinPlatform('win32');
    vi.useFakeTimers();
    vi.mocked(spawn).mockClear();
    let versionProbeStarted;
    let hangingChild;
    const started = new Promise((resolve) => { versionProbeStarted = resolve; });
    vi.mocked(execFile).mockImplementation((cmd, ...rest) => {
      const cb = lastCallback(rest);
      if (cmd === 'where') return cb(null, 'C:\\tools\\slow-cli.exe\r\n', '');
      hangingChild = new EventEmitter();
      hangingChild.pid = 5678;
      hangingChild.kill = vi.fn();
      hangingChild.stdin = { destroy: vi.fn() };
      hangingChild.stdout = { destroy: vi.fn() };
      hangingChild.stderr = { destroy: vi.fn() };
      versionProbeStarted(rest[rest.length - 2]);
      // The direct process exits but its descendant retains the execFile pipes,
      // so the callback never fires and the watchdog owns the timeout.
      return hangingChild;
    });
    const p = await makeCliProvider('slow-cli');

    const testPromise = providerService.testProvider(p.id);
    await started;
    hangingChild.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await testPromise;

    expect(result).toMatchObject({ success: false });
    expect(result.error).toMatch(/process cleanup could not be confirmed/);
    expect(spawn).not.toHaveBeenCalled();
    expect(hangingChild.kill).not.toHaveBeenCalled();
  });

  it('falls back to "available" when the binary spawns but supports no version flag', async () => {
    pinPlatform('linux');
    vi.mocked(execFile).mockImplementation((cmd, ...rest) => {
      const cb = lastCallback(rest);
      if (cmd === 'which' || cmd === 'where') return cb(null, '/usr/local/bin/claude\n', '');
      // The binary ran (it's spawnable) but exited non-zero on the unknown flag —
      // a numeric exit code is how Node surfaces a non-zero exit from execFile.
      const e = new Error('Command failed: claude --version'); e.code = 1;
      const child = makeProbeChild();
      cb(e);
      return child;
    });
    const p = await makeCliProvider();

    const result = await providerService.testProvider(p.id);

    expect(result.success).toBe(true);
    expect(result.version).toBe('available');
  });

  it('reports failure when the resolved path cannot be spawned (Windows .cmd/.bat shim)', async () => {
    pinPlatform('win32');
    vi.mocked(execFile).mockImplementation((cmd, ...rest) => {
      const cb = lastCallback(rest);
      if (cmd === 'which' || cmd === 'where') return cb(null, 'C:\\Users\\Joe\\AppData\\npm\\claude.cmd\r\n', '');
      // Simulate a genuinely unspawnable shim even after resolveWindowsExecutable
      // picks it (e.g. corrupted/missing target) — a spawn error carries a
      // string code (ENOENT), distinct from a non-zero exit's numeric code.
      const e = new Error('spawn claude.cmd ENOENT'); e.code = 'ENOENT';
      return cb(e);
    });
    const p = await makeCliProvider();

    const result = await providerService.testProvider(p.id);

    expect(result.success).toBe(false);
    expect(result.error).toContain('could not be executed');
    expect(result.path).toBeUndefined();
  });
});
