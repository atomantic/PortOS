import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The real `request()` from apiCore runs here on purpose: the bug this guards
// (#3515) was that `organizeGoals` dropped its caller's request-level options,
// so `request()` toasted the failure AND the Goals views toasted it again —
// two stacked error toasts for one failed AI organization run. Only the Toast
// module and `fetch` are stubbed, so the assertion is about how many toasts the
// helper layer actually fires.
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('../components/ui/Toast', () => ({
  default: Object.assign(() => {}, { error: toastError, success: () => {} }),
}));

import { organizeGoals } from './apiGoals.js';

const failingFetch = () => Promise.resolve({
  ok: false,
  status: 500,
  json: () => Promise.resolve({ error: 'Organization failed' }),
});

beforeEach(() => {
  toastError.mockReset();
  vi.stubGlobal('fetch', vi.fn(failingFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('organizeGoals', () => {
  it('forwards { silent: true } so a caller with its own error toast gets only one', async () => {
    await expect(organizeGoals({ providerId: 'p1', model: 'm1' }, { silent: true })).rejects.toThrow('Organization failed');
    expect(toastError).not.toHaveBeenCalled();
  });

  it('still sends the provider selection as the request body', async () => {
    await organizeGoals({ providerId: 'p1', model: 'm1' }, { silent: true }).catch(() => null);
    const [, config] = fetch.mock.calls[0];
    expect(config.method).toBe('POST');
    expect(JSON.parse(config.body)).toEqual({ providerId: 'p1', model: 'm1' });
  });

  it('keeps the helper toast for callers that pass no options', async () => {
    // Not hard-coded silent — a caller without its own error UI must still see one.
    await organizeGoals({ providerId: 'p1' }).catch(() => null);
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});
// @vitest-environment node
