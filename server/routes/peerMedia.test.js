import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { mkdirSync, writeFileSync } from 'fs';
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
vi.mock('../services/mediaAssetIndex/index.js', () => ({ unindexVideo: async () => {}, unindexImage: async () => {} }));
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

  it('deletes a gallery image this machine holds and answers with its tombstone', async () => {
    mkdirSync(PATHS.images, { recursive: true });
    writeFileSync(join(PATHS.images, 'fox.png'), 'synthetic');
    writeFileSync(join(PATHS.images, 'fox.metadata.json'), JSON.stringify({ prompt: 'a fox', originInstanceId: 'local-inst' }));
    const res = await post(PEER_AUTH, { kind: 'image', key: 'fox.png' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, tombstone: { key: 'fox.png' } });
    expect(trashFiles).toHaveBeenCalledWith(expect.arrayContaining([join(PATHS.images, 'fox.png')]));
    expect((await listMediaTombstones('image')).map((t) => t.key)).toEqual(['fox.png']);
    await vi.waitFor(() => expect(deleteFrames).toEqual([expect.objectContaining({ category: 'imageHistory', id: 'fox.png' })]));

    const ghost = await post(PEER_AUTH, { kind: 'image', key: 'ghost.png' });
    expect(ghost.status).toBe(404);
    expect(ghost.body.code).toBe('MEDIA_NOT_HELD');
  });

  it('validates the body and the image filename', async () => {
    expect((await post(PEER_AUTH, { kind: 'image', key: '../escape.png' })).status).toBe(400);
    expect((await post(PEER_AUTH, { kind: 'image', key: 'notes.txt' })).status).toBe(400);
    expect((await post(PEER_AUTH, { kind: 'video' })).status).toBe(400);
    expect((await post(PEER_AUTH, { kind: 'video', key: 'v1', extra: true })).status).toBe(400);
    expect((await readRows()).map((r) => r.id)).toEqual(['v1']);
  });
});

describe('POST /api/peer-media/release', () => {
  const release = (auth, body = {}) => request(buildApp(auth)).post('/api/peer-media/release')
    .send({ kind: 'video', filename: 'v1.mp4', primaryInstanceId: 'peer-p', primaryAt: '2026-07-01T00:00:00.000Z', ...body });

  beforeEach(() => {
    writeFileSync(join(PATHS.videos, 'v1.mp4'), 'bytes');
  });

  it('refuses a caller that is not a paired peer, and a peer without the media delete grant', async () => {
    const session = await release({ enabled: true, authenticated: true, method: 'session' });
    expect(session.status).toBe(403);
    expect(session.body.code).toBe('PEER_CREDENTIAL_REQUIRED');
    registry.peers = [peer({ mediaDeleteAllowed: false })];
    const refused = await release(PEER_AUTH);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('MEDIA_DELETE_FORBIDDEN');
    expect(trashFiles).not.toHaveBeenCalled();
  });

  it('keeps the copy when the primary is not a paired peer of this machine', async () => {
    const res = await release(PEER_AUTH, { primaryInstanceId: 'peer-unknown' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PRIMARY_NOT_PAIRED');
    expect(trashFiles).not.toHaveBeenCalled();
  });

  it('rejects a file name that is not a single path segment', async () => {
    const res = await release(PEER_AUTH, { filename: '../video-history.json' });
    expect(res.status).toBe(400);
    expect(trashFiles).not.toHaveBeenCalled();
  });
});
