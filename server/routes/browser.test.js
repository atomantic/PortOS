/**
 * SSRF-guard boundary tests for POST /api/browser/navigate.
 *
 * The navigate route reuses the catalog ingest guard (isSafeIngestUrl): http(s)
 * only, and loopback / link-local / cloud-metadata hosts blocked — including
 * IPv4-mapped-IPv6 bypass forms. Private/LAN hosts stay allowed (a single-user
 * tool legitimately drives its browser to a Tailscale peer or home-network app).
 * browserService is mocked so a rejected URL never reaches CDP and an accepted
 * one doesn't launch a real browser.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const navigateToUrl = vi.fn(async (url) => ({ ok: true, url }));
vi.mock('../services/browserService.js', () => ({
  navigateToUrl: (...a) => navigateToUrl(...a),
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

beforeEach(() => vi.clearAllMocks());

describe('POST /api/browser/navigate — SSRF guard', () => {
  it('accepts a normal https URL and forwards it to the browser service', async () => {
    const r = await navigate('https://example.com/');
    expect(r.status).toBe(200);
    expect(navigateToUrl).toHaveBeenCalledWith('https://example.com/');
  });

  it('accepts private / LAN hosts (intentionally allowed)', async () => {
    for (const url of ['http://192.168.1.10/', 'http://10.0.0.5:8080/', 'http://my-nas.local/']) {
      const r = await navigate(url);
      expect(r.status, url).toBe(200);
    }
    expect(navigateToUrl).toHaveBeenCalledTimes(3);
  });

  it('rejects non-http(s) schemes (file:/chrome:/javascript:)', async () => {
    for (const url of ['file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)', 'ftp://host/x']) {
      const r = await navigate(url);
      expect(r.status, url).toBe(400);
    }
    expect(navigateToUrl).not.toHaveBeenCalled();
  });

  it('rejects loopback hosts', async () => {
    for (const url of ['http://localhost:3000/', 'http://127.0.0.1/', 'http://[::1]/', 'http://0.0.0.0/']) {
      const r = await navigate(url);
      expect(r.status, url).toBe(400);
    }
    expect(navigateToUrl).not.toHaveBeenCalled();
  });

  it('rejects link-local and cloud-metadata hosts', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://[fe80::1]/', 'http://metadata.google.internal/']) {
      const r = await navigate(url);
      expect(r.status, url).toBe(400);
    }
    expect(navigateToUrl).not.toHaveBeenCalled();
  });

  it('rejects IPv4-mapped-IPv6 loopback/link-local bypasses', async () => {
    for (const url of ['http://[::ffff:127.0.0.1]/', 'http://[::ffff:169.254.169.254]/']) {
      const r = await navigate(url);
      expect(r.status, url).toBe(400);
    }
    expect(navigateToUrl).not.toHaveBeenCalled();
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
    expect(navigateToUrl).not.toHaveBeenCalled();
  });

  it('rejects a non-URL string', async () => {
    const r = await navigate('not a url');
    expect(r.status).toBe(400);
    expect(navigateToUrl).not.toHaveBeenCalled();
  });
});
