import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { reapOwnedBrowser } from './lib/ownedBrowserCleanup.js';

it('reaps the retained child when the provider kill never dispatches, requiring its cleanup to settle', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'playwright_chromiumdev_profile-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', `--user-data-dir=${profile}`], {
    stdio: 'ignore',
  });
  const exited = once(child, 'close');
  // Models Playwright swallowing a failed group signal and awaiting cleanup.
  const cleanup = exited.then(() => rmSync(profile, { recursive: true, force: true }));
  const kill = vi.fn(() => cleanup);
  try {
    await once(child, 'spawn');
    const evidence = await reapOwnedBrowser({ process: () => child, close: () => new Promise(() => {}), kill },
      1000, { requireProfileRemoval: true });
    expect(child.signalCode).toBe('SIGKILL');
    expect(kill).toHaveBeenCalledTimes(1);
    expect(evidence).toContain('exit=confirmed');
    expect(evidence).toContain('killPromise=fulfilled profile=absent directKill=sent');
    expect(existsSync(profile)).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    rmSync(profile, { recursive: true, force: true });
  }
});

it.each(['refused', 'failed', 'exit-without-cleanup'])(
  'keeps direct termination %s a failed teardown and clears its timers', async outcome => {
    vi.useFakeTimers();
    const { EventEmitter } = await import('node:events');
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
    child.kill = vi.fn(() => {
      if (outcome === 'failed') throw new Error('private signal error');
      if (outcome === 'exit-without-cleanup') {
        child.signalCode = 'SIGKILL';
        child.emit('exit');
        return true;
      }
      return false;
    });
    const pending = () => new Promise(() => {});
    try {
      const closing = reapOwnedBrowser({ process: () => child, close: pending, kill: pending }, 100).catch(error => error);
      await vi.advanceTimersByTimeAsync(90);
      const error = await closing;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain(`directKill=${outcome === 'exit-without-cleanup' ? 'sent' : outcome}`);
      expect(error.message).toContain(`exit=${outcome === 'exit-without-cleanup' ? 'confirmed' : 'unconfirmed'}`);
      expect(error.message).toContain('killPromise=pending');
      expect(error.message).not.toContain('private signal error');
      expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
      expect(vi.getTimerCount()).toBe(0);
      expect(child.eventNames()).toEqual([]);
    } finally { vi.useRealTimers(); }
  },
);

it.each([['a confirmed exit', 900001], ['a child that never started', undefined]])(
  'settles crash handlers only once the browser is gone, after %s', async (_case, pid) => {
    const { EventEmitter } = await import('node:events');
    const child = Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null });
    const settle = vi.fn(async () => {
      expect(child.exitCode).toBe(0);
      return 'found=2 signalled=1 settled=2';
    });
    const server = { process: () => child, close: async () => { child.exitCode = 0; }, kill: vi.fn() };
    const evidence = await reapOwnedBrowser(server, 1000, { crashHandlers: { settle } });
    if (pid) expect(evidence).toMatch(/; crashHandlers found=2 signalled=1 settled=2$/);
    else expect(settle).not.toHaveBeenCalled();

    // Neither an unconfirmed exit nor a failed settlement is reported as clean.
    child.exitCode = null;
    settle.mockClear();
    await expect(reapOwnedBrowser({ ...server, close: async () => {}, kill: async () => {} }, 1000, { crashHandlers: { settle } }))
      .rejects.toThrow('returned without an exit status');
    expect(settle).not.toHaveBeenCalled();
    settle.mockRejectedValue(new Error('crash handler exit unconfirmed'));
    if (pid) await expect(reapOwnedBrowser(server, 1000, { crashHandlers: { settle } }))
      .rejects.toThrow(/^crash handler exit unconfirmed; cleanup phases: close elapsed=/);
  },
);
