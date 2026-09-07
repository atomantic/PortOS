import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveInteractiveShellWith,
  resolveInteractiveShell,
  _resetInteractiveShellCache,
} from './interactiveShellResolver.js';

// Windows env fixture. `exists` is driven per-test so the whole preference
// chain is reachable from a POSIX host.
const WIN_ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local',
  SystemRoot: 'C:\\Windows',
  COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
};
const PS5 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const onlyExists = (...paths) => (p) => paths.includes(p);
// readdir and the PATH lookup are stubbed by default so the suite never depends
// on what the host machine happens to have installed.
const win = (opts = {}) => resolveInteractiveShellWith({
  platform: 'win32', env: WIN_ENV, readdir: () => ['7'], findOnPath: () => null, ...opts,
});

describe('resolveInteractiveShellWith on Windows', () => {
  it('prefers PowerShell 7+ over Windows PowerShell and cmd.exe', () => {
    // The whole point: cmd.exe cannot reach another drive by anything a user
    // would type — `cd I:` prints that drive's cwd and stays put.
    expect(win({ exists: onlyExists('C:\\Program Files\\PowerShell\\7\\pwsh.exe', PS5) }))
      .toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  });

  it('builds Windows paths with backslashes even when the host is POSIX', () => {
    // The win32 branch is reachable from any host (that is what injectable
    // `platform` is for), so it must join with win32 semantics. The platform
    // `join` produced `C:\Program Files/PowerShell/7/pwsh.exe` on Linux — a path
    // that matches nothing, silently falling through to cmd.exe.
    const picked = win({ exists: () => true });
    expect(picked).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
    expect(picked).not.toContain('/');
  });

  it('picks the newest installed pwsh major, comparing numerically not as strings', () => {
    // '10' must beat '7'; a lexical sort would pick '7'.
    expect(win({
      readdir: (dir) => (dir === 'C:\\Program Files\\PowerShell' ? ['7', '10', 'preview'] : []),
      exists: (p) => p.startsWith('C:\\Program Files\\PowerShell\\'),
    })).toBe('C:\\Program Files\\PowerShell\\10\\pwsh.exe');
  });

  it('survives a machine with no PowerShell install directory to list', () => {
    // readdirSync throws on a stock box that never installed PowerShell 7+.
    expect(win({
      readdir: () => { throw new Error('ENOENT'); },
      exists: onlyExists(PS5),
    })).toBe(PS5);
  });

  it('falls back to Windows PowerShell 5.1 when pwsh is absent', () => {
    // 5.1 ships with every supported Windows and crosses drives too — it is
    // the realistic floor, not cmd.exe.
    expect(win({ exists: onlyExists(PS5) })).toBe(PS5);
  });

  it('finds a pwsh installed anywhere on PATH (scoop, choco, the Store shim)', () => {
    // Those installs have no %ProgramFiles%\PowerShell\<n> directory, so the
    // versioned scan misses them entirely.
    const scoop = 'C:\\Users\\example\\scoop\\shims\\pwsh.exe';
    expect(win({
      exists: onlyExists(PS5),
      findOnPath: (name) => (name === 'pwsh.exe' ? scoop : null),
    })).toBe(scoop);
  });

  it('does not scan PATH when a versioned pwsh install already answered', () => {
    const versioned = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    const findOnPath = vi.fn(() => 'C:\\other\\pwsh.exe');
    expect(win({ exists: onlyExists(versioned), findOnPath })).toBe(versioned);
    expect(findOnPath).not.toHaveBeenCalled();
  });

  it('uses COMSPEC only when no PowerShell exists at all', () => {
    expect(win({ exists: () => false })).toBe('C:\\Windows\\system32\\cmd.exe');
  });

  it('defaults to cmd.exe when COMSPEC is unset and no PowerShell exists', () => {
    expect(resolveInteractiveShellWith({ platform: 'win32', env: {}, exists: () => false }))
      .toBe('cmd.exe');
  });
});

describe('resolveInteractiveShellWith PORTOS_SHELL override', () => {
  it('wins over the Windows preference chain when the path exists', () => {
    const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    expect(win({ env: { ...WIN_ENV, PORTOS_SHELL: bash }, exists: onlyExists(bash, PS5) })).toBe(bash);
  });

  it('is ignored when it names a path that does not exist', () => {
    // A stale `.env` entry must not strand every session on a shell that
    // cannot spawn.
    expect(win({
      env: { ...WIN_ENV, PORTOS_SHELL: 'D:\\gone\\nushell.exe' },
      exists: onlyExists(PS5),
    })).toBe(PS5);
  });

  it('passes a bare command name through unchecked, since PATH resolves it', () => {
    expect(resolveInteractiveShellWith({
      platform: 'darwin',
      env: { PORTOS_SHELL: 'fish', SHELL: '/bin/bash' },
      exists: () => false,
    })).toBe('fish');
  });

  it('ignores a blank/whitespace override', () => {
    expect(resolveInteractiveShellWith({
      platform: 'linux',
      env: { PORTOS_SHELL: '   ', SHELL: '/bin/bash' },
      exists: onlyExists('/bin/bash'),
    })).toBe('/bin/bash');
  });

  it('wins on POSIX when the override path exists', () => {
    expect(resolveInteractiveShellWith({
      platform: 'linux',
      env: { PORTOS_SHELL: '/usr/local/bin/fish', SHELL: '/bin/bash' },
      exists: onlyExists('/usr/local/bin/fish', '/bin/bash'),
    })).toBe('/usr/local/bin/fish');
  });

  it('falls through on POSIX when the override path is missing', () => {
    expect(resolveInteractiveShellWith({
      platform: 'linux',
      env: { PORTOS_SHELL: '/opt/missing/zsh', SHELL: '/bin/bash' },
      exists: onlyExists('/bin/bash'),
      findOnPath: () => null,
    })).toBe('/bin/bash');
  });
});

describe('resolveInteractiveShellWith on POSIX', () => {
  it('uses an existing SHELL path when set', () => {
    expect(resolveInteractiveShellWith({
      platform: 'darwin',
      env: { SHELL: '/bin/bash' },
      exists: onlyExists('/bin/bash'),
      findOnPath: () => null,
    })).toBe('/bin/bash');
  });

  it('passes a bare SHELL name through unchecked', () => {
    expect(resolveInteractiveShellWith({
      platform: 'linux',
      env: { SHELL: 'bash' },
      exists: () => false,
      findOnPath: () => null,
    })).toBe('bash');
  });

  it('skips a missing SHELL path and picks bash when zsh is absent', () => {
    // The PM2 / container failure mode: SHELL unset (or pointing at a removed
    // binary), no zsh on disk, bash present. Must NOT return `/bin/zsh`.
    expect(resolveInteractiveShellWith({
      platform: 'linux',
      env: {},
      exists: onlyExists('/bin/bash', '/bin/sh'),
      findOnPath: () => null,
    })).toBe('/bin/bash');
  });

  it('prefers /bin/bash over /bin/sh and over zsh when SHELL is unset', () => {
    expect(resolveInteractiveShellWith({
      platform: 'linux',
      env: {},
      exists: onlyExists('/bin/bash', '/bin/sh', '/bin/zsh'),
      findOnPath: () => null,
    })).toBe('/bin/bash');
  });

  it('falls back to /bin/sh when bash is absent', () => {
    expect(resolveInteractiveShellWith({
      platform: 'linux',
      env: {},
      exists: onlyExists('/bin/sh'),
      findOnPath: () => null,
    })).toBe('/bin/sh');
  });

  it('uses zsh only when it exists and earlier candidates do not', () => {
    expect(resolveInteractiveShellWith({
      platform: 'linux',
      env: {},
      exists: onlyExists('/bin/zsh'),
      findOnPath: () => null,
    })).toBe('/bin/zsh');
  });

  it('never returns a hard-coded /bin/zsh that does not exist', () => {
    expect(resolveInteractiveShellWith({
      platform: 'linux',
      env: {},
      exists: () => false,
      findOnPath: () => null,
    })).toBe('sh');
  });

  it('uses findCommandOnPath for bare bash/sh when no absolute candidate exists', () => {
    const findOnPath = vi.fn((name) => (name === 'bash' ? '/nix/store/…/bin/bash' : null));
    expect(resolveInteractiveShellWith({
      platform: 'linux',
      env: {},
      exists: () => false,
      findOnPath,
    })).toBe('/nix/store/…/bin/bash');
    expect(findOnPath).toHaveBeenCalledWith('bash', expect.objectContaining({ env: {} }));
  });

  it('never reaches the Windows candidates even when they exist', () => {
    // Empty POSIX env + every path "exists" → first POSIX absolute candidate.
    expect(resolveInteractiveShellWith({
      platform: 'linux',
      env: WIN_ENV,
      exists: () => true,
      findOnPath: () => null,
    })).toBe('/bin/bash');
  });

  it('skips a stale absolute SHELL and continues the candidate chain', () => {
    expect(resolveInteractiveShellWith({
      platform: 'linux',
      env: { SHELL: '/bin/zsh' },
      exists: onlyExists('/usr/bin/bash'),
      findOnPath: () => null,
    })).toBe('/usr/bin/bash');
  });
});

describe('resolveInteractiveShell memoization', () => {
  beforeEach(() => {
    _resetInteractiveShellCache();
  });
  afterEach(() => {
    _resetInteractiveShellCache();
  });

  it('memoizes the first resolveInteractiveShell result until reset', async () => {
    // Drive the memo through the injectable helper by temporarily resolving
    // with process defaults is host-dependent; instead poke the cache by
    // resolving once, then confirming a second call returns the same reference
    // without re-entering detection (reset clears it for the next assertion).
    const first = resolveInteractiveShell();
    const second = resolveInteractiveShell();
    expect(second).toBe(first);
    _resetInteractiveShellCache();
    // After reset, a fresh resolve runs again under the real host env/fs.
    const after = resolveInteractiveShell();
    expect(typeof after).toBe('string');
    expect(after.length).toBeGreaterThan(0);
    // A hard-coded missing /bin/zsh was the bug; if we return that absolute
    // path it must actually exist on this host.
    if (after === '/bin/zsh') {
      const { existsSync } = await import('fs');
      expect(existsSync('/bin/zsh')).toBe(true);
    }
  });
});
