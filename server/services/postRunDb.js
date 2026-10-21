/**
 * PostgreSQL leaf I/O for normalized MeatSpace POST runs (#4441).
 *
 * Every run save replaces that run's attempt set in one transaction. Stable
 * run/attempt ids therefore make retries idempotent, while a failure anywhere
 * rolls the complete save back instead of leaving a partial training session.
 */

import { toPgJson } from '../lib/pgJson.js';

const asIso = (value) => value instanceof Date ? value.toISOString() : value;
const asDay = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);

function withPersistedTimes(run, existing) {
  const localDay = existing?.local_day ? asDay(existing.local_day) : run.localDay;
  const startedAt = existing?.started_at ? asIso(existing.started_at) : run.startedAt;
  const data = { ...(run.data || {}) };
  if (run.mode === 'test' || run.mode === 'benchmark') {
    data.date = localDay;
    data.startedAt = startedAt;
  } else {
    data.localDay = localDay;
    data.startedAt = startedAt;
  }
  return { ...run, localDay, startedAt, data };
}

/** Save one normalized run using an already-open transaction client. */
export async function saveNormalizedRunWithClient(client, input) {
  const attemptIds = new Set();
  for (const attempt of input.attempts || []) {
    if (attemptIds.has(attempt.id)) throw new Error(`Duplicate POST attempt id: ${attempt.id}`);
    attemptIds.add(attempt.id);
  }

  // A row lock cannot protect the first insert because no row exists yet.
  // Serialize transactions for the same client run id so concurrent retries
  // agree which one is the creation (retention side effects run only once).
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [input.id]);
  const existingResult = await client.query(
    `SELECT mode, local_day, started_at FROM post_runs WHERE id = $1 FOR UPDATE`,
    [input.id],
  );
  const existing = existingResult.rows[0] || null;
  if (existing && existing.mode !== input.mode) {
    throw new Error(`POST run ${input.id} already exists in mode ${existing.mode}`);
  }
  const run = withPersistedTimes(input, existing);

  await client.query(
    `INSERT INTO post_runs
       (id, mode, local_day, started_at, completed_at, status, planned, data, legacy)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
     ON CONFLICT (id) DO UPDATE SET
       completed_at = EXCLUDED.completed_at,
       status = EXCLUDED.status,
       planned = EXCLUDED.planned,
       data = EXCLUDED.data,
       legacy = post_runs.legacy OR EXCLUDED.legacy,
       updated_at = NOW()`,
    [
      run.id, run.mode, run.localDay, run.startedAt, run.completedAt || null,
      run.status || 'completed', toPgJson(run.planned || {}),
      toPgJson(run.data || {}), run.legacy === true,
    ],
  );

  const attempts = run.attempts || [];
  if (attempts.length) {
    const collisions = await client.query(
      `SELECT id, run_id FROM post_attempts WHERE id = ANY($1::text[]) FOR UPDATE`,
      [attempts.map((attempt) => attempt.id)],
    );
    const foreign = collisions.rows.find((row) => row.run_id !== run.id);
    if (foreign) throw new Error(`POST attempt ${foreign.id} already belongs to another run`);
    // Move existing positions out of the unique (run_id, position) range before
    // the upserts. This lets a corrected retry reorder or shrink the attempt set
    // without transient uniqueness conflicts; the transaction hides the move.
    await client.query(
      `UPDATE post_attempts SET position = position + 1000000 WHERE run_id = $1`,
      [run.id],
    );
  }
  for (let position = 0; position < attempts.length; position += 1) {
    const attempt = attempts[position];
    await client.query(
      `INSERT INTO post_attempts
         (id, run_id, position, module, drill_type, difficulty, config_version,
          correct, score, latency_ms, completion, hint_used, confidence,
          input_mode, scorer_provenance, data, legacy)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16::jsonb, $17)
       ON CONFLICT (id) DO UPDATE SET
         position = EXCLUDED.position,
         module = EXCLUDED.module,
         drill_type = EXCLUDED.drill_type,
         difficulty = EXCLUDED.difficulty,
         config_version = EXCLUDED.config_version,
         correct = EXCLUDED.correct,
         score = EXCLUDED.score,
         latency_ms = EXCLUDED.latency_ms,
         completion = EXCLUDED.completion,
         hint_used = EXCLUDED.hint_used,
         confidence = EXCLUDED.confidence,
         input_mode = EXCLUDED.input_mode,
         scorer_provenance = EXCLUDED.scorer_provenance,
         data = EXCLUDED.data,
         legacy = post_attempts.legacy OR EXCLUDED.legacy,
         updated_at = NOW()`,
      [
        attempt.id, run.id, position, attempt.module, attempt.drillType,
        attempt.difficulty == null ? null : toPgJson(attempt.difficulty),
        attempt.configVersion || null, attempt.correct ?? null, attempt.score ?? null,
        attempt.latencyMs || 0, attempt.completion ?? null, attempt.hintUsed === true,
        attempt.confidence ?? null, attempt.inputMode || 'unknown',
        attempt.scorerProvenance || 'unknown', toPgJson(attempt.data || {}),
        attempt.legacy === true,
      ],
    );
  }

  if (attempts.length) {
    await client.query(
      `DELETE FROM post_attempts WHERE run_id = $1 AND NOT (id = ANY($2::text[]))`,
      [run.id, attempts.map((attempt) => attempt.id)],
    );
  } else {
    await client.query(`DELETE FROM post_attempts WHERE run_id = $1`, [run.id]);
  }

  return { run, isNew: !existing };
}

export function saveNormalizedRun(db, run) {
  return db.withTransaction((client) => saveNormalizedRunWithClient(client, run));
}

export async function listScoredSessions(db, { strict: _strict = false } = {}) {
  const result = await db.query(
    `SELECT data FROM post_runs WHERE mode = 'test' ORDER BY started_at, id`,
  );
  return result.rows.map((row) => row.data);
}

export async function getScoredSession(db, id) {
  const result = await db.query(
    `SELECT data FROM post_runs WHERE id = $1 AND mode = 'test'`,
    [id],
  );
  return result.rows[0]?.data || null;
}

export async function listTrainingEntries(db, { strict: _strict = false } = {}) {
  const result = await db.query(
    `SELECT a.data
      FROM post_attempts a
       JOIN post_runs r ON r.id = a.run_id
      WHERE r.mode = 'training'
      ORDER BY r.started_at, r.id, a.position, a.id`,
  );
  return result.rows.map((row) => row.data);
}
