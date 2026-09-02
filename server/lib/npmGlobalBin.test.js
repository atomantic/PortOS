import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { adoptNpmGlobalBinDir, __resetNpmGlobalBinCache } from './npmGlobalBin.js';

const IS_WIN = process.platform === 'win32';

// npm answers with the PREFIX; the bin directory is the prefix itself on
// Windows and `<prefix>/bin` everywhere else.
const binDirFor = (prefix) => (IS_WIN ? prefix : join(prefix, 'bin'));
const npmAnswering = (prefix) => vi.fn(async () => ({ stdout: `${prefix}\n` }));

describe('adoptNpmGlobalBinDir', () => {
  let root;
  let originalPath;

  beforeEach(() => {
    __resetNpmGlobalBinCache();
    root = mkdtempSync(join(tmpdir(), 'portos-npm-prefix-'));
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  });

  it('puts npm\'s own global bin directory on PATH, once, for concurrent callers', async () => {
    const binDir = binDirFor(root);
    mkdirSync(binDir, { recursive: true });
    const spawnImpl = npmAnswering(root);

    const both = await Promise.all([
      adoptNpmGlobalBinDir({ spawnImpl }),
      adoptNpmGlobalBinDir({ spawnImpl }),
    ]);

    expect(both).toEqual([binDir, binDir]);
    expect(process.env.PATH.split(delimiter).filter((entry) => entry === binDir)).toHaveLength(1);
    // The Providers page probes every runtime at once, and each one asks.
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    // Windows wraps npm's .cmd shim as `cmd.exe /c <path> …` — the fixed
    // subcommand is the tail either way, and never a shell string.
    const [, args, options] = spawnImpl.mock.calls[0];
    expect(args.slice(-2)).toEqual(['prefix', '-g']);
    expect(options.shell).toBe(false);
  });

  it('answers null when npm cannot be asked, without falling back to a guess', async () => {
    const spawnImpl = vi.fn(async () => { throw new Error('ENOENT'); });

    await expect(adoptNpmGlobalBinDir({ spawnImpl })).resolves.toBeNull();
    expect(process.env.PATH).toBe(originalPath);
  });

  // The prefix directory does not exist until the first global install, and
  // making that install visible without a restart is the whole point — so the
  // on-disk check must NOT be cached alongside npm's answer.
  it('adopts a prefix that only appears after the first global install', async () => {
    const binDir = binDirFor(root);
    rmSync(root, { recursive: true, force: true });
    const spawnImpl = npmAnswering(root);

    await expect(adoptNpmGlobalBinDir({ spawnImpl })).resolves.toBeNull();
    expect(process.env.PATH).toBe(originalPath);

    mkdirSync(binDir, { recursive: true });
    await expect(adoptNpmGlobalBinDir({ spawnImpl })).resolves.toBe(binDir);
    expect(process.env.PATH.split(delimiter)).toContain(binDir);
    // Still one probe: only the existence check re-runs.
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });
});
