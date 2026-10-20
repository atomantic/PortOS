import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// GET /api/catalog/sync is a peer pull (PEER_API_SURFACE). The real peer-pull
// gate runs; only the peer registry, settings and the sync read are stubbed.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-catalog-sync-pull-') }));
afterAll(cleanupTempDataRoots);
const peers = [];
vi.mock('../services/instances.js', async () => ({
  ...(await vi.importActual('../services/instances.js')),
  getPeers: async () => peers,
}));
let settings = {};
vi.mock('../services/settings.js', async () => ({
  ...(await vi.importActual('../services/settings.js')),
  getSettings: async () => settings,
}));
vi.mock('../services/catalogSync.js', () => ({
  getChangesSince: vi.fn(async () => ({ changes: {}, maxSequences: {}, hasMore: false })),
  applyRemoteChanges: vi.fn(),
}));

import * as catalogSync from '../services/catalogSync.js';
import { PEER_INSTANCE_ID_HEADER } from '../services/sharing/peerPullAuthorization.js';
import catalogRoutes from './catalog.js';

const PEER_ID = 'peer-a-instance-id';
const buildApp = () => {
  const app = express();
  app.use('/api/catalog', catalogRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('GET /api/catalog/sync peer pull authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings = { federation: { strictPullAuthorization: true } };
    peers.length = 0;
  });

  it('refuses a peer the user does not share the catalog with', async () => {
    peers.push({ instanceId: PEER_ID, enabled: true, syncEnabled: true, directions: ['outbound', 'inbound'], syncCategories: { brain: true } });

    const res = await request(buildApp()).get('/api/catalog/sync?since=0').set(PEER_INSTANCE_ID_HEADER, PEER_ID);

    expect(res.status).toBe(403);
    expect(catalogSync.getChangesSince).not.toHaveBeenCalled();
  });

  it('serves a peer with the catalog category on', async () => {
    peers.push({ instanceId: PEER_ID, enabled: true, syncEnabled: true, directions: ['outbound', 'inbound'], syncCategories: { catalog: true } });

    const res = await request(buildApp()).get('/api/catalog/sync?since=0').set(PEER_INSTANCE_ID_HEADER, PEER_ID);

    expect(res.status).toBe(200);
    expect(catalogSync.getChangesSince).toHaveBeenCalledOnce();
  });
});
