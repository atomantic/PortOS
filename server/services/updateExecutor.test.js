import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { pinPlatform } from '../lib/testHelper.js';

vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: { root: '/mock', data: '/mock/data' }
}));

vi.mock('../lib/detachedSpawn.js', () => ({
  spawnDetached: vi.fn(),
  isDetachedRunning: vi.fn().mockResolvedValue(false)
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./updateChecker.js', () => ({
  recordUpdateResult: vi.fn().mockResolvedValue(undefined),
  getCurrentVersion: vi.fn().mockResolvedValue('1.0.0')
}));

import { spawnDetached, isDetachedRunning } from '../lib/detachedSpawn.js';
import { readFile } from 'fs/promises';
import { getCurrentVersion, recordUpdateResult } from './updateChecker.js';
import { executeUpdate } from './updateExecutor.js';

// The spawnDetached handle deliberately has NO unref (its launcher already
// unref'd), so executeUpdate must never call one.
function createMockChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 12345;
  return child;
}

// A run that reports no progress at all is treated as "the script never ran"
// (#6169), so any test asserting a SUCCESSFUL update has to look like a real
// one and emit at least one STEP line before closing.
const emitStep = (child, line = 'STEP:git-pull:running:Pulling latest changes\n') =>
  child.stdout.emit('data', Buffer.from(line));

// executeUpdate awaits spawnDetached before wiring its event listeners, so
// tests must flush the microtask/immediate queue after calling it and before
// emitting child events, or the emission fires into the void.
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function startUpdate(...args) {
  const promise = executeUpdate(...args);
  await flush();
  // Wrapped in an object so `await startUpdate(...)` does not flatten the
  // still-pending executeUpdate promise (which only settles after 'close').
  return { promise };
}

// executeUpdate picks its interpreter from process.platform, and every test
// below except the win32 one asserts the bash/update.sh command. Pin the
// platform so they see that on a Windows host too. Safe here: updateExecutor.js
// and its (mocked) deps load no native addon that picks a binary from
// process.platform.
let restorePlatform = () => {};

afterEach(() => restorePlatform());

beforeEach(() => {
  restorePlatform = pinPlatform('linux');
  vi.clearAllMocks();
  // Default: marker file not found (tests that need it override this)
  readFile.mockRejectedValue(new Error('ENOENT'));
  getCurrentVersion.mockResolvedValue('1.0.0');
  // Default: no prior update script still running
  isDetachedRunning.mockResolvedValue(false);
});

describe('executeUpdate', () => {
  // Windows goes through spawnDetached too — its supervisor launcher is what
  // makes update.ps1 survive. The plain `spawn(..., { detached: true })` this
  // replaced meant DETACHED_PROCESS, which denies powershell a console:
  // update.ps1 exited 0 within ~100ms without running a line, and pm2's
  // `taskkill /T` would have killed an attached one mid-update anyway (#6169).
  it('launches powershell through spawnDetached on win32', async () => {
    // Re-pin over the file-level linux default; the file-level afterEach still
    // restores the pristine descriptor, so a failure here can't leak win32.
    pinPlatform('win32');
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const { promise } = await startUpdate('v1.0.0', () => {});
    emitStep(child);
    child.emit('close', 0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(spawnDetached).toHaveBeenCalledWith(
      'powershell',
      expect.arrayContaining(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']),
      expect.objectContaining({ controlDir: expect.stringContaining('update-detached') })
    );
    // The still-running guard covers Windows too now that the script survives there.
    expect(isDetachedRunning).toHaveBeenCalledWith(
      expect.stringContaining('update-detached'),
      { executable: 'powershell', args: expect.any(Array) }
    );
  });

  // Regression for the reconcile "shuts down but never restarts" failure: a
  // plain spawn(detached:true) child is still a PPID-descendant of
  // portos-server, so update.sh's own `pm2 delete` tree-killed the script
  // before it could run the final `pm2 start`. POSIX must launch through
  // spawnDetached's double-fork (reparent to init) instead.
  it('launches via spawnDetached with a control dir on POSIX', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const { promise } = await startUpdate('v1.0.0', () => {});
    emitStep(child);
    child.emit('close', 0);
    await promise;

    expect(isDetachedRunning).toHaveBeenCalledWith(
      expect.stringContaining('update-detached'),
      {
        executable: 'bash',
        args: [expect.stringContaining('update.sh')]
      }
    );
    expect(spawnDetached).toHaveBeenCalledWith(
      'bash',
      [expect.stringContaining('update.sh')],
      expect.objectContaining({
        cwd: '/mock',
        controlDir: expect.stringContaining('update-detached')
      })
    );
  });

  it('continues when a stale control PID does not match the update process', async () => {
    isDetachedRunning.mockResolvedValue(false);
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const { promise } = await startUpdate('v1.0.0', () => {});
    emitStep(child);
    child.emit('close', 0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(spawnDetached).toHaveBeenCalledOnce();
  });

  // Reusing the fixed control dir while the prior update script is still
  // alive would let the old supervisor's late `exit` write prematurely close
  // the new handle with the old script's status — so a still-running script
  // must refuse the new update instead of spawning over it.
  it('refuses to spawn while a prior update script is still running', async () => {
    isDetachedRunning.mockResolvedValue(true);

    const emits = [];
    const { promise } = await startUpdate('v1.0.0', (...args) => emits.push(args));
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe('starting');
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(recordUpdateResult).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, log: expect.stringContaining('still running') })
    );
    expect(emits.some(e => e[0] === 'starting' && e[1] === 'error')).toBe(true);
  });

  it('parses STEP markers from stdout', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const emits = [];
    const { promise } = await startUpdate('v1.0.0', (...args) => emits.push(args));

    // Simulate STEP output
    child.stdout.emit('data', Buffer.from('STEP:git-pull:running:Pulling latest changes\n'));
    child.stdout.emit('data', Buffer.from('STEP:git-pull:done:Latest changes pulled\n'));

    child.emit('close', 0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(emits.some(e => e[0] === 'git-pull' && e[1] === 'running')).toBe(true);
    expect(emits.some(e => e[0] === 'git-pull' && e[1] === 'done')).toBe(true);
  });

  // Marker missing usually means the restarted server already consumed it, so
  // the version that stands is the one on disk — the triggering tag is only
  // what the update AIMED at, and stamping it produced a "Success" line naming
  // a release the install was never running (#6169).
  it('records the on-disk version, not the triggering tag, when the marker is missing', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);
    getCurrentVersion.mockResolvedValue('2.0.0');

    const { promise } = await startUpdate('v9.9.9', () => {});
    emitStep(child);
    child.emit('close', 0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.version).toBe('2.0.0');
    expect(recordUpdateResult).toHaveBeenCalledWith(
      expect.objectContaining({ version: '2.0.0', success: true })
    );
  });

  // The failure this whole change exists for: a launch that never executed the
  // script exits 0 with no output whatsoever. Both update scripts emit
  // `git-pull:running` before touching anything, so silence means no update ran
  // — recording it as a success left the UI offering the same release forever.
  it('records a failure when the script exits 0 without reporting any progress', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const emits = [];
    const { promise } = await startUpdate('v2.0.0', (...args) => emits.push(args));
    child.emit('close', 0);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/never ran/);
    expect(recordUpdateResult).toHaveBeenCalledWith(
      expect.objectContaining({ version: '2.0.0', success: false, log: expect.stringContaining('never ran') })
    );
    expect(emits.some(e => e[0] === 'complete')).toBe(false);
    expect(emits.some(e => e[1] === 'error')).toBe(true);
  });

  // 'starting' is synthetic — it only means "we launched the script". The first
  // real step proves that, so it must not keep spinning for the whole update.
  it('closes out the synthetic starting step once the script reports progress', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const emits = [];
    const { promise } = await startUpdate('v1.0.0', (...args) => emits.push(args));
    emitStep(child);
    emitStep(child, 'STEP:git-pull:done:Latest changes pulled\n');
    child.emit('close', 0);
    await promise;

    const startingStatuses = emits.filter(e => e[0] === 'starting').map(e => e[1]);
    expect(startingStatuses).toEqual(['running', 'done']);
  });

  it('records failure on non-zero exit code', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const { promise } = await startUpdate('v1.0.0', () => {});
    child.emit('close', 1);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(recordUpdateResult).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    );
  });

  it('handles CRLF line endings from Windows PowerShell', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const emits = [];
    const { promise } = await startUpdate('v1.0.0', (...args) => emits.push(args));

    // Simulate CRLF output (Windows PowerShell)
    child.stdout.emit('data', Buffer.from('STEP:git-pull:running:Pulling latest changes\r\n'));
    child.stdout.emit('data', Buffer.from('STEP:git-pull:done:Latest changes pulled\r\n'));

    child.emit('close', 0);
    await promise;

    // Messages should not contain trailing \r
    const pullRunning = emits.find(e => e[0] === 'git-pull' && e[1] === 'running');
    expect(pullRunning[2]).toBe('Pulling latest changes');
    expect(pullRunning[2]).not.toMatch(/\r/);
  });

  it('returns actual version from completion marker and records result on success', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);
    readFile.mockResolvedValue(JSON.stringify({ version: '2.0.0', completedAt: '2026-01-01T00:00:00Z' }));

    const { promise } = await startUpdate('v1.0.0', () => {});
    emitStep(child);
    child.emit('close', 0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.version).toBe('2.0.0');
    expect(recordUpdateResult).toHaveBeenCalledWith(
      expect.objectContaining({ version: '2.0.0', success: true })
    );
  });

  it('handles spawn error', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const emits = [];
    const { promise } = await startUpdate('v1.0.0', (...args) => emits.push(args));
    child.emit('error', new Error('spawn failed'));
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe('starting');
    expect(recordUpdateResult).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, log: 'spawn failed' })
    );
  });

  // Reconcile (issue #1779) passes the stale workspaces so update.sh force-
  // reinstalls exactly those, regardless of the commit diff.
  it('passes allowlisted forceCleanWorkspaces as PORTOS_FORCE_CLEAN_WORKSPACES', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);
    const { promise } = await startUpdate('v1.0.0', () => {}, { forceCleanWorkspaces: ['.', 'client'] });
    child.emit('close', 0);
    await promise;
    const env = spawnDetached.mock.calls[0][2].env;
    expect(env.PORTOS_FORCE_CLEAN_WORKSPACES).toBe('.,client');
  });

  it('does NOT set PORTOS_FORCE_CLEAN_WORKSPACES when none are given', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);
    const { promise } = await startUpdate('v1.0.0', () => {});
    child.emit('close', 0);
    await promise;
    const env = spawnDetached.mock.calls[0][2].env;
    expect(env.PORTOS_FORCE_CLEAN_WORKSPACES).toBeUndefined();
  });

  it('filters out non-allowlisted workspace names (no injection)', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);
    const { promise } = await startUpdate('v1.0.0', () => {}, { forceCleanWorkspaces: ['client', '../../etc', 'rm -rf /'] });
    child.emit('close', 0);
    await promise;
    const env = spawnDetached.mock.calls[0][2].env;
    expect(env.PORTOS_FORCE_CLEAN_WORKSPACES).toBe('client');
  });

  it('does NOT set the env when every workspace name is rejected', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);
    const { promise } = await startUpdate('v1.0.0', () => {}, { forceCleanWorkspaces: ['bogus'] });
    child.emit('close', 0);
    await promise;
    const env = spawnDetached.mock.calls[0][2].env;
    expect(env.PORTOS_FORCE_CLEAN_WORKSPACES).toBeUndefined();
  });
});
