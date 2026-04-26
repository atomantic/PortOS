import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./fileUtils.js', () => ({
  PATHS: { data: '/mock/data' }
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  statSync: vi.fn()
}));

import { readFileSync, statSync } from 'node:fs';
import { getSelfHost } from './peerSelfHost.js';

describe('peerSelfHost.getSelfHost', () => {
  beforeEach(() => {
    delete process.env.PORTOS_HOST;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.PORTOS_HOST;
  });

  it('honors PORTOS_HOST env override before reading meta.json', () => {
    process.env.PORTOS_HOST = 'override.example.ts.net';
    expect(getSelfHost()).toBe('override.example.ts.net');
    expect(statSync).not.toHaveBeenCalled();
  });

  it('returns null when meta.json does not exist', () => {
    statSync.mockReturnValue(undefined);
    expect(getSelfHost()).toBeNull();
  });

  it('returns hostname from tailscale-mode meta.json', () => {
    statSync.mockReturnValue({ mtimeMs: 1 });
    readFileSync.mockReturnValue(JSON.stringify({
      mode: 'tailscale',
      hostname: 'void.taile8179.ts.net'
    }));
    expect(getSelfHost()).toBe('void.taile8179.ts.net');
  });

  it('returns null for self-signed mode (no announceable hostname)', () => {
    statSync.mockReturnValue({ mtimeMs: 1 });
    readFileSync.mockReturnValue(JSON.stringify({
      mode: 'self-signed',
      ips: ['127.0.0.1', '100.111.11.146']
    }));
    expect(getSelfHost()).toBeNull();
  });
});
