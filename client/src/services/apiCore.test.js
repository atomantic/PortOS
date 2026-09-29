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
import { throwApiError, request, uploadBody, isServerUnreachable } from './apiCore.js';

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

  it('rejects with SERVER_UNREACHABLE code when fetch fails to connect', async () => {
    global.fetch.mockRejectedValue(new Error('Connection refused'));
    await expect(request('/x', { silent: true })).rejects.toMatchObject({
      message: expect.stringContaining('Server unreachable'),
      code: 'SERVER_UNREACHABLE',
    });
  });
});

describe('isServerUnreachable', () => {
  it('identifies server unreachable error codes and messages', () => {
    expect(isServerUnreachable(new Error('Server unreachable — check your connection and try again'))).toBe(true);
    expect(isServerUnreachable(Object.assign(new Error('down'), { code: 'SERVER_UNREACHABLE' }))).toBe(true);
    expect(isServerUnreachable(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isServerUnreachable(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }))).toBe(true);
    expect(isServerUnreachable(Object.assign(new Error('gateway timeout'), { status: 504 }))).toBe(true);
    expect(isServerUnreachable(Object.assign(new Error('bad gateway'), { status: 502 }))).toBe(true);
    expect(isServerUnreachable(Object.assign(new Error('service unavailable'), { status: 503 }))).toBe(true);
    expect(isServerUnreachable(new TypeError('Failed to fetch'))).toBe(true);
    expect(isServerUnreachable(new TypeError('NetworkError when attempting to fetch resource'))).toBe(true);
  });

  it('returns false for reachable server errors and empty values', () => {
    expect(isServerUnreachable(null)).toBe(false);
    expect(isServerUnreachable(undefined)).toBe(false);
    expect(isServerUnreachable(new Error('Invalid password'))).toBe(false);
    expect(isServerUnreachable(Object.assign(new Error('Not found'), { status: 404 }))).toBe(false);
    expect(isServerUnreachable(Object.assign(new Error('Unauthorized'), { status: 401 }))).toBe(false);
  });
});


it('streams Blob uploads with a browser boundary and retains legacy JSON callers', async () => {
  const file = new Blob(['video bytes'], { type: 'video/mp4' });
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ filename: 'saved.mp4' }) });
  await request('/video-gen/upload', { method: 'POST', body: uploadBody(file, 'clip.mp4') });
  const [, options] = global.fetch.mock.calls[0];
  expect(options.headers).not.toHaveProperty('Content-Type');
  expect(options.body.get('file').name).toBe('clip.mp4');
  expect(await options.body.get('file').text()).toBe('video bytes');
  expect(JSON.parse(uploadBody('YWJj', 'old.mp4'))).toEqual({ data: 'YWJj', filename: 'old.mp4' });
});
