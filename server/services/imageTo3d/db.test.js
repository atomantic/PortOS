import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as connection from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { listGeneratingModelSummaries, listModels } from './db.js';

const health = await connection.checkHealth();
const runDb = requireDbOrSkip('image-to-3D summaries', health.connected, health.error);

describe.skipIf(!runDb)('image-to-3D activity projection', () => {
  beforeAll(async () => {
    await connection.ensureSchema();
    await connection.query('DELETE FROM image_to_3d_models');
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await connection.query('DELETE FROM image_to_3d_models');
    await connection.close();
  });

  it('returns only live generating id/name rows in update order without hydrating gallery records', async () => {
    expect(await listGeneratingModelSummaries()).toEqual([]);

    const completed = Array.from({ length: 1000 }, (_, i) => ({
      id: `completed-${i}`, name: 'Example completed mesh', status: 'completed',
      updatedAt: '2026-01-01T00:00:00Z', deleted: false,
      runs: [{ output: 'Example generation history' }],
    }));
    const others = [
      { id: 'draft', status: 'draft' },
      { id: 'failed', status: 'failed' },
      { id: 'deleted', status: 'generating', deleted: true },
      { id: 'older', status: 'generating', updatedAt: '2026-01-02T00:00:00Z', name: '' },
      { id: 'newer', status: 'generating', updatedAt: '2026-01-03T00:00:00Z' },
    ].map((record) => ({
      name: 'Example mesh', updatedAt: '2026-01-01T00:00:00Z', deleted: false, ...record,
    }));
    await connection.query(
      `INSERT INTO image_to_3d_models (id, name, status, deleted, updated_at, data)
       SELECT value->>'id', value->>'name', value->>'status',
              (value->>'deleted')::boolean, (value->>'updatedAt')::timestamptz, value
       FROM jsonb_array_elements($1::jsonb)`,
      [JSON.stringify([...completed, ...others])],
    );

    const querySpy = vi.spyOn(connection, 'query');
    expect(await listGeneratingModelSummaries()).toEqual([
      { id: 'newer', name: 'Example mesh' },
      { id: 'older', name: '' },
    ]);
    // A row-shape assertion alone would allow SELECT * followed by JS projection.
    expect(querySpy).toHaveBeenCalledExactlyOnceWith(
      "SELECT id, name FROM image_to_3d_models WHERE deleted = FALSE AND status = 'generating' ORDER BY updated_at DESC",
    );
    querySpy.mockRestore();

    const gallery = await listModels();
    expect(gallery).toHaveLength(1004);
    expect(gallery.find((model) => model.id === 'completed-0')).toEqual(completed[0]);
    expect(await listModels({ includeDeleted: true })).toHaveLength(1005);
  });
});
