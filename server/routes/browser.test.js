/**
 * SSRF-guard boundary tests for POST /api/browser/navigate.
 *
 * The navigate route defends in three layers:
 *   1. Host-literal Zod refine (isSafeIngestUrl): http(s) only, and loopback /
 *      link-local / cloud-metadata host LITERALS blocked — including
 *      IPv4-mapped-IPv6 bypass forms. Private/LAN hosts stay allowed (a
 *      single-user tool legitimately drives its browser to a Tailscale peer or
 *      home-network app).
 *   2. DNS-resolve pre-check (assertPublicHttpUrl): a HOSTNAME whose A record
 *      points at a blocked address is rejected before a tab is opened — closing
 *      the DNS-rebinding gap the literal guard can't see.
 *   3. CDP connect-time pin (navigateToUrlPinned): Chrome's ACTUAL per-hop
 *      connect IP (initial nav + every redirect + settle-window navigation) is
 *      verified against isBlockedIngestHost, so a rebind/redirect to a blocked
 *      host after the pre-check still fails closed.
 *
 * dns/promises is mocked so the resolve pre-check is hermetic (no real network),
 * and browserService is mocked so a rejected URL never reaches CDP and an
 * accepted one doesn't launch a real browser.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Default: every hostname resolves to a public address (allowed). Individual
// tests override this to simulate a hostname that rebinds to a blocked IP.
const lookup = vi.fn(async () => ({ address: '93.184.216.34', family: 4 }));
vi.mock('dns/promises', () => ({ default: { lookup }, lookup }));

const navigateToUrlPinned = vi.fn(async (url) => ({ id: 'tab-1', url }));
vi.mock('../services/browserService.js', () => ({
  navigateToUrlPinned: (...a) => navigateToUrlPinned(...a),
  // other exports are referenced by sibling routes but not by these tests
  restartBrowser: vi.fn(),
  getHealthStatus: vi.fn(),
  getBrowserStatus: vi.fn(),
  getBrowserLogs: vi.fn(),
}));

const router = (await import('./browser.js')).default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/browser', router);
  app.use(errorMiddleware);
  return app;
}

const navigate = (url) => request(makeApp()).post('/api/browser/navigate').send({ url });

beforeEach(() => {
  vi.clearAllMocks();
  lookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });
});

describe('POST /api/browser/navigate — SSRF guard', () => {
  it('accepts a normal https URL and pins it through the browser service', async () => {
    const r = await navigate('https://example.com/');
    expect(r.status).toBe(200);
    expect(navigateToUrlPinned).toHaveBeenCalledWith('https://example.com/', expect.objectContaining({
      verifyRemoteIp: expect.any(Function),
      settleMs: expect.any(Number),
    }));
  });

  it('pins with a predicate that rejects blocked connect IPs and allows public/LAN ones', async () => {
    await navigate('https://example.com/');
    const { verifyRemoteIp } = navigateToUrlPinned.mock.calls[0][1];
    // Blocked: loopback, link-local, cloud-metadata
    expect(verifyRemoteIp('127.0.0.1')).toBe(false);
    expect(verifyRemoteIp('169.254.169.254')).toBe(false);
    expect(verifyRemoteIp('::1')).toBe(false);
    // Allowed: public + private/LAN (Tailscale/home-network navigation stays usable)
    expect(verifyRemoteIp('93.184.216.34')).toBe(true);
    expect(verifyRemoteIp('192.168.1.10')).toBe(true);
  });

  it('accepts private / LAN hosts (intentionally allowed)', async () => {
    for (const url of ['http://192.168.1.10/', 'http://10.0.0.5:8080/', 'http://my-nas.local/']) {
      const r = await navigate(url);
      expect(r.status, url).toBe(200);
    }
    expect(navigateToUrlPinned).toHaveBeenCalledTimes(3);
  });

  it('rejects non-http(s) schemes (file:/chrome:/javascript:)', async () => {
    for (const url of ['file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)', 'ftp://host/x']) {
      const r = await navigate(url);
      expect(r.status, url).toBe(400);
    }
    expect(navigateToUrlPinned).not.toHaveBeenCalled();
  });

  it('rejects loopback hosts', async () => {
    for (const url of ['http://localhost:3000/', 'http://127.0.0.1/', 'http://[::1]/', 'http://0.0.0.0/']) {
      const r = await navigate(url);
      expect(r.status, url).toBe(400);
    }
    expect(navigateToUrlPinned).not.toHaveBeenCalled();
  });

  it('rejects link-local and cloud-metadata hosts', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://[fe80::1]/', 'http://metadata.google.internal/']) {
      const r = await navigate(url);
      expect(r.status, url).toBe(400);
    }
    expect(navigateToUrlPinned).not.toHaveBeenCalled();
  });

  it('rejects IPv4-mapped-IPv6 loopback/link-local bypasses', async () => {
    for (const url of ['http://[::ffff:127.0.0.1]/', 'http://[::ffff:169.254.169.254]/']) {
      const r = await navigate(url);
      expect(r.status, url).toBe(400);
    }
    expect(navigateToUrlPinned).not.toHaveBeenCalled();
  });

  it('rejects IPv4-compatible-IPv6 + trailing-dot bypasses', async () => {
    for (const url of [
      'http://[::127.0.0.1]/',          // → ::7f00:1 (compatible, not ::ffff:)
      'http://[::169.254.169.254]/',    // → ::a9fe:a9fe
      'http://localhost./',             // trailing FQDN dot
      'http://127.0.0.1./',
    ]) {
      const r = await navigate(url);
      expect(r.status, url).toBe(400);
    }
    expect(navigateToUrlPinned).not.toHaveBeenCalled();
  });

  it('rejects a hostname that DNS-rebinds to a blocked address (never opens a tab)', async () => {
    // Passes the host-literal guard (rebind.example is not a blocked literal) but
    // its A record resolves to loopback / cloud-metadata — the DNS-resolve
    // pre-check must catch it before navigateToUrlPinned is ever called.
    for (const address of ['127.0.0.1', '169.254.169.254']) {
      lookup.mockResolvedValueOnce({ address, family: 4 });
      const r = await navigate('http://rebind.example/');
      expect(r.status, address).toBe(400);
    }
    expect(navigateToUrlPinned).not.toHaveBeenCalled();
  });

  it('fails closed when a hostname cannot be resolved', async () => {
    // An unresolvable name can't be vetted → can't be safely pinned → refuse
    // rather than fall through to an unpinned navigate that re-resolves.
    lookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    const r = await navigate('http://does-not-resolve.example/');
    expect(r.status).toBe(400);
    expect(navigateToUrlPinned).not.toHaveBeenCalled();
  });

  it('rejects a non-URL string', async () => {
    const r = await navigate('not a url');
    expect(r.status).toBe(400);
    expect(navigateToUrlPinned).not.toHaveBeenCalled();
  });
});
