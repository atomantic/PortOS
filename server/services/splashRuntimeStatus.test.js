import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const getSplashManagedState = vi.hoisted(() => vi.fn());
vi.mock('./splashServerManager.js', () => ({ getSplashManagedState }));

vi.mock('../lib/processEnv.js', async (importOriginal) => ({
  ...await importOriginal(), findCommandOnPath: () => '/usr/local/bin/splash',
}));

const host = { platform: 'darwin', arch: 'arm64', macVersion: '27.2.0', cpuModel: 'Apple M5 Max' };
beforeEach(() => getSplashManagedState.mockReset().mockResolvedValue({ installed: false, managed: false }));

import { getSplashRuntimeStatus } from './splashRuntimeStatus.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('reports the model only after the external engine is ready, never generates or follows a redirect', async () => {
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
  expect(getSplashManagedState).toHaveBeenCalledTimes(4);
  expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/ready', '/ready', '/ready', '/v1/models', '/ready', '/v1/models']);
  expect(fetch.mock.calls.every(([, init]) => init?.redirect === 'error' && init.method === undefined)).toBe(true);
});

it('does not connect from an unsupported host', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  expect(await getSplashRuntimeStatus({ platform: 'linux' })).toMatchObject({ supported: false, state: 'unsupported' });
  expect(fetch).not.toHaveBeenCalled();
});

it('distinguishes a managed warmup from a ready managed endpoint', async () => {
  getSplashManagedState.mockResolvedValue({ installed: true, managed: true, requestedContextWindow: 1000000 });
  const fetch = vi.fn().mockRejectedValueOnce(new Error('not bound'))
    .mockResolvedValueOnce(Response.json({ status: 'ready' }))
    .mockResolvedValueOnce(Response.json({ data: [
      { id: 'alias', owned_by: 'splash', max_model_len: 65536 },
      { id: 'inkling2-mini', owned_by: 'splash', context_length: 524288 },
    ] }));
  vi.stubGlobal('fetch', fetch);
  expect(await getSplashRuntimeStatus(host)).toMatchObject({ state: 'starting', managed: true });
  expect(await getSplashRuntimeStatus(host)).toMatchObject({
    state: 'running', managed: true, model: 'inkling2-mini', requestedContextWindow: 1000000, servedContextWindow: 524288,
  });
});

it.each([
  { ...host, cpuModel: 'Apple M2 Ultra' },
  { ...host, macVersion: '26.3.0' },
])('explains unsupported Apple Silicon versions without probing them', async (unsupported) => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  expect(await getSplashRuntimeStatus(unsupported)).toMatchObject({ supported: false, state: 'unsupported' });
  expect(fetch).not.toHaveBeenCalled();
});

it('reports a managed install as stopped and a PATH-only install as missing', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('not bound')));
  expect(await getSplashRuntimeStatus(host)).toMatchObject({ installed: false, state: 'missing' });

  getSplashManagedState.mockResolvedValue({ installed: true, managed: false });
  expect(await getSplashRuntimeStatus(host)).toMatchObject({ installed: true, state: 'stopped' });
});
