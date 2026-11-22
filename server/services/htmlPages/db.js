/**
 * PostgreSQL store for HTML Pages bench runs: one model's generated pages for the fixed creative brief, kept as a reference gallery.
 *
 * The full record, generated HTML included, lives in data JSONB (a run is at most five pages of bounded size). Status/timestamps/deleted are mirrored columns for list queries and audit triggers.
 *
 * Storage: `db-primary` — machine-local, not federated: a run describes what one local model produced on this hardware, the same stance as capability-test results. Soft-delete columns let federation be added without a record-shape migration.
 */

import { randomUUID } from 'crypto';
import { query, withTransaction } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';
import { toPgJson } from '../../lib/pgJson.js';
import { modelLifecycleEvents } from '../modelLifecycleEvents.js';

const rowToRun = (row) => row?.data ?? null;

async function persist(exec, run) {
  await exec(
    `INSERT INTO html_page_runs (id, backend, model_id, status, data, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at`,
    [run.id, run.backend, run.modelId, run.status, toPgJson(run), run.createdAt, run.updatedAt, run.deleted === true, run.deletedAt || null],
  );
  return run;
}

/** Newest first. Pages are included: the gallery renders them, and a run is bounded. */
export async function listRuns() {
  const result = await query('SELECT data FROM html_page_runs WHERE deleted = FALSE ORDER BY created_at DESC');
  return result.rows.map(rowToRun);
}

export async function getRun(id, { includeDeleted = false } = {}) {
  const result = await query('SELECT data FROM html_page_runs WHERE id = $1', [id]);
  const run = rowToRun(result.rows[0]);
  if (!run || (!includeDeleted && run.deleted)) return null;
  return run;
}

export async function createRun({ backend, modelId, pageCount, themes }) {
  const now = new Date().toISOString();
  const run = {
    id: `htmlpages-${randomUUID()}`,
    schemaVersion: 1,
    backend,
    modelId,
    pageCount,
    // The exact themes asked for, so a later change to the shipped list never rewrites what an old run was given.
    themes,
    status: 'queued',
    // Pages finished so far; `pages` fills in as each one returns.
    progress: { done: 0, total: pageCount },
    pages: [],
    detail: null,
    timings: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    deleted: false,
    deletedAt: null,
  };
  await persist(query, run);
  modelLifecycleEvents.emit('html-page-run:changed', { id: run.id });
  return run;
}

/** Read-modify-write under a row lock. `mutate` returns the next record, or a falsy value for "no change". */
export async function mutateRun(id, mutate, { includeDeleted = false } = {}) {
  let changed = false;
  const run = await withTransaction(async (client) => {
    const result = await client.query('SELECT data FROM html_page_runs WHERE id = $1 FOR UPDATE', [id]);
    const current = rowToRun(result.rows[0]);
    if (!current || (!includeDeleted && current.deleted)) {
      throw new ServerError('HTML pages run not found', { status: 404, code: 'NOT_FOUND' });
    }
    const next = mutate(current);
    if (!next) return current;
    next.updatedAt = new Date().toISOString();
    await persist(client.query.bind(client), next);
    changed = true;
    return next;
  });
  // After COMMIT, so a listener can immediately read the persisted row.
  if (changed) modelLifecycleEvents.emit('html-page-run:changed', { id });
  return run;
}

export async function deleteRun(id) {
  const now = new Date().toISOString();
  const run = await mutateRun(id, (current) => ({ ...current, deleted: true, deletedAt: now }));
  return { id: run.id, deleted: true };
}
