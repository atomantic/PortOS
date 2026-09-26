import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeModelResource, registerModelObservationSocket, resetModelObservationsForTests } from './modelObservation.js';

function viewer() {
  const socket = new EventEmitter();
  socket.connected = true;
  socket.frames = [];
  socket.on('loaded-models:changed', payload => socket.frames.push(payload));
  registerModelObservationSocket(socket);
  return socket;
}
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('shared model observations through socket subscriptions and HTTP reads', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { resetModelObservationsForTests(); vi.useRealTimers(); });

  it('shares one external sample across viewers and stops after the final disconnect', async () => {
    const probe = vi.fn().mockResolvedValue({ ollama: [] });
    const resource = observeModelResource('loaded-models', probe, 2000);
    expect(probe).not.toHaveBeenCalled();
    const first = viewer();
    const second = viewer();
    first.emit('loaded-models:subscribe');
    second.emit('loaded-models:subscribe');
    await Promise.all([resource.read(), resource.read()]);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(first.frames).toEqual([{}]); // unchanged samples stay quiet
    first.emit('loaded-models:unsubscribe');
    probe.mockResolvedValue({ ollama: [{ id: 'example-model' }] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(first.frames).toHaveLength(1);
    expect(second.frames).toHaveLength(2);
    second.emit('disconnect');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('publishes probe failures and recovery without converting failure into empty data', async () => {
    const probe = vi.fn().mockResolvedValue({ ollama: [] });
    const resource = observeModelResource('loaded-models', probe, 2000);
    const socket = viewer();
    socket.emit('loaded-models:subscribe');
    await flush();
    probe.mockRejectedValue(new Error('unavailable'));
    await vi.advanceTimersByTimeAsync(2000);
    await expect(resource.read()).rejects.toThrow('unavailable');
    expect(socket.frames).toHaveLength(2);
    expect(probe).toHaveBeenCalledTimes(2); // failure reads share the sample too
    probe.mockResolvedValue({ ollama: [] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(socket.frames).toHaveLength(3);
    await expect(resource.read()).resolves.toEqual({ ollama: [] });
  });

  it('fences an in-flight pre-unload sample for every waiting viewer', async () => {
    let resolveOld;
    const probe = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValue({ ollama: [] });
    const resource = observeModelResource('loaded-models', probe, 2000);
    const socket = viewer();
    socket.emit('loaded-models:subscribe');
    const read = resource.read();
    await flush();
    resource.invalidate();
    resolveOld({ ollama: [{ id: 'unloaded-model' }] });
    await expect(read).resolves.toEqual({ ollama: [] });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(socket.frames).toEqual([{}]);
  });

  it('does not restart observation when the last viewer leaves during a read', async () => {
    let resolve;
    const resource = observeModelResource('loaded-models', () => new Promise(done => { resolve = done; }), 2000);
    const socket = viewer();
    socket.emit('loaded-models:subscribe');
    const read = resource.read();
    await flush();
    socket.emit('disconnect');
    resolve({ ollama: [] });
    await read;
    expect(socket.frames).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
