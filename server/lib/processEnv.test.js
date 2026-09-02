import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { basename, delimiter, dirname, join } from 'path';
import { adoptPathDirs, buildSafeCliBaseEnv, findCommandOnPath, safeChildProcessEnv, stripDebugMallocEnv, whichFirst } from './processEnv.js';

describe('stripDebugMallocEnv', () => {
  it('drops every key that starts with "Malloc"', () => {
    const out = stripDebugMallocEnv({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      MallocStackLogging: '1',
      MallocScribble: '1',
      MallocCheckHeapEach: '100',
      MallocNanoZone: '0',
    });
    expect(out).toEqual({ PATH: '/usr/bin', HOME: '/Users/x' });
  });

  it('preserves keys that contain but do not start with "Malloc"', () => {
    const out = stripDebugMallocEnv({ MY_MallocFlag: 'keep', MallocFlag: 'drop' });
    expect(out).toEqual({ MY_MallocFlag: 'keep' });
  });

  it('returns an empty object for an empty env', () => {
    expect(stripDebugMallocEnv({})).toEqual({});
  });

  it('does not mutate the input', () => {
    const input = { PATH: '/x', MallocStackLogging: '1' };
    stripDebugMallocEnv(input);
    expect(input).toEqual({ PATH: '/x', MallocStackLogging: '1' });
  });
});

describe('safeChildProcessEnv', () => {
  it('strips process-level Malloc keys and applies overrides', () => {
    const oldPath = process.env.PATH;
    const oldMalloc = process.env.MallocStackLogging;
    const oldPortosTest = process.env.PORTOS_PROCESS_ENV_TEST;
    process.env.PATH = '/usr/bin';
    process.env.MallocStackLogging = '0';
    process.env.PORTOS_PROCESS_ENV_TEST = 'parent';

    try {
      const out = safeChildProcessEnv({
        PORTOS_PROCESS_ENV_TEST: 'child',
        EXTRA: '1',
        MallocOverride: 'drop',
      });

      expect(out.PATH).toBe('/usr/bin');
      expect(out.MallocStackLogging).toBeUndefined();
      expect(out.MallocOverride).toBeUndefined();
      expect(out.PORTOS_PROCESS_ENV_TEST).toBe('child');
      expect(out.EXTRA).toBe('1');
      expect(process.env.MallocStackLogging).toBe('0');
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldMalloc === undefined) delete process.env.MallocStackLogging;
      else process.env.MallocStackLogging = oldMalloc;
      if (oldPortosTest === undefined) delete process.env.PORTOS_PROCESS_ENV_TEST;
      else process.env.PORTOS_PROCESS_ENV_TEST = oldPortosTest;
    }
  });
});

describe('buildSafeCliBaseEnv', () => {
  it('keeps CLI essentials and provider auth while dropping unrelated app variables', () => {
    const env = buildSafeCliBaseEnv({
      PATH: '/usr/bin',
      HOME: '/home/example',
      CODEX_HOME: '/tmp/example-codex',
      SSH_AUTH_SOCK: '/tmp/example-agent.sock',
      GH_TOKEN: 'owner-token',
      GITHUB_TOKEN: 'owner-token-alias',
      ANTHROPIC_API_KEY: 'unselected-provider-key',
      PRIVATE_APP_AUTH_KEYS: 'sidecar-secret',
      PRIVATE_APP_TOKEN: 'sidecar-token',
    });

    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/example',
      CODEX_HOME: '/tmp/example-codex',
      SSH_AUTH_SOCK: '/tmp/example-agent.sock',
      GH_TOKEN: 'owner-token',
      GITHUB_TOKEN: 'owner-token-alias',
    });
  });

  it('keeps only the selected provider auth and drops paid keys for local providers', () => {
    const source = {
      ANTHROPIC_API_KEY: 'claude-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-oauth',
      OPENAI_API_KEY: 'openai-key',
    };

    expect(buildSafeCliBaseEnv(source, { id: 'claude-code', command: 'claude' })).toEqual({
      ANTHROPIC_API_KEY: 'claude-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-oauth',
    });
    expect(buildSafeCliBaseEnv(source, { id: 'opencode-ollama', command: 'opencode', ollamaBacked: true })).toEqual({});
  });

  it('does not mutate the source environment', () => {
    const source = { PATH: '/usr/bin', PRIVATE_APP_AUTH_KEYS: 'sidecar-secret' };
    buildSafeCliBaseEnv(source);
    expect(source).toEqual({ PATH: '/usr/bin', PRIVATE_APP_AUTH_KEYS: 'sidecar-secret' });
  });
});

describe('whichFirst', () => {
  // `node` (both `which node` and `where node`) is on PATH wherever this runs.
  it('resolves an on-PATH binary to an absolute path', async () => {
    const resolved = await whichFirst('node');
    expect(resolved).toBeTruthy();
    expect(basename(resolved).toLowerCase()).toContain('node');
  });

  it('returns the FIRST line when the probe reports several matches', async () => {
    // The contract is single-line: `where` on Windows can print several paths;
    // whichFirst must return exactly one, never a multi-line blob.
    const resolved = await whichFirst('node');
    expect(resolved).not.toContain('\n');
    expect(resolved).not.toContain('\r');
  });

  it('returns null for a binary that is not on PATH', async () => {
    const resolved = await whichFirst('portos-nonexistent-binary-xyz-2392');
    expect(resolved).toBeNull();
  });
});

describe('findCommandOnPath', () => {
  it('resolves against the supplied child PATH without needing which/where', () => {
    const nodePath = process.execPath;
    const resolved = findCommandOnPath(basename(nodePath), {
      env: { PATH: dirname(nodePath), Path: dirname(nodePath) },
    });
    expect(resolved).toBe(nodePath);
  });

  it('returns null when the child PATH excludes the command', () => {
    const resolved = findCommandOnPath(basename(process.execPath), { env: { PATH: '', Path: '' } });
    expect(resolved).toBeNull();
  });

  it('resolves a relative child PATH entry from the child working directory', () => {
    const nodePath = process.execPath;
    const resolved = findCommandOnPath(basename(nodePath), {
      env: { PATH: '.' },
      cwd: dirname(nodePath),
    });
    expect(resolved).toBe(nodePath);
  });
});

describe('adoptPathDirs', () => {
  const IS_WIN = process.platform === 'win32';
  let root;
  let originalPath;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'portos-adopt-path-'));
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  });

  // A package manager that installed into a directory this process's PATH does
  // not name (winget's Links dir, npm's global prefix) is invisible to both
  // findCommandOnPath AND the bare-name spawns children make until it is here.
  it('appends a real directory and reports it, skipping one that does not exist', () => {
    const missing = join(root, 'never-created');

    expect(adoptPathDirs([root, missing])).toEqual([root]);

    const entries = process.env.PATH.split(delimiter);
    expect(entries).toContain(root);
    // A dead entry taxes every later PATH walk, so it must never be added.
    expect(entries).not.toContain(missing);
  });

  it('does not re-add a directory PATH already carries', () => {
    adoptPathDirs([root]);
    const afterFirst = process.env.PATH;

    expect(adoptPathDirs([root, root])).toEqual([]);
    expect(process.env.PATH).toBe(afterFirst);
  });

  // Windows PATH mixes casings freely and its paths are case-insensitive, so a
  // case-sensitive compare would append a duplicate of an entry already there.
  it.runIf(IS_WIN)('matches an existing Windows PATH entry regardless of case', () => {
    process.env.PATH = `${originalPath}${delimiter}${root.toUpperCase()}`;
    const before = process.env.PATH;

    expect(adoptPathDirs([root])).toEqual([]);
    expect(process.env.PATH).toBe(before);
  });
});
