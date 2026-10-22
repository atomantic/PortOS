import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-storyboards-') }));
afterAll(cleanupTempDataRoots);

const { default: routes } = await import('./storyboards.js');

const app = express();
app.use(express.json());
app.use('/api/storyboards', routes);
app.use(errorMiddleware);

const api = (method, path, body) => request(app)[method](`/api/storyboards${path}`).send(body);

describe('storyboards routes', () => {
  it('plans a story with no song: beats, panels with estimated seconds, catalog links, art takes', async () => {
    const created = await api('post', '/', { name: 'Example Story', aspectRatio: '9:16' });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(created.body).toMatchObject({ name: 'Example Story', aspectRatio: '9:16', artStyle: 'pencil', beats: [] });

    const opening = await api('post', `/${id}/beats`, { title: 'Arrival', what: 'She steps into the empty gym', musicalRole: 'intro' });
    const beatId = opening.body.beatId;
    const chorus = await api('post', `/${id}/beats`, { title: 'First dance', musicalRole: 'chorus', index: 0 });
    expect(chorus.body.board.beats.map((b) => b.title)).toEqual(['First dance', 'Arrival']);

    const p1 = await api('post', `/${id}/beats/${beatId}/panels`, { action: 'Wide of the gym doors', framing: 'wide', seconds: 3.456, castIds: ['cat-example-1'] });
    expect(p1.status).toBe(201);
    const panelId = p1.body.panelId;
    const panel = p1.body.board.beats[1].panels[0];
    expect(panel).toMatchObject({ seconds: 3.46, framing: 'wide', castIds: ['cat-example-1'], takes: [], selectedTakeId: null });

    const take = await api('post', `/${id}/panels/${panelId}/takes`, { source: 'upload', image: '/data/images/example.png' });
    expect(take.status).toBe(201);
    const sketch = await api('post', `/${id}/panels/${panelId}/takes`, { source: 'sketch', sketchKey: 'sketch:abc-123' });
    const art = sketch.body.board.beats[1].panels[0];
    expect(art.takes.map((t) => t.image ?? t.sketchKey)).toEqual(['example.png', 'sketch:abc-123']);
    expect(art.selectedTakeId).toBe(sketch.body.takeId);

    // Removing the selected take falls back to the newest remaining one.
    const removed = await api('delete', `/${id}/panels/${panelId}/takes/${sketch.body.takeId}`);
    expect(removed.body.beats[1].panels[0].selectedTakeId).toBe(take.body.takeId);

    const list = await api('get', '/');
    expect(list.body).toEqual([expect.objectContaining({ id, beatCount: 2, panelCount: 1, runtimeSec: 3.46, cover: { image: 'example.png', sketchKey: null } })]);
  });

  it('moves a panel to another beat and keeps the order', async () => {
    const { body: board } = await api('post', '/', { name: 'Moves' });
    const a = (await api('post', `/${board.id}/beats`, { title: 'A' })).body.beatId;
    const b = (await api('post', `/${board.id}/beats`, { title: 'B' })).body.beatId;
    const p1 = (await api('post', `/${board.id}/beats/${a}/panels`, { action: 'one' })).body.panelId;
    await api('post', `/${board.id}/beats/${b}/panels`, { action: 'two' });
    const moved = await api('post', `/${board.id}/panels/${p1}/move`, { beatId: b, index: 0 });
    expect(moved.body.beats[0].panels).toEqual([]);
    expect(moved.body.beats[1].panels.map((p) => p.action)).toEqual(['one', 'two']);
  });

  it('refuses over-limit text and malformed art instead of cutting or keeping it', async () => {
    const { body: board } = await api('post', '/', {});
    expect(board.name).toBe('Untitled storyboard');
    const beat = (await api('post', `/${board.id}/beats`, {})).body.beatId;
    const tooLong = await api('patch', `/${board.id}/beats/${beat}`, { what: 'x'.repeat(2001) });
    expect(tooLong.status).toBe(400);
    const panel = (await api('post', `/${board.id}/beats/${beat}/panels`, {})).body.panelId;
    const external = await api('post', `/${board.id}/panels/${panel}/takes`, { source: 'upload', image: 'https://example.com/a.png' });
    expect(external.status).toBe(400);
    const mixed = await api('post', `/${board.id}/panels/${panel}/takes`, { source: 'sketch', image: 'a.png' });
    expect(mixed.status).toBe(400);
  });

  it('attaches a temp track from uploads and takes it off again', async () => {
    const { body: board } = await api('post', '/', { name: 'Demo' });
    const set = await api('patch', `/${board.id}`, { tempTrack: { filename: '0a1b2c3d-demo_v2.mp3', name: 'demo v2.mp3' } });
    expect(set.body.tempTrack).toEqual({ filename: '0a1b2c3d-demo_v2.mp3', name: 'demo v2.mp3' });
    // Only an uploaded audio file: no paths, no other file types.
    expect((await api('patch', `/${board.id}`, { tempTrack: { filename: '../secrets.mp3' } })).status).toBe(400);
    expect((await api('patch', `/${board.id}`, { tempTrack: { filename: '0a1b2c3d-cover.png' } })).status).toBe(400);
    const cleared = await api('patch', `/${board.id}`, { tempTrack: null });
    expect(cleared.body.tempTrack).toBeNull();
  });

  it('treats a deleted board as gone', async () => {
    const { body: board } = await api('post', '/', { name: 'Gone' });
    expect((await api('delete', `/${board.id}`)).body).toEqual({ ok: true });
    expect((await api('get', `/${board.id}`)).status).toBe(404);
    expect((await api('patch', `/${board.id}`, { name: 'Back' })).status).toBe(404);
    expect((await api('get', '/')).body.some((row) => row.id === board.id)).toBe(false);
  });
});
