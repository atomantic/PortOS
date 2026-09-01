import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/certMeta.js', async () => ({
  ...await vi.importActual('../lib/certMeta.js'),
  readCertMeta: vi.fn(),
}));

vi.mock('../lib/tailscale-https.js', () => ({
  hasTailscaleCert: vi.fn(),
}));

vi.mock('../server/lib/tailscale.js', () => ({
  getTailscaleStatus: vi.fn(),
}));

import { readCertMeta } from '../lib/certMeta.js';
import { hasTailscaleCert } from '../lib/tailscale-https.js';
import { getTailscaleStatus } from '../server/lib/tailscale.js';
import {
  formatSetupGuide,
  formatSetupSummary,
  getCliSetupGuide,
} from './setup-guide.js';

const readyTailscale = {
  available: true,
  running: true,
  sandboxed: false,
  dnsName: 'host-alpha.example-tailnet.ts.net',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
  readCertMeta.mockReturnValue(null);
  hasTailscaleCert.mockReturnValue(false);
  getTailscaleStatus.mockResolvedValue({
    available: false,
    running: false,
    reason: 'tailscale-not-installed',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const incompleteGuide = {
  complete: false,
  nextStep: {
    id: 'https-cert',
    title: 'Provision a trusted HTTPS certificate',
    detail: 'Enable HTTPS Certificates, then let PortOS fetch the certificate.',
  },
  steps: [
    {
      id: 'tailscale-install',
      title: 'Install Tailscale',
      status: 'complete',
      detail: 'The Tailscale CLI is installed.',
      action: null,
    },
    {
      id: 'magic-dns',
      title: 'Enable MagicDNS',
      status: 'complete',
      detail: 'MagicDNS assigned host-alpha.example-tailnet.ts.net.',
      action: null,
    },
    {
      id: 'https-cert',
      title: 'Provision a trusted HTTPS certificate',
      status: 'action',
      detail: 'Enable HTTPS Certificates, then let PortOS fetch the certificate.',
      action: {
        type: 'provision-cert',
        label: 'Enable HTTPS',
        adminUrl: 'https://login.tailscale.com/admin/dns',
      },
    },
  ],
};

describe('setup walkthrough formatting', () => {
  it('prints the ordered network actions and all three AI provider paths', () => {
    const output = formatSetupGuide(incompleteGuide, {
      localUrl: 'http://localhost:5555',
      setupUrl: 'http://localhost:5555/capabilities',
    });

    expect(output).toContain('[✓] Install Tailscale');
    expect(output).toContain('[→] Provision a trusted HTTPS certificate');
    expect(output).toContain('https://login.tailscale.com/admin/dns');
    expect(output).toContain('npm run setup:cert');
    expect(output).toContain('Subscription CLI');
    expect(output).toContain('API provider');
    expect(output).toContain('Local/private');
    expect(output).toContain('Open setup: http://localhost:5555/capabilities');
    expect(output).toContain('Local PortOS URL: http://localhost:5555');
  });

  it('summarizes the next action without claiming setup is complete', () => {
    expect(formatSetupSummary(incompleteGuide)).toBe(
      'Provision a trusted HTTPS certificate — Enable HTTPS Certificates, then let PortOS fetch the certificate.',
    );
  });

  it('prints the exact trusted URL for a completed install', () => {
    const guide = {
      complete: true,
      trustedUrl: 'https://host-alpha.example-tailnet.ts.net:5555',
      nextStep: null,
      steps: [],
    };
    expect(formatSetupSummary(guide)).toBe(
      'Trusted Tailscale HTTPS ready at https://host-alpha.example-tailnet.ts.net:5555',
    );
    expect(formatSetupGuide(guide)).toContain(
      'Trusted PortOS URL: https://host-alpha.example-tailnet.ts.net:5555',
    );
  });
});

describe('getCliSetupGuide', () => {
  it('uses the trusted URL without probing when the restarted server is known active', async () => {
    readCertMeta.mockReturnValue({
      mode: 'tailscale',
      hostname: 'host-alpha.example-tailnet.ts.net',
    });
    hasTailscaleCert.mockReturnValue(true);
    getTailscaleStatus.mockResolvedValue(readyTailscale);

    const guide = await getCliSetupGuide({ assumeActive: true });

    expect(guide.complete).toBe(true);
    expect(guide.trustedUrl).toBe('https://host-alpha.example-tailnet.ts.net:5555');
    expect(guide.setupUrl).toBe('https://host-alpha.example-tailnet.ts.net:5555/capabilities');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the live HTTP URL after a certificate is written before restart', async () => {
    readCertMeta.mockReturnValue({
      mode: 'tailscale',
      hostname: 'host-alpha.example-tailnet.ts.net',
    });
    hasTailscaleCert.mockReturnValue(true);
    getTailscaleStatus.mockResolvedValue(readyTailscale);
    fetch
      .mockRejectedValueOnce(new Error('mirror is not running'))
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ scheme: 'http' }),
      });

    const guide = await getCliSetupGuide();

    expect(guide.complete).toBe(false);
    expect(guide.nextStep).toMatchObject({ id: 'activate-https' });
    expect(guide.localUrl).toBe('http://localhost:5555');
    expect(guide.setupUrl).toBe('http://localhost:5555/capabilities');
    expect(fetch).toHaveBeenNthCalledWith(1,
      'http://localhost:5553/api/system/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(fetch).toHaveBeenNthCalledWith(2,
      'http://localhost:5555/api/system/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('uses the default HTTP URL without probing when no certificate exists', async () => {
    const guide = await getCliSetupGuide();

    expect(guide.complete).toBe(false);
    expect(guide.localUrl).toBe('http://localhost:5555');
    expect(guide.setupUrl).toBe('http://localhost:5555/capabilities');
    expect(fetch).not.toHaveBeenCalled();
  });
});
