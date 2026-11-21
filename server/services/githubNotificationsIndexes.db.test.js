/**
 * Postgres-backed check that the notification-resolve listener lookup and the
 * Automations activity listing are servable from the partial indexes (#17278).
 * Runs via `npm run test:db` (portos_test only).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { checkHealth, ensureSchema, close, query, withTransaction } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';

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
const runDb = requireDbOrSkip('services/githubNotificationsIndexes.db.test', dbReady, skipReason);

// Plan text with seq scans disabled: the index is usable only when the query's
// WHERE implies the partial predicate, which is what this pins.
async function planWithoutSeqScan(sql, params) {
  return withTransaction(async (client) => {
    await client.query('SET LOCAL enable_seqscan = off');
    const { rows } = await client.query(`EXPLAIN ${sql}`, params);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  });
}

describe.skipIf(!runDb)('github notification partial indexes (#17278)', () => {
  afterAll(async () => { await close(); });

  it('resolve-task lookup uses the partial handoff index', async () => {
    const plan = await planWithoutSeqScan(
      `SELECT account_id, thread_id FROM github_notifications
       WHERE state = 'open' AND evidence->'handoff'->>'lane' = 'notification-resolve' AND evidence->'handoff'->>'taskId' = $1`,
      ['task-1'],
    );
    expect(plan).toContain('idx_github_notifications_resolve_task');
  });

  it('automation activity listing uses the partial events index', async () => {
    const plan = await planWithoutSeqScan(
      `SELECT e.id FROM github_notification_events e
       WHERE e.actor = 'automation' AND e.kind = ANY($1::text[]) AND e.account_id = ANY($2::text[])
       ORDER BY e.created_at DESC, e.id DESC LIMIT $3`,
      [['done', 'handed-off'], ['acct-1'], 50],
    );
    expect(plan).toContain('idx_github_notification_events_automation');
  });

  it('index definitions exist', async () => {
    const { rows } = await query(`SELECT indexname FROM pg_indexes WHERE indexname IN ('idx_github_notifications_resolve_task','idx_github_notification_events_automation')`);
    expect(rows).toHaveLength(2);
  });
});
