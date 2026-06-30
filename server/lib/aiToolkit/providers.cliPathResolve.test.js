import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock child_process so testProvider's command-resolution branch runs against a
// controllable `which`/`where` + version probe instead of the host's real PATH.
// execFile is replaced with a plain vi.fn (the real one carries a custom
// util.promisify symbol; the mock doesn't, so promisify resolves to the single
// value we hand the callback — we pass a `{ stdout, stderr }` object to keep the
// `const { stdout } = await execFileAsync(...)` destructure working).
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFile: vi.fn() };
});

import { execFile } from 'child_process';
import { createProviderService } from './providers.js';

const TEST_DATA_DIR = join(process.cwd(), 'test-data-cli-resolve');

describe('testProvider — cli command resolution (cross-platform PATH)', () => {
  let providerService;
  let originalPlatform;
  let originalPath;
  let fakePathDir;

  beforeEach(async () => {
    originalPlatform = process.platform;
    if (!existsSync(TEST_DATA_DIR)) await mkdir(TEST_DATA_DIR, { recursive: true });
    providerService = createProviderService({ dataDir: TEST_DATA_DIR, providersFile: 'providers.json' });
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
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    process.env.PATH = originalPath;
    await rm(fakePathDir, { recursive: true, force: true });
    vi.mocked(execFile).mockReset();
    if (existsSync(TEST_DATA_DIR)) await rm(TEST_DATA_DIR, { recursive: true });
  });

  const setPlatform = (value) => Object.defineProperty(process, 'platform', { value, configurable: true });

  // execFile's callback is always its last argument — the version probe now
  // passes an extra `{ shell }` options object (4 args) while the which/where
  // lookup stays at 3, so find the callback positionally instead of assuming
  // a fixed arity.
  const lastCallback = (args) => args[args.length - 1];

  // Drive the mocked execFile: `lookup` is the stdout the which/where call emits,
  // `version` is the stdout the resolved-binary --version probe emits.
  const stubExec = ({ lookup, version = 'claude 1.0.0\n' }) => {
    vi.mocked(execFile).mockImplementation((cmd, ...rest) => {
      const cb = lastCallback(rest);
      if (cmd === 'which' || cmd === 'where') {
        if (lookup === null) return cb(new Error('not found'));
        return cb(null, { stdout: lookup, stderr: '' });
      }
      // version probe against the resolved path
      return cb(null, { stdout: version, stderr: '' });
    });
  };

  const makeCliProvider = (command = 'claude') =>
    providerService.createProvider({ name: 'Claude CLI', type: 'cli', command });

  it('uses `where` (not `which`) on win32 and reports success when the command resolves', async () => {
    setPlatform('win32');
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
  });

  it('takes the first line when `where` returns multiple matches', async () => {
    setPlatform('win32');
    stubExec({ lookup: 'C:\\a\\claude.exe\r\nC:\\b\\claude.exe\r\n' });
    const p = await makeCliProvider();

    const result = await providerService.testProvider(p.id);

    expect(result.success).toBe(true);
    expect(result.path).toBe('C:\\a\\claude.exe');
  });

  it('re-resolves to the real .cmd shim when `where`s first match is an unspawnable extension-less stub (#1865 root cause)', async () => {
    setPlatform('win32');
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
    expect(versionCall?.length).toBe(3);
    expect(typeof versionCall?.[2]).toBe('function');
  });

  it('falls back to the where-resolved path when no extension-bearing match exists on PATH', async () => {
    setPlatform('win32');
    // fakePathDir intentionally has no claude.* files — resolveWindowsExecutable
    // finds nothing, so testProvider must fall back to the `where` result.
    stubExec({ lookup: 'C:\\Users\\Joe\\.local\\bin\\claude.exe\r\n' });
    const p = await makeCliProvider();

    const result = await providerService.testProvider(p.id);

    expect(result.success).toBe(true);
    expect(result.path).toBe('C:\\Users\\Joe\\.local\\bin\\claude.exe');
  });

  it('invokes the resolved path for the version probe (so win32 runs the exact .exe)', async () => {
    setPlatform('win32');
    stubExec({ lookup: 'C:\\Users\\Joe\\.local\\bin\\claude.exe\r\n' });
    const p = await makeCliProvider();

    await providerService.testProvider(p.id);

    const versionCall = vi.mocked(execFile).mock.calls.find((c) => c[0] !== 'where' && c[0] !== 'which');
    expect(versionCall?.[0]).toBe('C:\\Users\\Joe\\.local\\bin\\claude.exe');
    expect(versionCall?.[1]).toEqual(['--version']);
  });

  it('uses `which` on non-win32 platforms', async () => {
    setPlatform('linux');
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
    setPlatform('win32');
    stubExec({ lookup: null });
    const p = await makeCliProvider('claude');

    const result = await providerService.testProvider(p.id);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Command 'claude' not found in PATH");
  });

  it('falls back to "available" when the binary spawns but supports no version flag', async () => {
    setPlatform('linux');
    vi.mocked(execFile).mockImplementation((cmd, ...rest) => {
      const cb = lastCallback(rest);
      if (cmd === 'which' || cmd === 'where') return cb(null, { stdout: '/usr/local/bin/claude\n', stderr: '' });
      // The binary ran (it's spawnable) but exited non-zero on the unknown flag —
      // a numeric exit code is how Node surfaces a non-zero exit from execFile.
      const e = new Error('Command failed: claude --version'); e.code = 1;
      return cb(e);
    });
    const p = await makeCliProvider();

    const result = await providerService.testProvider(p.id);

    expect(result.success).toBe(true);
    expect(result.version).toBe('available');
  });

  it('reports failure when the resolved path cannot be spawned (Windows .cmd/.bat shim)', async () => {
    setPlatform('win32');
    vi.mocked(execFile).mockImplementation((cmd, ...rest) => {
      const cb = lastCallback(rest);
      if (cmd === 'which' || cmd === 'where') return cb(null, { stdout: 'C:\\Users\\Joe\\AppData\\npm\\claude.cmd\r\n', stderr: '' });
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
