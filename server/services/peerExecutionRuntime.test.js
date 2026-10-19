import { describe, expect, it, vi } from 'vitest';
import EventEmitter from 'node:events';

const fakeWatcher = new EventEmitter();
fakeWatcher.close = vi.fn();
fakeWatcher.unref = vi.fn();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    watch: vi.fn(() => fakeWatcher),
    mkdirSync: vi.fn(),
  };
});

vi.mock('../lib/testDataIsolation.js', () => ({
  assertNotRealDataWrite: vi.fn(),
}));

vi.mock('../lib/db.js', () => ({
  query: vi.fn(),
}));

import { initializePeerExecution, peerExecutionRuntime, _getPeerExecutionWatcher } from './peerExecutionRuntime.js';

describe('peerExecutionRuntime watcher', () => {
  it('attaches an error listener to watcher and re-arms on receiver.kick()', async () => {
    await initializePeerExecution();

    const watcher = _getPeerExecutionWatcher();
    expect(watcher).toBe(fakeWatcher);
    expect(watcher.listenerCount('error')).toBe(1);

    // Emitting error should close watcher and not throw
    expect(() => {
      fakeWatcher.emit('error', new Error('EPERM: operation not permitted'));
    }).not.toThrow();

    expect(fakeWatcher.close).toHaveBeenCalled();
    expect(_getPeerExecutionWatcher()).toBeNull();

    // Calling receiver.kick() re-arms the watcher
    const receiver = await peerExecutionRuntime();
    receiver.kick();

    expect(_getPeerExecutionWatcher()).toBe(fakeWatcher);
  });
});
