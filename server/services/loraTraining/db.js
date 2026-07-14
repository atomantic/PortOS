/**
 * LoRA training run records — PostgreSQL adapter (`lora_training_runs`).
 *
 * One row per run: id/status/character_id mirrored as columns for
 * filtering, the full record in `data` JSONB (returned verbatim — columns
 * are never read back). Mirrors the `creative_director_projects` adapter
 * pattern.
 *
 * Within a single run, `updateRun` has overlapping callers — the debounced
 * progress-mirror flush (checkpoint/sample array appends) races the
 * status/startedAt/completedAt writes. A bare read-modify-write would let a
 * stale read clobber a concurrent append, so `updateRun` chains every
 * mutation for the same id onto a per-id tail promise (the same discipline
 * as `issueWriteTail` in pipeline/issues.js). Writes to DIFFERENT runs stay
 * parallel; the map entry is pruned once its chain settles.
 */

import { query } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';

const rowToRun = (row) => row?.data ?? null;

// id → tail Promise. Serializes read-modify-write cycles for one run; writes to
// different runs stay parallel. Same silence/prune discipline as the store
// facades — routed through the shared `createKeyCachedQueue` helper.
const queueRunWrite = createKeyCachedQueue();

async function persist(run) {
  await query(
    `INSERT INTO lora_training_runs (id, status, character_id, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       character_id = EXCLUDED.character_id,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at`,
    [
      run.id,
      run.status,
      run.character?.entryId || null,
      JSON.stringify(run),
      run.createdAt || new Date().toISOString(),
      new Date().toISOString(),
    ],
  );
  return run;
}

export async function createRun(run) {
  return persist(run);
}

export async function getRun(id) {
  const result = await query('SELECT data FROM lora_training_runs WHERE id = $1', [id]);
  return rowToRun(result.rows[0]);
}

export async function getRunRequired(id) {
  const run = await getRun(id);
  if (!run) {
    throw new ServerError(`Training run not found: ${id}`, { status: 404, code: 'NOT_FOUND' });
  }
  return run;
}

/**
 * Read-modify-write, serialized per run id so a concurrent append (e.g. the
 * debounced checkpoint-array flush) can't be clobbered by a stale read from
 * a parallel status write. `patch` is an object merged shallowly, or a
 * function `(current) => next` (return falsy to abort without writing).
 */
export async function updateRun(id, patch) {
  return queueRunWrite(id, async () => {
    const current = await getRunRequired(id);
    const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
    if (!next) return current;
    next.updatedAt = new Date().toISOString();
    return persist(next);
  });
}

export async function listRuns({ status = null, characterId = null, datasetId = null, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (characterId) { params.push(characterId); where.push(`character_id = $${params.length}`); }
  if (datasetId) { params.push(datasetId); where.push(`data->>'datasetId' = $${params.length}`); }
  params.push(Math.max(1, Math.min(500, limit)));
  const result = await query(
    `SELECT data FROM lora_training_runs
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(rowToRun).filter(Boolean);
}

export async function deleteRun(id) {
  await query('DELETE FROM lora_training_runs WHERE id = $1', [id]);
  return { ok: true, id };
}

/** Runs persisted as queued/running — boot-time reconcile targets. */
export async function listActiveRuns() {
  const result = await query(
    `SELECT data FROM lora_training_runs WHERE status IN ('queued', 'running')`,
  );
  return result.rows.map(rowToRun).filter(Boolean);
}
