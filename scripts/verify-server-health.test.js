import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { healthProbeUrls, parseTimeoutMs, probeHealth, waitForHealthy } from './verify-server-health.js';

/** Start a loopback server that answers one canned response, and return its URL. */
async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}/api/system/health`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('post-update server health verification', () => {
  it('probes the loopback mirror before the API port, and dedupes a plain-HTTP install', () => {
    expect(healthProbeUrls({ apiPort: 5555, mirrorPort: 5553 })).toEqual([
      'http://127.0.0.1:5553/api/system/health',
      'http://127.0.0.1:5555/api/system/health',
      'https://127.0.0.1:5555/api/system/health',
    ]);
    // No cert provisioned: the mirror never binds and the API port serves HTTP,
    // so the two http candidates collapse into one.
    expect(healthProbeUrls({ apiPort: 5555, mirrorPort: 5555 })).toEqual([
      'http://127.0.0.1:5555/api/system/health',
      'https://127.0.0.1:5555/api/system/health',
    ]);
  });

  it('accepts only a 200 that actually reports status "ok"', async () => {
    const ok = await withServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: '0.0.0-test' }));
    }, (url) => probeHealth(url));
    expect(ok).toBe(true);

    // A half-booted server, or something else squatting the port, answers —
    // treating that as healthy would skip the recovery the caller exists for.
    const degraded = await withServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'degraded' }));
    }, (url) => probeHealth(url));
    expect(degraded).toBe(false);

    const notJson = await withServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>proxy error</html>');
    }, (url) => probeHealth(url));
    expect(notJson).toBe(false);

    const serverError = await withServer((_req, res) => {
      res.writeHead(503);
      res.end('');
    }, (url) => probeHealth(url));
    expect(serverError).toBe(false);
  });

  it('reports unhealthy for a port nothing is listening on', async () => {
    // Bind then release so the port is known-free rather than guessed.
    const port = await withServer(() => {}, (url) => Number(new URL(url).port));
    expect(await probeHealth(`http://127.0.0.1:${port}/api/system/health`, 1_000)).toBe(false);
  });

  it('keeps polling a booting server until it answers, without spending the whole budget', async () => {
    let clock = 0;
    const probe = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const result = await waitForHealthy({
      urls: ['http://127.0.0.1:5553/api/system/health'],
      timeoutMs: 120_000,
      intervalMs: 2_000,
      probe,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });

    expect(result).toEqual({ healthy: true, url: 'http://127.0.0.1:5553/api/system/health', attempts: 3 });
    expect(clock).toBe(4_000);
  });

  it('gives up once the budget is spent, after asking at least once', async () => {
    let clock = 0;
    const probe = vi.fn().mockResolvedValue(false);

    const result = await waitForHealthy({
      urls: ['http://a/health', 'http://b/health'],
      timeoutMs: 5_000,
      intervalMs: 2_000,
      probe,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });

    expect(result.healthy).toBe(false);
    expect(result.url).toBe(null);
    // The contract is "kept asking for the whole budget, then stopped", not a
    // particular pass schedule: every candidate is asked on every pass, at
    // least one full pass happened, and it only gave up past the deadline.
    expect(probe.mock.calls.length % 2).toBe(0);
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(clock).toBeGreaterThanOrEqual(5_000);
  });

  it('reads a deliberate zero budget from the environment instead of falling back', () => {
    // `|| DEFAULT` would turn a fail-fast 0 — and a typo — into a silent 120s.
    expect(parseTimeoutMs('0')).toBe(0);
    expect(parseTimeoutMs('30000')).toBe(30_000);
    expect(parseTimeoutMs(undefined)).toBe(120_000);
    expect(parseTimeoutMs('')).toBe(120_000);
    expect(parseTimeoutMs('12O')).toBe(120_000);
    expect(parseTimeoutMs('-1')).toBe(120_000);
  });

  it('still makes one full pass when the budget is already exhausted', async () => {
    const probe = vi.fn().mockResolvedValue(false);

    const result = await waitForHealthy({
      urls: ['http://a/health'],
      timeoutMs: 0,
      probe,
      now: () => 0,
      sleep: async () => {},
    });

    expect(result.healthy).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
