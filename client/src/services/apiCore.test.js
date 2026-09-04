// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The real Toast default export is callable (`toast(msg, opts)`) AND carries
// `.error`/`.success`/etc, mirroring react-hot-toast's API — a plain object
// mock would make request()'s `toast(err.message, { icon })` call throw.
vi.mock('../components/ui/Toast', () => {
  const toastFn = vi.fn();
  toastFn.error = vi.fn();
  toastFn.success = vi.fn();
  return { default: toastFn };
});

import toast from '../components/ui/Toast';
import { throwApiError, request } from './apiCore.js';

const makeResponse = ({ status = 400, ok = false, json = null } = {}) => ({
  status,
  ok,
  json: json === null ? async () => { throw new Error('not json'); } : async () => json,
});

beforeEach(() => {
  global.fetch = vi.fn();
  toast.mockReset();
  toast.error.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('throwApiError', () => {
  it('throws with the server message, code, and status', async () => {
    const response = makeResponse({ status: 404, json: { error: 'not found', code: 'NOT_FOUND' } });
    await expect(throwApiError(response)).rejects.toMatchObject({
      message: 'not found',
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('forwards structured error.context onto the thrown error', async () => {
    const context = { universeId: 'u1', seriesId: 's1', arcAlreadyPersisted: true };
    const response = makeResponse({
      status: 409,
      json: { error: 'partial commit', code: 'ERR_PARTIAL_COMMIT_ISSUES', context },
    });
    await expect(throwApiError(response)).rejects.toMatchObject({ context });
  });

  it('omits context when the server did not send any', async () => {
    const response = makeResponse({ status: 500, json: { error: 'boom' } });
    const err = await throwApiError(response).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.context).toBeUndefined();
  });

  it('falls back to an HTTP-status message when the body is not JSON', async () => {
    const response = makeResponse({ status: 502 }); // json:null → makeResponse's json() rejects
    await expect(throwApiError(response)).rejects.toMatchObject({ message: 'HTTP 502' });
  });

  it('falls back to an HTTP-status message when the body is valid JSON but not an object', async () => {
    // response.json() resolves successfully with `null` here — a real case
    // (an endpoint that responds 500 with a bare `null` body) distinct from
    // "body isn't JSON at all" above, which rejects instead of resolving.
    const response = { status: 500, ok: false, json: async () => null };
    await expect(throwApiError(response)).rejects.toMatchObject({ message: 'HTTP 500' });
  });
});

describe('request() error path (now delegating to throwApiError)', () => {
  it('rejects with the same shape throwApiError produces, context included', async () => {
    const context = { retryable: false };
    global.fetch.mockResolvedValue(
      makeResponse({ status: 422, json: { error: 'bad input', code: 'VALIDATION', context } }),
    );
    await expect(request('/x')).rejects.toMatchObject({ code: 'VALIDATION', status: 422, context });
    expect(toast.error).toHaveBeenCalledWith('bad input');
  });

  it('warns instead of toasting an error for PLATFORM_UNAVAILABLE', async () => {
    global.fetch.mockResolvedValue(
      makeResponse({ status: 503, json: { error: 'offline', code: 'PLATFORM_UNAVAILABLE' } }),
    );
    await expect(request('/x')).rejects.toMatchObject({ code: 'PLATFORM_UNAVAILABLE' });
    expect(toast).toHaveBeenCalledWith('offline', { icon: '⚠️' });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('stays silent when { silent: true } is passed', async () => {
    global.fetch.mockResolvedValue(makeResponse({ status: 500, json: { error: 'boom' } }));
    await expect(request('/x', { silent: true })).rejects.toMatchObject({ status: 500 });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('suppresses the PLATFORM_UNAVAILABLE warning toast too when { silent: true } is passed', async () => {
    global.fetch.mockResolvedValue(
      makeResponse({ status: 503, json: { error: 'offline', code: 'PLATFORM_UNAVAILABLE' } }),
    );
    await expect(request('/x', { silent: true })).rejects.toMatchObject({ code: 'PLATFORM_UNAVAILABLE' });
    expect(toast).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
