import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { resolveSpawnCwd } from './spawnCwd.js';

describe('resolveSpawnCwd', () => {
  let dir;
  let logSpy;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spawncwd-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the workspace when it exists', () => {
    expect(resolveSpawnCwd(dir, '/fallback')).toBe(dir);
  });

  it('falls back to the root when no workspace was supplied', () => {
    expect(resolveSpawnCwd(undefined, '/fallback')).toBe('/fallback');
    expect(resolveSpawnCwd(null, '/fallback')).toBe('/fallback');
    expect(resolveSpawnCwd('', '/fallback')).toBe('/fallback');
  });

  // "Nothing supplied" and "something blank supplied" must not collapse.
  // repoPath is validated as z.string().min(1), so an app CAN hold "   ";
  // treating that as absent hands the run the PortOS root and silently writes
  // there — the bug this module exists to prevent, through the one input the
  // schema still allows.
  it('rejects a whitespace-only workspace instead of falling back', () => {
    expect(() => resolveSpawnCwd('   ', '/fallback')).toThrow(/blank/);
    expect(() => resolveSpawnCwd('\t\n ', '/fallback')).toThrow(/Repository Path/);
  });

  it('logs the effective cwd so a run is never silently misrouted', () => {
    resolveSpawnCwd(dir, '/fallback', 'Run abc');
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Run abc');
    expect(logSpy.mock.calls.flat().join('\n')).toContain(dir);

    logSpy.mockClear();
    resolveSpawnCwd('', '/fallback', 'Run xyz');
    expect(logSpy.mock.calls.flat().join('\n')).toContain('no workspace selected');
  });

  // The #3180 regression: a workspace was requested but does not exist. The old
  // behavior spawned in the PortOS root anyway, so the agent's relative file
  // writes landed in the wrong repo with no error anywhere.
  it('throws instead of falling back when the requested workspace is missing', () => {
    const missing = join(dir, 'no-such-repo');
    expect(() => resolveSpawnCwd(missing, '/fallback')).toThrow(/does not exist/);
    expect(() => resolveSpawnCwd(missing, '/fallback')).toThrow(/Repository Path/);
  });

  it('throws when the requested workspace is a file, not a directory', () => {
    const file = join(dir, 'a-file.txt');
    writeFileSync(file, 'x');
    expect(() => resolveSpawnCwd(file, '/fallback')).toThrow(/not a directory/);
  });
});

describe('resolveSpawnCwd — home expansion', () => {
  // repoPath is only validated as a non-empty string, so a user can save
  // `~/Projects/App`. Without expansion the new guard would hard-fail it with a
  // message naming a path that was never meant to be literal.
  it('expands a leading ~ instead of rejecting it as missing', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(resolveSpawnCwd('~', '/fallback')).toBe(homedir());
    logSpy.mockRestore();
  });
});

// Two review rounds each surfaced a different *input shape* that collapsed back
// into the silent fallback (`~` rejected as missing, a file accepted as a repo,
// whitespace-only treated as absent). The shapes differ; the invariant doesn't:
//
//   a workspace that was SUPPLIED but is not a usable directory must never
//   resolve to fallbackRoot — it throws, or it returns the real directory.
//
// Enumerating the shape space and asserting the invariant catches the next
// variant without waiting for a reviewer to name it.
describe('resolveSpawnCwd — supplied-but-unusable never reaches the fallback', () => {
  let dir, file, logSpy;
  const FALLBACK = '/the-portos-checkout';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spawncwd-inv-'));
    file = join(dir, 'a-file.txt');
    writeFileSync(file, 'x');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('never returns the fallback for any supplied-but-unusable shape', () => {
    const unusable = () => [
      '   ', '\t', '\n', ' \t\n ',            // blank after trim
      join(dir, 'no-such-dir'),                // missing
      join(dir, 'no', 'such', 'nested'),       // missing, nested
      file,                                    // exists but is a file
      `${file}  `,                             // file with trailing space
      '~/definitely-not-a-real-portos-dir',    // expands, still missing
    ];
    for (const shape of unusable()) {
      let result, threw = false;
      try { result = resolveSpawnCwd(shape, FALLBACK); } catch { threw = true; }
      expect(threw, `expected ${JSON.stringify(shape)} to be rejected`).toBe(true);
      expect(result, `${JSON.stringify(shape)} must never resolve to the fallback`).not.toBe(FALLBACK);
    }
  });

  it('returns the real directory for usable shapes, never the fallback', () => {
    for (const shape of [dir, `  ${dir}  `, `${dir}/`]) {
      const result = resolveSpawnCwd(shape, FALLBACK);
      expect(result).not.toBe(FALLBACK);
      expect(result.replace(/\/$/, '')).toBe(dir);
    }
  });

  // The complement: only a genuinely ABSENT workspace earns the fallback.
  it('returns the fallback only for absent shapes', () => {
    for (const shape of [undefined, null, '']) {
      expect(resolveSpawnCwd(shape, FALLBACK)).toBe(FALLBACK);
    }
  });
});
