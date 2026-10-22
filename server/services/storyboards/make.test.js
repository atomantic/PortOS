import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { errorMiddleware } from '../../lib/errorHandler.js';
import { request } from '../../lib/testHelper.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-storyboard-make-') }));
afterAll(cleanupTempDataRoots);

const { default: routes } = await import('../../routes/storyboards.js');
const { __setDepsForTests, attachPanelFrame, failPanelFrame } = await import('./make.js');

const app = express();
app.use(express.json());
app.use('/api/storyboards', routes);
app.use(errorMiddleware);
const api = (method, path, body) => request(app)[method](`/api/storyboards${path}`).send(body);

const provider = { id: 'example-api', name: 'Example', type: 'api', enabled: true };
let runPrompt;
let enqueue;
let emitted;

beforeEach(() => {
  runPrompt = vi.fn(async () => ({ text: '  A wide pencil frame of gym doors  ' }));
  let n = 0;
  enqueue = vi.fn(async () => ({ jobId: `job-${(n += 1)}` }));
  emitted = [];
  __setDepsForTests({
    resolveProvider: async () => ({ provider, selectedModel: 'example-model' }),
    runPrompt,
    getSettings: async () => ({}),
    imageParams: async (_settings, route, common) => ({ ...common, mode: route.mode }),
    enqueue,
    linkedMedia: async (ids) => new Map(ids.map((id) => [id, [{ kind: 'portrait', mediaKey: `${id}.png` }]])),
    ingredient: async (id) => ({ id, name: `Name of ${id}` }),
    emit: (payload) => { emitted.push(payload); },
  });
});

async function boardWithPanel(panel = { action: 'She pushes open the gym doors', framing: 'wide' }) {
  const { body: board } = await api('post', '/', { name: 'Example Story', aspectRatio: '9:16' });
  const beatId = (await api('post', `/${board.id}/beats`, { title: 'Arrival', what: 'She arrives' })).body.beatId;
  const { panelId } = (await api('post', `/${board.id}/beats/${beatId}/panels`, panel)).body;
  return { id: board.id, panelId };
}

const nodeState = (board, nodeId) => board.beats[0].panels[0].make?.nodes?.[nodeId];

describe('storyboard panel maker', () => {
  it('writes a prompt from the panel words and the visible system prompt, recording exactly what was sent', async () => {
    const { id, panelId } = await boardWithPanel();
    const res = await api('post', `/${id}/panels/${panelId}/make/node-writer/run`);
    expect(res.status).toBe(200);

    const sent = runPrompt.mock.calls[0][0].prompt;
    expect(sent).toContain('You write one prompt for an image model.');
    expect(sent).toContain('She pushes open the gym doors\nFraming: wide');
    const state = nodeState(res.body, 'node-writer');
    expect(state).toMatchObject({ status: 'done', text: 'A wide pencil frame of gym doors', providerId: 'example-api', model: 'example-model', sentPrompt: sent });
    expect(state.promptAdditions.map((a) => a.id)).toEqual(['creative-latitude', 'system-prompt']);
    expect(emitted.map((e) => e.status)).toEqual(['running', 'done']);

    // The written prompt stays editable before the image runs.
    const edited = await api('patch', `/${id}/panels/${panelId}/make/node-writer`, { text: 'My own prompt' });
    expect(nodeState(edited.body, 'node-writer').text).toBe('My own prompt');
  });

  it('refuses a prompt writer with no words instead of calling the model', async () => {
    const { id, panelId } = await boardWithPanel({ action: '' });
    const res = await api('post', `/${id}/panels/${panelId}/make/node-writer/run`);
    expect(res.status).toBe(400);
    expect(runPrompt).not.toHaveBeenCalled();
  });

  it('queues one frame per count with the linked cast as references; frames become takes without changing the selection', async () => {
    const { id, panelId } = await boardWithPanel({ action: 'Doors', castIds: ['cat-example-1'] });
    await api('post', `/${id}/panels/${panelId}/takes`, { source: 'upload', image: 'chosen.png' });
    await api('patch', `/${id}/panels/${panelId}/make/node-writer`, { text: 'A wide frame' });

    const run = await api('post', `/${id}/panels/${panelId}/make/node-image/run`);
    expect(run.status).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(4);
    const { params } = enqueue.mock.calls[0][0];
    expect(params).toMatchObject({ prompt: 'A wide frame', width: 768, height: 1344, storyboardPanelRender: { storyboardId: id, panelId, nodeId: 'node-image' } });
    const queued = nodeState(run.body, 'node-image');
    expect(queued).toMatchObject({ status: 'queued', jobIds: ['job-1', 'job-2', 'job-3', 'job-4'], sentPrompt: 'A wide frame' });
    expect(queued.sentRefs).toEqual([{ image: 'cat-example-1.png', label: 'Name of cat-example-1' }]);

    const tag = params.storyboardPanelRender;
    for (const jobId of ['job-1', 'job-2', 'job-3']) await attachPanelFrame({ ...tag, jobId, filename: `${jobId}.png` });
    await failPanelFrame({ ...tag, jobId: 'job-4' }, 'failed', 'Out of quota');

    const { body: board } = await api('get', `/${id}`);
    const panel = board.beats[0].panels[0];
    expect(panel.takes.map((t) => t.image)).toEqual(['chosen.png', 'job-1.png', 'job-2.png', 'job-3.png']);
    expect(panel.selectedTakeId).toBe(panel.takes[0].id);
    expect(nodeState(board, 'node-image')).toMatchObject({ status: 'done', takeIds: panel.takes.slice(1).map((t) => t.id), failedJobIds: ['job-4'] });
  });

  it('refuses an over-limit image prompt with its count rather than cutting it', async () => {
    const { id, panelId } = await boardWithPanel();
    await api('patch', `/${id}/panels/${panelId}/make/node-writer`, { text: 'x'.repeat(4001) });
    const res = await api('post', `/${id}/panels/${panelId}/make/node-image/run`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('4,001 characters');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('saves a rewired recipe, dropping edges between mismatched ports or closing a cycle', async () => {
    const { id } = await boardWithPanel();
    const nodes = [
      { id: 'node-a', type: 'text', settings: { source: 'custom' }, text: 'Rain on glass' },
      { id: 'node-b', type: 'llm', title: 'Prompt enhancer' },
      { id: 'node-c', type: 'llm' },
      { id: 'node-d', type: 'image', settings: { count: 2 } },
    ];
    const edges = [
      { from: 'node-a', to: 'node-b', toPort: 'prompt' },
      { from: 'node-b', to: 'node-c', toPort: 'prompt' },
      { from: 'node-c', to: 'node-b', toPort: 'system' },
      { from: 'node-a', to: 'node-d', toPort: 'images' },
      { from: 'node-c', to: 'node-d', toPort: 'prompt' },
    ];
    const res = await api('put', `/${id}/recipe`, { recipe: { nodes, edges } });
    expect(res.status).toBe(200);
    expect(res.body.recipe.edges).toEqual([
      { from: 'node-a', to: 'node-b', toPort: 'prompt' },
      { from: 'node-b', to: 'node-c', toPort: 'prompt' },
      { from: 'node-c', to: 'node-d', toPort: 'prompt' },
    ]);
    const reset = await api('put', `/${id}/recipe`, { recipe: null });
    expect(reset.body.recipe).toBeNull();
  });

  it('counts a frame that finishes before its run is recorded, and settles when a full panel drops a frame', async () => {
    const { id, panelId } = await boardWithPanel({ action: 'Doors' });
    await api('patch', `/${id}/panels/${panelId}/make/node-writer`, { text: 'A wide frame' });
    await api('put', `/${id}/recipe`, { recipe: { nodes: [
      { id: 'node-writer', type: 'llm' }, { id: 'node-image', type: 'image', settings: { count: 2 } },
    ], edges: [{ from: 'node-writer', to: 'node-image', toPort: 'prompt' }] } });
    // The first frame lands while the second is still being queued.
    enqueue.mockImplementationOnce(async ({ params }) => {
      await attachPanelFrame({ ...params.storyboardPanelRender, jobId: 'job-fast', filename: 'fast.png' });
      return { jobId: 'job-fast' };
    });
    const run = await api('post', `/${id}/panels/${panelId}/make/node-image/run`);
    const tag = enqueue.mock.calls[0][0].params.storyboardPanelRender;
    expect(nodeState(run.body, 'node-image')).toMatchObject({ status: 'queued', frameCount: 2, takeIds: [expect.any(String)] });

    // Fill the panel before the last frame lands.
    for (let i = 0; i < 29; i += 1) await api('post', `/${id}/panels/${panelId}/takes`, { source: 'upload', image: `manual-${i}.png` });
    await attachPanelFrame({ ...tag, jobId: 'job-1', filename: 'late.png' });
    const { body: board } = await api('get', `/${id}`);
    expect(board.beats[0].panels[0].takes).toHaveLength(30);
    expect(nodeState(board, 'node-image')).toMatchObject({ status: 'done', failedJobIds: ['job-1'] });
    expect(nodeState(board, 'node-image').error).toContain('panel is full');
  });
});
