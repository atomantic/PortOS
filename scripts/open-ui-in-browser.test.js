import { describe, expect, it, vi } from 'vitest';
import {
  navigateWithRetry,
  isPortOsPage,
  findExistingPortOsTab,
  openPortOsUi,
} from './open-ui-in-browser.js';

const baseOpts = {
  totalTimeoutMs: 10_000,
  intervalMs: 1_000,
  sleep: vi.fn().mockResolvedValue(undefined),
};

describe('navigateWithRetry', () => {
  it('resolves immediately when the first attempt succeeds', async () => {
    const navigateFn = vi.fn().mockResolvedValue({ id: 'tab-1', url: 'https://host.example-tailnet.ts.net:5555' });
    const result = await navigateWithRetry({ ...baseOpts, navigateFn });
    expect(result).toEqual({ ok: true, page: { id: 'tab-1', url: 'https://host.example-tailnet.ts.net:5555' } });
    expect(navigateFn).toHaveBeenCalledTimes(1);
    expect(baseOpts.sleep).not.toHaveBeenCalled();
  });

  it('retries past a cold-launching browser (Chrome not up yet) and eventually succeeds', async () => {
    // Simulates the update.sh race: Chrome is still cold-launching so the first
    // couple of navigate attempts fail (CDP connection refused), then it comes up.
    const sleep = vi.fn().mockResolvedValue(undefined);
    const navigateFn = vi.fn()
      .mockRejectedValueOnce(new Error('CDP open-blank failed: connect ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('CDP open-blank failed: connect ECONNREFUSED'))
      .mockResolvedValueOnce({ id: 'tab-1', url: 'https://host.example-tailnet.ts.net:5555' });

    const result = await navigateWithRetry({ ...baseOpts, sleep, navigateFn });

    expect(result).toEqual({ ok: true, page: { id: 'tab-1', url: 'https://host.example-tailnet.ts.net:5555' } });
    expect(navigateFn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it('gives up once the total retry budget is exhausted, returning the last failure', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const sleep = vi.fn().mockImplementation(async (ms) => { now += ms; });
    const navigateFn = vi.fn().mockRejectedValue(new Error('CDP open-blank failed: connect ECONNREFUSED'));

    const result = await navigateWithRetry({
      ...baseOpts,
      totalTimeoutMs: 3_000,
      intervalMs: 1_000,
      sleep,
      navigateFn,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('CDP open-blank failed: connect ECONNREFUSED');
    // Budget of 3000ms at 1000ms/attempt: attempts stop once the next sleep
    // would cross the deadline, so it must not spin forever.
    expect(navigateFn.mock.calls.length).toBeGreaterThan(0);
    expect(navigateFn.mock.calls.length).toBeLessThan(10);

    vi.restoreAllMocks();
  });

  it('surfaces a thrown refusal (e.g. the SSRF pin rejecting a redirect) as a retryable failure, not a crash', async () => {
    const navigateFn = vi.fn().mockRejectedValue(new Error('refusing to ingest: response IP not allowed'));
    const result = await navigateWithRetry({ ...baseOpts, totalTimeoutMs: 500, intervalMs: 1000, navigateFn });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('refusing to ingest');
  });
});

describe('isPortOsPage', () => {
  it('matches exact targetUrl origin and subpaths', () => {
    const targetUrl = 'https://node.example.ts.net:5555';
    expect(isPortOsPage({ type: 'page', url: 'https://node.example.ts.net:5555/' }, { targetUrl })).toBe(true);
    expect(isPortOsPage({ type: 'page', url: 'https://node.example.ts.net:5555/dashboard' }, { targetUrl })).toBe(true);
    expect(isPortOsPage({ type: 'page', url: 'https://node.example.ts.net:5555/settings' }, { targetUrl })).toBe(true);
  });

  it('matches loopback hosts on API port, mirror port, and dev UI port', () => {
    expect(isPortOsPage({ type: 'page', url: 'http://localhost:5555/' })).toBe(true);
    expect(isPortOsPage({ type: 'page', url: 'http://127.0.0.1:5555/writers-room' })).toBe(true);
    expect(isPortOsPage({ type: 'page', url: 'http://localhost:5553/' })).toBe(true);
    expect(isPortOsPage({ type: 'page', url: 'http://localhost:5554/dashboard' })).toBe(true);
    expect(isPortOsPage({ type: 'page', url: 'https://localhost:5555/' })).toBe(true);
  });

  it('matches Tailscale MagicDNS domains (*.ts.net) on API port', () => {
    expect(isPortOsPage({ type: 'page', url: 'https://my-mac.example-tailnet.ts.net:5555/chat' })).toBe(true);
  });

  it('matches custom/LAN hosts on a PortOS port when title is PortOS', () => {
    expect(isPortOsPage({ type: 'page', url: 'http://192.168.1.50:5555/dashboard', title: 'PortOS' })).toBe(true);
    expect(isPortOsPage({ type: 'page', url: 'http://192.168.1.50:5555/chat', title: 'PortOS: Chat' })).toBe(true);
    expect(isPortOsPage({ type: 'page', url: 'http://192.168.1.50:5555/chat', title: 'PortOS - Studio' })).toBe(true);
  });

  it('rejects external websites even if title mentions PortOS', () => {
    expect(isPortOsPage({ type: 'page', url: 'https://github.com/atomantic/PortOS', title: 'GitHub - atomantic/PortOS' })).toBe(false);
    expect(isPortOsPage({ type: 'page', url: 'https://google.com', title: 'Google' })).toBe(false);
  });

  it('rejects blank and internal browser pages', () => {
    expect(isPortOsPage({ type: 'page', url: 'about:blank' })).toBe(false);
    expect(isPortOsPage({ type: 'page', url: 'chrome://newtab/' })).toBe(false);
  });

  it('rejects non-page targets, malformed URLs, and non-PortOS ports', () => {
    expect(isPortOsPage({ type: 'service_worker', url: 'http://localhost:5555/sw.js' })).toBe(false);
    expect(isPortOsPage({ type: 'page', url: 'http://localhost:8080/' })).toBe(false);
    expect(isPortOsPage(null)).toBe(false);
    expect(isPortOsPage({})).toBe(false);
    expect(isPortOsPage({ type: 'page', url: 'not-a-valid-url' })).toBe(false);
  });
});

describe('findExistingPortOsTab', () => {
  it('finds the first matching PortOS tab from a list of targets', () => {
    const pages = [
      { id: 'tab-0', type: 'page', url: 'chrome://newtab/' },
      { id: 'tab-1', type: 'page', url: 'https://my-mac.ts.net:5555/dashboard' },
      { id: 'tab-2', type: 'page', url: 'http://localhost:5555/' },
    ];
    const found = findExistingPortOsTab(pages, { targetUrl: 'https://my-mac.ts.net:5555' });
    expect(found).toEqual(pages[1]);
  });

  it('returns null when no PortOS tab exists in targets', () => {
    const pages = [
      { id: 'tab-0', type: 'page', url: 'chrome://newtab/' },
      { id: 'tab-1', type: 'page', url: 'https://example.com' },
    ];
    expect(findExistingPortOsTab(pages, { targetUrl: 'https://my-mac.ts.net:5555' })).toBe(null);
  });

  it('handles empty or non-array inputs safely', () => {
    expect(findExistingPortOsTab([])).toBe(null);
    expect(findExistingPortOsTab(null)).toBe(null);
    expect(findExistingPortOsTab(undefined)).toBe(null);
  });
});

describe('openPortOsUi', () => {
  it('skips launching when an existing PortOS tab is already open', async () => {
    const existingTab = { id: 'tab-1', type: 'page', url: 'https://host.ts.net:5555/dashboard' };
    const getPagesFn = vi.fn().mockResolvedValue([existingTab]);
    const navigatePinnedFn = vi.fn();

    const result = await openPortOsUi({
      targetUrl: 'https://host.ts.net:5555',
      getPagesFn,
      navigatePinnedFn,
    });

    expect(result).toEqual({
      ok: true,
      page: { alreadyOpen: true, tab: existingTab },
    });
    expect(getPagesFn).toHaveBeenCalledTimes(1);
    expect(navigatePinnedFn).not.toHaveBeenCalled();
  });

  it('navigates to open a new tab when no PortOS tab is currently open', async () => {
    const blankTab = { id: 'tab-0', type: 'page', url: 'chrome://newtab/' };
    const getPagesFn = vi.fn().mockResolvedValue([blankTab]);
    const newPage = { id: 'tab-1', url: 'https://host.ts.net:5555' };
    const navigatePinnedFn = vi.fn().mockResolvedValue(newPage);

    const result = await openPortOsUi({
      targetUrl: 'https://host.ts.net:5555',
      getPagesFn,
      navigatePinnedFn,
    });

    expect(result).toEqual({
      ok: true,
      page: { alreadyOpen: false, tab: newPage },
    });
    expect(getPagesFn).toHaveBeenCalledTimes(1);
    expect(navigatePinnedFn).toHaveBeenCalledWith('https://host.ts.net:5555');
  });

  it('retries through cold launch and detects existing tab once connected', async () => {
    const existingTab = { id: 'tab-1', type: 'page', url: 'http://localhost:5555/' };
    const getPagesFn = vi.fn()
      .mockRejectedValueOnce(new Error('CDP /json/list failed: connect ECONNREFUSED'))
      .mockResolvedValueOnce([existingTab]);
    const navigatePinnedFn = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await openPortOsUi({
      targetUrl: 'https://host.ts.net:5555',
      getPagesFn,
      navigatePinnedFn,
      sleep,
      totalTimeoutMs: 5_000,
      intervalMs: 1_000,
    });

    expect(result).toEqual({
      ok: true,
      page: { alreadyOpen: true, tab: existingTab },
    });
    expect(getPagesFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(navigatePinnedFn).not.toHaveBeenCalled();
  });

  it('retries through cold launch and navigates when no tab exists once connected', async () => {
    const getPagesFn = vi.fn()
      .mockRejectedValueOnce(new Error('CDP /json/list failed: connect ECONNREFUSED'))
      .mockResolvedValueOnce([]);
    const newPage = { id: 'tab-1', url: 'http://localhost:5555' };
    const navigatePinnedFn = vi.fn().mockResolvedValue(newPage);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await openPortOsUi({
      targetUrl: 'http://localhost:5555',
      getPagesFn,
      navigatePinnedFn,
      sleep,
      totalTimeoutMs: 5_000,
      intervalMs: 1_000,
    });

    expect(result).toEqual({
      ok: true,
      page: { alreadyOpen: false, tab: newPage },
    });
    expect(getPagesFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(navigatePinnedFn).toHaveBeenCalledTimes(1);
  });
});

