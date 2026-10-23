import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
import { spawn } from 'node:child_process';
import { runWatchConfigRestart } from './vitestTempRootFixture.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

describe('watch fixture process settlement', () => {
  let host;
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (host) rmSync(host, { recursive: true, force: true });
  });

  function fixture({ ready = true } = {}) {
    host = mkdtempSync(join(tmpdir(), 'watch-settlement-'));
    const child = new EventEmitter();
    Object.assign(child, { pid: 12345, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    vi.spyOn(process, 'kill').mockReturnValue(true);
    spawn.mockImplementation(() => {
      if (ready) {
        for (const n of [1, 2]) writeFileSync(join(host, 'marks', `run-${n}.json`), JSON.stringify({ root: 'synthetic', owner: '12345' }));
        setImmediate(() => child.stdout.write('Waiting for file changes'));
      }
      return child;
    });
    return child;
  }

  it('does not release the host to its caller until the killed watcher closes', async () => {
    const child = fixture();
    let inspected;
    const inspection = new Promise(resolve => { inspected = resolve; });
    let settled = false;
    const pending = runWatchConfigRestart(host, 'server', () => { inspected(); return 'inspected'; });
    pending.then(() => { settled = true; }, () => { settled = true; });
    await inspection;
    await tick();
    const releasedBeforeClose = settled;
    child.emit('exit', null, 'SIGKILL');
    await tick();
    const releasedBeforePipesClosed = settled;
    child.emit('close', null, 'SIGKILL');
    await expect(pending).resolves.toBe('inspected');
    expect(releasedBeforeClose).toBe(false);
    expect(releasedBeforePipesClosed).toBe(false);
  });

  it('cancels readiness but still waits for process close before returning', async () => {
    const child = fixture({ ready: false });
    const controller = new AbortController();
    const pending = runWatchConfigRestart(host, 'server', () => {}, { signal: controller.signal });
    const result = pending.catch(error => error);
    controller.abort();
    await tick();
    child.emit('exit', null, 'SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await expect(result).resolves.toMatchObject({ name: 'AbortError' });
  });

  it('reports unconfirmed close as cleanup failure even after cancellation', async () => {
    const child = fixture({ ready: false });
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = runWatchConfigRestart(host, 'server', () => {}, { signal: controller.signal });
    const result = pending.catch(error => error);
    controller.abort();
    await vi.advanceTimersByTimeAsync(2000);
    child.emit('close', null, 'SIGKILL');
    const error = await result;
    expect(error).toMatchObject({ code: 'FIXTURE_CLOSE_UNCONFIRMED', cause: { name: 'AbortError' } });
    expect(error.errors[1].message).toBe('watch fixture process close unconfirmed');
  });
});
