import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-peer-sync-auth-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

vi.mock('../../lib/portosAuthCore.js', async () => {
  const actual = await vi.importActual('../../lib/portosAuthCore.js');
  const testParams = { N: 1024, r: 8, p: 1, maxmem: 8 * 1024 * 1024 };
  const hashPassword = (password, salt) =>
    actual.__hashPasswordWithParamsForTests(password, salt, testParams);
  return {
    ...actual,
    hashPassword,
    verifyPasswordAgainst: async (auth, password) => {
      if (!auth?.enabled || !auth.passwordHash || !auth.salt || typeof password !== 'string' || password.length === 0) return false;
      return actual.constantEqual(await hashPassword(password, auth.salt), auth.passwordHash);
    },
  };
});

vi.mock('../services/sharing/peerSync.js', () => ({
  listPeerSubscriptions: vi.fn(),
  subscribePeer: vi.fn(),
  unsubscribePeer: vi.fn(),
  applyIncomingPush: vi.fn(),
  forcePushRecord: vi.fn(),
  getRecordPayloadForPeer: vi.fn(),
  pullRecordFromPeer: vi.fn(),
  syncNowForPeer: vi.fn(),
  buildMediaLibraryManifest: vi.fn(),
  buildCosHistoryManifest: vi.fn(),
  buildCosTasksPayload: vi.fn(),
  ERR_NOT_FOUND: 'PEER_SYNC_SUBSCRIPTION_NOT_FOUND',
  ERR_VALIDATION: 'PEER_SYNC_SUBSCRIPTION_VALIDATION',
  ERR_SCHEMA_VERSION_AHEAD: 'PEER_SYNC_SCHEMA_VERSION_AHEAD',
  PEER_SUBSCRIBABLE_KINDS: Object.freeze(['universe', 'series', 'mediaCollection']),
}));

const resetSettings = () => {
  writeFileSync(join(tempRoot, 'settings.json'), '{}\n');
  writeFileSync(join(tempRoot, 'auth-sessions.json'), '{"tokens":[]}\n');
};

const buildApp = async () => {
  const { authGate } = await import('../services/authGate.js');
  const peerSyncRoutes = (await import('./peerSync.js')).default;
  const { errorMiddleware } = await import('../lib/errorHandler.js');
  const app = express();
  app.use(express.json());
  app.use(authGate);
  app.use('/api/peer-sync', peerSyncRoutes);
  app.use(errorMiddleware);
  return app;
};

beforeEach(() => {
  vi.resetModules();
  resetSettings();
});

afterAll(() => cleanup());

describe('peer-sync routes through authGate', () => {
  it('returns 401 before handling an unauthenticated push when instance auth is enabled', async () => {
    const auth = await import('../services/auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const svc = await import('../services/sharing/peerSync.js');
    const app = await buildApp();

    const res = await request(app)
      .post('/api/peer-sync/push')
      .send({
        kind: 'universe',
        record: { id: 'u1' },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
    expect(svc.applyIncomingPush).not.toHaveBeenCalled();
  });
});
