import { afterEach, expect, it, vi } from 'vitest';
import { getSplashRuntimeStatus } from './splashRuntimeStatus.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('reports the model only after the external engine is ready, never generates or follows a redirect', async () => {
  const host = { platform: 'darwin', arch: 'arm64' };
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ status: 'unavailable' }, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ status: 'ready' }))
    .mockResolvedValueOnce(Response.json({ data: [{ id: 'test-other-model', owned_by: 'example' }] }))
    .mockResolvedValueOnce(Response.json({ status: 'ready' }))
    .mockResolvedValueOnce(Response.json({ data: [{ id: 'inkling2-mini', owned_by: 'splash' }] }));
  vi.stubGlobal('fetch', fetch);

  expect(await getSplashRuntimeStatus(host)).toMatchObject({ supported: true, state: 'unrecognized' });
  expect(await getSplashRuntimeStatus(host)).toMatchObject({ supported: true, state: 'not-ready' });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(await getSplashRuntimeStatus(host)).toMatchObject({ supported: true, state: 'unrecognized' });
  expect(await getSplashRuntimeStatus(host)).toMatchObject({ supported: true, state: 'external', model: 'inkling2-mini' });
  expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/ready', '/ready', '/ready', '/v1/models', '/ready', '/v1/models']);
  expect(fetch.mock.calls.every(([, init]) => init?.redirect === 'error' && init.method === undefined)).toBe(true);
});

it('does not connect from an unsupported host', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  expect(await getSplashRuntimeStatus({ platform: 'linux' })).toMatchObject({ supported: false, state: 'unsupported' });
  expect(fetch).not.toHaveBeenCalled();
});
