/**
 * Start a Video from a storyboard through the real router and file-backed
 * stores: the panels become the draft's shots, linked to the board, and a
 * board that can't make a Video leaves no draft behind.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('storyboard-to-video-');
vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../instanceIdentity.js', () => ({ ensureInstanceId: vi.fn(async () => 'example-owner'), getInstanceId: vi.fn(async () => 'example-owner') }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('../catalogDB.js', async (importOriginal) => ({
  ...await importOriginal(),
  // Only `ing-hero` still exists in the catalog.
  resolveIngredientsByIds: vi.fn(async (ids = []) => ids.filter((id) => id === 'ing-hero')
    .map((id) => ({ id, name: 'Example Hero', type: 'character', payload: {} }))),
  linkIngredientsToCreativeDirector: vi.fn(async (_id, ingredients) => ingredients),
}));

vi.mock('../catalogDB/ingredients.js', async (importOriginal) => ({
  ...await importOriginal(),
  getIngredient: vi.fn(async (id) => (id === 'ing-hero' ? { id, name: 'Example Hero', type: 'character', updatedAt: '2026-01-01T00:00:00.000Z' } : null)),
}));

const { default: storyboardRoutes } = await import('../../routes/storyboards.js');
const { listProjects } = await import('../creativeDirector/local.js');

const app = express();
app.use(express.json());
app.use('/api/storyboards', storyboardRoutes);
app.use(errorMiddleware);
afterAll(cleanupTempDataRoots);

const choices = { name: 'Example Video', aspectRatio: '16:9', quality: 'standard', modelId: '', targetDurationSeconds: 5, userStory: 'Example brief' };

async function board(beats, firstPanel = {}) {
  const created = await request(app).post('/api/storyboards').send({ name: 'Example board', logline: 'A girl comes home.' });
  const added = await request(app).post(`/api/storyboards/${created.body.id}/beats/add`).send({ beats });
  const panelId = added.body.beats?.[0]?.panels[0]?.id ?? (await request(app).get(`/api/storyboards/${created.body.id}`)).body.beats[0].panels[0].id;
  if (Object.keys(firstPanel).length) await request(app).patch(`/api/storyboards/${created.body.id}/panels/${panelId}`).send(firstPanel);
  return (await request(app).get(`/api/storyboards/${created.body.id}`)).body;
}

describe('start a Video from a storyboard', () => {
  // A picked move replacing the free-text camera note uniquely catches the two fighting in one prompt.
  it('creates a linked Video draft whose shots are the panels', async () => {
    const b = await board([
      { title: 'Arrival', panels: [
        { action: 'She steps off the bus', framing: 'wide', camera: 'slow push in', seconds: 4.4 },
        { action: 'The town square', seconds: 14 },
      ] },
      { title: 'Home', what: 'She finds the house empty', panels: [] },
    ], { castIds: ['ing-hero', 'ing-gone'], lens: 'telephoto', eyeline: 'off-left', move: 'static' });
    const res = await request(app).post(`/api/storyboards/${b.id}/video`).send({ boardUpdatedAt: b.updatedAt, project: choices });
    expect([res.status, res.body.error]).toEqual([201, undefined]);
    const { project } = res.body;
    expect(project).toMatchObject({
      workspace: 'video', storyboardId: b.id, targetDurationSeconds: 17, status: 'draft',
      videoDraft: { durationRange: { min: 17, max: 17 }, sources: [{ kind: 'catalog', id: 'ing-hero' }] },
    });
    expect(project.cast.map((member) => member.ingredientId)).toEqual(['ing-hero']);
    expect(project.treatment.logline).toBe('A girl comes home.');
    expect(project.treatment.scenes.map((s) => [s.intent, s.prompt, s.durationSeconds, (s.cast || []).map((c) => c.name)])).toEqual([
      ['She steps off the bus', 'She steps off the bus. Wide shot. Telephoto lens. Subject looks off to the left. Static camera, no movement.', 4, ['Example Hero']],
      ['The town square', 'The town square.', 10, []],
      ['She finds the house empty', 'She finds the house empty.', 3, []],
    ]);
    expect(project.treatment.artifact.shots.at(-1).endSeconds).toBe(17);
  });

  it('refuses a board edited since the preview, and one too short for a Video, without leaving a draft', async () => {
    const b = await board([{ title: 'Blink', panels: [{ action: 'A flash', seconds: 2 }] }]);
    const before = (await listProjects()).length;
    const stale = await request(app).post(`/api/storyboards/${b.id}/video`).send({ boardUpdatedAt: '2000-01-01T00:00:00.000Z', project: choices });
    expect([stale.status, stale.body.code]).toEqual([409, 'STORYBOARD_CHANGED']);
    const short = await request(app).post(`/api/storyboards/${b.id}/video`).send({ boardUpdatedAt: b.updatedAt, project: choices });
    expect([short.status, short.body.code]).toEqual([400, 'STORYBOARD_VIDEO_UNFIT']);
    expect(short.body.error).toMatch(/at least 5 s/);
    expect((await listProjects()).length).toBe(before);
  });
});
