import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../components/ui/Toast', () => ({
  default: { loading: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

import toast from '../components/ui/Toast';
import { handleSelfRestart } from './apiApps';

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
