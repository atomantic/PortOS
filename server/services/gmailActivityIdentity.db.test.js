/**
 * Gmail activity identity across live sync and Takeout import (#15308): both
 * paths key a message on its RFC-822 Message-ID, so one email is one row in
 * either order, and rows the live sync wrote under the legacy per-account key
 * are re-keyed atomically on the next sync.
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
import { importGmailMbox } from './gmailMboxImport.js';
import { deleteEvents } from './humanActivity.js';

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

async function importMbox(name) {
  const dir = await mkdtemp(path.join(tmpdir(), 'portos-gmail-identity-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'All mail.mbox');
  await writeFile(file, [
    'From 1234@xxx Sat Jul 04 10:00:00 +0000 2026',
    `Message-ID: <${messageId(name)}>`,
    'Date: Sat, 04 Jul 2026 10:00:00 +0000',
    'From: Friend <friend@example.com>',
    'To: me@example.com',
    `Subject: Hello ${name}`,
    'X-Gmail-Labels: Inbox',
    '',
    'body',
    '',
  ].join('\n'));
  return importGmailMbox({ path: file });
}

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

  it('still erases a deleted account\'s re-keyed live rows', async () => {
    const acct = account('erase');
    await recordMessageActivity(acct, [liveMessage('erase')]);
    expect(await deleteEvents({ accountId: acct.id })).toEqual({ deleted: 1 });
    expect(await rowsFor('erase', acct)).toEqual([]);
  });
});
