import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./fileUtils.js', () => ({
  PATHS: { data: '/mock/data' },
  safeJSONParse: (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } },
}));

vi.mock('./httpsState.js', () => ({
  getHttpsEnabledAtBoot: vi.fn(),
}));

vi.mock('./peerSelfHost.js', () => ({
  getSelfHost: vi.fn(),
}));

vi.mock('./tailscale.js', () => ({
  getTailscaleStatus: vi.fn(),
}));

vi.mock('../../lib/tailscale-https.js', () => ({
  hasTailscaleCert: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  statSync: vi.fn(),
}));

import { readFileSync, statSync } from 'node:fs';
import { getHttpsEnabledAtBoot } from './httpsState.js';
import { getSelfHost } from './peerSelfHost.js';
import { getTailscaleStatus } from './tailscale.js';
import { hasTailscaleCert } from '../../lib/tailscale-https.js';
import {
  buildNetworkSetupGuide,
  getNetworkExposureSetupStatus,
  getNetworkExposureStatus,
  isLoopbackHost,
  localApiBaseUrl,
} from './networkExposure.js';

describe('networkExposure.isLoopbackHost', () => {
  it.each([
    ['localhost', true],
    ['LOCALHOST', true],
    ['127.0.0.1', true],
    ['::1', true],
    ['0.0.0.0', false],
    ['100.64.0.50', false],
    ['host-alpha.example-tailnet.ts.net', false],
    ['', false],
    [null, false],
    [undefined, false],
  ])('isLoopbackHost(%p) === %p', (input, expected) => {
    expect(isLoopbackHost(input)).toBe(expected);
  });
});

describe('networkExposure.localApiBaseUrl', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PORT;
    delete process.env.PORTOS_HTTP_PORT;
    statSync.mockReturnValue(undefined);
    hasTailscaleCert.mockReturnValue(false);
    getSelfHost.mockReturnValue(null);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  // Under HTTPS the API port is TLS-only, so handing a plain-HTTP caller that
  // port fails at the transport layer — the mirror is the only correct target.
  it('resolves to the loopback HTTP mirror port when HTTPS is active', () => {
    getHttpsEnabledAtBoot.mockReturnValue({ value: true, initialized: true });
    expect(localApiBaseUrl()).toBe('http://127.0.0.1:5553');
  });

  it('honors PORTOS_HTTP_PORT for the mirror', () => {
    getHttpsEnabledAtBoot.mockReturnValue({ value: true, initialized: true });
    process.env.PORTOS_HTTP_PORT = '5999';
    expect(localApiBaseUrl()).toBe('http://127.0.0.1:5999');
  });

  it('resolves to the bound API port when HTTPS is off and no mirror is bound', () => {
    getHttpsEnabledAtBoot.mockReturnValue({ value: false, initialized: true });
    expect(localApiBaseUrl()).toBe('http://127.0.0.1:5555');

    process.env.PORT = '6000';
    expect(localApiBaseUrl()).toBe('http://127.0.0.1:6000');
  });
});

describe('networkExposure.getNetworkExposureStatus', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HOST;
    delete process.env.PORT;
    delete process.env.PORTOS_HTTP_PORT;
    statSync.mockReturnValue(undefined);
    hasTailscaleCert.mockReturnValue(false);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('reports HTTP-only when HTTPS is not enabled at boot', () => {
    getHttpsEnabledAtBoot.mockReturnValue({ value: false, initialized: true });
    getSelfHost.mockReturnValue(null);

    const status = getNetworkExposureStatus();
    expect(status.scheme).toBe('http');
    expect(status.httpsEnabled).toBe(false);
    expect(status.loopbackMirror.enabled).toBe(false);
    expect(status.cert.mode).toBeNull();
    expect(status.cert.tailscaleHost).toBeNull();
  });

  it('reports HTTPS + tailscale mode when cert meta.json indicates tailscale', () => {
    getHttpsEnabledAtBoot.mockReturnValue({ value: true, initialized: true });
    getSelfHost.mockReturnValue('host-alpha.example-tailnet.ts.net');
    hasTailscaleCert.mockReturnValue(true);
    statSync.mockReturnValue({ mtimeMs: 1 });
    readFileSync.mockReturnValue(JSON.stringify({
      mode: 'tailscale',
      hostname: 'host-alpha.example-tailnet.ts.net',
      ips: ['100.64.0.50']
    }));

    const status = getNetworkExposureStatus();
    expect(status.scheme).toBe('https');
    expect(status.httpsEnabled).toBe(true);
    expect(status.loopbackMirror.enabled).toBe(true);
    expect(status.cert.mode).toBe('tailscale');
    expect(status.cert.provisioned).toBe(true);
    expect(status.cert.provisionedHost).toBe('host-alpha.example-tailnet.ts.net');
    expect(status.cert.tailscaleHost).toBe('host-alpha.example-tailnet.ts.net');
    expect(status.cert.ips).toEqual(['100.64.0.50']);
  });

  it('reports HTTPS + self-signed mode when meta.json mode is self-signed', () => {
    getHttpsEnabledAtBoot.mockReturnValue({ value: true, initialized: true });
    getSelfHost.mockReturnValue(null);
    hasTailscaleCert.mockReturnValue(true);
    statSync.mockReturnValue({ mtimeMs: 1 });
    readFileSync.mockReturnValue(JSON.stringify({
      mode: 'self-signed',
      ips: ['127.0.0.1', '100.64.0.50']
    }));

    const status = getNetworkExposureStatus();
    expect(status.cert.mode).toBe('self-signed');
    expect(status.cert.tailscaleHost).toBeNull();
    expect(status.cert.ips).toEqual(['127.0.0.1', '100.64.0.50']);
  });

  it('returns "unknown" cert mode when HTTPS is on but meta.json is missing', () => {
    getHttpsEnabledAtBoot.mockReturnValue({ value: true, initialized: true });
    getSelfHost.mockReturnValue(null);
    statSync.mockReturnValue(undefined);

    const status = getNetworkExposureStatus();
    expect(status.cert.mode).toBe('unknown');
  });

  it('classifies bind audience by host', () => {
    getHttpsEnabledAtBoot.mockReturnValue({ value: false, initialized: true });
    getSelfHost.mockReturnValue(null);

    process.env.HOST = '0.0.0.0';
    expect(getNetworkExposureStatus().bind.audience).toBe('all-interfaces');

    process.env.HOST = '127.0.0.1';
    expect(getNetworkExposureStatus().bind.audience).toBe('loopback-only');

    process.env.HOST = '100.64.0.50';
    expect(getNetworkExposureStatus().bind.audience).toBe('specific-interface');
  });

  it('honors PORT and PORTOS_HTTP_PORT env overrides', () => {
    getHttpsEnabledAtBoot.mockReturnValue({ value: true, initialized: true });
    getSelfHost.mockReturnValue(null);
    process.env.PORT = '6000';
    process.env.PORTOS_HTTP_PORT = '6001';

    const status = getNetworkExposureStatus();
    expect(status.bind.port).toBe(6000);
    expect(status.loopbackMirror.port).toBe(6001);
  });
});

describe('networkExposure.buildNetworkSetupGuide', () => {
  const baseNetwork = {
    httpsEnabled: false,
    bind: { port: 5555 },
    cert: {
      mode: null,
      provisioned: false,
      provisionedMode: null,
      provisionedHost: null,
      tailscaleHost: null,
    },
  };

  it('starts at Tailscale installation when the CLI is absent', () => {
    const guide = buildNetworkSetupGuide(baseNetwork, {
      available: false,
      running: false,
      reason: 'tailscale-not-installed',
    });

    expect(guide.complete).toBe(false);
    expect(guide.nextStep).toMatchObject({ id: 'tailscale-install', status: 'action' });
    expect(guide.steps.map((step) => step.id)).toEqual([
      'tailscale-install',
      'tailscale-connect',
      'magic-dns',
      'https-cert',
      'activate-https',
    ]);
  });

  it('offers automatic provisioning after Tailscale and MagicDNS are ready', () => {
    const guide = buildNetworkSetupGuide(baseNetwork, {
      available: true,
      running: true,
      sandboxed: false,
      dnsName: 'Host-Alpha.Example-Tailnet.ts.net.',
    });

    expect(guide.canProvision).toBe(true);
    expect(guide.dnsName).toBe('host-alpha.example-tailnet.ts.net');
    expect(guide.nextStep).toMatchObject({
      id: 'https-cert',
      action: { type: 'provision-cert' },
    });
  });

  it('offers the writable CLI command when only the sandboxed macOS CLI is available', () => {
    const guide = buildNetworkSetupGuide(baseNetwork, {
      available: true,
      running: true,
      sandboxed: true,
      dnsName: 'host-alpha.example-tailnet.ts.net',
    });

    expect(guide.nextStep).toMatchObject({
      id: 'https-cert',
      status: 'action',
      action: { type: 'command', command: 'brew install tailscale' },
    });
  });

  it('names a stale certificate hostname before offering reprovisioning', () => {
    const guide = buildNetworkSetupGuide({
      ...baseNetwork,
      cert: {
        mode: null,
        provisioned: true,
        provisionedMode: 'tailscale',
        provisionedHost: 'host-old.example-tailnet.ts.net',
      },
    }, {
      available: true,
      running: true,
      sandboxed: false,
      dnsName: 'host-alpha.example-tailnet.ts.net',
    });

    expect(guide.nextStep).toMatchObject({
      id: 'https-cert',
      status: 'action',
      detail: 'The installed certificate is for host-old.example-tailnet.ts.net; reprovision it for host-alpha.example-tailnet.ts.net.',
      action: { type: 'provision-cert' },
    });
  });

  it('asks for a restart when the trusted cert exists but this process booted on HTTP', () => {
    const guide = buildNetworkSetupGuide({
      ...baseNetwork,
      cert: {
        mode: null,
        provisioned: true,
        provisionedMode: 'tailscale',
        provisionedHost: 'host-alpha.example-tailnet.ts.net',
      },
    }, {
      available: true,
      running: true,
      sandboxed: false,
      dnsName: 'host-alpha.example-tailnet.ts.net',
    });

    expect(guide.nextStep).toMatchObject({ id: 'activate-https', action: { type: 'restart' } });
    expect(guide.pendingTrustedUrl).toBe('https://host-alpha.example-tailnet.ts.net:5555');
  });

  it('reports the exact trusted URL only when HTTPS is active for the current host', () => {
    const guide = buildNetworkSetupGuide({
      ...baseNetwork,
      httpsEnabled: true,
      cert: {
        mode: 'tailscale',
        provisioned: true,
        provisionedMode: 'tailscale',
        provisionedHost: 'host-alpha.example-tailnet.ts.net',
      },
    }, {
      available: true,
      running: true,
      sandboxed: false,
      dnsName: 'host-alpha.example-tailnet.ts.net',
    });

    expect(guide.complete).toBe(true);
    expect(guide.nextStep).toBeNull();
    expect(guide.trustedUrl).toBe('https://host-alpha.example-tailnet.ts.net:5555');
  });

  it('never constructs a trusted URL from invalid or missing certificate host metadata', () => {
    const guide = buildNetworkSetupGuide({
      ...baseNetwork,
      httpsEnabled: true,
      cert: {
        mode: 'tailscale',
        provisioned: true,
        provisionedMode: 'tailscale',
        provisionedHost: null,
      },
    }, {
      available: true,
      running: true,
      sandboxed: false,
      dnsName: 'https://example.com/path',
    });

    expect(guide.complete).toBe(false);
    expect(guide.dnsName).toBeNull();
    expect(guide.trustedUrl).toBeNull();
    expect(guide.pendingTrustedUrl).toBeNull();
  });

  it('does not report remote setup complete while Tailscale is disconnected', () => {
    const guide = buildNetworkSetupGuide({
      ...baseNetwork,
      httpsEnabled: true,
      cert: {
        mode: 'tailscale',
        provisioned: true,
        provisionedMode: 'tailscale',
        provisionedHost: 'host-alpha.example-tailnet.ts.net',
      },
    }, {
      available: true,
      running: false,
      state: 'Stopped',
      dnsName: null,
    });

    expect(guide.complete).toBe(false);
    expect(guide.nextStep).toMatchObject({ id: 'tailscale-connect', status: 'action' });
    expect(guide.trustedUrl).toBeNull();
  });
});

describe('networkExposure.getNetworkExposureSetupStatus', () => {
  it('publishes only local setup facts and excludes the Tailscale peer map', async () => {
    readFileSync.mockImplementation(() => { throw new Error('missing'); });
    statSync.mockReturnValue(undefined);
    getHttpsEnabledAtBoot.mockReturnValue({ value: false, initialized: true });
    getSelfHost.mockReturnValue(null);
    hasTailscaleCert.mockReturnValue(false);
    getTailscaleStatus.mockResolvedValue({
      available: true,
      running: true,
      state: 'Running',
      reason: 'running',
      sandboxed: false,
      dnsName: 'host-alpha.example-tailnet.ts.net',
      peers: [{ hostName: 'host-beta', ips: ['100.64.0.50'] }],
    });

    const status = await getNetworkExposureSetupStatus();
    expect(status.tailscale).toEqual({
      available: true,
      running: true,
      state: 'Running',
      reason: 'running',
      sandboxed: false,
      dnsName: 'host-alpha.example-tailnet.ts.net',
    });
    expect(JSON.stringify(status)).not.toContain('host-beta');
  });
});
