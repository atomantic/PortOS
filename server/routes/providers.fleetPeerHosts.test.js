import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Router } from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/fleetLlmHost.js', () => ({
  getFleetPeerHosts: vi.fn(),
  revealFleetPeerHostKey: vi.fn(),
  getFleetLlmHostStatus: vi.fn(),
  revealFleetLlmKey: vi.fn(),
  configureFleetLlmHost: vi.fn(),
}));

const fleetLlmHost = await import('../services/fleetLlmHost.js');
const { createPortOSProviderRoutes } = await import('./providers.js');

const buildApp = () => {
  const providerService = { getAllProviders: vi.fn().mockResolvedValue({ activeProvider: 'test', providers: [] }) };
  const app = express();
  app.use(express.json());
  app.use('/api/providers', createPortOSProviderRoutes({
    services: { providers: providerService }, routes: { providers: Router() },
  }));
  app.use(errorMiddleware);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/providers/fleet-peer-hosts', () => {
  it('returns peer hosts list from fleetLlmHost service', async () => {
    const mockHosts = [
      {
        peerId: 'peer-1',
        peerName: 'Workstation GPU',
        endpoint: 'http://gpu.ts.net:18022/v1',
        model: 'qwen3.8-27b',
        serving: true,
      },
    ];
    fleetLlmHost.getFleetPeerHosts.mockResolvedValue({ hosts: mockHosts });

    const res = await request(buildApp()).get('/api/providers/fleet-peer-hosts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hosts: mockHosts });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('POST /api/providers/fleet-peer-hosts/:peerId/key', () => {
  it('reveals key for a specific peer', async () => {
    fleetLlmHost.revealFleetPeerHostKey.mockResolvedValue({ apiKey: 'sample-peer-token' });

    const res = await request(buildApp()).post('/api/providers/fleet-peer-hosts/peer-1/key');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ apiKey: 'sample-peer-token' });
    expect(fleetLlmHost.revealFleetPeerHostKey).toHaveBeenCalledWith('peer-1');
  });
});
