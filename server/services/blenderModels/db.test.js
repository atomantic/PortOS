import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as connection from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { modelLifecycleEvents } from '../modelLifecycleEvents.js';
import { createModel, getModel, listBuildingModelIds, listModels, mutateModel } from './store.js';

const health = await connection.checkHealth();
const runDb = requireDbOrSkip('Blender model store', health.connected, health.error);

describe.skipIf(!runDb)('Blender model store', () => {
  beforeAll(async () => {
    await connection.ensureSchema();
    await connection.query('DELETE FROM blender_models');
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await connection.query('DELETE FROM blender_models');
    await connection.close();
  });

  it('mirrors the derived status, announces each commit and hides soft-deleted rows', async () => {
    const announced = [];
    const listener = (payload) => announced.push(payload);
    modelLifecycleEvents.on('blender-model:changed', listener);
    const model = await createModel({ name: 'Example lamp' });
    expect(model).toMatchObject({ status: 'draft', publishedBuildId: null, builds: [] });

    await mutateModel(model.id, (current) => ({ ...current, builds: [{ id: 'build-20260101T000000Z-0000abcd', status: 'running' }] }));
    expect(await listBuildingModelIds()).toEqual([model.id]);
    const columns = await connection.query('SELECT status, name FROM blender_models WHERE id = $1', [model.id]);
    expect(columns.rows[0]).toEqual({ status: 'building', name: 'Example lamp' });

    await mutateModel(model.id, (current) => ({
      ...current, publishedBuildId: 'build-20260101T000000Z-0000abcd',
      builds: current.builds.map((build) => ({ ...build, status: 'complete' })),
    }));
    expect((await getModel(model.id)).status).toBe('published');
    expect(await listBuildingModelIds()).toEqual([]);
    // A mutation that returns nothing writes nothing and announces nothing.
    const before = announced.length;
    await mutateModel(model.id, () => null);
    expect(announced).toHaveLength(before);

    await mutateModel(model.id, (current) => ({ ...current, deleted: true, deletedAt: new Date().toISOString() }));
    expect(await getModel(model.id)).toBeNull();
    expect((await getModel(model.id, { includeDeleted: true })).deleted).toBe(true);
    expect(await listModels()).toEqual([]);
    await expect(mutateModel(model.id, (current) => current)).rejects.toMatchObject({ status: 404 });
    modelLifecycleEvents.off('blender-model:changed', listener);
    expect(announced.every((payload) => payload.id === model.id && Object.keys(payload).length === 1)).toBe(true);
  });
});
