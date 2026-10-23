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
import { describe, it, expect, afterAll, vi } from 'vitest';
import { checkHealth, ensureSchema, close, query, withTransaction } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
// Pin the user timezone per test so day bounds are deterministic.
const tzState = vi.hoisted(() => ({ tz: 'UTC' }));
vi.mock('./userTimezone.js', () => ({ getUserTimezone: async () => tzState.tz }));

import { recordEvents, listEvents, getDaySummary, stripParticipantsForAccount, countEventsByHandle, eraseEvents, listSourceCounts } from './humanActivity.js';

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
const runDb = requireDbOrSkip('services/humanActivity.db.test', dbReady, skipReason);

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

describe.skipIf(!runDb)('humanActivity store (#2150)', () => {
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

describe.skipIf(!runDb)('getDaySummary full-day aggregates (#11151)', () => {
  const DAY_SOURCE = `test-${nonce}-day`;
  const dayEvents = (n, iso, prefix, over = {}) => Array.from({ length: n }, (_, i) => ({
    source: DAY_SOURCE, kind: 'message.received', happenedAt: iso, dedupeKey: `${prefix}-${i}`, title: 'e', ...over,
  }));

  afterAll(async () => {
    tzState.tz = 'UTC';
    if (dbReady) await query('DELETE FROM human_activity_events WHERE source = $1', [DAY_SOURCE]).catch(() => {});
  });

  it('counts and buckets the whole day even when it exceeds the event page (2,001-event case, scaled)', async () => {
    tzState.tz = 'UTC';
    // Far-past day: no other suite or live data lands here.
    const date = '2001-03-04';
    const PAGE = 3;
    const before = await getDaySummary({ date, eventLimit: PAGE });
    await recordEvents([
      ...dayEvents(PAGE, '2001-03-04T12:00:00Z', 'noon'),
      ...dayEvents(1, '2001-03-04T08:00:00Z', 'early', { kind: 'calendar.event' }),
    ]);
    const s = await getDaySummary({ date, eventLimit: PAGE });
    expect(s.counts.total - before.counts.total).toBe(PAGE + 1);
    expect(s.counts.bySource[DAY_SOURCE]).toBe(PAGE + 1);
    expect(s.counts.byKind['calendar.event'] - (before.counts.byKind['calendar.event'] || 0)).toBe(1);
    expect(s.histogram[8].count - before.histogram[8].count).toBe(1);
    expect(s.histogram[12].count - before.histogram[12].count).toBe(PAGE);
    // The listed page stays bounded and is honest about it.
    expect(s.events.length).toBeLessThanOrEqual(PAGE);
    expect(s.eventPage).toEqual({ total: s.counts.total, returned: s.events.length, limit: PAGE, hasMore: true });
    // Oldest-first display order.
    const times = s.events.map((e) => new Date(e.happenedAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('uses the same exclusive local-day bounds for aggregates and rows across a DST day', async () => {
    tzState.tz = 'America/Los_Angeles';
    // 2001-04-01 was a 23-hour day in Los Angeles: 08:00Z .. 07:00Z next day.
    const date = '2001-04-01';
    await recordEvents([
      { source: DAY_SOURCE, kind: 'message.sent', happenedAt: '2001-04-01T07:59:59Z', dedupeKey: 'dst-prev' },
      { source: DAY_SOURCE, kind: 'message.sent', happenedAt: '2001-04-01T08:00:00Z', dedupeKey: 'dst-start' },
      { source: DAY_SOURCE, kind: 'message.sent', happenedAt: '2001-04-02T06:59:59Z', dedupeKey: 'dst-last' },
      { source: DAY_SOURCE, kind: 'message.sent', happenedAt: '2001-04-02T07:00:00Z', dedupeKey: 'dst-next' },
    ]);
    const s = await getDaySummary({ date });
    const mine = s.events.filter((e) => e.source === DAY_SOURCE).map((e) => e.dedupeKey).sort();
    expect(mine).toEqual(['dst-last', 'dst-start']);
    expect(s.counts.bySource[DAY_SOURCE]).toBe(2);
    expect(s.histogram[0].count).toBeGreaterThanOrEqual(1); // 08:00Z = local 00:00
    expect(s.histogram[23].count).toBeGreaterThanOrEqual(1); // 06:59:59Z next day = local 23:59
    expect(s.eventPage.total).toBe(s.counts.total);
  });

  it('keeps aggregates and the page consistent when rows are inserted mid-read', async () => {
    tzState.tz = 'UTC';
    const date = '2001-05-06';
    await recordEvents(dayEvents(3, '2001-05-06T10:00:00Z', 'base'));
    // Insert concurrently with the read; whichever side of the snapshot the
    // insert lands on, total and page must describe the same row set.
    const [s] = await Promise.all([
      getDaySummary({ date }),
      recordEvents(dayEvents(5, '2001-05-06T11:00:00Z', 'racer')),
    ]);
    const listed = s.events.filter((e) => e.source === DAY_SOURCE).length;
    expect(s.eventPage.returned).toBe(s.events.length);
    expect(s.counts.bySource[DAY_SOURCE]).toBe(listed);
    expect(s.counts.total).toBe(s.eventPage.total);
  });
});

describe.skipIf(!runDb)('stripParticipantsForAccount — send-as alias backfill (#2855)', () => {
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

// #5715 — the source-scoped composite is what keeps a low-volume source sitting
// behind a high-volume one off a backwards walk of the whole `happened_at`
// index. Assert the PLAN, not a timing: plan shape is deterministic in CI,
// elapsed time is not.
describe.skipIf(!runDb)('source-scoped read plan (#5715)', () => {
  // On a near-empty shared test table a sequential scan is genuinely the
  // cheapest plan, so an unmodified EXPLAIN would prove nothing about the index.
  // Disabling seqscan for the transaction makes the choice Postgres faces on a
  // real, large table — this composite vs. the plain `happened_at` index —
  // observable here.
  const explainWithoutSeqScan = (sql, params) => withTransaction(async (client) => {
    await client.query('SET LOCAL enable_seqscan = off');
    const res = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
    return res.rows[0]['QUERY PLAN'][0].Plan;
  });

  const planNodes = (node) => [node, ...(node.Plans || []).flatMap(planNodes)];

  // The point of the composite is that the index supplies the ordering, so the
  // LIMIT stops early. A bitmap scan feeding a Sort would still name the index
  // while re-reading and sorting every matching row — the exact regression this
  // pins — so assert an ordered Index Scan AND the absence of a Sort node.
  const expectOrderedIndexScan = (plan, indexName) => {
    const nodes = planNodes(plan);
    expect(nodes.map((n) => n['Node Type'])).not.toContain('Sort');
    expect(nodes.some((n) => /^Index (Only )?Scan$/.test(n['Node Type']) && n['Index Name'] === indexName))
      .toBe(true);
  };

  it('uses idx_human_activity_source_happened for a source-scoped newest-first read', async () => {
    await recordEvents([mk({ dedupeKey: 'plan-1' }), mk({ dedupeKey: 'plan-2' })]);
    const plan = await explainWithoutSeqScan(
      `SELECT * FROM human_activity_events
       WHERE source = $1
       ORDER BY happened_at DESC
       LIMIT 50`,
      [SOURCE],
    );
    expectOrderedIndexScan(plan, 'idx_human_activity_source_happened');
  });

  it('uses idx_human_activity_source_kind_happened when the read is also kind-scoped', async () => {
    await recordEvents([mk({ dedupeKey: 'plan-kind-1' })]);
    const plan = await explainWithoutSeqScan(
      `SELECT * FROM human_activity_events
       WHERE source = $1 AND kind = $2
       ORDER BY happened_at DESC
       LIMIT 50`,
      [SOURCE, 'message.received'],
    );
    expectOrderedIndexScan(plan, 'idx_human_activity_source_kind_happened');
  });
});

describe.skipIf(!runDb)('countEventsByHandle — SQL-aggregated handle frequency (#6026)', () => {
  it('groups and counts events per metadata.handle without loading full rows', async () => {
    await recordEvents([
      mk({ dedupeKey: 'handle-a-1', metadata: { handle: '+15551112222' } }),
      mk({ dedupeKey: 'handle-a-2', metadata: { handle: '+15551112222' } }),
      mk({ dedupeKey: 'handle-a-3', metadata: { handle: '+15551112222' } }),
      mk({ dedupeKey: 'handle-b-1', metadata: { handle: '+15553334444' } }),
      // No handle in metadata — must not surface as a spurious group.
      mk({ dedupeKey: 'handle-none' }),
    ]);
    const rows = await countEventsByHandle({ source: SOURCE, eventLimit: 2000 });
    const byHandle = new Map(rows.map((r) => [r.handle, r.eventCount]));
    expect(byHandle.get('+15551112222')).toBe(3);
    expect(byHandle.get('+15553334444')).toBe(1);
    expect(byHandle.has('')).toBe(false);
    expect(byHandle.has(undefined)).toBe(false);
    // Ranked most-frequent first.
    expect(rows[0].handle).toBe('+15551112222');
  });

  it('returns nothing for a source with no matching events', async () => {
    const rows = await countEventsByHandle({ source: `${SOURCE}-empty` });
    expect(rows).toEqual([]);
  });
});

describe.skipIf(!runDb)('eraseEvents — user-driven source erasure (#12987)', () => {
  const ERASE_SOURCE = `test-${nonce}-erase`;
  const KEEP_SOURCE = `test-${nonce}-keep`;
  afterAll(async () => {
    if (dbReady) await query('DELETE FROM human_activity_events WHERE source = ANY($1::text[])', [[ERASE_SOURCE, KEEP_SOURCE]]).catch(() => {});
  });

  it('erases only the named source, honors a range, refuses a missing source, and re-import restores', async () => {
    const rows = [
      mk({ source: ERASE_SOURCE, dedupeKey: 'e-1', happenedAt: '2026-01-01T10:00:00Z' }),
      mk({ source: ERASE_SOURCE, dedupeKey: 'e-2', happenedAt: '2026-03-01T10:00:00Z' }),
      mk({ source: ERASE_SOURCE, kind: 'message.sent', dedupeKey: 'e-3', happenedAt: '2026-01-02T10:00:00Z' }),
      mk({ source: ERASE_SOURCE, dedupeKey: 'e-4', happenedAt: '2025-12-01T10:00:00Z' }),
      mk({ source: KEEP_SOURCE, dedupeKey: 'k-1' }),
    ];
    await recordEvents(rows);

    expect(await eraseEvents({})).toEqual({ deleted: 0 });
    expect((await listSourceCounts()).find((s) => s.source === ERASE_SOURCE).eventCount).toBe(4);

    const ranged = await eraseEvents({ source: ERASE_SOURCE, kind: 'message.received', from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' });
    expect(ranged.deleted).toBe(1);
    expect(await listEvents({ source: ERASE_SOURCE })).toHaveLength(3);

    const all = await eraseEvents({ source: ERASE_SOURCE });
    expect(all.deleted).toBe(3);
    expect(await listEvents({ source: KEEP_SOURCE })).toHaveLength(1);

    const again = await recordEvents(rows.slice(0, 4));
    expect(again.recorded).toBe(4);
  });
});
