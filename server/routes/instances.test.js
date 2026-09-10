import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Heavy service deps are mocked so route validation stays cheap and does not
// reach the live instance store.
vi.mock('../services/syncOrchestrator.js', () => ({
  getSyncStatus: vi.fn(),
  syncWithPeer: vi.fn(),
}));
vi.mock('../services/instances.js', () => ({
  updatePeer: vi.fn(),
  addPeer: vi.fn(),
  sanitizePeerForClient: vi.fn((peer) => peer),
  getAssignableInstances: vi.fn(),
}));
// This suite's routes/instances.js import pulls getSelf/updateSelf from the
// identity leaf (#6836) — double it too so an untested route (e.g. GET /
// self-view) can never fall through to a real data/instances.json read.
vi.mock('../services/instanceIdentity.js', () => ({
  getSelf: vi.fn(),
  updateSelf: vi.fn(),
}));
vi.mock('../services/sharing/peerSync.js', () => ({
  getFullSyncCoverageForPeer: vi.fn(),
}));
vi.mock('../services/certProvisioner.js', () => ({
  provisionTailscaleCert: vi.fn(),
}));
vi.mock('../lib/tailscale.js', () => ({
  getTailscaleStatus: vi.fn(),
}));

import { getSyncStatus } from '../services/syncOrchestrator.js';
import * as instances from '../services/instances.js';
import { getTailscaleStatus } from '../lib/tailscale.js';
vi.mock('../services/tailcatPeer.js', async (original) => ({
  ...(await original()),
  addPeerViaTailcat: vi.fn(),
  listTailcatForwards: vi.fn(),
  retryTailcatForward: vi.fn(),
  forgetTailcatForward: vi.fn(),
}));
vi.mock('../services/tailcatServe.js', async (original) => ({
  ...(await original()),
  getTailcatServeStatus: vi.fn(),
  ensureTailcatServe: vi.fn(),
  retryTailcatServe: vi.fn(),
  stopTailcatServe: vi.fn(),
}));
import {
  addPeerViaTailcat,
  listTailcatForwards,
  retryTailcatForward,
  forgetTailcatForward,
} from '../services/tailcatPeer.js';
import {
  getTailcatServeStatus,
  ensureTailcatServe,
  retryTailcatServe,
  stopTailcatServe,
} from '../services/tailcatServe.js';
import instancesRoutes from './instances.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/instances', instancesRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('GET /api/instances/tailnet-suffix', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the shared normalized MagicDNS snapshot used by setup guidance', async () => {
    getTailscaleStatus.mockResolvedValue({
      reason: 'running',
      dnsName: 'host-alpha.example-tailnet.ts.net',
      magicDnsSuffix: 'example-tailnet.ts.net',
      peers: [{
        dnsName: 'host-beta.example-tailnet.ts.net',
        hostName: 'host-beta',
        ips: ['100.64.0.50'],
      }],
    });

    const res = await request(buildApp()).get('/api/instances/tailnet-suffix');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      reason: 'running',
      self: 'host-alpha.example-tailnet.ts.net',
      suffix: 'example-tailnet.ts.net',
      peers: [{
        dnsName: 'host-beta.example-tailnet.ts.net',
        hostName: 'host-beta',
        ips: ['100.64.0.50'],
      }],
    });
  });
});

// #4520: the CoS task form's instance picker reads this. It is deliberately
// narrower than GET /api/instances — no addresses, no sync state, no peer that
// has yet to advertise a federation identity.
describe('GET /api/instances/assignable', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the assignable id/name pairs the picker renders', async () => {
    const assignable = [
      { instanceId: 'self-id', name: 'workstation', isSelf: true },
      { instanceId: 'peer-id', name: 'render-box', isSelf: false }
    ];
    instances.getAssignableInstances.mockResolvedValue(assignable);
    const res = await request(buildApp()).get('/api/instances/assignable');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ instances: assignable });
  });

  it('is not shadowed by the peer routes — a real handler answers it', async () => {
    instances.getAssignableInstances.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/instances/assignable');
    expect(res.status).toBe(200);
    expect(instances.getAssignableInstances).toHaveBeenCalled();
  });
});

describe('GET /api/instances/sync-status — forPeer scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSyncStatus.mockResolvedValue({ local: { brainSeq: 0, memorySeq: 0, checksums: {} } });
  });

  it('threads a canonical GUID forPeer through to getSyncStatus', async () => {
    const id = '191aaece-a492-41ee-a66d-d4661eadc132';
    const res = await request(buildApp()).get(`/api/instances/sync-status?forPeer=${id}`);
    expect(res.status).toBe(200);
    expect(getSyncStatus).toHaveBeenCalledWith({ includeChecksums: true, forPeer: id });
  });

  it('accepts a non-GUID forPeer (older PortOS / `unknown` sentinel) instead of throwing a 500', async () => {
    // Regression: an older PortOS or a prober carrying the `unknown` instance-id
    // sentinel hits us with a non-GUID value. The route must degrade
    // gracefully, not throw a ServerError on every probe cycle.
    const res = await request(buildApp()).get('/api/instances/sync-status?forPeer=unknown');
    expect(res.status).toBe(200);
    expect(getSyncStatus).toHaveBeenCalledWith({ includeChecksums: true, forPeer: 'unknown' });
  });

  it('accepts a bare empty ?forPeer= (the value z.string().guid() used to 500 on) → undefined', async () => {
    const res = await request(buildApp()).get('/api/instances/sync-status?forPeer=');
    expect(res.status).toBe(200);
    expect(getSyncStatus).toHaveBeenCalledWith({ includeChecksums: true, forPeer: undefined });
  });

  it('trims whitespace and caps an oversized forPeer at 128 chars', async () => {
    const long = 'x'.repeat(200);
    const res = await request(buildApp()).get(`/api/instances/sync-status?forPeer=%20${long}%20`);
    expect(res.status).toBe(200);
    expect(getSyncStatus).toHaveBeenCalledWith({ includeChecksums: true, forPeer: 'x'.repeat(128) });
  });

  it('drops a blank/whitespace-only forPeer to undefined (unscoped self-view)', async () => {
    const res = await request(buildApp()).get('/api/instances/sync-status?forPeer=%20%20');
    expect(res.status).toBe(200);
    expect(getSyncStatus).toHaveBeenCalledWith({ includeChecksums: true, forPeer: undefined });
  });

  it('drops a repeated forPeer (array) to undefined so only a scalar id scopes', async () => {
    const res = await request(buildApp()).get('/api/instances/sync-status?forPeer=a&forPeer=b');
    expect(res.status).toBe(200);
    expect(getSyncStatus).toHaveBeenCalledWith({ includeChecksums: true, forPeer: undefined });
  });

  it('omits forPeer entirely (legacy inbound-only shape) → undefined', async () => {
    const res = await request(buildApp()).get('/api/instances/sync-status');
    expect(res.status).toBe(200);
    expect(getSyncStatus).toHaveBeenCalledWith({ includeChecksums: true, forPeer: undefined });
  });

  it('surfaces cursorForYou only when getSyncStatus returns one', async () => {
    getSyncStatus.mockResolvedValue({
      local: { brainSeq: 3, memorySeq: 5, checksums: { universe: 'abc' } },
      cursorForYou: 42,
    });
    const res = await request(buildApp()).get('/api/instances/sync-status?forPeer=peer-1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ brainSeq: 3, memorySeq: 5, cursorForYou: 42 });
  });
});

describe('PUT /api/instances/peers/:id — media provider selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    instances.updatePeer.mockImplementation(async (id, updates) => ({ id, ...updates }));
  });

  it('validates and preserves mixed-version fields in the consumer allowlist', async () => {
    const mediaProvider = {
      enabled: true,
      futureField: 'keep',
      audioModels: [{
        engine: 'minimax-music3',
        modelId: 'minimax-music3',
        futureModelField: 'keep-too',
      }],
    };

    const res = await request(buildApp())
      .put('/api/instances/peers/peer-example')
      .send({ mediaProvider });

    expect(res.status).toBe(200);
    expect(instances.updatePeer).toHaveBeenCalledWith('peer-example', { mediaProvider });
    expect(res.body.mediaProvider).toEqual(mediaProvider);
  });

  it('rejects duplicate engine/model pairs before mutating the peer record', async () => {
    const model = { engine: 'minimax-music3', modelId: 'minimax-music3' };
    const res = await request(buildApp())
      .put('/api/instances/peers/peer-example')
      .send({ mediaProvider: { enabled: true, audioModels: [model, model] } });

    expect(res.status).toBe(400);
    expect(instances.updatePeer).not.toHaveBeenCalled();
  });
});

describe('POST /api/instances/peers/tailcat', () => {
  const tcAddress = 'tcEXAMPLE' + 'A'.repeat(40);
  beforeEach(() => vi.clearAllMocks());

  it('passes the selected HTTPS protocol and credentials through the managed transport', async () => {
    const peer = { id: 'peer-example', transport: 'tailcat', address: '127.0.0.1', port: 15555, protocol: 'https' };
    addPeerViaTailcat.mockResolvedValue(peer);
    const auth = { password: 'example-password' };
    const res = await request(buildApp()).post('/api/instances/peers/tailcat')
      .send({ tcAddress: ` ${tcAddress} `, protocol: 'https', auth });
    expect(res.status).toBe(201);
    expect(addPeerViaTailcat).toHaveBeenCalledWith({ tcAddress, protocol: 'https', auth, remotePort: 5565 });
    expect(instances.sanitizePeerForClient).toHaveBeenCalledWith(peer);
    expect(res.body).toEqual(peer);
  });

  it('rejects invalid addresses and protocols without starting a transport', async () => {
    for (const body of [{ tcAddress: 'invalid' }, { tcAddress, protocol: 'file' }]) {
      const res = await request(buildApp()).post('/api/instances/peers/tailcat').send(body);
      expect(res.status).toBe(400);
    }
    expect(addPeerViaTailcat).not.toHaveBeenCalled();
  });

  it('keeps the classic loopback guard in force', async () => {
    const res = await request(buildApp()).post('/api/instances/peers')
      .send({ address: '127.0.0.1', port: 15555, transport: 'tailcat' });
    expect(res.status).toBe(400);
    expect(instances.addPeer).not.toHaveBeenCalled();
    expect(addPeerViaTailcat).not.toHaveBeenCalled();
  });
});

describe('saved tailcat forward routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists saved forwards ahead of the /peers/:id patterns', async () => {
    const rows = [{ id: 'fwd_1', tcAddress: 'tcEX…wxyz', status: 'failed', lastError: 'startup timed out' }];
    listTailcatForwards.mockResolvedValue(rows);
    const res = await request(buildApp()).get('/api/instances/peers/tailcat/forwards');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ forwards: rows });
  });

  it('retries a saved forward and sanitizes the resulting peer', async () => {
    const peer = { id: 'peer-example', transport: 'tailcat', address: '127.0.0.1', port: 15556 };
    retryTailcatForward.mockResolvedValue(peer);
    const res = await request(buildApp()).post('/api/instances/peers/tailcat/forwards/fwd_1/retry');
    expect(res.status).toBe(200);
    expect(retryTailcatForward).toHaveBeenCalledWith('fwd_1', {});
    expect(instances.sanitizePeerForClient).toHaveBeenCalledWith(peer);
  });

  it('forgets a saved forward', async () => {
    forgetTailcatForward.mockResolvedValue({ id: 'fwd_1', peerId: 'peer-example' });
    const res = await request(buildApp()).delete('/api/instances/peers/tailcat/forwards/fwd_1');
    expect(res.status).toBe(200);
    expect(forgetTailcatForward).toHaveBeenCalledWith('fwd_1');
    expect(res.body).toEqual({ id: 'fwd_1', peerId: 'peer-example' });
  });
});


describe('tailcat serve routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns serve status including a copyable address shape', async () => {
    const status = {
      enabled: true,
      status: 'active',
      live: true,
      localPort: 5555,
      keyName: 'portos-api',
      tcAddress: 'tcEXAMPLE' + 'A'.repeat(40),
      tcAddressRedacted: 'tcEX…AAAA',
      hasAddress: true,
      lastError: null,
      lastErrorAt: null,
    };
    getTailcatServeStatus.mockResolvedValue(status);
    const res = await request(buildApp()).get('/api/instances/peers/tailcat/serve');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(status);
  });

  it('starts serve via POST', async () => {
    const status = { enabled: true, live: true, status: 'active', localPort: 5555, keyName: 'portos-api', hasAddress: true };
    ensureTailcatServe.mockResolvedValue(status);
    const res = await request(buildApp()).post('/api/instances/peers/tailcat/serve').send({});
    expect(res.status).toBe(200);
    expect(ensureTailcatServe).toHaveBeenCalled();
    expect(res.body).toEqual(status);
  });

  it('retries and stops serve', async () => {
    retryTailcatServe.mockResolvedValue({ enabled: true, live: true, status: 'active' });
    stopTailcatServe.mockResolvedValue({ enabled: false, live: false, status: 'stopped' });
    const retry = await request(buildApp()).post('/api/instances/peers/tailcat/serve/retry');
    expect(retry.status).toBe(200);
    expect(retryTailcatServe).toHaveBeenCalled();
    const stop = await request(buildApp()).delete('/api/instances/peers/tailcat/serve');
    expect(stop.status).toBe(200);
    expect(stopTailcatServe).toHaveBeenCalledWith({ disable: true });
  });
});

it('rejects main API and HTTP mirror ports for managed serving', async () => {
  for (const localPort of [5555, 5553]) {
    const response = await request(buildApp()).post('/api/instances/peers/tailcat/serve').send({ localPort });
    expect(response.status).toBe(400);
  }
});
