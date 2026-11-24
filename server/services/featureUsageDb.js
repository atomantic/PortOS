/**
 * PostgreSQL leaf I/O for feature usage: one `feature_usage_days` row per feature area per local calendar day.
 *
 * Split out of `featurePriorities.js` the way `userActionsDb.js` is split out of `userActions.js`: the store facade selects the FILE backend under `NODE_ENV=test`, so the SQL would otherwise be unreachable from a test.
 * Every function takes the `db` module as its first argument, which lets `featureUsageDb.db.test.js` drive it against `portos_test` under `npm run test:db`.
 *
 * Days are `YYYY-MM-DD` strings in both directions (`to_char` on read), because the pg driver would otherwise turn a DATE into a Date at the server's local midnight.
 */

/** Count one focused visit to an area on a day; the first visit of the day creates the row. */
export async function incrementFeatureVisit(db, areaId, day) {
  await db.query(
    `INSERT INTO feature_usage_days (area_id, day, visits)
     VALUES ($1, $2::date, 1)
     ON CONFLICT (area_id, day) DO UPDATE SET visits = feature_usage_days.visits + 1`,
    [areaId, day],
  );
}

/**
 * Delete every row older than `cutoffDay`. Called inline after a visit lands rather than from a cron: the table only grows when the user opens a page.
 * @returns {Promise<number>} rows deleted.
 */
export async function pruneFeatureUsage(db, cutoffDay) {
  const result = await db.query('DELETE FROM feature_usage_days WHERE day < $1::date', [cutoffDay]);
  return result.rowCount || 0;
}

/** Rows on or after `sinceDay`, as `{ areaId, day, visits }`. */
export async function listFeatureUsageDays(db, sinceDay) {
  const result = await db.query(
    `SELECT area_id, to_char(day, 'YYYY-MM-DD') AS day, visits
     FROM feature_usage_days
     WHERE day >= $1::date
     ORDER BY day, area_id`,
    [sinceDay],
  );
  return result.rows.map((row) => ({ areaId: row.area_id, day: row.day, visits: row.visits }));
}
