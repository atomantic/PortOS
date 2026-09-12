import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../components/ui/Toast', () => ({
  default: { loading: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

import toast from '../components/ui/Toast';
import { handleSelfRestart, getApps, getApp } from './apiApps';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('handleSelfRestart', () => {
  it('polls and navigates on the new HTTPS origin after a TLS-enabling restart', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    const assign = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('location', {
      pathname: '/instances',
      search: '?view=peers',
      hash: '#https',
      assign,
      reload: vi.fn(),
    });

    handleSelfRestart({ targetOrigin: 'https://host-alpha.example-tailnet.ts.net:5555/' });

    expect(toast.loading).toHaveBeenCalledWith('Restarting PortOS...', {
      id: 'self-restart',
      duration: Infinity,
    });

    await vi.advanceTimersByTimeAsync(2000);

    expect(fetch).toHaveBeenCalledWith(
      'https://host-alpha.example-tailnet.ts.net:5555/api/system/health',
      { mode: 'no-cors' }
    );
    expect(toast.success).toHaveBeenCalledWith('PortOS restarted successfully', {
      id: 'self-restart',
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(assign).toHaveBeenCalledWith(
      'https://host-alpha.example-tailnet.ts.net:5555/instances?view=peers#https'
    );
  });
});

it('requests quality only for opted-in views and preserves caller request options', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
  vi.stubGlobal('fetch', fetch);
  const signal = new AbortController().signal;
  await getApps();
  await getApp('portos-default');
  await getApps({ includeQuality: true, signal });
  await getApp('portos-default', { includeQuality: true, signal });
  await getApps({ view: 'nav' });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    '/api/apps', '/api/apps/portos-default', '/api/apps?includeQuality=true', '/api/apps/portos-default?includeQuality=true', '/api/apps?view=nav',
  ]);
  expect(fetch.mock.calls[2][1]).toMatchObject({ signal });
  expect(fetch.mock.calls[2][1]).not.toHaveProperty('includeQuality');
});
