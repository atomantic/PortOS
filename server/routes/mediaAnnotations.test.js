import { recordingOperatorIo } from '../test/recordingOperatorIo.js';
import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorEvents, errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Real mediaAnnotations service (annotation store on disk) over a temp data root.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-media-annotations-') }));
afterAll(cleanupTempDataRoots);

// Annotations are keyed by the local instance id; the identity store persists outside the temp
// root, so stub it rather than mint a real identity.
vi.mock('../services/instanceIdentity.js', () => ({
  UNKNOWN_INSTANCE_ID: 'unknown',
  getInstanceId: async () => 'instance-local',
  getSelf: async () => ({ instanceId: 'instance-local', name: 'Local' }),
}));

const { default: mediaAnnotationsRoutes } = await import('./mediaAnnotations.js');

// With an io on the app, the error middleware also raises errorEvents 'error',
// which throws on an EventEmitter with no listener; the server registers one at boot.
errorEvents.on('error', () => {});
const io = recordingOperatorIo();
const app = express();
app.set('io', io);
app.use(express.json());
app.use('/api/media/annotations', mediaAnnotationsRoutes);
app.use(errorMiddleware);

const notBroadcast = () => expect(io.emit).not.toHaveBeenCalledWith('media:annotation:updated', expect.anything());
const BASE = '/api/media/annotations';
const patch = (key, body) => request(app).patch(`${BASE}/${key}`).send(body);
const list = async () => (await request(app).get(BASE)).body.annotations;

describe('/api/media/annotations', () => {
  it('persists a patch so it reads back from the list, and broadcasts it to other views', async () => {
    const res = await patch('image:a.png', { starred: true, note: 'keeper' });
    expect(res.status).toBe(200);
    expect(res.body.entry.own).toMatchObject({ starred: true, note: 'keeper' });
    expect(io.emit).toHaveBeenCalledWith('media:annotation:updated', { key: 'image:a.png', entry: res.body.entry });
    expect((await list())['image:a.png'].own).toMatchObject({ starred: true, note: 'keeper' });
  });

  it('merges partial patches and clears the entry once nothing is set', async () => {
    await patch('video:b.mp4', { starred: true });
    await patch('video:b.mp4', { rating: 'good' });
    expect((await list())['video:b.mp4'].own).toMatchObject({ starred: true, rating: 'good' });

    await patch('video:b.mp4', { starred: false, rating: null });
    expect((await list())['video:b.mp4']).toBeUndefined();
  });

  it('refuses an empty or over-long patch before touching the store', async () => {
    io.emit.mockClear();
    expect((await patch('image:c.png', {})).status).toBe(400);
    expect((await patch('image:c.png', { note: 'x'.repeat(2001) })).status).toBe(400);
    // "Rejected" is a music video take state, never a media rating.
    expect((await patch('image:c.png', { rating: 'rejected' })).status).toBe(400);
    expect((await list())['image:c.png']).toBeUndefined();
    notBroadcast();
  });

  it('maps the service refusal of a malformed key to 400, stores nothing and broadcasts nothing', async () => {
    io.emit.mockClear();
    const res = await patch('nope', { starred: false });
    expect(res.status).toBe(400);
    expect((await list()).nope).toBeUndefined();
    notBroadcast();
  });
});
