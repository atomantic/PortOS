import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('./childProcess.js', async (orig) => ({ ...(await orig()), spawn: spawnMock }));

import { runFfmpegProcess, FFMPEG_KILL_GRACE_MS } from './ffmpeg.js';

// A child that records kills and only closes when told (a wedged ffmpeg).
function stuckChild({ honorsSigterm = false } = {}) {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.signals = [];
  child.kill = vi.fn((sig) => {
    child.signals.push(sig);
    if (sig === 'SIGKILL' || (sig === 'SIGTERM' && honorsSigterm)) {
      queueMicrotask(() => child.emit('close', null, sig));
    }
    return true;
  });
  return child;
}

describe('runFfmpegProcess stall handling', () => {
  beforeEach(() => { vi.useFakeTimers(); spawnMock.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('times out a child that ignores SIGTERM and escalates to SIGKILL', async () => {
    const child = stuckChild();
    spawnMock.mockReturnValue(child);
    const p = runFfmpegProcess({ bin: 'ffmpeg', args: [], timeoutMs: 30000 });
    await vi.advanceTimersByTimeAsync(30000);
    expect(child.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(FFMPEG_KILL_GRACE_MS);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(await p).toEqual({ ok: false, reason: 'timed out after 30s' });
  });

  it('skips SIGKILL when the child exits on SIGTERM', async () => {
    const child = stuckChild({ honorsSigterm: true });
    spawnMock.mockReturnValue(child);
    const p = runFfmpegProcess({ bin: 'ffmpeg', args: [], timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toEqual({ ok: false, reason: 'timed out after 1s' });
    await vi.advanceTimersByTimeAsync(FFMPEG_KILL_GRACE_MS * 2);
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('does not time out a child that finishes in time', async () => {
    const child = stuckChild();
    spawnMock.mockReturnValue(child);
    const p = runFfmpegProcess({ bin: 'ffmpeg', args: [], timeoutMs: 1000 });
    child.emit('close', 0, null);
    expect(await p).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(10000);
    expect(child.signals).toEqual([]);
  });

  it('escalates the abort-signal path to SIGKILL', async () => {
    const child = stuckChild();
    spawnMock.mockReturnValue(child);
    const ac = new AbortController();
    const p = runFfmpegProcess({ bin: 'ffmpeg', args: [], signal: ac.signal });
    ac.abort();
    expect(child.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(FFMPEG_KILL_GRACE_MS);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(await p).toEqual({ ok: false, reason: 'cancelled (SIGKILL)' });
  });
});
