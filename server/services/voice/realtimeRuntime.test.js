import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeInstall, ensureRealtimeSidecar, stopRealtimeSidecar } from './realtimeRuntime.js';

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

const fakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
  return child;
};

afterEach(() => {
  stopRealtimeSidecar();
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

describe('ensureRealtimeSidecar', () => {
  it('refuses with what is missing when the model is not installed', async () => {
    await expect(ensureRealtimeSidecar({ home: tempRoot() })).rejects.toThrow(/missing python, engine, weights/);
  });

  it('launches the sidecar once, resolves its tokenized loopback URL when ready, and reuses it', async () => {
    const home = fakeInstall();
    const child = fakeChild();
    const launch = vi.fn(() => child);
    const first = ensureRealtimeSidecar({ home }, { persona: 'You are Ada.', launch });
    child.stdout.write('Loading the model...\n{"ready": true, "port": 5569}\n');
    const { url } = await first;
    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:5569\/\?token=[0-9a-f]{36}$/);
    const args = launch.mock.calls[0][1];
    expect(launch.mock.calls[0][0]).toBe(join(home, '.venv', 'bin', 'python'));
    expect(args).toEqual(expect.arrayContaining(['--models', join(home, 'models'), '--persona', 'You are Ada.']));
    await expect(ensureRealtimeSidecar({ home }, { persona: 'You are Ada.', launch })).resolves.toEqual({ url });
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
