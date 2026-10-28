import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { PORTS } from '../server/lib/ports.js';

vi.mock('../lib/certMeta.js', async () => ({
  ...await vi.importActual('../lib/certMeta.js'),
  readCertMeta: vi.fn(),
}));
vi.mock('../lib/tailscale-https.js', () => ({ hasTailscaleCert: vi.fn() }));
vi.mock('../server/lib/tailscale.js', () => ({ getTailscaleStatus: vi.fn() }));

import { readCertMeta } from '../lib/certMeta.js';
import { hasTailscaleCert } from '../lib/tailscale-https.js';
import { getTailscaleStatus } from '../server/lib/tailscale.js';

const unrelatedPort = 49123;
const mirrorPort = 49124;
const host = 'host-alpha.example-tailnet.ts.net';
let health;
let browser;
let setup;
let banner;
let output;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('PORT', String(unrelatedPort));
  vi.stubEnv('PORTOS_HTTP_PORT', String(mirrorPort));
  vi.stubEnv('PORTOS_HEALTH_WAIT_MS', '0');
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
  hasTailscaleCert.mockReturnValue(false);
  readCertMeta.mockReturnValue(null);
  getTailscaleStatus.mockResolvedValue({ available: false, running: false });
  [health, browser, setup, banner] = await Promise.all([
    import('./verify-server-health.js'),
    import('./open-ui-in-browser.js'),
    import('./setup-guide.js'),
    import('./print-access-url.js'),
  ]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function provisionTrustedCert() {
  hasTailscaleCert.mockReturnValue(true);
  readCertMeta.mockReturnValue({ mode: 'tailscale', hostname: host });
  getTailscaleStatus.mockResolvedValue({
    available: true, running: true, sandboxed: false, dnsName: host,
  });
}

describe('managed maintenance ignores an unrelated inherited PORT', () => {
  it.each([
    ['HTTP-only', `http://127.0.0.1:${PORTS.API}/api/system/health`],
    ['HTTPS mirror', `http://127.0.0.1:${mirrorPort}/api/system/health`],
    ['HTTPS without a responding mirror', `https://127.0.0.1:${PORTS.API}/api/system/health`],
  ])('verifies the managed server for %s', async (_mode, healthyUrl) => {
    // Route only the expected managed candidate to an ephemeral fixture listener;
    // no test request can reach the running install or the inherited shell port.
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const fixtureUrl = `http://127.0.0.1:${server.address().port}/api/system/health`;
    const probe = vi.fn(async (url) => url === healthyUrl && health.probeHealth(fixtureUrl));
    try {
      expect(await health.runCli({ probe })).toBe(0);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
    expect(probe).toHaveBeenCalledWith(healthyUrl);
    expect(probe.mock.calls.flat().some(url => url.includes(`:${unrelatedPort}/`))).toBe(false);
    expect(output).toHaveBeenCalledWith(expect.stringContaining(healthyUrl));
  });

  it('reuses a managed browser tab and retains explicit custom-port recognition', async () => {
    const tab = { type: 'page', url: `http://localhost:${PORTS.API}/dashboard` };
    const navigatePinnedFn = vi.fn();
    const result = await browser.openPortOsUi({
      targetUrl: `http://localhost:${PORTS.API}`,
      getPagesFn: async () => [tab],
      navigatePinnedFn,
    });
    expect(result.page).toEqual({ alreadyOpen: true, tab });
    expect(navigatePinnedFn).not.toHaveBeenCalled();
    expect(browser.isPortOsPage({ url: `http://localhost:${unrelatedPort}/` })).toBe(false);
    expect(browser.isPortOsPage({ url: `http://localhost:${mirrorPort}/` })).toBe(true);
    expect(browser.isPortOsPage({ url: `http://localhost:${unrelatedPort}/` }, {
      apiPort: unrelatedPort,
    })).toBe(true);
  });

  it('advertises the managed HTTP endpoint in the setup guide and access banner', async () => {
    expect(await setup.getCliSetupGuide()).toMatchObject({
      localUrl: `http://localhost:${PORTS.API}`,
      setupUrl: `http://localhost:${PORTS.API}/capabilities`,
    });
    banner.printAccessUrl();
    expect(output).toHaveBeenCalledWith(`Access at: http://localhost:${PORTS.API}`);
  });

  it('probes the overridden mirror and managed API while a new cert awaits restart', async () => {
    provisionTrustedCert();
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error('mirror is not running'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ scheme: 'http' }) });
    vi.stubGlobal('fetch', fetch);
    expect(await setup.getCliSetupGuide()).toMatchObject({
      localUrl: `http://localhost:${PORTS.API}`,
      setupUrl: `http://localhost:${PORTS.API}/capabilities`,
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `http://localhost:${mirrorPort}/api/system/health`,
      `http://localhost:${PORTS.API}/api/system/health`,
    ]);
  });

  it('advertises trusted HTTPS on the managed API and keeps the overridden mirror', async () => {
    provisionTrustedCert();
    const guide = await setup.getCliSetupGuide({ assumeActive: true });
    expect(guide).toMatchObject({
      trustedUrl: `https://${host}:${PORTS.API}`,
      localUrl: `http://localhost:${mirrorPort}`,
      setupUrl: `https://${host}:${PORTS.API}/capabilities`,
    });
    banner.printAccessUrl();
    const lines = output.mock.calls.flat().join('\n');
    expect(lines).toContain(`http://localhost:${mirrorPort}`);
    expect(lines).toContain(`https://${host}:${PORTS.API}`);
    expect(lines).toContain(`https://localhost:${PORTS.API}`);
    expect(lines).not.toContain(String(unrelatedPort));
  });
});
