import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { data: '/tmp/portos-test-data' },
  readJSONFile: vi.fn()
}));

vi.mock('../../lib/fetchWithTimeout.js', () => ({
  fetchWithTimeout: vi.fn()
}));

vi.mock('../../services/instanceFeatures.js', () => ({
  isInstanceFeatureEnabled: vi.fn()
}));

import { readJSONFile } from '../../lib/fileUtils.js';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';
import { isInstanceFeatureEnabled } from '../../services/instanceFeatures.js';
import { getRuntimeStatus } from './api.js';

const OPENCLAW_ENV_KEYS = Object.keys(process.env).filter(key => key.startsWith('OPENCLAW_'));

function mockUpstreamResponse(payload) {
  fetchWithTimeout.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload)
  });
}

describe('openclaw getRuntimeStatus', () => {
  const savedEnv = {};

  beforeEach(() => {
    vi.clearAllMocks();
    isInstanceFeatureEnabled.mockResolvedValue(true);
    for (const key of OPENCLAW_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    readJSONFile.mockResolvedValue({ baseUrl: 'http://openclaw.local', defaultSession: 'main' });
  });

  afterEach(() => {
    for (const key of OPENCLAW_ENV_KEYS) {
      process.env[key] = savedEnv[key];
    }
  });

  it('exposes only the allowlisted runtime fields, never the raw upstream payload', async () => {
    mockUpstreamResponse({
      ok: true,
      result: {
        sessions: [{ id: 'main' }, { id: 'work' }],
        internalToken: 'should-never-reach-the-client',
        debugInfo: { host: 'internal-host' }
      }
    });

    const status = await getRuntimeStatus();

    expect(status.reachable).toBe(true);
    expect(status.runtime).toEqual({ sessionsCount: 2 });
    expect(JSON.stringify(status)).not.toContain('should-never-reach-the-client');
    expect(JSON.stringify(status)).not.toContain('internal-host');
  });

  it('returns runtime: null when the runtime is unreachable', async () => {
    fetchWithTimeout.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const status = await getRuntimeStatus();

    expect(status.reachable).toBe(false);
    expect(status.runtime).toBeNull();
  });

  it('returns runtime: null when OpenClaw is not configured', async () => {
    readJSONFile.mockResolvedValue({});

    const status = await getRuntimeStatus();

    expect(status.configured).toBe(false);
    expect(status.runtime).toBeNull();
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('does not configure or probe the runtime when the PortOS feature is disabled', async () => {
    isInstanceFeatureEnabled.mockResolvedValue(false);

    const status = await getRuntimeStatus();

    expect(status).toMatchObject({
      configured: false,
      enabled: false,
      reachable: false,
      message: 'OpenClaw is disabled for this PortOS instance'
    });
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
});
