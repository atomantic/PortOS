import { describe, it, expect } from 'vitest';
import { basename } from 'path';
import { safeChildProcessEnv, stripDebugMallocEnv, whichFirst } from './processEnv.js';

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
