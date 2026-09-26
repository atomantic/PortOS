import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./systemHealthSnapshot.js', () => ({ getSystemHealthSnapshot: vi.fn() }));
vi.mock('./capabilitiesSnapshot.js', () => ({ getCapabilitiesSnapshot: vi.fn() }));
vi.mock('./settings.js', () => ({ settingsEvents: new EventEmitter() }));
vi.mock('./apps.js', () => ({ appsEvents: new EventEmitter() }));
vi.mock('./providerStatus.js', () => ({ providerStatusEvents: new EventEmitter() }));
vi.mock('./cosEvents.js', () => ({ cosEvents: new EventEmitter() }));
vi.mock('./mediaJobQueue/index.js', () => ({ mediaJobEvents: new EventEmitter() }));
import { getSystemHealthSnapshot } from './systemHealthSnapshot.js';
import { getCapabilitiesSnapshot } from './capabilitiesSnapshot.js';
import { settingsEvents } from './settings.js';
import { cosEvents } from './cosEvents.js';
import {
  armReadinessWatchers, registerReadinessSocket, __resetReadinessForTests,
  READINESS_OBSERVE_MS, READINESS_COALESCE_MS,
} from './readinessNotify.js';

function connect() {
  const handlers = new Map();
  const socket = { connected: true, on: (event, fn) => handlers.set(event, fn), emit: vi.fn() };
  registerReadinessSocket(socket);
  handlers.get('readiness:subscribe')();
  return { socket, send: event => handlers.get(event)() };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  getSystemHealthSnapshot.mockResolvedValue({ overallHealth: 'healthy', timestamp: 'one', system: { uptime: 1 } });
  getCapabilitiesSnapshot.mockResolvedValue({ summary: { overall: 'ok' }, timestamp: 'one' });
});
afterEach(() => { __resetReadinessForTests(); vi.useRealTimers(); });

describe('shared readiness subscription', () => {
  it('shares one observer, ignores clock-only changes and stops after the last unsubscribe', async () => {
    const a = connect();
    const b = connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(getCapabilitiesSnapshot).toHaveBeenCalledTimes(1);
    expect(getSystemHealthSnapshot).toHaveBeenCalledTimes(1);
    getCapabilitiesSnapshot.mockResolvedValue({ summary: { overall: 'ok' }, timestamp: 'two' });
    getSystemHealthSnapshot.mockResolvedValue({ overallHealth: 'healthy', timestamp: 'two', system: { uptime: 2 } });
    await vi.advanceTimersByTimeAsync(READINESS_OBSERVE_MS + READINESS_COALESCE_MS);
    expect(a.socket.emit).not.toHaveBeenCalled();

    getCapabilitiesSnapshot.mockResolvedValue({ summary: { overall: 'warn' } });
    await vi.advanceTimersByTimeAsync(READINESS_OBSERVE_MS);
    expect(a.socket.emit).toHaveBeenCalledExactlyOnceWith('capabilities:changed', {});
    expect(b.socket.emit).toHaveBeenCalledExactlyOnceWith('capabilities:changed', {});
    a.send('readiness:unsubscribe');
    const reads = getCapabilitiesSnapshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(READINESS_OBSERVE_MS);
    expect(getCapabilitiesSnapshot).toHaveBeenCalledTimes(reads + 1);
    b.send('disconnect');
    await vi.advanceTimersByTimeAsync(READINESS_OBSERVE_MS * 3);
    expect(getCapabilitiesSnapshot).toHaveBeenCalledTimes(reads + 1);
  });

  it('coalesces service events without forwarding private payloads, and distinguishes probe failure/recovery', async () => {
    await armReadinessWatchers();
    await armReadinessWatchers();
    const a = connect();
    await vi.advanceTimersByTimeAsync(0);
    settingsEvents.emit('settings:updated', { secrets: 'not a socket payload' });
    cosEvents.emit('health:check', { private: 'not a socket payload' });
    await vi.advanceTimersByTimeAsync(READINESS_COALESCE_MS);
    expect(a.socket.emit.mock.calls).toEqual([
      ['system:health:changed', {}], ['capabilities:changed', {}],
    ]);
    a.socket.emit.mockClear();
    getCapabilitiesSnapshot.mockRejectedValue(new Error('Probe failed'));
    await vi.advanceTimersByTimeAsync(READINESS_OBSERVE_MS);
    expect(a.socket.emit).toHaveBeenCalledExactlyOnceWith('capabilities:changed', {});
    a.socket.emit.mockClear();
    await vi.advanceTimersByTimeAsync(READINESS_OBSERVE_MS);
    expect(a.socket.emit).not.toHaveBeenCalled();
    getCapabilitiesSnapshot.mockResolvedValue({ summary: { overall: 'ok' } });
    await vi.advanceTimersByTimeAsync(READINESS_OBSERVE_MS);
    expect(a.socket.emit).toHaveBeenCalledExactlyOnceWith('capabilities:changed', {});
    __resetReadinessForTests();
    expect(settingsEvents.listenerCount('settings:updated')).toBe(0);
    expect(cosEvents.listenerCount('health:check')).toBe(0);
  });
  it('never overlaps a slow sample and discards its result after the last consumer leaves', async () => {
    let finish;
    getCapabilitiesSnapshot.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const a = connect();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(READINESS_OBSERVE_MS * 3);
    expect(getCapabilitiesSnapshot).toHaveBeenCalledTimes(1);
    a.send('disconnect');
    finish({ summary: { overall: 'warn' } });
    await vi.advanceTimersByTimeAsync(READINESS_OBSERVE_MS);
    expect(a.socket.emit).not.toHaveBeenCalled();
    expect(getCapabilitiesSnapshot).toHaveBeenCalledTimes(1);
    connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(getCapabilitiesSnapshot).toHaveBeenCalledTimes(2);
  });

});
