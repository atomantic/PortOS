import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { errorMiddleware } from '../../lib/errorHandler.js';
import { request } from '../../lib/testHelper.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-storyboard-plot-') }));
afterAll(cleanupTempDataRoots);

const { default: routes } = await import('../../routes/storyboards.js');
const { __setPlotDepsForTests } = await import('./plot.js');

const app = express();
app.use(express.json());
app.use('/api/storyboards', routes);
app.use(errorMiddleware);
const api = (method, path, body) => request(app)[method](`/api/storyboards${path}`).send(body);

const provider = { id: 'example-api', name: 'Example', type: 'api', enabled: true };
const answer = {
  beats: [
    { title: 'Arrival', what: 'She reaches the gym', why: 'The dance is her last chance', emotion: 'nervous', musicalRole: 'intro',
      panels: [{ action: 'She pushes open the doors', framing: 'Wide', camera: 'slow push', seconds: 3.456 }, { action: '' }] },
    { title: 'First step', what: 'She joins the floor', musicalRole: 'not-a-role', panels: [{ action: 'Her shoes hit the floor', framing: 'close' }] },
  ],
};
let runPrompt;

beforeEach(() => {
  runPrompt = vi.fn(async () => ({ text: `Here you go:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`` }));
  __setPlotDepsForTests({ resolveProvider: async () => ({ provider, selectedModel: 'example-model' }), runPrompt });
});

describe('storyboard beats from a plot summary', () => {
  it('sends the plot as written with the visible instructions, previews the beats, and adds only what the user keeps', async () => {
    const { body: board } = await api('post', '/', { name: 'Example Story' });
    const plot = 'A shy teenager finds her courage at the school dance.';
    const res = await api('post', `/${board.id}/beats/extract`, { plot, providerId: 'example-api', model: 'example-model', effort: 'high' });
    expect(res.status).toBe(200);

    const sent = runPrompt.mock.calls[0][0];
    expect(sent).toMatchObject({ effort: 'high', prompt: res.body.sentPrompt });
    expect(sent.prompt.endsWith(`Plot summary:\n${plot}`)).toBe(true);
    expect(res.body.promptAdditions.map((a) => a.id)).toEqual(['creative-latitude', 'beat-instructions']);
    // The preview is not on the board; the plot and pick are, for next time.
    expect(res.body.board).toMatchObject({ plot, plotLlm: { providerId: 'example-api', model: 'example-model', effort: 'high' }, beats: [] });
    expect(res.body.beats).toEqual([
      { title: 'Arrival', what: 'She reaches the gym', why: 'The dance is her last chance', emotion: 'nervous', musicalRole: 'intro',
        panels: [{ action: 'She pushes open the doors', dialogue: '', framing: 'wide', camera: 'slow push', seconds: 3.46 }] },
      { title: 'First step', what: 'She joins the floor', why: '', emotion: '', musicalRole: null,
        panels: [{ action: 'Her shoes hit the floor', dialogue: '', framing: 'close', camera: '', seconds: null }] },
    ]);

    const added = await api('post', `/${board.id}/beats/add`, { beats: [res.body.beats[1]] });
    expect(added.status).toBe(200);
    expect(added.body.beats.map((b) => [b.title, b.panels.map((p) => p.action)])).toEqual([['First step', ['Her shoes hit the floor']]]);
    expect(added.body.beats[0].id).toMatch(/^beat-/);
  });

  it('refuses an empty plot without calling the model, and says so when the answer has no beats', async () => {
    const { body: board } = await api('post', '/', { name: 'Example Story' });
    expect((await api('post', `/${board.id}/beats/extract`, { plot: '   ' })).status).toBe(400);
    expect(runPrompt).not.toHaveBeenCalled();

    runPrompt.mockResolvedValueOnce({ text: 'I could not do that.' });
    const res = await api('post', `/${board.id}/beats/extract`, { plot: 'A plot' });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('did not answer with any beats');
  });
});
