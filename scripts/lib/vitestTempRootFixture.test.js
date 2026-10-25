import { mkdtempSync, rmSync, writeFileSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:fs', async original => {
  const actual = await original();
  return { ...actual, watch: vi.fn(actual.watch) };
});

import { runFixtureToCompletion, waitForFixtureReady } from './vitestTempRootFixture.js';

describe('waitForFixtureReady', () => {
  it('resolves for a file that is already present and for one that appears later', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixture-ready-'));
    try {
      const present = join(dir, 'present');
      writeFileSync(present, 'ready');
      await expect(waitForFixtureReady(present)).resolves.toBeUndefined();

      const later = join(dir, 'later');
      const pending = waitForFixtureReady(later);
      writeFileSync(later, 'ready');
      await expect(pending).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects and closes ownership when the readiness watcher fails asynchronously', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixture-watch-error-'));
    const watcher = new EventEmitter();
    watcher.close = vi.fn();
    vi.mocked(watch).mockReturnValueOnce(watcher);
    vi.useFakeTimers();
    try {
      const failure = Object.assign(new Error('controlled watcher failure'), { code: 'EMFILE' });
      const pending = waitForFixtureReady(join(directory, 'ready'));
      const rejected = expect(pending).rejects.toBe(failure);
      watcher.emit('error', failure);
      await rejected;
      expect(watcher.close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects on the caller signal and ignores a file created after that abort', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixture-abort-'));
    try {
      const file = join(dir, 'ready');
      const controller = new AbortController();
      const pending = waitForFixtureReady(file, { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      writeFileSync(file, 'late');
      await new Promise(resolve => setTimeout(resolve, 40));
      await expect(Promise.race([
        pending.then(() => 'resolved', () => 'rejected'),
        new Promise(resolve => setTimeout(() => resolve('quiet'), 20)),
      ])).resolves.toBe('rejected');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runFixtureToCompletion', () => {
  // A cancelled caller must not wait out the ceiling: its `finally` has to
  // remove the fixture host before the worker tears down (#12924).
  it('kills the nested run and settles promptly when the caller signal aborts', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runFixtureToCompletion({
      args: ['-e', 'setInterval(() => {}, 1000)'], options: { env: process.env, timeout: 1 },
    }, 60000, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.error).toMatchObject({ name: 'AbortError', message: 'fixture run aborted' });
    expect(Date.now() - started).toBeLessThan(10000);
  });
});
