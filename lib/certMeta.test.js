import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  statSync: vi.fn(),
}));

import { readFileSync, statSync } from 'node:fs';
import {
  getTailscaleCertHostname,
  getTailscaleHttpsUrl,
  readCertMeta,
} from './certMeta.js';

const META_PATH = '/mock/data/certs/meta.json';

describe('certMeta.readCertMeta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when meta.json does not exist', () => {
    statSync.mockReturnValue(undefined);
    expect(readCertMeta(META_PATH)).toBeNull();
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('returns null when meta.json contains malformed JSON (mid-write)', () => {
    statSync.mockReturnValue({ mtimeMs: 1 });
    readFileSync.mockReturnValue('{ "mode": "tailscale", "hostname":');
    expect(readCertMeta(META_PATH)).toBeNull();
  });

  it('returns parsed tailscale meta with mode + hostname + ips', () => {
    statSync.mockReturnValue({ mtimeMs: 1 });
    readFileSync.mockReturnValue(JSON.stringify({
      mode: 'tailscale',
      hostname: 'host-alpha.example-tailnet.ts.net',
      ips: ['100.64.0.50'],
    }));
    expect(readCertMeta(META_PATH)).toEqual({
      mode: 'tailscale',
      hostname: 'host-alpha.example-tailnet.ts.net',
      ips: ['100.64.0.50'],
    });
  });

  it('returns parsed self-signed meta', () => {
    statSync.mockReturnValue({ mtimeMs: 1 });
    readFileSync.mockReturnValue(JSON.stringify({
      mode: 'self-signed',
      ips: ['127.0.0.1', '100.64.0.50'],
    }));
    expect(readCertMeta(META_PATH)).toEqual({
      mode: 'self-signed',
      ips: ['127.0.0.1', '100.64.0.50'],
    });
  });

  it('honors the metaPath argument (callers can swap paths per data dir)', () => {
    statSync.mockReturnValue({ mtimeMs: 1 });
    readFileSync.mockReturnValue(JSON.stringify({ mode: 'self-signed' }));
    readCertMeta('/alt/data/certs/meta.json');
    expect(statSync).toHaveBeenCalledWith('/alt/data/certs/meta.json', { throwIfNoEntry: false });
    expect(readFileSync).toHaveBeenCalledWith('/alt/data/certs/meta.json', 'utf-8');
  });

  it('returns null when statSync throws (e.g. EACCES on the parent dir)', () => {
    statSync.mockImplementation(() => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });
    expect(readCertMeta(META_PATH)).toBeNull();
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('returns null when readFileSync throws (e.g. EACCES on the file)', () => {
    statSync.mockReturnValue({ mtimeMs: 1 });
    readFileSync.mockImplementation(() => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });
    expect(readCertMeta(META_PATH)).toBeNull();
  });

  it('returns null when meta.json contains valid-but-primitive JSON (string / number / null / array)', () => {
    statSync.mockReturnValue({ mtimeMs: 1 });
    for (const primitive of ['"tailscale"', '42', 'null', 'true', '[1,2]']) {
      readFileSync.mockReturnValue(primitive);
      expect(readCertMeta(META_PATH), `expected null for ${primitive}`).toBeNull();
    }
  });
});

describe('certMeta trusted Tailscale URL helpers', () => {
  it('normalizes a valid Tailscale hostname and includes the PortOS port', () => {
    const meta = { mode: 'tailscale', hostname: 'Host-Alpha.Example-Tailnet.TS.NET.' };
    expect(getTailscaleCertHostname(meta)).toBe('host-alpha.example-tailnet.ts.net');
    expect(getTailscaleHttpsUrl(meta, 6000)).toBe('https://host-alpha.example-tailnet.ts.net:6000');
  });

  it('rejects untrusted modes, non-Tailscale hostnames, and invalid ports', () => {
    expect(getTailscaleCertHostname({ mode: 'self-signed', hostname: 'host.example.ts.net' })).toBeNull();
    expect(getTailscaleCertHostname({ mode: 'tailscale', hostname: 'example.com' })).toBeNull();
    expect(getTailscaleHttpsUrl({ mode: 'tailscale', hostname: 'host.example.ts.net' }, 0)).toBeNull();
    expect(getTailscaleHttpsUrl({ mode: 'tailscale', hostname: 'host.example.ts.net' }, 65536)).toBeNull();
  });
});
