/**
 * Postgres-backed regression for #15310: computeWeeklyScorecard used to read the
 * four-week span through one 2,000-row capped listEvents call, silently dropping
 * the oldest trend weeks (and the target week's earliest days) in a busy window.
 *
 * `*.db.test.js` → runs ONLY via `npm run test:db` against `portos_test`. Rows
 * live in a far-past window under a per-run source and are removed in afterAll;
 * scorecard output is re-rooted into a temp dir.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

var tempRoot;
function getTempRoot() {
  if (!tempRoot) tempRoot = mkdtempSync(join(tmpdir(), 'goal-scorecard-db-test-'));
  return tempRoot;
}
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => getTempRoot() }));
vi.mock('./userTimezone.js', () => ({ getUserTimezone: async () => 'UTC' }));

import { checkHealth, ensureSchema, close, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { recordEvents, forEachEventPage } from './humanActivity.js';
import { computeWeeklyScorecard, NOMINAL_SECONDS } from './goalScorecard.js';

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
const runDb = requireDbOrSkip('services/goalScorecard.db.test', dbReady, skipReason);

const SOURCE = `test-gs${Date.now()}`;
// Monday 2019-03-04 is the target week; the four-week span starts 2019-02-11.
const TARGET_WEEK = '2019-03-04';
const SPAN_START = '2019-02-11T00:00:00.000Z';
const SPAN_END = '2019-03-11T00:00:00.000Z';

afterAll(async () => {
  if (dbReady) {
    await query('DELETE FROM human_activity_events WHERE source = $1', [SOURCE]).catch(() => {});
    await close();
  }
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

const at = (weekOffset, i, sharedSecond = false) => {
  const base = Date.parse(SPAN_START) + weekOffset * 7 * 86400000;
  const ms = sharedSecond ? 3600000 : (i % (7 * 24)) * 3600000 + Math.floor(i / (7 * 24)) * 1000;
  return new Date(base + ms).toISOString();
};
const mkRows = (weekOffset, n, prefix) => Array.from({ length: n }, (_, i) => ({
  source: SOURCE,
  kind: 'message.sent',
  happenedAt: at(weekOffset, i),
  dedupeKey: `${prefix}-${i}`,
  title: 'Scorecard volume event',
}));

describe.skipIf(!runDb)('computeWeeklyScorecard volume (#15310)', () => {
  it('counts every event in every trend week, including past 2,000 total and in the target week', async () => {
    // Oldest week first: 700 events; target week alone holds 2,100 (> one page).
    const perWeek = [700, 300, 400, 2100];
    for (const [w, n] of perWeek.entries()) {
      await recordEvents(mkRows(w, n, `w${w}`));
    }

    const card = await computeWeeklyScorecard({ weekStart: TARGET_WEEK });

    const { rows } = await query(
      `SELECT date_trunc('week', happened_at AT TIME ZONE 'UTC') AS wk, COUNT(*)::int AS n
       FROM human_activity_events
       WHERE happened_at >= $1 AND happened_at < $2
       GROUP BY 1 ORDER BY 1`,
      [SPAN_START, SPAN_END],
    );
    const sqlCounts = rows.map((r) => r.n);
    expect(sqlCounts).toEqual(perWeek);
    // No goals are configured, so every second lands in unalignedSeconds.
    expect(card.trend.map((t) => t.unalignedSeconds)).toEqual(
      perWeek.map((n) => n * NOMINAL_SECONDS['message.sent']),
    );
    expect(card.trend[0].unalignedSeconds, 'the oldest week used to read as empty').toBeGreaterThan(0);
    expect(card.totals.eventCount).toBe(2100);
  });

  it('visits events sharing one happened_at exactly once across page boundaries', async () => {
    const week = 5; // beyond the scorecard span; isolated window
    const shared = at(week, 0, true);
    const rows = Array.from({ length: 7 }, (_, i) => ({
      source: SOURCE, kind: 'message.sent', happenedAt: shared, dedupeKey: `tie-${i}`, title: 'tie',
    }));
    await recordEvents(rows);
    const from = new Date(Date.parse(shared) - 1000).toISOString();
    const to = new Date(Date.parse(shared) + 1000).toISOString();
    const seen = [];
    await forEachEventPage({ from, to, pageSize: 3 }, (page) => { for (const e of page) seen.push(e.id); });
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });
});
