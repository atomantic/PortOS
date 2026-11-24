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

  it('open-lane reads use the open partial index', async () => {
    const plan = await planWithoutSeqScan(
      `SELECT * FROM github_notifications WHERE account_id = ANY($1::text[]) AND state = 'open' AND unread
       ORDER BY gh_updated_at DESC LIMIT 100`,
      [['acct-1']],
    );
    expect(plan).toContain('idx_github_notifications_open_updated');
  });

  it('per-repo thread counts use the account+repo index', async () => {
    const plan = await planWithoutSeqScan(
      'SELECT repo_full_name, COUNT(*)::int AS n FROM github_notifications WHERE account_id = $1 AND repo_full_name = ANY($2::text[]) GROUP BY repo_full_name',
      ['acct-1', ['o/r']],
    );
    expect(plan).toContain('idx_github_notifications_account_repo');
  });

  it('audit change listing uses the account index', async () => {
    const plan = await planWithoutSeqScan(
      'SELECT * FROM github_notification_audit_changes WHERE account_id = ANY($1::text[]) ORDER BY applied_at DESC, id DESC LIMIT 100',
      [['acct-1']],
    );
    expect(plan).toContain('idx_github_notification_audit_changes_account');
  });

  it('inbox counts evaluate mutes with one join and no correlated SubPlans', async () => {
    const plan = await planWithoutSeqScan(
      `SELECT COUNT(*) FILTER (WHERE NOT muted_in_portos)::int
       FROM (SELECT n.*, (NOT n.suspect AND m.account_id IS NOT NULL) AS muted_in_portos
         FROM github_notifications n
         LEFT JOIN github_notification_mutes m ON m.account_id = n.account_id
           AND m.repo_full_name = lower(n.repo_full_name) AND m.reason = n.reason
         WHERE n.account_id = ANY($1::text[])) github_notifications`,
      [['acct-1']],
    );
    expect(plan).not.toContain('SubPlan');
  });

  it('index definitions exist', async () => {
    const { rows } = await query(`SELECT indexname FROM pg_indexes WHERE indexname IN ('idx_github_notifications_resolve_task','idx_github_notification_events_automation','idx_github_notifications_open_updated','idx_github_notifications_account_repo','idx_github_notification_audit_changes_account')`);
    expect(rows).toHaveLength(5);
  });
});
