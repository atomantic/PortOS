import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { attachFfmpegRenderGuard } from './ffmpegRenderGuard.js';

// Let the async listener bodies (they `await` the callbacks) settle.
const flush = () => new Promise((resolve) => setImmediate(resolve));

const makeProc = () => new EventEmitter();

const makeHandlers = (overrides = {}) => ({
  label: 'Test render',
  onSpawnError: vi.fn(),
  onProcessError: vi.fn(),
  onClose: vi.fn(),
  ...overrides,
});

describe('attachFfmpegRenderGuard', () => {
  it('routes a pre-spawn error (no "spawn" fired) to onSpawnError only', async () => {
    const proc = makeProc();
    const h = makeHandlers();
    attachFfmpegRenderGuard(proc, h);

    const err = new Error('ENOENT');
    proc.emit('error', err);
    await flush();

    expect(h.onSpawnError).toHaveBeenCalledTimes(1);
    expect(h.onSpawnError).toHaveBeenCalledWith(err);
    expect(h.onProcessError).not.toHaveBeenCalled();
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it('routes a post-spawn error to onProcessError WITHOUT consuming the terminal slot', async () => {
    const proc = makeProc();
    const h = makeHandlers();
    attachFfmpegRenderGuard(proc, h);

    proc.emit('spawn');
    proc.emit('error', new Error('failed kill'));
    await flush();

    expect(h.onProcessError).toHaveBeenCalledTimes(1);
    expect(h.onSpawnError).not.toHaveBeenCalled();

    // ffmpeg is still live; the pending 'close' must still run the sole
    // terminal finalization.
    proc.emit('close', 0, null);
    await flush();
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.onClose).toHaveBeenCalledWith(0, null);
  });

  it('runs onClose for a normal exit', async () => {
    const proc = makeProc();
    const h = makeHandlers();
    attachFfmpegRenderGuard(proc, h);

    proc.emit('spawn');
    proc.emit('close', 0, null);
    await flush();

    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.onClose).toHaveBeenCalledWith(0, null);
    expect(h.onSpawnError).not.toHaveBeenCalled();
    expect(h.onProcessError).not.toHaveBeenCalled();
  });

  it('passes the signal through to onClose for a cancelled render', async () => {
    const proc = makeProc();
    const h = makeHandlers();
    attachFfmpegRenderGuard(proc, h);

    proc.emit('spawn');
    proc.emit('close', null, 'SIGTERM');
    await flush();

    expect(h.onClose).toHaveBeenCalledWith(null, 'SIGTERM');
  });

  it('is exactly-once: a pre-spawn error already finalized, so a later "close" is a no-op', async () => {
    const proc = makeProc();
    const h = makeHandlers();
    attachFfmpegRenderGuard(proc, h);

    proc.emit('error', new Error('ENOENT'));
    await flush();
    proc.emit('close', 1, null); // late stray close after the process never started
    await flush();

    expect(h.onSpawnError).toHaveBeenCalledTimes(1);
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it('is exactly-once: after "close" finalizes, a late stray "error" is ignored', async () => {
    const proc = makeProc();
    const h = makeHandlers();
    attachFfmpegRenderGuard(proc, h);

    proc.emit('spawn');
    proc.emit('close', 0, null);
    await flush();
    proc.emit('error', new Error('ESRCH from a kill on the dead pid'));
    await flush();

    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.onProcessError).not.toHaveBeenCalled();
    expect(h.onSpawnError).not.toHaveBeenCalled();
  });

  it('runs onClose exactly once even if "close" is emitted twice', async () => {
    const proc = makeProc();
    const h = makeHandlers();
    attachFfmpegRenderGuard(proc, h);

    proc.emit('spawn');
    proc.emit('close', 0, null);
    proc.emit('close', 0, null);
    await flush();

    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it('swallows a throwing onClose so the process does not crash (crash-guard try/catch)', async () => {
    const proc = makeProc();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = makeHandlers({
      onClose: vi.fn(() => { throw new Error('finalize boom'); }),
    });
    attachFfmpegRenderGuard(proc, h);

    proc.emit('spawn');
    // Must not reject/throw out of the listener.
    expect(() => proc.emit('close', 0, null)).not.toThrow();
    await flush();

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Test render close handler failed'));
    errSpy.mockRestore();
  });

  it('swallows a throwing onSpawnError (crash-guard try/catch)', async () => {
    const proc = makeProc();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = makeHandlers({
      onSpawnError: vi.fn(() => { throw new Error('spawn-finalize boom'); }),
    });
    attachFfmpegRenderGuard(proc, h);

    expect(() => proc.emit('error', new Error('ENOENT'))).not.toThrow();
    await flush();

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Test render error handler failed'));
    errSpy.mockRestore();
  });

  it('awaits async finalize callbacks', async () => {
    const proc = makeProc();
    const order = [];
    const h = makeHandlers({
      onClose: vi.fn(async () => {
        await Promise.resolve();
        order.push('closed');
      }),
    });
    attachFfmpegRenderGuard(proc, h);

    proc.emit('spawn');
    proc.emit('close', 0, null);
    await flush();

    expect(order).toEqual(['closed']);
  });
});
