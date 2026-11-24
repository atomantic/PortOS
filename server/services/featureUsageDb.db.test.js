/**
 * Postgres-backed tests for feature usage (`featureUsageDb.js`):
 *   - incrementFeatureVisit()  — first visit creates the row, repeats upsert `visits = visits + 1`
 *   - pruneFeatureUsage()      — drops rows older than the cutoff day
 *   - listFeatureUsageDays()   — returns `YYYY-MM-DD` day strings (not Dates) from `sinceDay` on
 *
 * These drive `featureUsageDb.js` directly: the store facade selects the FILE backend under NODE_ENV=test, so the SQL is only reachable through the leaf module (same split as `userActions.db.test.js`).
 *
 * `*.db.test.js` → runs ONLY via `npm run test:db` against `portos_test`, never the real `portos` DB (the db.js runner guard + the suite skip below enforce this).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import * as db from '../lib/db.js';
import { checkHealth, ensureSchema, close, query } from '../lib/db.js';
import { incrementFeatureVisit, listFeatureUsageDays, pruneFeatureUsage } from './featureUsageDb.js';

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    dbReady = true;
  }
}
const runDb = requireDbOrSkip('services/featureUsageDb.db.test', dbReady, skipReason);

const AREA = 'db-test-area';

// Relative days keep the suite stable as the calendar moves.
const dayOffset = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

beforeAll(async () => {
  if (dbReady) await query('DELETE FROM feature_usage_days WHERE area_id = $1', [AREA]);
});

afterAll(async () => {
  if (dbReady) {
    await query('DELETE FROM feature_usage_days WHERE area_id = $1', [AREA]).catch(() => {});
    await close();
  }
});

describe.skipIf(!runDb)('feature_usage_days', () => {
  it('creates a row on the first visit and increments it on repeats', async () => {
    const day = dayOffset(1);
    await incrementFeatureVisit(db, AREA, day);
    await incrementFeatureVisit(db, AREA, day);
    await incrementFeatureVisit(db, AREA, day);
    const rows = (await listFeatureUsageDays(db, day)).filter((row) => row.areaId === AREA);
    expect(rows).toEqual([{ areaId: AREA, day, visits: 3 }]);
  });

  it('lists day strings from the since-day on, oldest first', async () => {
    for (const ago of [5, 3, 1]) await incrementFeatureVisit(db, AREA, dayOffset(ago));
    const rows = (await listFeatureUsageDays(db, dayOffset(4))).filter((row) => row.areaId === AREA);
    expect(rows.map((row) => row.day)).toEqual([dayOffset(3), dayOffset(1)]);
    expect(typeof rows[0].day).toBe('string');
  });

  it('prunes only rows older than the cutoff day', async () => {
    for (const ago of [100, 5]) await incrementFeatureVisit(db, AREA, dayOffset(ago));
    await pruneFeatureUsage(db, dayOffset(90));
    const rows = (await listFeatureUsageDays(db, dayOffset(200))).filter((row) => row.areaId === AREA);
    expect(rows.map((row) => row.day)).not.toContain(dayOffset(100));
    expect(rows.map((row) => row.day)).toContain(dayOffset(5));
  });
});
