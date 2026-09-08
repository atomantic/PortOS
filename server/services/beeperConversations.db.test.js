/**
 * Postgres-backed query-plan tests for the Beeper conversation/message list
 * paths (audit cluster 06 — indexes and query plans). The unit suite
 * (`beeperConversations.test.js`) mocks the database and pins query SHAPE;
 * this file proves the shape a real planner chooses, against real indexes, on
 * a real seeded dataset — the plans proven on a small seeded database only,
 * not measured against a large mirror.
 *
 * `SET LOCAL enable_seqscan = off` (inside a throwaway transaction) is used to
 * make these plans deterministic: Postgres's planner prefers a sequential
 * scan below some row-count threshold regardless of which indexes exist, on a
 * table small enough for a test to seed and tear down quickly. Forcing the
 * planner away from a seq scan does not change what is being asserted — the
 * point is that an index CAN serve the query's ORDER BY / keyset predicate
 * with no extra Sort node, which this reveals whether or not the planner
 * would have picked it unprompted at this row count.
 *
 * `*.db.test.js` → runs ONLY via `npm run test:db` against `portos_test`
 * (registered in vitest.config.db.js's DB_TEST_INCLUDE — a `<name>.db.test.js`
 * file is not auto-globbed). Every fixture value is invented per root
 * AGENTS.md Sensitive Data & Privacy — no real handle, name, or content.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { checkHealth, ensureSchema, close, query, withTransaction } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { listConversations, listMessages } from './beeperConversations.js';

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
const runDb = requireDbOrSkip('services/beeperConversations.db.test', dbReady, skipReason);

const nonce = `beeperconv-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ACCOUNT_ID = nonce;
const NETWORK = nonce;
const CONV_COUNT = 12;
const MESSAGES_PER_CONV = 4;
const conversationIds = [];
const msgId = (convIdx, j) => `${nonce}-conv${convIdx}-msg${j}`;

/**
 * Run one read-only statement inside a throwaway transaction with
 * `enable_seqscan` disabled for that transaction alone (`SET LOCAL` resets on
 * COMMIT/ROLLBACK, so it never leaks onto another connection from the pool).
 * Returns the EXPLAIN plan as one joined string.
 */
async function explainPlan(sql, params, { analyze = false } = {}) {
  return withTransaction(async (client) => {
    await client.query('SET LOCAL enable_seqscan = off');
    const result = await client.query(`EXPLAIN ${analyze ? '(ANALYZE, TIMING OFF) ' : ''}${sql}`, params);
    return result.rows.map((row) => row['QUERY PLAN']).join('\n');
  });
}

beforeAll(async () => {
  if (!dbReady) return;

  await query(
    `INSERT INTO beeper_accounts (account_id, network, display_name, status, bridge_id)
     VALUES ($1, $2, 'Example Account', 'connected', 'example-bridge')`,
    [ACCOUNT_ID, NETWORK],
  );

  const now = Date.now();
  for (let i = 0; i < CONV_COUNT; i += 1) {
    // Conversations 0..8 carry a real last_activity, freshest first (i=0
    // newest). Conversations 9..11 have NO last_activity at all — #81's
    // fallback is `'epoch'::timestamptz`, not `created_at`, so all three tie
    // on the same sentinel ordering value and sort LAST as a group,
    // regardless of when their row was minted. `created_at` is set to a
    // point in the FUTURE here deliberately: if the ordering ever regressed
    // to the old `COALESCE(last_activity, created_at)` fallback, these three
    // would sort ahead of every real-activity conversation instead of behind
    // all of them, and the "sorts last" test below would fail loudly rather
    // than passing on a coincidence of timing.
    const nullActivity = i >= 9;
    const lastActivity = nullActivity ? null : new Date(now - i * 60_000).toISOString();
    const createdAt = nullActivity ? new Date(now + (100 + i) * 60_000).toISOString() : null;
    // eslint-disable-next-line no-await-in-loop -- deterministic seed order
    const { rows } = await query(
      `INSERT INTO beeper_conversations
         (account_id, network, source_chat_id, title, type, last_activity, created_at)
       VALUES ($1, $2, $3, $4, 'single', $5, COALESCE($6::timestamptz, NOW()))
       RETURNING id`,
      [ACCOUNT_ID, NETWORK, `${nonce}-chat-${i}`, `Example Chat ${i}`, lastActivity, createdAt],
    );
    conversationIds.push(rows[0].id);

    for (let j = 0; j < MESSAGES_PER_CONV; j += 1) {
      // Message j is more recent as j increases (msg 3 is the latest), so the
      // conversation's "last message" preview is deterministic.
      const ts = new Date(now - i * 60_000 + j * 1_000).toISOString();
      // eslint-disable-next-line no-await-in-loop -- deterministic seed order
      await query(
        `INSERT INTO beeper_messages (id, conversation_id, sender_id, body, sent_at, created_at)
         VALUES ($1, $2, 'user-1', $3, $4, $4)`,
        [msgId(i, j), conversationIds[i], `message ${j} in conversation ${i}`, ts],
      );
    }
  }

  // One real attachment, for the (message_id, idx) index-shape proof below.
  await query(
    `INSERT INTO beeper_attachments (conversation_id, message_id, idx, mxc_id, mime_type, file_name)
     VALUES ($1, $2, 0, 'mxc://example/attachment-1', 'image/png', 'example.png')`,
    [conversationIds[0], msgId(0, MESSAGES_PER_CONV - 1)],
  );

  // Eviction fixture (LENS-4): four attachments on conversationIds[1]'s
  // messages. Only A and B are eviction-eligible at all — C has no bytes, D
  // is locked — so the ORDER BY proves both the predicate and NULLS FIRST.
  await query(
    `INSERT INTO beeper_attachments
       (conversation_id, message_id, idx, mxc_id, mime_type, file_name, local_path, keep, last_viewed_at, unavailable_at)
     VALUES
       ($1, $2, 0, 'mxc://example/evict-a', 'image/png', 'a.png', 'ev/a.png', FALSE, NULL, NULL),
       ($1, $3, 0, 'mxc://example/evict-b', 'image/png', 'b.png', 'ev/b.png', FALSE, '2020-01-01T00:00:00Z', NULL),
       ($1, $4, 0, 'mxc://example/evict-c', 'image/png', 'c.png', NULL, FALSE, NULL, NULL),
       ($1, $5, 0, 'mxc://example/evict-d', 'image/png', 'd.png', 'ev/d.png', TRUE, '2019-01-01T00:00:00Z', NULL)`,
    [conversationIds[1], msgId(1, 0), msgId(1, 1), msgId(1, 2), msgId(1, 3)],
  );
});

afterAll(async () => {
  if (dbReady) {
    await query('DELETE FROM beeper_accounts WHERE account_id = $1', [ACCOUNT_ID]).catch(() => {});
    await close();
  }
});

describe.skipIf(!runDb)('beeper conversation/message list query plans (audit cluster 06)', () => {
  it('pages the conversation list on the activity-ordering index, with no separate Sort node', async () => {
    const basePlan = await explainPlan(
      `SELECT c.*, COALESCE(c.last_activity, 'epoch'::timestamptz) AS ordering_ts
         FROM beeper_conversations c
        ORDER BY COALESCE(c.last_activity, 'epoch'::timestamptz) DESC, c.id DESC
        LIMIT $1`,
      [6],
    );
    expect(basePlan).toMatch(/Index Scan.*idx_beeper_conversations_activity_epoch_keyset/s);
    expect(basePlan).not.toMatch(/\bSort\b/);

    // A keyset-paginated page (the cursor predicate) is served the same way.
    const keysetPlan = await explainPlan(
      `SELECT c.*, COALESCE(c.last_activity, 'epoch'::timestamptz) AS ordering_ts
         FROM beeper_conversations c
        WHERE (COALESCE(c.last_activity, 'epoch'::timestamptz), c.id) < ($1::timestamptz, $2::uuid)
        ORDER BY COALESCE(c.last_activity, 'epoch'::timestamptz) DESC, c.id DESC
        LIMIT $3`,
      [new Date().toISOString(), conversationIds[0], 6],
    );
    expect(keysetPlan).toMatch(/Index Scan.*idx_beeper_conversations_activity_epoch_keyset/s);
    expect(keysetPlan).not.toMatch(/\bSort\b/);
  });

  it('evaluates the last-message preview LATERAL once per PAGE id, never once per matching conversation', async () => {
    const pageIds = conversationIds.slice(0, 5); // 5 of the 12 seeded conversations
    const plan = await explainPlan(
      `SELECT ids.conversation_id, lm.id AS preview_id
         FROM unnest($1::uuid[]) AS ids(conversation_id)
         LEFT JOIN LATERAL (
           SELECT m.id
             FROM beeper_messages m
            WHERE m.conversation_id = ids.conversation_id
            ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC
            LIMIT 1
         ) lm ON TRUE`,
      [pageIds],
      { analyze: true },
    );
    expect(plan).toMatch(/idx_beeper_messages_conversation_order/);
    const loopCounts = [...plan.matchAll(/loops=(\d+)/g)].map((m) => Number(m[1]));
    expect(loopCounts.length).toBeGreaterThan(0);
    // The LATERAL sub-plan runs once per array element (the page), never once
    // per the 12 seeded conversations — a `unnest($1)` restructuring makes
    // this a property of the SQL, not of a plan the optimizer happened to
    // choose.
    expect(Math.max(...loopCounts)).toBe(pageIds.length);
  });

  it('paginates conversations by activity and attaches each page\'s own last-message preview', async () => {
    const { conversations: page1, nextCursor } = await listConversations({ network: NETWORK, limit: 5 });
    expect(page1.map((c) => c.id)).toEqual(conversationIds.slice(0, 5));
    expect(nextCursor).toBeTruthy();
    for (const conv of page1) {
      expect(conv.lastMessage).toBeTruthy();
    }
    // Conversation 0's latest message is index MESSAGES_PER_CONV-1 (the
    // preview orders newest-first within the conversation).
    expect(page1[0].lastMessage.id).toBe(msgId(0, MESSAGES_PER_CONV - 1));

    const { conversations: page2 } = await listConversations({ network: NETWORK, limit: 5, cursor: nextCursor });
    // conv5..conv8 (real, decreasing last_activity) keep a fixed, deterministic
    // order; conv9..conv11 all tie on the epoch sentinel, so only ONE of them
    // fills the page's 5th slot and which one is an implementation detail of
    // the id tiebreak, not a contract this test should pin.
    expect(page2.slice(0, 4).map((c) => c.id)).toEqual(conversationIds.slice(5, 9));
    expect(conversationIds.slice(9, 12)).toContain(page2[4].id);
  });

  // #81: an activity-less conversation sorts LAST as a group, never
  // interleaved with (or ahead of) a conversation with real activity — the
  // fix for the reported symptom (empty rows sorting above recent threads).
  it('sorts every activity-less conversation after every conversation with real activity', async () => {
    const { conversations: all } = await listConversations({ network: NETWORK, limit: CONV_COUNT });
    expect(all).toHaveLength(CONV_COUNT);
    expect(all.slice(0, 9).map((c) => c.id)).toEqual(conversationIds.slice(0, 9));
    // The last three are exactly the activity-less set, in ANY order — their
    // relative order is an id tiebreak, not a product contract.
    expect(new Set(all.slice(9).map((c) => c.id))).toEqual(new Set(conversationIds.slice(9, 12)));
    for (const conv of all.slice(9)) {
      expect(conv.lastActivity).toBeNull();
    }
  });

  it('pages a thread on the conversation+order index, without sorting the whole history', async () => {
    const targetConv = conversationIds[3];
    const basePlan = await explainPlan(
      `SELECT m.*, COALESCE(m.sent_at, m.created_at) AS ordering_ts
         FROM beeper_messages m
        WHERE m.conversation_id = $1
        ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC
        LIMIT $2`,
      [targetConv, 2],
    );
    expect(basePlan).toMatch(/Index Scan.*idx_beeper_messages_conversation_order/s);
    expect(basePlan).not.toMatch(/\bSort\b/);

    const keysetPlan = await explainPlan(
      `SELECT m.*, COALESCE(m.sent_at, m.created_at) AS ordering_ts
         FROM beeper_messages m
        WHERE m.conversation_id = $1
          AND (COALESCE(m.sent_at, m.created_at), m.id) < ($2::timestamptz, $3::text)
        ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC
        LIMIT $4`,
      [targetConv, new Date().toISOString(), msgId(3, MESSAGES_PER_CONV - 1), 2],
    );
    expect(keysetPlan).toMatch(/Index Scan.*idx_beeper_messages_conversation_order/s);
    expect(keysetPlan).not.toMatch(/\bSort\b/);

    // Functional: the real listMessages() paginates the full seeded history
    // with no gaps or repeats.
    const seen = [];
    let cursor;
    for (let guard = 0; guard < MESSAGES_PER_CONV + 1; guard += 1) {
      // eslint-disable-next-line no-await-in-loop -- exercising real pagination
      const page = await listMessages(targetConv, { limit: 2, cursor });
      seen.push(...page.messages.map((m) => m.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([
      msgId(3, 3), msgId(3, 2), msgId(3, 1), msgId(3, 0),
    ]);
  });

  it('looks up an attachment by (message_id, idx) via an index, not a table scan', async () => {
    const plan = await explainPlan(
      `SELECT * FROM beeper_attachments WHERE message_id = $1 AND idx = $2`,
      [msgId(0, MESSAGES_PER_CONV - 1), 0],
    );
    expect(plan).toMatch(/Index Scan.*idx_beeper_attachments_message/s);
    expect(plan).not.toMatch(/Seq Scan/);
  });

  it('picks the never-viewed evictable attachment first (NULLS FIRST), with no separate Sort node', async () => {
    // Verbatim `evictToBudget()` query shape — no `conversation_id` filter:
    // the sweep picks its single best candidate across the WHOLE mirror, not
    // per conversation. Adding a `conversation_id` predicate here (as an
    // earlier draft of this test did) changes the plan the assertion is
    // supposed to prove: with an equality filter this selective, the planner
    // reaches for the PK (which leads with `conversation_id`) instead of the
    // new partial index, which is a real answer to a different question than
    // the one `evictToBudget()` actually asks.
    const candidateSql = `
      SELECT message_id, idx, mxc_id, local_path, byte_length
        FROM beeper_attachments
       WHERE local_path IS NOT NULL AND keep = FALSE
         AND unavailable_at IS NULL AND mxc_id IS NOT NULL
       ORDER BY last_viewed_at ASC NULLS FIRST, fetched_at ASC NULLS FIRST
       LIMIT 1`;
    const { rows } = await query(candidateSql);
    // Row A (never viewed) outranks row B (viewed in 2020) under NULLS FIRST;
    // row C (no bytes) and row D (kept) are excluded by the predicate. No
    // other seeded attachment (the lone conv0 fixture) has `local_path` set,
    // so A is the single global candidate.
    expect(rows[0].message_id).toBe(msgId(1, 0));

    const plan = await explainPlan(candidateSql);
    expect(plan).toMatch(/Index Scan.*idx_beeper_attachments_eviction_candidates/s);
    expect(plan).not.toMatch(/\bSort\b/);
  });
});
