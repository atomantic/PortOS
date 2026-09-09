import { describe, it, expect } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import {
  diagnosePtySpawnFailure,
  probePtyRuntime,
  PTY_UNAVAILABLE_PREFIX,
  PTY_WORKSPACE_MISSING_PREFIX,
} from './ptySpawnDiagnostics.js';

// The exact string node-pty raises for every POSIX launch failure — the whole
// reason this module exists. Nothing in it names which file was missing.
const POSIX_SPAWN_ENOENT = new Error('posix_spawn failed: No such file or directory');

const workingProbe = () => true;
const brokenProbe = () => false;

describe('diagnosePtySpawnFailure', () => {
  it('blames the PTY runtime, not the request, when a known-good probe also fails', () => {
    // The outage this module was written for: `server/node_modules` emptied out
    // from under a live runner, so node-pty's `spawn-helper` is gone and every
    // fork fails — while the requested cwd and command are both perfectly fine.
    const { retryable, message } = diagnosePtySpawnFailure(POSIX_SPAWN_ENOENT, {
      cwd: tmpdir(),
      probeCwd: tmpdir(),
      runtimeProbe: brokenProbe,
    });

    expect(retryable).toBe(false);
    expect(message.startsWith(PTY_UNAVAILABLE_PREFIX)).toBe(true);
    // The repair command is the payload — a diagnosis that omits it leaves the
    // reader exactly where the raw node-pty string did.
    expect(message).toContain('npm install --prefix server');
    expect(message).toContain(POSIX_SPAWN_ENOENT.message);
  });

  it('blames the workspace when the requested cwd is gone, without spending a probe', () => {
    const missing = join(tmpdir(), 'portos-pty-diagnostics-absent-dir');
    let probed = false;

    const { retryable, message } = diagnosePtySpawnFailure(POSIX_SPAWN_ENOENT, {
      cwd: missing,
      probeCwd: tmpdir(),
      runtimeProbe: () => { probed = true; return true; },
    });

    expect(retryable).toBe(false);
    expect(message.startsWith(PTY_WORKSPACE_MISSING_PREFIX)).toBe(true);
    // A reaped worktree says nothing about the runtime; forking to ask would be
    // a wasted process on the one path that already has its answer.
    expect(probed).toBe(false);
  });

  it('stays retryable when the workspace exists and the PTY layer still forks', () => {
    // Neither known fault applies, so the failure is specific to this request and
    // may well be transient. Reporting it as unrecoverable would block a task
    // that a plain retry fixes.
    const err = new Error('resource temporarily unavailable');
    const { retryable, message } = diagnosePtySpawnFailure(err, {
      cwd: tmpdir(),
      probeCwd: tmpdir(),
      runtimeProbe: workingProbe,
    });

    expect(retryable).toBe(true);
    expect(message).toBe('resource temporarily unavailable');
  });

  it('checks the cwd it was handed, not the probe directory', () => {
    // Guards the argument-swap bug: probing a directory that always exists would
    // make the workspace branch permanently unreachable.
    const missing = join(tmpdir(), 'portos-pty-diagnostics-absent-dir-2');
    const { message } = diagnosePtySpawnFailure(POSIX_SPAWN_ENOENT, {
      cwd: missing,
      probeCwd: missing,
      runtimeProbe: brokenProbe,
    });
    expect(message.startsWith(PTY_WORKSPACE_MISSING_PREFIX)).toBe(true);
  });
});

describe('probePtyRuntime', () => {
  it('reports false when the pty module throws, and never lets the probe escape', () => {
    const exploding = { spawn: () => { throw new Error('posix_spawn failed: No such file or directory'); } };
    expect(() => probePtyRuntime(exploding, tmpdir())).not.toThrow();
    expect(probePtyRuntime(exploding, tmpdir())).toBe(false);
  });

  it('reports true — and still cleans up — when the child exits before kill()', () => {
    // `echo` regularly beats the kill, so a throwing kill() must not be read as a
    // broken runtime.
    const alreadyGone = { spawn: () => ({ kill: () => { throw new Error('process not found'); } }) };
    expect(probePtyRuntime(alreadyGone, tmpdir())).toBe(true);
  });

  it('runs the probe in the directory it was given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'portos-pty-probe-'));
    try {
      let seen = null;
      const recording = { spawn: (_cmd, _args, opts) => { seen = opts.cwd; return { kill: () => {} }; } };
      expect(probePtyRuntime(recording, dir)).toBe(true);
      expect(seen).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('actually forks against the real node-pty module', async () => {
    // The one test that would have caught the live outage: it fails exactly when
    // node-pty's on-disk artifacts are missing, which is what an emptied
    // `server/node_modules` produces while the loaded binding still looks fine.
    const pty = await import('node-pty');
    expect(probePtyRuntime(pty, tmpdir())).toBe(true);
  });
});
