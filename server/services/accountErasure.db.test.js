/**
 * Postgres-backed proof that deleting a mail/calendar account or purging an
 * iMessage chat erases the subjects, previews and attendees sync copied into
 * the Timeline and Tribe, including the `record_audit` snapshots (#12984).
 *
 * `*.db.test.js` → runs ONLY via `npm run test:db` against `portos_test`.
 * Fixtures use placeholder data and a per-run nonce; assertions are scoped to
 * this run's own ids.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { checkHealth, close, ensureSchema, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import * as humanActivity from './humanActivity.js';
import * as tribe from './tribe.js';
import { purgeConversation, encodeChatKey } from './imessageManage.js';

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
const runDb = requireDbOrSkip('services/accountErasure.db.test', dbReady, skipReason);

const nonce = `erase${Date.now()}`;
const MAIL_A = `mail-a_${nonce}`; // underscore: a LIKE metacharacter that must not widen the match
const MAIL_B = `mailXa_${nonce}`;
const CAL_A = `cal-a-${nonce}`;
const CAL_B = `cal-b-${nonce}`;
const CHAT_A = `chat-a;${nonce}`;
const CHAT_B = `chat-b;${nonce}`;
const SOURCES = [`mail-${nonce}`, `calendar-${nonce}`];
const IMESSAGE = 'imessage'; // purgeConversation is scoped to the real source; chat guids carry the nonce
const personIds = [];

afterAll(async () => {
  if (!dbReady) return;
  await query('DELETE FROM human_activity_events WHERE source = ANY($1::text[]) OR metadata->>\'chatGuid\' = ANY($2::text[])', [SOURCES, [CHAT_A, CHAT_B]]).catch(() => {});
  if (personIds.length) {
    await query('DELETE FROM tribe_people WHERE id = ANY($1::uuid[])', [personIds]).catch(() => {});
    await query(
      `DELETE FROM record_audit WHERE table_name = 'tribe_touchpoints' AND row_snapshot->>'person_id' = ANY($1::text[])`,
      [personIds],
    ).catch(() => {});
  }
  await close();
});

const count = async (sql, params) => Number((await query(sql, params)).rows[0].n);
const touchpointCount = (where, params) => count(`SELECT COUNT(*) AS n FROM tribe_touchpoints WHERE person_id = $1 AND ${where}`, [personIds[0], ...params]);

async function seed() {
  const person = await tribe.createPerson({ name: `Example Person ${nonce}`, emails: [`p-${nonce}@example.com`] });
  personIds.push(person.id);
  const tp = (data) => tribe.autoCreateTouchpoint(person.id, { happenedAt: '2026-07-04T15:00:00Z', channel: 'x', summary: 'Example subject line', ...data });
  await tp({ source: 'message', dedupeKey: `msg:${MAIL_A}:t1:2026-07-04` });
  await tp({ source: 'message', dedupeKey: `msg:${MAIL_B}:t1:2026-07-04` });
  await tp({ source: 'calendar', calendarAccountId: CAL_A, calendarEventId: 'e1', dedupeKey: `cal:${CAL_A}:e1` });
  await tp({ source: 'calendar', calendarAccountId: CAL_B, calendarEventId: 'e1', dedupeKey: `cal:${CAL_B}:e1` });
  await tp({ source: 'imessage', dedupeKey: `imsg:${CHAT_A}:2026-07-04` });
  await tp({ source: 'imessage', dedupeKey: `imsg:${CHAT_B}:2026-07-04` });
  const ev = (source, accountId, key, metadata = {}) => ({
    source, accountId, kind: 'message.received', happenedAt: '2026-07-04T15:00:00Z', dedupeKey: key, title: 'Example subject', metadata,
  });
  await humanActivity.recordEvents([
    ev(SOURCES[0], MAIL_A, 'a1'), ev(SOURCES[0], MAIL_B, 'b1'),
    ev(SOURCES[1], CAL_A, 'a2'), ev(SOURCES[1], CAL_B, 'b2'),
    ev(IMESSAGE, null, `i1-${nonce}`, { chatGuid: CHAT_A }), ev(IMESSAGE, null, `i2-${nonce}`, { chatGuid: CHAT_B }),
  ]);
}

const auditRows = () => count(
  `SELECT COUNT(*) AS n FROM record_audit WHERE table_name = 'tribe_touchpoints' AND row_snapshot->>'person_id' = $1
     AND (row_snapshot->>'dedupe_key' LIKE ANY($2::text[]))`,
  [personIds[0], [`msg:${MAIL_A}:%`, `cal:${CAL_A}:%`, `imsg:${CHAT_A}:%`]],
);
const events = (accountId) => count('SELECT COUNT(*) AS n FROM human_activity_events WHERE account_id = $1', [accountId]);

describe.skipIf(!runDb)('derived-data erasure (#12984)', () => {
  it('mail account delete removes its events, message touchpoints and audit snapshots, sparing other accounts', async () => {
    await seed();
    await humanActivity.deleteEvents({ accountId: MAIL_A });
    const result = await tribe.deleteAutoTouchpoints({ accountId: MAIL_A });
    expect(result.touchpoints).toBe(1);
    expect(await events(MAIL_A)).toBe(0);
    expect(await events(MAIL_B)).toBe(1);
    expect(await touchpointCount(`dedupe_key LIKE 'msg:%'`, [])).toBe(1); // MAIL_B survives the `_` wildcard
    expect(await touchpointCount(`dedupe_key = $2`, [`msg:${MAIL_B}:t1:2026-07-04`])).toBe(1);
    expect(await count(
      `SELECT COUNT(*) AS n FROM record_audit WHERE table_name = 'tribe_touchpoints' AND row_snapshot->>'dedupe_key' LIKE $1`,
      [`msg:${MAIL_A}:%`],
    )).toBe(0);
  });

  it('calendar account delete removes its events and touchpoints, sparing other accounts', async () => {
    await humanActivity.deleteEvents({ accountId: CAL_A });
    await tribe.deleteAutoTouchpoints({ accountId: CAL_A });
    expect(await events(CAL_A)).toBe(0);
    expect(await events(CAL_B)).toBe(1);
    expect(await touchpointCount(`calendar_account_id = $2`, [CAL_A])).toBe(0);
    expect(await touchpointCount(`calendar_account_id = $2`, [CAL_B])).toBe(1);
  });

  it('iMessage purge removes that chat\'s touchpoints and snapshots only', async () => {
    await purgeConversation(encodeChatKey(CHAT_A));
    expect(await touchpointCount(`dedupe_key = $2`, [`imsg:${CHAT_A}:2026-07-04`])).toBe(0);
    expect(await touchpointCount(`dedupe_key = $2`, [`imsg:${CHAT_B}:2026-07-04`])).toBe(1);
    const chatEvents = (guid) => count(`SELECT COUNT(*) AS n FROM human_activity_events WHERE metadata->>'chatGuid' = $1`, [guid]);
    expect(await chatEvents(CHAT_A)).toBe(0);
    expect(await chatEvents(CHAT_B)).toBe(1);
    expect(await auditRows()).toBe(0);
  });

  it('empty selectors delete nothing', async () => {
    expect(await humanActivity.deleteEvents({})).toEqual({ deleted: 0 });
    expect(await humanActivity.deleteEvents({ source: SOURCES[0] })).toEqual({ deleted: 0 });
    expect(await tribe.deleteAutoTouchpoints({})).toEqual({ touchpoints: 0, auditRows: 0 });
    expect(await events(MAIL_B)).toBe(1);
  });
});
