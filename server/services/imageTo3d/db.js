/**
 * PostgreSQL store for image-to-3D model records (issue #2952).
 *
 * The full record lives in `data` JSONB; name/status/timestamps/deleted are
 * mirrored columns for list queries and audit triggers. Mirrors the shape of
 * `server/services/threejsModels/db.js` — the two are sibling media records
 * (procedural JS source vs. a neural GLB mesh). The binary GLB itself stays on
 * disk (data/image-to-3d/<id>/model.glb) and is referenced by path.
 */

import { randomUUID } from 'crypto';
import { query, withTransaction } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';

const rowToModel = (row) => row?.data ?? null;

async function persist(exec, model) {
  await exec(
    `INSERT INTO image_to_3d_models (id, name, status, data, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       status = EXCLUDED.status,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at`,
    [
      model.id,
      model.name,
      model.status,
      JSON.stringify(model),
      model.createdAt,
      model.updatedAt,
      model.deleted === true,
      model.deletedAt || null,
    ],
  );
  return model;
}

export async function listModels({ includeDeleted = false } = {}) {
  const result = includeDeleted
    ? await query('SELECT data FROM image_to_3d_models ORDER BY updated_at DESC')
    : await query('SELECT data FROM image_to_3d_models WHERE deleted = FALSE ORDER BY updated_at DESC');
  return result.rows.map(rowToModel);
}

export async function getModel(id, { includeDeleted = false } = {}) {
  const result = await query('SELECT data FROM image_to_3d_models WHERE id = $1', [id]);
  const model = rowToModel(result.rows[0]);
  if (!model || (!includeDeleted && model.deleted)) return null;
  return model;
}

export async function createModel(input) {
  const now = new Date().toISOString();
  const model = {
    id: `image3d-${randomUUID()}`,
    schemaVersion: 1,
    name: input.name,
    target: input.target,
    sourceImage: {
      filename: input.filename,
      path: `/data/images/${encodeURIComponent(input.filename)}`,
    },
    status: 'draft',
    assetPath: null,
    error: null,
    generationOperationId: null,
    runs: [],
    createdAt: now,
    updatedAt: now,
    generatedAt: null,
    deleted: false,
    deletedAt: null,
  };
  return persist(query, model);
}

export async function mutateModel(id, mutate, { includeDeleted = false } = {}) {
  return withTransaction(async (client) => {
    const result = await client.query('SELECT data FROM image_to_3d_models WHERE id = $1 FOR UPDATE', [id]);
    const current = rowToModel(result.rows[0]);
    if (!current || (!includeDeleted && current.deleted)) {
      throw new ServerError('Image-to-3D model not found', { status: 404, code: 'NOT_FOUND' });
    }
    const next = mutate(current);
    if (!next) return current;
    next.updatedAt = new Date().toISOString();
    await persist(client.query.bind(client), next);
    return next;
  });
}

export async function deleteModel(id) {
  const now = new Date().toISOString();
  await mutateModel(id, (current) => ({
    ...current,
    status: current.status === 'generating' ? 'canceled' : current.status,
    deleted: true,
    deletedAt: now,
  }));
  return { ok: true };
}

/**
 * A render child cannot survive the PortOS process. Mark interrupted records
 * failed-retryable on boot without launching any new render work (the GLB
 * render is user-triggered only — CLAUDE.md no-cold-bootstrap policy).
 */
export async function recoverInterruptedModels() {
  const result = await query(
    `SELECT data FROM image_to_3d_models WHERE deleted = FALSE AND status = 'generating'`,
  );
  let recovered = 0;
  for (const row of result.rows) {
    const current = rowToModel(row);
    await mutateModel(current.id, (fresh) => {
      if (fresh.status !== 'generating') return null;
      recovered += 1;
      const runs = Array.isArray(fresh.runs) ? [...fresh.runs] : [];
      const activeIndex = runs.findLastIndex((run) => run.status === 'running');
      if (activeIndex !== -1) {
        runs[activeIndex] = {
          ...runs[activeIndex],
          status: 'failed',
          error: 'Render was interrupted by a server restart',
          completedAt: new Date().toISOString(),
        };
      }
      return {
        ...fresh,
        status: 'failed',
        error: 'Render was interrupted by a server restart. Generate again to retry.',
        generationOperationId: null,
        runs,
      };
    });
  }
  return { recovered };
}
