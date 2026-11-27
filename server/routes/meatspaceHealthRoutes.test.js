import { afterAll, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import express from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy, ownTestBodies } from '../lib/mockPathsDataRoot.js';
import { request } from '../lib/testHelper.js';

vi.mock('../lib/fileUtils.js', async (original) => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('portos-meatspace-health-routes-'),
}));

// Use the real file-backed services with the optional iCloud integration disabled.
vi.mock('../services/mortalLoomStore.js', () => ({
  isMortalLoomEnabled: async () => false,
  mlArrayIfEnabled: async () => null,
  readDailyLogIfEnabled: async () => null,
}));

import { PATHS } from '../lib/fileUtils.js';
import healthRoutes from './meatspaceHealthRoutes.js';

const app = express();
app.use(express.json());
app.use('/api/meatspace', healthRoutes);
app.use(errorMiddleware);

const { it, drain } = ownTestBodies(vitestIt);
beforeEach(async () => {
  await rm(PATHS.meatspace, { recursive: true, force: true });
});
afterAll(async () => {
  try {
    await drain();
  } finally {
    cleanupTempDataRoots();
  }
});

const date = '2024-06-01';
const badRowId = 'x'.repeat(201);

describe.each([
  {
    resource: 'blood', listKey: 'tests', deleteBy: 'id', malformed: badRowId,
    fields: { metabolicPanel: { glucose: 91 } }, invalid: { metabolicPanel: { glucose: 'high' } },
  },
  {
    resource: 'body', deleteBy: 'date', malformed: badRowId,
    fields: { weightLbs: 150 }, invalid: { weightLbs: 0 },
  },
  {
    resource: 'blood-pressure', listKey: 'readings', deleteBy: 'date', malformed: 'yesterday',
    fields: { systolic: 110, diastolic: 75 }, invalid: { diastolic: 0 },
  },
  {
    resource: 'workouts', listKey: 'workouts', deleteBy: 'id', malformed: badRowId,
    fields: { type: 'walk', durationMinutes: 20 }, invalid: { durationMinutes: -1 },
  },
  {
    resource: 'epigenetic', listKey: 'tests', deleteBy: 'id', malformed: badRowId,
    fields: { biologicalAge: 30 }, invalid: { biologicalAge: 151 },
  },
  {
    resource: 'eyes', listKey: 'exams', deleteBy: 'id',
    fields: { rightSphere: -1 }, invalid: { rightSphere: 'invalid' },
  },
])('/api/meatspace/$resource', ({ resource, listKey, deleteBy, malformed, fields, invalid }) => {
  const path = `/api/meatspace/${resource}`;
  const input = { date, ...fields };
  const list = async () => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    return listKey ? res.body[listKey] : res.body;
  };

  it('creates, reads and removes a record, then returns a JSON 404 for the deleted record', async () => {
    const created = await request(app).post(path).send(input);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject(input);
    expect(created.body[deleteBy]).toEqual(expect.any(String));
    expect(await list()).toEqual([expect.objectContaining(input)]);

    const target = `${path}/${created.body[deleteBy]}`;
    const removed = await request(app).delete(target);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject(input);
    expect(await list()).toEqual([]);

    expect(await request(app).delete(target)).toMatchObject({
      status: 404, body: { code: 'NOT_FOUND' },
    });
  });

  it('refuses an invalid creation payload without writing a record', async () => {
    expect(await request(app).post(path).send({ ...input, ...invalid })).toMatchObject({
      status: 400, body: { code: 'VALIDATION_ERROR' },
    });
    expect(await list()).toEqual([]);
  });

  // Eye exams accept opaque IDs and legacy array indices through their own resolver.
  if (malformed) {
    it('refuses a malformed deletion parameter', async () => {
      expect(await request(app).delete(`${path}/${malformed}`)).toMatchObject({
        status: 400, body: { code: 'VALIDATION_ERROR' },
      });
    });
  }
});

describe('/api/meatspace/eyes updates', () => {
  const path = '/api/meatspace/eyes';

  it('resolves the legacy numeric index, validates the patch and preserves omitted fields', async () => {
    const created = await request(app).post(path).send({ date, rightSphere: -1, leftSphere: -2 });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(await request(app).put(`${path}/${id}`).send({ rightSphere: 'bad' })).toMatchObject({
      status: 400, body: { code: 'VALIDATION_ERROR' },
    });
    expect(await request(app).get(path)).toMatchObject({
      status: 200, body: { exams: [expect.objectContaining({ id, rightSphere: -1 })] },
    });
    expect(await request(app).put(`${path}/0`).send({ rightSphere: null })).toMatchObject({
      status: 200, body: { id, date, rightSphere: null, leftSphere: -2 },
    });
    expect(await request(app).get(path)).toMatchObject({
      status: 200, body: { exams: [expect.objectContaining({ id, rightSphere: null, leftSphere: -2 })] },
    });
  });

  it('returns a JSON 404 for unknown IDs and out-of-range legacy indices', async () => {
    expect(await request(app).put(`${path}/missing-exam`).send({ rightSphere: 1 })).toMatchObject({
      status: 404, body: { code: 'NOT_FOUND' },
    });
    expect(await request(app).put(`${path}/42`).send({ rightSphere: 1 })).toMatchObject({
      status: 404, body: { code: 'NOT_FOUND' },
    });
    expect(await request(app).delete(`${path}/42`)).toMatchObject({
      status: 404, body: { code: 'NOT_FOUND' },
    });
  });
});
