import { describe, expect, it, vi } from 'vitest';
import EventEmitter from 'node:events';

const fakeWatcher1 = new EventEmitter();
fakeWatcher1.close = vi.fn();
const fakeWatcher2 = new EventEmitter();
fakeWatcher2.close = vi.fn();

const createdWatchers = [fakeWatcher1, fakeWatcher2];
let index = 0;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    watch: vi.fn(() => createdWatchers[index++]),
  };
});

import { watchCertReload } from './tailscale-https.js';

describe('watchCertReload', () => {
  it('attaches error listeners on watchers and does not throw on error event', async () => {
    const logs = [];
    const log = (msg) => logs.push(msg);
    const fakeServer = { setSecureContext: vi.fn() };

    const stop = watchCertReload(fakeServer, '/fake/cert/dir', { log });

    // Both fake watchers should have 'error' listeners attached
    expect(fakeWatcher1.listenerCount('error')).toBe(1);
    expect(fakeWatcher2.listenerCount('error')).toBe(1);

    // Emitting error must not throw
    expect(() => {
      fakeWatcher1.emit('error', new Error('EPERM: operation not permitted'));
    }).not.toThrow();

    expect(fakeWatcher1.close).toHaveBeenCalled();
    expect(logs.some(l => l.includes('cert watch error') && l.includes('EPERM'))).toBe(true);

    stop();
    expect(fakeWatcher2.close).toHaveBeenCalled();
  });
});
