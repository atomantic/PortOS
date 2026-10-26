import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { runFixtureToCompletion } from './vitestTempRootFixture.js';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn, spawnSync: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it('clears the close watchdog after exit settles, without retaining the runner', async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, exitCode: 0,
  });
  spawn.mockReturnValue(child);
  const completed = runFixtureToCompletion({ args: [], options: {} });
  child.emit('exit', 0);
  expect(vi.getTimerCount()).toBe(2);
  child.emit('close', 0);
  await expect(completed).resolves.toMatchObject({ status: 0, closeConfirmed: true });
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds cancellation settlement with one watchdog and retains unconfirmed-close evidence', async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, exitCode: null,
  });
  spawn.mockReturnValue(child);
  const controller = new AbortController();
  const completed = runFixtureToCompletion({ args: [], options: {} }, 120000, { signal: controller.signal });
  controller.abort();
  child.emit('exit', null);
  expect(vi.getTimerCount()).toBe(2);
  await vi.advanceTimersByTimeAsync(2000);
  await expect(completed).resolves.toMatchObject({ closeConfirmed: false, error: { code: 'FIXTURE_CLOSE_UNCONFIRMED' } });
  expect(vi.getTimerCount()).toBe(0);
});
