/**
 * PostgreSQL store for Three.js procedural-model workspaces.
 *
 * The full record lives in data JSONB. Name/status/timestamps/deleted are
 * mirrored columns for list queries and audit triggers.
 */

import { randomUUID } from 'crypto';
import { query, withTransaction } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';

const rowToModel = (row) => row?.data ?? null;

async function persist(exec, model) {
  await exec(
    `INSERT INTO threejs_models (id, name, status, data, created_at, updated_at, deleted, deleted_at)
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
    ? await query('SELECT data FROM threejs_models ORDER BY updated_at DESC')
    : await query('SELECT data FROM threejs_models WHERE deleted = FALSE ORDER BY updated_at DESC');
  return result.rows.map(rowToModel);
}

export async function getModel(id, { includeDeleted = false } = {}) {
  const result = await query('SELECT data FROM threejs_models WHERE id = $1', [id]);
  const model = rowToModel(result.rows[0]);
  if (!model || (!includeDeleted && model.deleted)) return null;
  return model;
}

export async function createModel(input) {
  const now = new Date().toISOString();
  const model = {
    id: `threejs-${randomUUID()}`,
    schemaVersion: 1,
    name: input.name,
    sourceImage: {
      filename: input.filename,
      path: `/data/images/${encodeURIComponent(input.filename)}`,
    },
    prompt: input.prompt || '',
    providerId: input.providerId,
    model: input.model || null,
    status: 'draft',
    spec: null,
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
    const result = await client.query('SELECT data FROM threejs_models WHERE id = $1 FOR UPDATE', [id]);
    const current = rowToModel(result.rows[0]);
    if (!current || (!includeDeleted && current.deleted)) {
      throw new ServerError('Three.js model not found', { status: 404, code: 'NOT_FOUND' });
    }
    const next = mutate(current);
    if (!next) return current;
    next.updatedAt = new Date().toISOString();
    await persist(client.query.bind(client), next);
    return next;
  });
}

export function updateModel(id, patch) {
  return mutateModel(id, (current) => ({ ...current, ...patch }));
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
 * A provider child cannot survive the PortOS process. Mark interrupted records
 * retryable on boot without launching any new AI work.
 */
export async function recoverInterruptedModels() {
  const result = await query(
    `SELECT data FROM threejs_models WHERE deleted = FALSE AND status = 'generating'`,
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
          error: 'Generation was interrupted by a server restart',
          completedAt: new Date().toISOString(),
        };
      }
      return {
        ...fresh,
        status: 'failed',
        error: 'Generation was interrupted by a server restart. Generate again to retry.',
        generationOperationId: null,
        runs,
      };
    });
  }
  return { recovered };
}
