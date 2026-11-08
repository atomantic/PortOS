/**
 * Gmail activity identity across live sync and Takeout import (#15308): both
 * paths key a message on its RFC-822 Message-ID, so one email is one row in
 * either order, and rows the live sync wrote under the legacy per-account key
 * are re-keyed atomically on the next sync. A Takeout import also retires a
 * legacy row live sync can no longer see, when exactly one matches (#15320).
 *
 * `*.db.test.js` → runs ONLY via `npm run test:db` against `portos_test`. Every
 * row carries a per-run nonce and is removed in afterAll.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkHealth, ensureSchema, close, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';

vi.mock('./userTimezone.js', () => ({ getUserTimezone: async () => 'UTC' }));

import { recordMessageActivity } from './messageSync.js';
import { importGmailMbox, parseMboxText } from './gmailMboxImport.js';
import { deleteEvents, recordEvents } from './humanActivity.js';
import { gmailConversationThreadKey } from '../lib/gmailThreadKey.js';

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
const runDb = requireDbOrSkip('services/gmailActivityIdentity.db.test', dbReady, skipReason);

const nonce = `gai${Date.now()}`;
const tempDirs = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  if (dbReady) {
    await query(
      `DELETE FROM human_activity_events WHERE source = 'gmail' AND (dedupe_key LIKE $1 OR account_id LIKE $2)`,
      [`gmail:${nonce}-%`, `${nonce}-%`],
    );
    await close();
  }
});

const account = (name) => ({ id: `${nonce}-${name}`, type: 'gmail', email: 'me@example.com' });
const messageId = (name) => `${nonce}-${name}@example.com`;
const liveMessage = (name, over = {}) => ({
  externalId: `api-gmail-${nonce}-${name}`,
  apiId: `${nonce}-${name}`,
  rfcMessageId: messageId(name),
  date: '2026-07-04T10:00:00.000Z',
  from: { name: 'Friend', email: 'friend@example.com' },
  to: ['me@example.com'],
  subject: `Hello ${name}`,
  labels: ['INBOX'],
  ...over,
});

// One Takeout message. `thrid` is the decimal X-GM-THRID; omitted, the message
// carries none (as in the #15308 cases, which predate thread matching).
const mboxMessage = (name, { thrid, date = 'Sat, 04 Jul 2026 10:00:00 +0000', subject = `Hello ${name}` } = {}) => [
  'From 1234@xxx Sat Jul 04 10:00:00 +0000 2026',
  `Message-ID: <${messageId(name)}>`,
  `Date: ${date}`,
  'From: Friend <friend@example.com>',
  'To: me@example.com',
  `Subject: ${subject}`,
  'X-Gmail-Labels: Inbox',
  ...(thrid ? [`X-GM-THRID: ${thrid}`] : []),
  '',
  'body',
  '',
].join('\n');

async function importMboxText(text) {
  const dir = await mkdtemp(path.join(tmpdir(), 'portos-gmail-identity-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'All mail.mbox');
  await writeFile(file, text);
  return importGmailMbox({ path: file });
}

const importMbox = (name, opts) => importMboxText(mboxMessage(name, opts));

// Every row either path could have written for this message.
async function rowsFor(name, acct) {
  const { rows } = await query(
    `SELECT dedupe_key, account_id FROM human_activity_events
      WHERE source = 'gmail' AND dedupe_key = ANY($1::text[]) ORDER BY dedupe_key`,
    [[`gmail:${messageId(name)}`, `msg:${acct.id}:api-gmail-${nonce}-${name}`]],
  );
  return rows;
}

describe.skipIf(!runDb)('Gmail activity identity (#15308)', () => {
  it('keeps one row when the live sync records a message before the Takeout import', async () => {
    const acct = account('live-first');
    await recordMessageActivity(acct, [liveMessage('live-first')]);
    expect((await importMbox('live-first')).recorded).toBe(0);
    expect(await rowsFor('live-first', acct)).toEqual([{ dedupe_key: `gmail:${messageId('live-first')}`, account_id: acct.id }]);
  });

  it('keeps one row when the Takeout import precedes the live sync', async () => {
    const acct = account('mbox-first');
    expect((await importMbox('mbox-first')).recorded).toBe(1);
    expect((await recordMessageActivity(acct, [liveMessage('mbox-first')])).recorded).toBe(0);
    expect(await rowsFor('mbox-first', acct)).toEqual([{ dedupe_key: `gmail:${messageId('mbox-first')}`, account_id: null }]);
  });

  it('re-keys a legacy live row on the next sync when no import row exists', async () => {
    const acct = account('legacy');
    // Before the fix the cache held no Message-ID, so the row took the msg: key.
    await recordMessageActivity(acct, [liveMessage('legacy', { rfcMessageId: undefined })]);
    expect(await rowsFor('legacy', acct)).toEqual([{ dedupe_key: `msg:${acct.id}:api-gmail-${nonce}-legacy`, account_id: acct.id }]);

    await recordMessageActivity(acct, [liveMessage('legacy')]);
    expect(await rowsFor('legacy', acct)).toEqual([{ dedupe_key: `gmail:${messageId('legacy')}`, account_id: acct.id }]);
  });

  it('drops the legacy duplicate on the next sync when an import row already holds the key', async () => {
    const acct = account('legacy-dup');
    await recordMessageActivity(acct, [liveMessage('legacy-dup', { rfcMessageId: undefined })]);
    await importMbox('legacy-dup');
    expect(await rowsFor('legacy-dup', acct)).toHaveLength(2);

    await recordMessageActivity(acct, [liveMessage('legacy-dup')]);
    expect(await rowsFor('legacy-dup', acct)).toEqual([{ dedupe_key: `gmail:${messageId('legacy-dup')}`, account_id: null }]);
  });

  it('records a message with no Message-ID once, under the legacy key', async () => {
    const acct = account('no-id');
    const message = liveMessage('no-id', { rfcMessageId: '' });
    expect((await recordMessageActivity(acct, [message])).recorded).toBe(1);
    expect((await recordMessageActivity(acct, [message])).recorded).toBe(0);
    expect(await rowsFor('no-id', acct)).toEqual([{ dedupe_key: `msg:${acct.id}:api-gmail-${nonce}-no-id`, account_id: acct.id }]);
  });

  it('keeps the legacy row when the re-keyed insert fails, because the delete and insert share a transaction', async () => {
    const acct = account('atomic');
    await recordMessageActivity(acct, [liveMessage('atomic', { rfcMessageId: undefined })]);
    // A valid JS date before PostgreSQL's timestamptz range fails the batch insert.
    const unstorable = liveMessage('atomic-bad', { date: '-010000-01-01T00:00:00.000Z' });

    await expect(recordMessageActivity(acct, [liveMessage('atomic'), unstorable])).rejects.toThrow();
    expect(await rowsFor('atomic', acct)).toEqual([{ dedupe_key: `msg:${acct.id}:api-gmail-${nonce}-atomic`, account_id: acct.id }]);
  });

  it('keeps a second mailbox\'s copy of one email on its own row, so erasing the first account keeps it', async () => {
    const first = account('shared-a');
    const second = account('shared-b');
    const secondLegacyKey = `msg:${second.id}:api-gmail-${nonce}-shared`;
    // The second account recorded the email before the upgrade.
    await recordMessageActivity(second, [liveMessage('shared', { rfcMessageId: undefined })]);
    await recordMessageActivity(first, [liveMessage('shared')]);

    await recordMessageActivity(second, [liveMessage('shared')]);
    const { rows } = await query(
      `SELECT dedupe_key, account_id FROM human_activity_events WHERE source = 'gmail' AND account_id = ANY($1::text[]) ORDER BY account_id`,
      [[first.id, second.id]],
    );
    expect(rows).toEqual([
      { dedupe_key: `gmail:${messageId('shared')}`, account_id: first.id },
      { dedupe_key: secondLegacyKey, account_id: second.id },
    ]);

    await deleteEvents({ accountId: first.id });
    const { rows: left } = await query(
      `SELECT dedupe_key FROM human_activity_events WHERE source = 'gmail' AND account_id = ANY($1::text[])`,
      [[first.id, second.id]],
    );
    expect(left).toEqual([{ dedupe_key: secondLegacyKey }]);
  });

  it('commits each 500-event chunk on its own, so a failing chunk does not discard the others', async () => {
    const acct = account('chunks');
    const good = Array.from({ length: 500 }, (_, i) => liveMessage(`chunk-${i}`));
    const unstorable = liveMessage('chunk-bad', { date: '-010000-01-01T00:00:00.000Z' });

    await expect(recordMessageActivity(acct, [...good, unstorable])).rejects.toThrow();
    const { rows } = await query(`SELECT count(*)::int AS n FROM human_activity_events WHERE source = 'gmail' AND account_id = $1`, [acct.id]);
    expect(rows[0].n).toBe(500);
  });

  it('still erases a deleted account\'s re-keyed live rows', async () => {
    const acct = account('erase');
    await recordMessageActivity(acct, [liveMessage('erase')]);
    expect(await deleteEvents({ accountId: acct.id })).toEqual({ deleted: 1 });
    expect(await rowsFor('erase', acct)).toEqual([]);
  });
});

// A unique 64-bit X-GM-THRID per run (past 2^53), and the hex Gmail API thread
// id live sync would have seen for it.
let threadSeq = 0n;
const nextThread = () => {
  threadSeq += 1n;
  const thrid = BigInt(Date.now()) * 1_000_000n + threadSeq;
  return { thrid: thrid.toString(), threadKey: gmailConversationThreadKey(thrid.toString(16)) };
};

// The row live sync wrote before #15308: a per-account key, no Message-ID, the
// Gmail receive time (a little after the header Date).
const recordLegacy = (acct, name, threadKey, over = {}) => recordMessageActivity(acct, [liveMessage(name, {
  rfcMessageId: undefined, threadId: threadKey, date: '2026-07-04T10:00:40.000Z', ...over,
})]);

async function gmailRowsForAccountOrIds(acct, names) {
  const { rows } = await query(
    `SELECT dedupe_key, account_id FROM human_activity_events
      WHERE source = 'gmail' AND (account_id = $1 OR dedupe_key = ANY($2::text[])) ORDER BY dedupe_key`,
    [acct.id, names.map((n) => `gmail:${messageId(n)}`)],
  );
  return rows;
}

describe.skipIf(!runDb)('Takeout import retires pre-#15308 live Gmail rows (#15320)', () => {
  it('leaves one row for an email live sync recorded before #15308, and re-importing stays a no-op', async () => {
    const acct = account('retire');
    const { thrid, threadKey } = nextThread();
    await recordLegacy(acct, 'retire', threadKey);

    expect((await importMbox('retire', { thrid })).recorded).toBe(1);
    expect(await gmailRowsForAccountOrIds(acct, ['retire'])).toEqual([{ dedupe_key: `gmail:${messageId('retire')}`, account_id: null }]);

    expect((await importMbox('retire', { thrid })).recorded).toBe(0);
    expect(await gmailRowsForAccountOrIds(acct, ['retire'])).toEqual([{ dedupe_key: `gmail:${messageId('retire')}`, account_id: null }]);
  });

  it('deletes nothing when two legacy rows fit the imported email', async () => {
    const acct = account('ambiguous');
    const { thrid, threadKey } = nextThread();
    // Two distinct emails, same thread, sender and subject, minutes apart.
    await recordLegacy(acct, 'ambiguous-a', threadKey, { subject: 'Hello ambiguous' });
    await recordLegacy(acct, 'ambiguous-b', threadKey, { subject: 'Hello ambiguous', date: '2026-07-04T10:03:00.000Z' });

    await importMbox('ambiguous-a', { thrid, subject: 'Hello ambiguous' });
    expect(await gmailRowsForAccountOrIds(acct, ['ambiguous-a'])).toEqual([
      { dedupe_key: `gmail:${messageId('ambiguous-a')}`, account_id: null },
      { dedupe_key: `msg:${acct.id}:api-gmail-${nonce}-ambiguous-a`, account_id: acct.id },
      { dedupe_key: `msg:${acct.id}:api-gmail-${nonce}-ambiguous-b`, account_id: acct.id },
    ]);
  });

  it('keeps a legacy row whose only lookalike is a sibling email in the same import', async () => {
    const acct = account('sibling');
    const { thrid, threadKey } = nextThread();
    await recordLegacy(acct, 'sibling-a', threadKey, { subject: 'Hello sibling' });

    await importMboxText([
      mboxMessage('sibling-a', { thrid, subject: 'Hello sibling' }),
      mboxMessage('sibling-b', { thrid, subject: 'Hello sibling', date: 'Sat, 04 Jul 2026 10:02:00 +0000' }),
    ].join('\n'));
    // Either imported email could be the legacy one, so it stays.
    expect(await gmailRowsForAccountOrIds(acct, ['sibling-a', 'sibling-b'])).toHaveLength(3);
  });

  it('keeps the legacy row when the import chunk fails, because retiring shares its transaction', async () => {
    const acct = account('retire-atomic');
    const { thrid, threadKey } = nextThread();
    await recordLegacy(acct, 'retire-atomic', threadKey);
    const [candidate] = parseMboxText(mboxMessage('retire-atomic', { thrid }));
    // A valid JS date before PostgreSQL's timestamptz range fails the chunk.
    const unstorable = { ...candidate, dedupeKey: `gmail:${messageId('retire-atomic-bad')}`, happenedAt: '-010000-01-01T00:00:00.000Z' };

    await expect(recordEvents([candidate, unstorable])).rejects.toThrow();
    expect(await gmailRowsForAccountOrIds(acct, ['retire-atomic'])).toEqual([
      { dedupe_key: `msg:${acct.id}:api-gmail-${nonce}-retire-atomic`, account_id: acct.id },
    ]);
  });
});
