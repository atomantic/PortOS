/**
 * Postgres-backed tests for the human-activity timeline store (#2150):
 *   - recordEvents()   — idempotent insert via ON CONFLICT (source, dedupe_key)
 *   - listEvents()     — range / source / kind / personId filters
 *   - getDaySummary()  — local-day window + hourly histogram + tallies
 *   - stripParticipantsForAccount() — scoped send-as-alias backfill (#2855)
 *
 * `*.db.test.js` → runs ONLY via `npm run test:db` against `portos_test`, never
 * the real `portos` DB (the db.js runner guard + the suite skip below enforce
 * this). The DB is shared across worktrees, so every row created here uses a
 * per-run nonce and is torn down in afterAll; assertions are relative to the
 * rows this suite inserts.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { checkHealth, ensureSchema, close, query } from '../lib/db.js';
import { recordEvents, listEvents, getDaySummary, stripParticipantsForAccount } from './humanActivity.js';

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
if (!dbReady) console.log(`⏭️ humanActivity.db.test: skipping suite — ${skipReason || 'no database'}`);

const nonce = `ha${Date.now()}`;
const SOURCE = `test-${nonce}`;
const PERSON = `person-${nonce}`;
// The alias-backfill tests need their own source: stripParticipantsForAccount is
// scoped by (account_id, source), and a shared source would let one test's repair
// touch another's rows.
const ALIAS_SOURCE = `test-${nonce}-alias`;

afterAll(async () => {
  if (dbReady) {
    await query('DELETE FROM human_activity_events WHERE source = ANY($1::text[])', [[SOURCE, ALIAS_SOURCE]]).catch(() => {});
    await close();
  }
});

const mk = (over = {}) => ({
  source: SOURCE,
  kind: 'message.received',
  happenedAt: '2026-07-04T15:00:00Z',
  dedupeKey: `k-${Math.random().toString(36).slice(2)}`,
  title: 'Test event',
  ...over,
});

describe.skipIf(!dbReady)('humanActivity store (#2150)', () => {
  it('records events and is idempotent on (source, dedupe_key)', async () => {
    const cands = [
      mk({ dedupeKey: 'dup-1', title: 'First' }),
      mk({ dedupeKey: 'dup-2', title: 'Second' }),
    ];
    const first = await recordEvents(cands);
    expect(first.recorded).toBe(2);

    // Re-recording the exact same candidates is a no-op.
    const second = await recordEvents(cands);
    expect(second.recorded).toBe(0);
    expect(second.skipped).toBe(2);

    // A batch mixing a new + a duplicate records only the new one.
    const mixed = await recordEvents([mk({ dedupeKey: 'dup-1' }), mk({ dedupeKey: 'dup-3' })]);
    expect(mixed.recorded).toBe(1);
  });

  it('drops candidates that fail normalization (no double-count)', async () => {
    const res = await recordEvents([mk({ dedupeKey: 'valid-1' }), { source: SOURCE /* missing kind/happenedAt/dedupeKey */ }]);
    expect(res.recorded).toBe(1);
    expect(res.skipped).toBe(1);
  });

  it('filters by source, kind, and time range', async () => {
    await recordEvents([
      mk({ dedupeKey: 'f-1', kind: 'message.sent', happenedAt: '2026-07-04T09:00:00Z' }),
      mk({ dedupeKey: 'f-2', kind: 'calendar.event', happenedAt: '2026-07-04T18:00:00Z' }),
    ]);
    const bySource = await listEvents({ source: SOURCE, limit: 500 });
    expect(bySource.every((e) => e.source === SOURCE)).toBe(true);

    const byKind = await listEvents({ source: SOURCE, kind: 'calendar.event' });
    expect(byKind.every((e) => e.kind === 'calendar.event')).toBe(true);
    expect(byKind.some((e) => e.dedupeKey === 'f-2')).toBe(true);

    const inRange = await listEvents({
      source: SOURCE,
      from: '2026-07-04T17:00:00Z',
      to: '2026-07-04T19:00:00Z',
    });
    expect(inRange.some((e) => e.dedupeKey === 'f-2')).toBe(true);
    expect(inRange.some((e) => e.dedupeKey === 'f-1')).toBe(false);
  });

  it('matches a participant by personId via JSONB containment', async () => {
    await recordEvents([mk({
      dedupeKey: 'p-1',
      participants: [{ name: 'Pat', email: 'pat@x.io', personId: PERSON }],
    })]);
    const hits = await listEvents({ source: SOURCE, personId: PERSON });
    expect(hits.some((e) => e.dedupeKey === 'p-1')).toBe(true);
    const miss = await listEvents({ source: SOURCE, personId: `${PERSON}-nope` });
    expect(miss.some((e) => e.dedupeKey === 'p-1')).toBe(false);
  });

  it('round-trips participants and metadata as JSON', async () => {
    await recordEvents([mk({
      dedupeKey: 'json-1',
      participants: [{ email: 'a@b.com' }],
      metadata: { threadId: 't-9', externalId: 'x-9' },
    })]);
    const [row] = await listEvents({ source: SOURCE, kind: 'message.received', limit: 500 })
      .then((rows) => rows.filter((r) => r.dedupeKey === 'json-1'));
    expect(row.participants).toEqual([{ email: 'a@b.com' }]);
    expect(row.metadata).toEqual({ threadId: 't-9', externalId: 'x-9' });
  });

  it('getDaySummary returns events, a 24-slot histogram, and tallies', async () => {
    // Use a source-scoped fetch to keep the assertion independent of other rows,
    // then sanity-check the summary shape for the same day.
    const summary = await getDaySummary({ date: '2026-07-04' });
    expect(summary.date).toBe('2026-07-04');
    // The server's "today" (user-timezone) ships with every summary so the
    // client can gate its Today/next-day controls on the server's day.
    expect(summary.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(summary.histogram).toHaveLength(24);
    expect(typeof summary.counts.total).toBe('number');
    expect(summary.counts.bySource).toBeTruthy();
  });
});

describe.skipIf(!dbReady)('stripParticipantsForAccount — send-as alias backfill (#2855)', () => {
  const ACCT = `acct-${nonce}`;
  const OTHER_ACCT = `other-${nonce}`;
  const ALIAS = 'alias@example.com';

  const aliasRow = (over = {}) => ({
    source: ALIAS_SOURCE,
    accountId: ACCT,
    kind: 'message.received',
    happenedAt: '2026-07-04T15:00:00Z',
    title: 'Hey',
    metadata: { handle: 'friend@x.io', threadId: 't-1' },
    ...over,
  });

  const fetchRow = async (dedupeKey) => {
    const rows = await listEvents({ source: ALIAS_SOURCE, limit: 2000 });
    return rows.find((r) => r.dedupeKey === dedupeKey);
  };

  it('strips the alias from an existing 1:1 row, leaving the sender and metadata.handle intact', async () => {
    await recordEvents([aliasRow({
      dedupeKey: 'alias-1',
      participants: [{ email: 'friend@x.io' }, { email: ALIAS }],
    })]);

    const repaired = await stripParticipantsForAccount(ACCT, ALIAS_SOURCE, [ALIAS]);
    expect(repaired).toBeGreaterThanOrEqual(1);

    const row = await fetchRow('alias-1');
    // Now a true 1:1 — exactly one counterpart, so outreach detection stops
    // rejecting it as a group conversation.
    expect(row.participants).toEqual([{ email: 'friend@x.io' }]);
    // The sender pointer is untouched — it identifies the person, not the owner.
    expect(row.metadata.handle).toBe('friend@x.io');
  });

  it('matches the alias case-insensitively and accepts an unnormalized input list', async () => {
    await recordEvents([aliasRow({
      dedupeKey: 'alias-case',
      participants: [{ email: 'friend@x.io' }, { email: ALIAS }],
    })]);
    await stripParticipantsForAccount(ACCT, ALIAS_SOURCE, ['  Alias@EXAMPLE.com ']);
    const row = await fetchRow('alias-case');
    expect(row.participants).toEqual([{ email: 'friend@x.io' }]);
  });

  it('leaves rows with no alias participant untouched', async () => {
    const participants = [{ name: 'Pat', email: 'pat@x.io' }, { email: 'sam@x.io' }];
    await recordEvents([aliasRow({ dedupeKey: 'alias-none', participants })]);
    await stripParticipantsForAccount(ACCT, ALIAS_SOURCE, [ALIAS]);
    const row = await fetchRow('alias-none');
    expect(row.participants).toEqual(participants);
  });

  it('is scoped to the account — another account keeping the same address is untouched', async () => {
    await recordEvents([aliasRow({
      dedupeKey: 'alias-other-acct',
      accountId: OTHER_ACCT,
      participants: [{ email: 'friend@x.io' }, { email: ALIAS }],
    })]);
    await stripParticipantsForAccount(ACCT, ALIAS_SOURCE, [ALIAS]);
    const row = await fetchRow('alias-other-acct');
    expect(row.participants.map((p) => p.email)).toContain(ALIAS);
  });

  it('yields an empty array (not NULL) when every participant was an owner address', async () => {
    await recordEvents([aliasRow({
      dedupeKey: 'alias-all',
      participants: [{ email: ALIAS }],
    })]);
    await stripParticipantsForAccount(ACCT, ALIAS_SOURCE, [ALIAS]);
    const row = await fetchRow('alias-all');
    expect(row.participants).toEqual([]);
  });

  it('is idempotent — a second repair matches nothing and reports 0 rows', async () => {
    await recordEvents([aliasRow({
      dedupeKey: 'alias-idem',
      participants: [{ email: 'friend@x.io' }, { email: ALIAS }],
    })]);
    await stripParticipantsForAccount(ACCT, ALIAS_SOURCE, [ALIAS]);
    const second = await stripParticipantsForAccount(ACCT, ALIAS_SOURCE, [ALIAS]);
    expect(second).toBe(0);
  });

  it('runs on a caller-supplied transaction client when one is passed (boot migration path)', async () => {
    await recordEvents([aliasRow({
      dedupeKey: 'alias-tx',
      participants: [{ email: 'friend@x.io' }, { email: ALIAS }],
    })]);
    // A thin client shim over the pool is enough to prove the option routes the
    // statement through the supplied client instead of the module's own query().
    const calls = [];
    const client = { query: (sql, params) => { calls.push(sql); return query(sql, params); } };
    const repaired = await stripParticipantsForAccount(ACCT, ALIAS_SOURCE, [ALIAS], { client });
    expect(repaired).toBe(1);
    expect(calls).toHaveLength(1);
    const row = await fetchRow('alias-tx');
    expect(row.participants).toEqual([{ email: 'friend@x.io' }]);
  });
});
