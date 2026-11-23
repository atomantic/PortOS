/**
 * PostgreSQL store for Blender model records (issue #17874).
 *
 * Storage: `db-primary` (`blender_models`) — machine-local, never federated: the
 * source and builds are host files. The full record lives in `data` JSONB;
 * name/status/timestamps/deleted are mirrored columns for list queries and
 * audit triggers, the same shape as `image_to_3d_models`. The record holds the
 * build index (`builds`, newest last), `publishedBuildId` and the last
 * completed build's `describe()`; the files stay under data/blender-models/<id>/.
 * Every committed change emits `blender-model:changed` with the id only.
 */
import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';
import { toPgJson } from '../../lib/pgJson.js';
import { modelLifecycleEvents } from '../modelLifecycleEvents.js';

export const BLENDER_MODEL_CHANGED = 'blender-model:changed';

const rowToModel = (row) => row?.data ?? null;

/** The mirrored status column: a running build wins, then a published one. */
export const blenderModelStatus = (model) => (
  (model.builds || []).some((build) => build.status === 'running') ? 'building' : model.publishedBuildId ? 'published' : 'draft'
);

export const announceBlenderModel = (id) => modelLifecycleEvents.emit(BLENDER_MODEL_CHANGED, { id });

async function persist(exec, model) {
  await exec(
    `INSERT INTO blender_models (id, name, status, data, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       status = EXCLUDED.status,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at`,
    [model.id, model.name, model.status, toPgJson(model), model.createdAt, model.updatedAt, model.deleted === true, model.deletedAt || null],
  );
  return model;
}

export async function listModels() {
  const result = await query('SELECT data FROM blender_models WHERE deleted = FALSE ORDER BY updated_at DESC, id ASC');
  return result.rows.map(rowToModel);
}

export async function getModel(id, { includeDeleted = false } = {}) {
  const result = await query('SELECT data FROM blender_models WHERE id = $1', [id]);
  const model = rowToModel(result.rows[0]);
  if (!model || (!includeDeleted && model.deleted)) return null;
  return model;
}

export async function createModel({ name }) {
  const now = new Date().toISOString();
  const model = {
    id: `bmodel-${randomUUID()}`,
    schemaVersion: 1,
    name,
    status: 'draft',
    publishedBuildId: null,
    describe: null,
    builds: [],
    createdAt: now,
    updatedAt: now,
    deleted: false,
    deletedAt: null,
  };
  await persist(query, model);
  announceBlenderModel(model.id);
  return model;
}

/**
 * Apply `mutate(current)` under a row lock. Returning a falsy value leaves the
 * row unchanged. The status column is re-derived from the result.
 */
export async function mutateModel(id, mutate, { includeDeleted = false } = {}) {
  let changed = false;
  const model = await withTransaction(async (client) => {
    const result = await client.query('SELECT data FROM blender_models WHERE id = $1 FOR UPDATE', [id]);
    const current = rowToModel(result.rows[0]);
    if (!current || (!includeDeleted && current.deleted)) {
      throw new ServerError('Blender model not found', { status: 404, code: 'NOT_FOUND' });
    }
    const next = mutate(current);
    if (!next) return current;
    next.status = blenderModelStatus(next);
    next.updatedAt = new Date().toISOString();
    await persist(client.query.bind(client), next);
    changed = true;
    return next;
  });
  // Notify only after COMMIT: a listener can immediately read the persisted row.
  if (changed) announceBlenderModel(id);
  return model;
}

/** Ids of live records that still say a build is running. */
export async function listBuildingModelIds() {
  const result = await query("SELECT id FROM blender_models WHERE deleted = FALSE AND status = 'building'");
  return result.rows.map((row) => row.id);
}
