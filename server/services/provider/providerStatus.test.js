import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getProviderStatus,
  isProviderAvailable,
  markProviderAvailable,
  providerStatusEvents,
  providerStatusService,
  setAIToolkit
} from './providerStatus.js';

function makeToolkit() {
  const events = new EventEmitter();
  const status = { available: false, reason: 'timeout' };
  const service = {
    events,
    getStatus: vi.fn(() => status),
    isAvailable: vi.fn(() => false),
    markAvailable: vi.fn(async () => ({ available: true, reason: 'ok' }))
  };
  return { toolkit: { services: { providerStatus: service } }, service, status };
}

afterEach(() => {
  setAIToolkit(null);
});

describe('provider status compatibility shim', () => {
  it('delegates reads, recovery, and the direct-service facade to the toolkit cache', async () => {
    const { toolkit, service, status } = makeToolkit();
    setAIToolkit(toolkit);

    expect(getProviderStatus('example-provider')).toBe(status);
    expect(isProviderAvailable('example-provider')).toBe(false);
    await expect(markProviderAvailable('example-provider')).resolves.toEqual({ available: true, reason: 'ok' });
    expect(providerStatusService.getStatus('example-provider')).toBe(status);

    expect(service.getStatus).toHaveBeenCalledTimes(2);
    expect(service.isAvailable).toHaveBeenCalledWith('example-provider');
    expect(service.markAvailable).toHaveBeenCalledWith('example-provider');
  });

  it('forwards events from only the currently registered toolkit service', () => {
    const first = makeToolkit();
    const second = makeToolkit();
    const listener = vi.fn();
    providerStatusEvents.on('status:changed', listener);

    setAIToolkit(first.toolkit);
    first.service.events.emit('status:changed', { providerId: 'first' });
    setAIToolkit(second.toolkit);
    first.service.events.emit('status:changed', { providerId: 'stale' });
    second.service.events.emit('status:changed', { providerId: 'second' });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, { providerId: 'first' });
    expect(listener).toHaveBeenNthCalledWith(2, { providerId: 'second' });
    providerStatusEvents.off('status:changed', listener);
  });
});
