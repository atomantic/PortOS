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
