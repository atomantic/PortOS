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

  it('restyles a saved recipe on an art style change, keeping an edited style prompt', async () => {
    const { defaultStoryboardStyle, defaultStoryboardSystemPrompt } = await import('../lib/storyboardRecipe.js');
    const { body: board } = await api('post', '/', { name: 'Styles', artStyle: 'production-sketch' });
    const recipe = (nodes) => ({ nodes, edges: [] });
    const style = (id, text) => ({ id, type: 'system', title: 'Style', x: 0, y: 0, text, settings: {} });
    await api('put', `/${board.id}/recipe`, { recipe: recipe([
      style('node-system', defaultStoryboardSystemPrompt('production-sketch')),
      style('node-style', defaultStoryboardStyle('production-sketch')),
      style('node-mine', 'My own style'),
    ]) });
    const changed = await api('patch', `/${board.id}`, { artStyle: 'clean-line' });
    expect(changed.body.artStyle).toBe('clean-line');
    expect(changed.body.recipe.nodes.map((node) => node.text)).toEqual([
      defaultStoryboardSystemPrompt('clean-line'), defaultStoryboardStyle('clean-line'), 'My own style',
    ]);
  });

  // Uniquely catches a board saved with an earlier shipped style default keeping the old look after an update.
  it('reads an untouched earlier default style as the current one, keeping an edited style', async () => {
    const { RETIRED_STORYBOARD_STYLES, defaultStoryboardStyle, effectiveRecipe } = await import('../lib/storyboardRecipe.js');
    const { body: board } = await api('post', '/', { name: 'Old style', artStyle: 'production-sketch' });
    const style = (id, text) => ({ id, type: 'system', title: 'Style', x: 0, y: 0, text, settings: {} });
    const saved = await api('put', `/${board.id}/recipe`, { recipe: { nodes: [
      style('node-old', RETIRED_STORYBOARD_STYLES['production-sketch'][0]), style('node-mine', 'My own style'),
    ], edges: [] } });
    expect(effectiveRecipe(saved.body).nodes.map((node) => node.text)).toEqual([defaultStoryboardStyle('production-sketch'), 'My own style']);
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

  // Uniquely catches a set camera outliving its unlinked place, which a later sync would still send.
  it('keeps a panel set camera, clears it, drops it with its place, and refuses an id no greybox shot can have', async () => {
    const { body: board } = await api('post', '/', {});
    const beat = (await api('post', `/${board.id}/beats`, {})).body.beatId;
    const panel = (await api('post', `/${board.id}/beats/${beat}/panels`, { environmentIds: ['cat-rink'] })).body.panelId;
    const setShot = { environmentId: 'cat-rink', shotId: 'wall-east' };
    expect((await api('patch', `/${board.id}/panels/${panel}`, { setShot })).body.beats[0].panels[0].setShot).toEqual(setShot);
    // Longer than a shot id fits in its capture's media role, so the music video shot would refuse it.
    expect((await api('patch', `/${board.id}/panels/${panel}`, { setShot: { ...setShot, shotId: `w${'x'.repeat(51)}` } })).status).toBe(400);
    expect((await api('patch', `/${board.id}/panels/${panel}`, { setShot: null })).body.beats[0].panels[0].setShot).toBeNull();
    await api('patch', `/${board.id}/panels/${panel}`, { setShot });
    expect((await api('patch', `/${board.id}/panels/${panel}`, { environmentIds: [] })).body.beats[0].panels[0].setShot).toBeNull();
    expect((await api('patch', `/${board.id}/panels/${panel}`, { environmentIds: ['cat-other'], setShot })).body.beats[0].panels[0].setShot).toBeNull();
  });

  it('attaches a temp track from uploads and takes it off again', async () => {
    const { body: board } = await api('post', '/', { name: 'Demo' });
    const set = await api('patch', `/${board.id}`, { tempTrack: { filename: '0a1b2c3d-demo_v2.mp3', name: 'demo v2.mp3' } });
    expect(set.body.tempTrack).toEqual({ filename: '0a1b2c3d-demo_v2.mp3', name: 'demo v2.mp3', sections: [], lines: [] });
    // Only an uploaded audio file: no paths, no other file types.
    expect((await api('patch', `/${board.id}`, { tempTrack: { filename: '../secrets.mp3' } })).status).toBe(400);
    expect((await api('patch', `/${board.id}`, { tempTrack: { filename: '0a1b2c3d-cover.png' } })).status).toBe(400);
    const cleared = await api('patch', `/${board.id}`, { tempTrack: null });
    expect(cleared.body.tempTrack).toBeNull();
  });

  it('pins a beat to a song section on the temp track, and drops the pin with its marker', async () => {
    const { body: board } = await api('post', '/', { name: 'Pins' });
    const beatId = (await api('post', `/${board.id}/beats`, { title: 'Chorus' })).body.beatId;
    const track = {
      filename: '0a1b2c3d-demo.mp3', name: 'demo.mp3',
      sections: [{ id: 'sec-b', label: 'Chorus 1', at: 45.678 }, { id: 'sec-a', label: 'Verse 1', at: 12 }],
      lines: [{ id: 'line-1', text: 'Here I am', at: null }],
    };
    const set = await api('patch', `/${board.id}`, { tempTrack: track });
    expect(set.body.tempTrack.sections.map((s) => [s.label, s.at])).toEqual([['Verse 1', 12], ['Chorus 1', 45.68]]);
    expect(set.body.tempTrack.lines).toEqual([{ id: 'line-1', text: 'Here I am', at: null }]);
    const pinned = await api('patch', `/${board.id}/beats/${beatId}`, { pin: 'sec-b' });
    expect(pinned.body.beats[0].pin).toBe('sec-b');
    const unmarked = await api('patch', `/${board.id}`, { tempTrack: { ...track, sections: [] } });
    expect(unmarked.body.beats[0].pin).toBeNull();
  });

  it('treats a deleted board as gone', async () => {
    const { body: board } = await api('post', '/', { name: 'Gone' });
    expect((await api('delete', `/${board.id}`)).body).toEqual({ ok: true });
    expect((await api('get', `/${board.id}`)).status).toBe(404);
    expect((await api('patch', `/${board.id}`, { name: 'Back' })).status).toBe(404);
    expect((await api('get', '/')).body.some((row) => row.id === board.id)).toBe(false);
  });
});
