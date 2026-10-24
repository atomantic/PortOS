import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';
import { REALITY_STARTER_V1 } from '../../lib/realityStarterV1.js';

let universe;
vi.mock('../../services/universeBuilder.js', async original => ({
  ...await original(),
  updateUniverse: vi.fn(async (_id, mutate) => {
    if (!universe || universe.deleted) throw Object.assign(new Error('Not found'), { code: 'NOT_FOUND' });
    universe = { ...universe, ...await mutate(universe) };
    return universe;
  }),
}));
import router from './crud.js';
const app = express();
app.use(express.json());
app.use('/universes', router);
app.use(errorMiddleware);
const stamp = '2026-01-01T00:00:00.000Z';
beforeEach(() => {
  universe = { id: 'universe-reality', updatedAt: stamp, premise: 'Custom', characters: [{ id: 'local' }], styleImageRefs: ['private.jpg'], factual: true };
});

it('restores shipped text without changing canon, media or settings', async () => {
  const response = await request(app).post('/universes/universe-reality/restore-starter').send({ expectedUpdatedAt: stamp });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ ...REALITY_STARTER_V1, characters: [{ id: 'local' }], styleImageRefs: ['private.jpg'], factual: true });
  expect(Object.keys(REALITY_STARTER_V1).sort()).toEqual(['influences', 'logline', 'premise', 'starterPrompt', 'styleNotes']);
});
it('refuses a stale revision before replacing any text', async () => {
  universe.updatedAt = '2026-01-02T00:00:00.000Z';
  const response = await request(app).post('/universes/universe-reality/restore-starter').send({ expectedUpdatedAt: stamp });
  expect(response.status).toBe(409);
  expect(universe.premise).toBe('Custom');
});
it('does not offer restoration on user-created universes', async () => {
  const response = await request(app).post('/universes/custom/restore-starter').send({ expectedUpdatedAt: stamp });
  expect(response.status).toBe(404);
});
it('requires the revision', async () => {
  const response = await request(app).post('/universes/universe-reality/restore-starter').send({});
  expect(response.status).toBe(400);
});

it.each([null, { deleted: true }])('does not recreate a missing or deleted universe: %j', async record => {
  universe = record;
  const response = await request(app).post('/universes/universe-reality/restore-starter').send({ expectedUpdatedAt: stamp });
  expect(response.status).toBe(404);
  expect(universe).toEqual(record);
});
