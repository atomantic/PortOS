import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeInstall,
  ensureRealtimeSidecar,
  realtimeStatus,
  scheduleRealtimeIdleStop,
  stopRealtimeSidecar,
} from './realtimeRuntime.js';

const roots = [];
const tempRoot = () => { const dir = mkdtempSync(join(tmpdir(), 'realtime-')); roots.push(dir); return dir; };

const fakeInstall = (size = '32B') => {
  const home = tempRoot();
  mkdirSync(join(home, '.venv', 'bin'), { recursive: true });
  mkdirSync(join(home, 'app'));
  const models = join(home, size === '4B' ? 'models-4b' : 'models');
  mkdirSync(models);
  for (const f of [join(home, '.venv', 'bin', 'python'), join(home, 'app', 'engine.py'), join(home, 'app', 'adapt.py'), join(models, '.complete')]) writeFileSync(f, '');
  return home;
};

const fakeChild = ({ autoCloseOnKill = true } = {}) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = vi.fn(() => { if (autoCloseOnKill) child.emit('close', 0); });
  return child;
};

afterEach(async () => {
  await stopRealtimeSidecar();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('describeInstall', () => {
  it('reports each missing part', () => {
    const home = tempRoot();
    expect(describeInstall({ home })).toMatchObject({ installed: false, parts: { python: false, engine: false, weights: false }, size: '32B' });
  });

  it('finds a complete install for the chosen size, defaulting an unknown size to 32B', () => {
    const home = fakeInstall('4B');
    expect(describeInstall({ home, size: '4B' })).toMatchObject({ installed: true, models: join(home, 'models-4b') });
    expect(describeInstall({ home, size: 'huge' })).toMatchObject({ size: '32B', installed: false });
  });
});

describe('realtimeStatus', () => {
  it('scrubs the OS home directory prefix from returned install paths', () => {
    const status = realtimeStatus({ home: '~/.portos/sophon-mac' });
    const osHome = homedir();
    expect(status.home).toBe('~/.portos/sophon-mac');
    expect(status.python).toBe(join('~', '.portos', 'sophon-mac', '.venv', 'bin', 'python'));
    expect(status.app).toBe(join('~', '.portos', 'sophon-mac', 'app'));
    expect(status.models).toBe(join('~', '.portos', 'sophon-mac', 'models'));
    if (osHome && osHome !== '/' && osHome !== '\\') {
      expect(status.home).not.toContain(osHome);
    }
  });
});

describe('ensureRealtimeSidecar', () => {
  it('refuses with what is missing and scrubs the OS home directory from the error', async () => {
    const osHome = homedir();
    const err = await ensureRealtimeSidecar({ home: '~/.portos/sophon-missing-test' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/~\/\.portos\/sophon-missing-test/);
    expect(err.message).toMatch(/missing python, engine, weights/);
    if (osHome && osHome !== '/' && osHome !== '\\') {
      expect(err.message).not.toContain(osHome);
    }
  });

  it('launches the sidecar with token and persona in env (not argv or URL) and reuses it', async () => {
    const home = fakeInstall();
    const child = fakeChild();
    const launch = vi.fn(() => child);
    const first = ensureRealtimeSidecar({ home }, { persona: 'You are Ada.', launch });
    child.stdout.write('Loading the model...\n{"ready": true, "port": 5569}\n');
    const { url, token } = await first;
    expect(url).toBe('ws://127.0.0.1:5569/');
    expect(token).toMatch(/^[0-9a-f]{36}$/);
    const [bin, args, opts] = launch.mock.calls[0];
    expect(bin).toBe(join(home, '.venv', 'bin', 'python'));
    expect(args).toEqual(expect.arrayContaining(['--models', join(home, 'models')]));
    expect(args).not.toContain('--token');
    expect(args).not.toContain('--persona');
    expect(args).not.toContain(token);
    expect(args).not.toContain('You are Ada.');
    expect(opts.env.PORTOS_REALTIME_TOKEN).toBe(token);
    expect(opts.env.PORTOS_REALTIME_PERSONA).toBe('You are Ada.');
    await expect(ensureRealtimeSidecar({ home }, { persona: 'You are Ada.', launch })).resolves.toEqual({ url, token });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('scrubs the OS home directory from spawn errors', async () => {
    const home = fakeInstall();
    const child = fakeChild();
    const launch = vi.fn(() => child);
    const pending = ensureRealtimeSidecar({ home }, { launch });
    const osHome = homedir();
    child.emit('error', new Error(`spawn ${join(osHome, '.portos', 'sophon-mac', '.venv', 'bin', 'python')} ENOENT`));
    const err = await pending.catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('~/.portos/sophon-mac/.venv/bin/python');
    if (osHome && osHome !== '/' && osHome !== '\\') {
      expect(err.message).not.toContain(osHome);
    }
  });

  it('restarts the sidecar with SIGTERM when persona or model size changes', async () => {
    const home = fakeInstall();
    const firstChild = fakeChild();
    const secondChild = fakeChild();
    const launch = vi.fn().mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);

    const first = ensureRealtimeSidecar({ home }, { persona: 'Persona A', launch });
    firstChild.stdout.write('{"ready": true}\n');
    await first;

    const second = ensureRealtimeSidecar({ home }, { persona: 'Persona B', launch });
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(2));
    secondChild.stdout.write('{"ready": true}\n');
    await second;

    expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('clears state when the sidecar exits before ready so a retry can launch cleanly', async () => {
    const home = fakeInstall();
    const crashed = fakeChild();
    const healthy = fakeChild();
    const launch = vi.fn().mockReturnValueOnce(crashed).mockReturnValueOnce(healthy);

    const failed = ensureRealtimeSidecar({ home }, { launch });
    crashed.emit('close', 1);
    await expect(failed).rejects.toThrow(/stopped \(exit 1\)/);
    expect(realtimeStatus({ home }).running).toBe(false);

    const retry = ensureRealtimeSidecar({ home }, { launch });
    healthy.stdout.write('{"ready": true}\n');
    await expect(retry).resolves.toMatchObject({
      url: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:/),
      token: expect.stringMatching(/^[0-9a-f]{36}$/),
    });
    expect(realtimeStatus({ home }).running).toBe(true);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('stops the sidecar after the idle timer elapses, and cancels the timer on reuse', async () => {
    vi.useFakeTimers();
    try {
      const home = fakeInstall();
      const child = fakeChild();
      const launch = vi.fn(() => child);

      const start = ensureRealtimeSidecar({ home }, { launch });
      child.stdout.write('{"ready": true}\n');
      await start;
      expect(realtimeStatus({ home }).running).toBe(true);

      // Reusing the sidecar before the idle timer fires cancels the pending stop.
      scheduleRealtimeIdleStop(500);
      vi.advanceTimersByTime(300);
      await ensureRealtimeSidecar({ home }, { launch });
      vi.advanceTimersByTime(300);
      expect(child.kill).not.toHaveBeenCalled();

      // Once idle without reuse, SIGTERM frees the sidecar and running flips false.
      scheduleRealtimeIdleStop(500);
      vi.advanceTimersByTime(500);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(realtimeStatus({ home }).running).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the failed sidecar slot on spawn error so a retry can launch cleanly', async () => {
    const home = fakeInstall();
    const firstChild = fakeChild();
    const secondChild = fakeChild();
    const launch = vi.fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);

    const failed = ensureRealtimeSidecar({ home }, { persona: 'You are Ada.', launch });
    firstChild.emit('error', new Error('ENOENT'));
    await expect(failed).rejects.toThrow(/Could not launch realtime voice: ENOENT/);

    const retried = ensureRealtimeSidecar({ home }, { persona: 'You are Ada.', launch });
    secondChild.stdout.write('{"ready": true, "port": 5569}\n');
    await expect(retried).resolves.toMatchObject({
      url: 'ws://127.0.0.1:5569/',
      token: expect.stringMatching(/^[0-9a-f]{36}$/),
    });
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('waits for the previous sidecar to exit before launching a replacement on config change', async () => {
    const home = fakeInstall('32B');
    mkdirSync(join(home, 'models-4b'));
    writeFileSync(join(home, 'models-4b', '.complete'), '');
    const firstChild = fakeChild({ autoCloseOnKill: false });
    const secondChild = fakeChild();
    const launch = vi.fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);

    const first = ensureRealtimeSidecar({ home, size: '32B' }, { persona: 'You are Ada.', launch });
    firstChild.stdout.write('{"ready": true, "port": 5569}\n');
    await first;

    const switched = ensureRealtimeSidecar({ home, size: '4B' }, { persona: 'You are Ada.', launch });
    await Promise.resolve();
    expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(launch).toHaveBeenCalledTimes(1);

    firstChild.emit('close', 0);
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(2));
    secondChild.stdout.write('{"ready": true, "port": 5569}\n');
    await expect(switched).resolves.toMatchObject({
      url: 'ws://127.0.0.1:5569/',
      token: expect.stringMatching(/^[0-9a-f]{36}$/),
    });
  });

  it('waits for a timed-out sidecar to exit after SIGKILL before launching a retry', async () => {
    vi.useFakeTimers();
    try {
      const home = fakeInstall();
      const firstChild = fakeChild({ autoCloseOnKill: false });
      const secondChild = fakeChild();
      const launch = vi.fn()
        .mockReturnValueOnce(firstChild)
        .mockReturnValueOnce(secondChild);

      const first = ensureRealtimeSidecar({ home }, { persona: 'You are Ada.', launch });
      const firstRejection = expect(first).rejects.toThrow(/did not finish loading/);
      await vi.advanceTimersByTimeAsync(180_000);
      await firstRejection;
      expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL');

      const retried = ensureRealtimeSidecar({ home }, { persona: 'You are Ada.', launch });
      await Promise.resolve();
      expect(launch).toHaveBeenCalledTimes(1);

      firstChild.emit('close', 137);
      await vi.advanceTimersByTimeAsync(0);
      expect(launch).toHaveBeenCalledTimes(2);
      secondChild.stdout.write('{"ready": true, "port": 5569}\n');
      await expect(retried).resolves.toMatchObject({
        url: 'ws://127.0.0.1:5569/',
        token: expect.stringMatching(/^[0-9a-f]{36}$/),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
