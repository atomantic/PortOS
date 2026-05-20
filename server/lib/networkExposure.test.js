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

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  statSync: vi.fn(),
}));

import { readFileSync, statSync } from 'node:fs';
import { getHttpsEnabledAtBoot } from './httpsState.js';
import { getSelfHost } from './peerSelfHost.js';
import { getNetworkExposureStatus, isLoopbackHost } from './networkExposure.js';

describe('networkExposure.isLoopbackHost', () => {
  it.each([
    ['localhost', true],
    ['LOCALHOST', true],
    ['127.0.0.1', true],
    ['::1', true],
    ['0.0.0.0', false],
    ['100.111.11.146', false],
    ['void.taile8179.ts.net', false],
    ['', false],
    [null, false],
    [undefined, false],
  ])('isLoopbackHost(%p) === %p', (input, expected) => {
    expect(isLoopbackHost(input)).toBe(expected);
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
    getSelfHost.mockReturnValue('void.taile8179.ts.net');
    statSync.mockReturnValue({ mtimeMs: 1 });
    readFileSync.mockReturnValue(JSON.stringify({
      mode: 'tailscale',
      hostname: 'void.taile8179.ts.net',
      ips: ['100.111.11.146']
    }));

    const status = getNetworkExposureStatus();
    expect(status.scheme).toBe('https');
    expect(status.httpsEnabled).toBe(true);
    expect(status.loopbackMirror.enabled).toBe(true);
    expect(status.cert.mode).toBe('tailscale');
    expect(status.cert.tailscaleHost).toBe('void.taile8179.ts.net');
    expect(status.cert.ips).toEqual(['100.111.11.146']);
  });

  it('reports HTTPS + self-signed mode when meta.json mode is self-signed', () => {
    getHttpsEnabledAtBoot.mockReturnValue({ value: true, initialized: true });
    getSelfHost.mockReturnValue(null);
    statSync.mockReturnValue({ mtimeMs: 1 });
    readFileSync.mockReturnValue(JSON.stringify({
      mode: 'self-signed',
      ips: ['127.0.0.1', '100.111.11.146']
    }));

    const status = getNetworkExposureStatus();
    expect(status.cert.mode).toBe('self-signed');
    expect(status.cert.tailscaleHost).toBeNull();
    expect(status.cert.ips).toEqual(['127.0.0.1', '100.111.11.146']);
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

    process.env.HOST = '100.111.11.146';
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
