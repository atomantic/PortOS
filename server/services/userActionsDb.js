/**
 * PostgreSQL leaf I/O for the operator-action ledger (#5594).
 *
 * Split out of `userActions.js` the same way `postRunDb.js` is split out of
 * `postRunStore.js`: the store owns backend selection (and therefore selects the
 * FILE backend under `NODE_ENV=test`), so the SQL would otherwise be unreachable
 * from a test. Every function here takes the `db` module as its first argument —
 * no module-level database import — which is what lets `userActions.db.test.js`
 * drive it against `portos_test` under `npm run test:db`.
 */

const iso = (value) => (value instanceof Date ? value.toISOString() : value);

/** Map a `user_action_events` row to the camelCase event shape the API returns. */
export function rowToUserActionEvent(row) {
  return {
    id: row.id,
    type: row.type,
    actor: row.actor,
    happenedAt: iso(row.happened_at),
    target: row.target,
    targetName: row.target_name,
    success: row.success,
    summary: row.summary,
    payload: row.payload || {},
    source: row.source || {},
    dedupeKey: row.dedupe_key,
    createdAt: iso(row.created_at),
  };
}

/**
 * Insert one event, idempotent on `(type, dedupe_key)`.
 * @returns {Promise<boolean>} true when a row landed, false when it was a duplicate.
 */
export async function insertUserActionEvent(db, event) {
  const result = await db.query(
    `INSERT INTO user_action_events
       (id, type, actor, happened_at, target, target_name, success, summary, payload, source, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11)
     ON CONFLICT (type, dedupe_key) DO NOTHING
     RETURNING id`,
    [
      event.id, event.type, event.actor, event.happenedAt, event.target, event.targetName,
      event.success, event.summary, JSON.stringify(event.payload),
      JSON.stringify(event.source), event.dedupeKey,
    ],
  );
  return (result.rowCount || 0) > 0;
}

/**
 * Enforce BOTH retention bounds: nothing older than `cutoffIso`, and no more than
 * `maxRows` rows. Called inline after a successful insert rather than from a cron
 * — the table only grows when the user acts, so a scheduled job for it would be a
 * moving part that earns nothing.
 * @returns {Promise<number>} rows deleted.
 */
export async function pruneUserActionEvents(db, { maxRows, cutoffIso }) {
  const aged = await db.query('DELETE FROM user_action_events WHERE happened_at < $1', [cutoffIso]);
  const overflow = await db.query(
    `DELETE FROM user_action_events WHERE id IN (
       SELECT id FROM user_action_events ORDER BY happened_at DESC, id DESC OFFSET $1
     )`,
    [maxRows],
  );
  return (aged.rowCount || 0) + (overflow.rowCount || 0);
}

/** Newest-first slice of the ledger. `filters` comes from `normalizeListOptions`. */
export async function listUserActionEvents(db, filters) {
  const where = [];
  const params = [];
  const bind = (value) => { params.push(value); return `$${params.length}`; };
  if (filters.types.length > 0) where.push(`type = ANY(${bind(filters.types)})`);
  if (filters.actor) where.push(`actor = ${bind(filters.actor)}`);
  if (filters.target) where.push(`target = ${bind(filters.target)}`);
  if (filters.success !== null) where.push(`success = ${bind(filters.success)}`);
  if (filters.from) where.push(`happened_at >= ${bind(filters.from)}`);
  if (filters.to) where.push(`happened_at <= ${bind(filters.to)}`);
  const result = await db.query(
    `SELECT * FROM user_action_events
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY happened_at DESC, id DESC
     LIMIT ${bind(filters.limit)} OFFSET ${bind(filters.offset)}`,
    params,
  );
  return result.rows.map(rowToUserActionEvent);
}
