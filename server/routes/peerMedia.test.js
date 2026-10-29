import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-peer-media-route-' });
const registry = vi.hoisted(() => ({ peers: [] }));

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});
vi.mock('../services/instances.js', async () => {
  const actual = await vi.importActual('../services/instances.js');
  return { ...actual, getPeers: async () => registry.peers };
});
vi.mock('../services/instanceIdentity.js', () => ({ UNKNOWN_INSTANCE_ID: 'unknown', getInstanceId: async () => 'local-inst' }));
vi.mock('../services/mediaAssetIndex/index.js', () => ({ unindexVideo: async () => {} }));
vi.mock('../services/musicVideo/mediaPool.js', () => ({ forgetDeletedMusicVideoAssets: async () => {} }));
vi.mock('../lib/trashFiles.js', () => ({ trashFiles: vi.fn(async () => {}) }));

const { PATHS, readJSONFile, atomicWrite } = await import('../lib/fileUtils.js');
const { trashFiles } = await import('../lib/trashFiles.js');
const { peerSyncBus } = await import('../services/peerSyncEventBus.js');
const { listMediaTombstones } = await import('../services/mediaTombstones.js');
const { default: peerMediaRoutes } = await import('./peerMedia.js');

const HISTORY = join(PATHS.data, 'video-history.json');
const PAIR = 's'.repeat(40);
const peer = (extra = {}) => ({ id: 'rec-peer', name: 'Example Peer', instanceId: 'peer-p', enabled: true, syncSecret: PAIR, ...extra });
const row = (id) => ({ id, filename: `${id}.mp4`, createdAt: '2026-05-01T00:00:00.000Z', originInstanceId: 'local-inst' });
const PEER_AUTH = { enabled: true, authenticated: true, method: 'peer', peerId: 'rec-peer' };

// authGate is the one verifier of the pair credential; it leaves this marker.
// The route must admit only its `method: 'peer'` outcome.
const buildApp = (auth) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.portosAuthContext = auth; next(); });
  app.use('/api/peer-media', peerMediaRoutes);
  app.use(errorMiddleware);
  return app;
};
const post = (auth, body = { kind: 'video', key: 'v1' }) => request(buildApp(auth)).post('/api/peer-media/delete').send(body);
const readRows = async () => readJSONFile(HISTORY, []);
const deleteFrames = [];
const onFrame = (event) => { if (event.op === 'delete') deleteFrames.push(event); };
peerSyncBus.on('event', onFrame);

beforeEach(async () => {
  mkdirSync(PATHS.videos, { recursive: true });
  mkdirSync(PATHS.videoThumbnails, { recursive: true });
  await atomicWrite(HISTORY, [row('v1')]);
  await atomicWrite(join(PATHS.data, 'media-tombstones.json'), { version: 1, video: [], image: [] });
  registry.peers = [peer()];
  trashFiles.mockClear();
  deleteFrames.length = 0;
});

afterAll(() => {
  peerSyncBus.off('event', onFrame);
  cleanup();
});

describe('POST /api/peer-media/delete', () => {
  it('authorized peer delete trashes files and emits a tombstone', async () => {
    const res = await post(PEER_AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, tombstone: { key: 'v1' } });
    expect(await readRows()).toEqual([]);
    expect(trashFiles).toHaveBeenCalledTimes(1);
    expect((await listMediaTombstones('video')).map((t) => t.key)).toEqual(['v1']);
    await vi.waitFor(() => expect(deleteFrames.map((e) => e.id)).toEqual(['v1']));
  });

  it('peer with capability off gets 403 and nothing is deleted', async () => {
    registry.peers = [peer({ mediaDeleteAllowed: false })];
    const res = await post(PEER_AUTH);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MEDIA_DELETE_FORBIDDEN');
    expect((await readRows()).map((r) => r.id)).toEqual(['v1']);
    expect(trashFiles).not.toHaveBeenCalled();
    expect(await listMediaTombstones('video')).toEqual([]);
  });

  it('rejects an unauthenticated, Basic-only or browser-session caller', async () => {
    const callers = [
      undefined,
      { enabled: false, authenticated: false, method: null },
      { enabled: true, authenticated: true, method: 'basic' },
      { enabled: true, authenticated: true, method: 'session' },
      // Claiming a peer id without authGate's verified marker is not a peer.
      { enabled: false, authenticated: false, method: 'peer', peerId: 'rec-peer' },
    ];
    for (const auth of callers) {
      const res = await post(auth);
      expect(res.status, JSON.stringify(auth)).toBe(403);
      expect(res.body.code).toBe('PEER_CREDENTIAL_REQUIRED');
    }
    expect((await readRows()).map((r) => r.id)).toEqual(['v1']);
    expect(trashFiles).not.toHaveBeenCalled();
  });

  it('refuses a verified peer that has since been unpaired or disabled', async () => {
    for (const changed of [peer({ syncSecret: undefined }), peer({ enabled: false }), null]) {
      registry.peers = changed ? [changed] : [];
      expect((await post(PEER_AUTH)).body.code).toBe('PEER_CREDENTIAL_REQUIRED');
    }
    expect((await readRows()).map((r) => r.id)).toEqual(['v1']);
  });

  it('a paired peer with a valid credential but an unknown row gets 404', async () => {
    const res = await post(PEER_AUTH, { kind: 'video', key: 'ghost' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('MEDIA_NOT_HELD');
    expect(await listMediaTombstones('video')).toEqual([]);
  });

  it('answers image deletes as not supported yet and validates the body', async () => {
    expect((await post(PEER_AUTH, { kind: 'image', key: 'example.png' })).status).toBe(501);
    expect((await post(PEER_AUTH, { kind: 'video' })).status).toBe(400);
    expect((await post(PEER_AUTH, { kind: 'video', key: 'v1', extra: true })).status).toBe(400);
    expect((await readRows()).map((r) => r.id)).toEqual(['v1']);
  });
});
