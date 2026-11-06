import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const peers = [];
vi.mock('../services/instances.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getPeers: async () => peers,
}));
vi.mock('../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: async () => ({ federation: { strictPullAuthorization: false } }),
}));
vi.mock('../services/sharing/peerSync.js', () => ({
  listPeerSubscriptions: vi.fn(), subscribePeer: vi.fn(), unsubscribePeer: vi.fn(),
  applyIncomingPush: vi.fn(), forcePushRecord: vi.fn(), getRecordPayloadForPeer: vi.fn(),
  pullRecordFromPeer: vi.fn(), syncNowForPeer: vi.fn(), buildMediaLibraryManifest: vi.fn(),
  buildCosHistoryManifest: vi.fn(), buildCosTasksPayload: vi.fn(), buildEidoverseFoundationOffering: vi.fn(),
  ERR_NOT_FOUND: 'NOT_FOUND', ERR_VALIDATION: 'VALIDATION', ERR_SCHEMA_VERSION_AHEAD: 'SCHEMA_AHEAD',
  PEER_SUBSCRIBABLE_KINDS: ['author', 'universe'],
}));
vi.mock('../services/sharing/integrity.js', () => ({
  buildLocalManifest: vi.fn(async () => [{ id: 'author-1' }]),
  getPeerIntegrity: vi.fn(), PEER_MANIFEST_VERSION: 1,
  isLegacyManifestKind: (kind) => kind === 'universe',
}));
vi.mock('../services/sharing/sidecarSync.js', () => ({ backfillMissingSidecars: vi.fn() }));

const { buildLocalManifest } = await import('../services/sharing/integrity.js');
const { __resetPullWarnThrottleForTests } = await import('../services/sharing/peerPullAuthorization.js');
const { default: routes } = await import('./peerSync.js');

function appFor({ localOperator = false } = {}) {
  const app = express();
  if (localOperator) app.use((req, _res, next) => {
    req.portosAuthContext = { enabled: false, authenticated: false, method: null };
    next();
  });
  app.use('/api/peer-sync', routes);
  app.use(errorMiddleware);
  return app;
}

describe('new integrity manifest authorization', () => {
  beforeEach(() => {
    peers.length = 0;
    vi.clearAllMocks();
    __resetPullWarnThrottleForTests();
  });

  it('serves configured peers and a local operator, but refuses disabled and unknown peers', async () => {
    peers.push(
      { instanceId: 'allowed', enabled: true, syncEnabled: true, directions: ['outbound'], syncCategories: { authors: true } },
      { instanceId: 'disabled', enabled: true, syncEnabled: true, directions: ['outbound'], syncCategories: { authors: false } },
    );
    for (const id of ['disabled', 'unknown']) {
      const response = await request(appFor()).get('/api/peer-sync/manifest?kind=author').set('X-PortOS-Instance-Id', id);
      expect(response.status).toBe(403);
    }
    expect(buildLocalManifest).not.toHaveBeenCalled();
    const allowed = await request(appFor()).get('/api/peer-sync/manifest?kind=author').set('X-PortOS-Instance-Id', 'allowed');
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({ manifestVersion: 1, records: [{ id: 'author-1' }] });
    expect((await request(appFor({ localOperator: true })).get('/api/peer-sync/manifest?kind=author')).status).toBe(200);
  });
});
