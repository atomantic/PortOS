/**
 * Postgres-backed tests for the Beeper ingestion sweep (#32). The unit suite
 * (`beeperSync.test.js`) mocks the database, so the SQL itself — column names,
 * the `ON CONFLICT` targets, the FK ordering inside the transaction, and the
 * COALESCE guards that keep a body from being discarded by an unsend — is only
 * ever executed here, against real constraints.
 *
 * Covers:
 *   - one sweep writes account, conversation, message, attachment and cursor
 *     rows with the expected shapes;
 *   - a re-observed message keeps its body and gains `unsent_at` (the source
 *     tombstone is never a removal, #7/#13);
 *   - the stored watermark stops the second sweep from re-paging an unchanged
 *     chat;
 *   - a sweep whose conversation is purged mid-flight commits no cursor row, so
 *     a purge can never be silently undone by a resurrected watermark;
 *   - a stored `is_sender` TRUE survives a later sweep whose payload omits the
 *     optional field.
 *
 * `*.db.test.js` → runs ONLY via `npm run test:db` against `portos_test`.
 * Every fixture uses placeholder names/handles per
 * root AGENTS.md Sensitive Data & Privacy — no real handle, name, or content.
 *
 * The credential path is the ONLY mocked part: the sweep resolves its token
 * through `beeperClient.resolveBeeperConfig`, which since #31 reads the
 * AES-256-GCM vault (`beeperCredentials.resolveBeeperToken`) with the legacy
 * plaintext `settings.beeper.token` as a read-only fallback. Both are stubbed
 * here so this suite never depends on whether `portos_test` happens to hold a
 * credential row, or on whether the vault key that encrypted it is still the
 * current one. Every other module in the graph — the Beeper client,
 * `beeperTribe`, `tribe`, `db` — is real.
 */
import {
  describe, it, expect, beforeAll, afterAll, vi,
} from 'vitest';
import pg from 'pg';
import { checkHealth, ensureSchema, close, query, withTransaction } from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';

vi.mock('../settings.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getSettings: async () => ({ beeper: { baseUrl: 'http://127.0.0.1:23373', enabled: true } }),
  };
});

vi.mock('./beeperCredentials.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveBeeperToken: async () => ({
      token: 'db-test-token', tokenExpiresAt: null, tokenSource: 'pasted',
    }),
  };
});

vi.mock('../instanceFeatures.js', () => ({ isInstanceFeatureEnabled: async () => true }));
const { runBeeperSweep, reconcileBeeperEvent, upsertMirroredMessage, normalizeMessageRow, normalizeAttachmentRows } = await import('./beeperSync.js');
const { listMessages: readThread, purgeConversation } = await import('./beeperConversations.js');
const beeperTribe = await import('./beeperTribe.js');
const { createPerson } = await import('../tribe.js');
const { linkIdentity } = await import('../tribeIdentities.js');
const { beeperSocketEvents } = await import('./beeperSocketEvents.js');

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
const runDb = requireDbOrSkip('services/beeperSync.db.test', dbReady, skipReason);

const nonce = `beepersync-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ACCOUNT_ID = nonce;
const OTHER_ACCOUNT_ID = `${nonce}-other`;
const CHAT_ID = `${nonce}-chat`;
const MESSAGE_ID = `${nonce}-msg`;

function jsonResponse(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

const ACCOUNTS = [{ accountID: ACCOUNT_ID, network: 'Example Net', user: { id: 'u-self', fullName: 'Example Owner' } }];
const BRIDGES = { items: [{ id: 'example-bridge', network: 'examplenet', status: 'connected', accounts: [{ accountID: ACCOUNT_ID }] }] };

function chatFixture(lastActivity) {
  return {
    id: CHAT_ID,
    accountID: ACCOUNT_ID,
    network: 'Example Net',
    title: 'Example Conversation',
    type: 'single',
    unreadCount: 2,
    isPinned: true,
    lastActivity,
    participants: {
      hasMore: false,
      total: 1,
      items: [{ id: `${nonce}-user`, fullName: 'Alice Example', username: 'alice_example' }],
    },
  };
}

function messageFixture({ isDeleted = false, text = 'Example message body' } = {}) {
  return {
    id: MESSAGE_ID,
    chatID: CHAT_ID,
    accountID: ACCOUNT_ID,
    senderID: `${nonce}-user`,
    senderName: 'Alice Example',
    timestamp: '2026-09-02T10:00:00.000Z',
    sortKey: '000000001',
    text: isDeleted ? '' : text,
    isDeleted: isDeleted || undefined,
    attachments: isDeleted ? [] : [{
      type: 'img',
      id: 'mxc://example.invalid/attachment-1',
      srcURL: '/tmp/decaying-local-path.png',
      mimeType: 'image/png',
      fileName: 'example.png',
      fileSize: 4096,
      size: { width: 640, height: 480 },
    }],
  };
}

/** Route a stubbed `fetch` for one sweep. Returns the recorded request URLs. */
function installFetch({ chats, messages }) {
  const urls = [];
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    urls.push(url);
    const { pathname } = new URL(url);
    if (pathname === '/v1/accounts') return jsonResponse(ACCOUNTS);
    if (pathname === '/v1/bridges') return jsonResponse(BRIDGES);
    if (pathname === '/v1/chats') return jsonResponse(chats);
    if (/\/messages$/.test(pathname)) return jsonResponse(messages);
    if (/\/messages\//.test(pathname)) {
      const message = messages.items?.find((item) => pathname.endsWith('/' + encodeURIComponent(item.id)));
      if (message) return jsonResponse(message);
      return { ok: false, status: 404, text: async () => '{}' };
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
  return urls;
}

/** Record SQL strings sent through pg.Client.prototype.query while active. */
function captureSqlQueries() {
  const sqlLog = [];
  const original = pg.Client.prototype.query;
  const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function spyQuery(...args) {
    const config = args[0];
    const text = typeof config === 'string' ? config : config?.text || '';
    if (text) sqlLog.push(text);
    return original.apply(this, args);
  });
  return { sqlLog, restore: () => spy.mockRestore() };
}

beforeAll(async () => {
  if (!dbReady) return;
  await query('DELETE FROM beeper_accounts WHERE account_id = ANY($1::text[])', [[ACCOUNT_ID, OTHER_ACCOUNT_ID]]).catch(() => {});
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (dbReady) {
    // Cascades through conversations / messages / attachments / participants /
    // cursors.
    await query('DELETE FROM beeper_accounts WHERE account_id = ANY($1::text[])', [[ACCOUNT_ID, OTHER_ACCOUNT_ID]]).catch(() => {});
    await query('DELETE FROM tribe_people WHERE name = $1', ['Alice Example']).catch(() => {});
    await close();
  }
});

describe.skipIf(!runDb)('beeperSync against Postgres', () => {
  it('persists account continuation across sweeps and resets it at end of list', async () => {
    const visits = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/v1/accounts') return jsonResponse(ACCOUNTS);
      if (parsed.pathname === '/v1/bridges') return jsonResponse(BRIDGES);
      if (parsed.pathname === '/v1/chats') {
        const page = Number(parsed.searchParams.get('cursor') || 1);
        visits.push(page);
        return jsonResponse({ items: [], hasMore: page < 21, oldestCursor: String(page + 1) });
      }
      throw new Error('Unexpected endpoint');
    }));
    expect(await runBeeperSweep()).toMatchObject({ unfinishedAccounts: 1, enumerationComplete: false });
    const checkpoint = await query('SELECT chat_cursor FROM beeper_accounts WHERE account_id = $1', [ACCOUNT_ID]);
    expect(checkpoint.rows[0].chat_cursor).toBe('21');
    expect(await runBeeperSweep()).toMatchObject({ unfinishedAccounts: 0, enumerationComplete: true });
    expect(visits.slice(20)).toEqual([1, 21]);
    const completed = await query('SELECT chat_cursor FROM beeper_accounts WHERE account_id = $1', [ACCOUNT_ID]);
    expect(completed.rows[0].chat_cursor).toBeNull();
  });

  it('writes account, conversation, message, attachment and cursor rows in one sweep', async () => {
    installFetch({
      chats: { items: [chatFixture('2026-09-02T10:00:00.000Z')], hasMore: false },
      messages: { items: [messageFixture()], hasMore: false, newestCursor: 'cursor-after-first-sweep' },
    });

    const result = await runBeeperSweep({ reason: 'db-test' });
    expect(result).toMatchObject({ skipped: false, accounts: 1, chats: 1, messages: 1, failedAccounts: 0 });

    const account = await query('SELECT * FROM beeper_accounts WHERE account_id = $1', [ACCOUNT_ID]);
    expect(account.rows[0]).toMatchObject({
      network: 'Example Net', display_name: 'Example Owner', status: 'connected', bridge_id: 'example-bridge',
    });
    expect(account.rows[0].last_seen_at).toBeTruthy();

    const conversation = await query(
      'SELECT * FROM beeper_conversations WHERE account_id = $1 AND source_chat_id = $2',
      [ACCOUNT_ID, CHAT_ID],
    );
    expect(conversation.rows[0]).toMatchObject({
      title: 'Example Conversation', type: 'single', is_group: false, is_pinned: true, unread_count: 2,
    });

    const message = await query('SELECT * FROM beeper_messages WHERE id = $1', [MESSAGE_ID]);
    expect(message.rows[0]).toMatchObject({
      conversation_id: conversation.rows[0].id,
      sender_id: `${nonce}-user`,
      body: 'Example message body',
      sort_key: '000000001',
      unsent_at: null,
    });

    const attachment = await query('SELECT * FROM beeper_attachments WHERE message_id = $1', [MESSAGE_ID]);
    expect(attachment.rows).toHaveLength(1);
    expect(attachment.rows[0]).toMatchObject({
      idx: 0, mxc_id: 'mxc://example.invalid/attachment-1', mime_type: 'image/png',
      file_name: 'example.png', width: 640, height: 480,
    });
    expect(String(attachment.rows[0].byte_length)).toBe('4096');
    // srcURL carries the spec's own "may be temporary" warning and has no
    // column here at all — nothing in the row may echo it.
    expect(JSON.stringify(attachment.rows[0])).not.toContain('decaying-local-path');

    const cursor = await query(
      'SELECT * FROM beeper_sync_cursors WHERE account_id = $1 AND chat_id = $2',
      [ACCOUNT_ID, CHAT_ID],
    );
    expect(cursor.rows[0].cursor).toBe('cursor-after-first-sweep');
    expect(new Date(cursor.rows[0].last_activity).toISOString()).toBe('2026-09-02T10:00:00.000Z');

    const participant = await query(
      'SELECT * FROM beeper_participants WHERE conversation_id = $1 AND source_user_id = $2',
      [conversation.rows[0].id, `${nonce}-user`],
    );
    expect(participant.rows[0]).toMatchObject({ display_name: 'Alice Example', handle: 'alice_example' });
  });

  it('repairs behind-cursor edits and missed events, preserving archive data and rejecting stale writers', async () => {
    // Regression: neither forward pagination nor reader refetch could repair message 50.
    const conversation = await query('SELECT conversation_id FROM beeper_messages WHERE id = $1', [MESSAGE_ID]);
    const conversationId = conversation.rows[0].conversation_id;
    const originalCursor = await query('SELECT cursor FROM beeper_sync_cursors WHERE account_id = $1', [ACCOUNT_ID]);
    let upstream = { ...messageFixture(), text: 'Corrected example', editedTimestamp: '2026-09-04T12:00:00Z' };
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (new URL(url).pathname.endsWith('/messages/' + encodeURIComponent(MESSAGE_ID))) return jsonResponse(upstream);
      return originalFetch(url);
    }));
    const persistedFrames = [];
    const listener = (frame) => { if (frame.kind === 'beeper-reconciled') persistedFrames.push(frame); };
    beeperSocketEvents.on('invalidate', listener);
    try {
      await reconcileBeeperEvent({ kind: 'message.upserted', chatID: CHAT_ID, ids: [MESSAGE_ID] });
      expect((await readThread(conversationId)).messages[0]).toMatchObject({
        body: 'Corrected example', editedAt: '2026-09-04T12:00:00.000Z',
      });
      expect(persistedFrames).toHaveLength(1);
      // Both an older source version and an older same-version observation lose,
      // even if a stale sweep/outbox transaction commits after the event.
      await withTransaction(async (client) => {
        await upsertMirroredMessage(client, conversationId,
          normalizeMessageRow(messageFixture({ text: 'Stale example' }), '2099-01-01T00:00:00Z'));
        await upsertMirroredMessage(client, conversationId,
          normalizeMessageRow({ ...upstream, text: 'Older concurrent example' }, '2020-01-01T00:00:00Z'));
        await upsertMirroredMessage(client, conversationId,
          normalizeMessageRow(messageFixture({ isDeleted: true }), '2020-01-01T00:00:00Z'));
      });
      expect((await readThread(conversationId)).messages[0].body).toBe('Corrected example');

      // Drop the event. An unchanged chat still participates in the independent
      // stored-ID rotation. Persisted checkpoint is the only progress state.
      upstream = { ...upstream, text: 'Missed event correction', editedTimestamp: '2026-09-05T12:00:00Z' };
      await runBeeperSweep({ reason: 'db-test' });
      expect((await readThread(conversationId)).messages[0].body).toBe('Missed event correction');
      const progress = await query('SELECT message_id FROM beeper_reconcile_cursors WHERE account_id = $1', [ACCOUNT_ID]);
      expect(progress.rows[0].message_id).toBe(MESSAGE_ID);
      expect((await query('SELECT cursor FROM beeper_sync_cursors WHERE account_id = $1', [ACCOUNT_ID])).rows).toEqual(originalCursor.rows);

      // End of rotation resets durably, then an unavailable fetch must not
      // manufacture a source deletion. The next rotation retries the row.
      upstream = null;
      await runBeeperSweep({ reason: 'db-test' });
      await runBeeperSweep({ reason: 'db-test' });
      expect((await readThread(conversationId)).messages[0]).toMatchObject({
        body: 'Missed event correction', unsentAt: null,
      });
      upstream = { ...messageFixture({ isDeleted: true }), text: 'Source tombstone placeholder' };
      await reconcileBeeperEvent({ kind: 'message.deleted', chatID: CHAT_ID, ids: [MESSAGE_ID] });
      await reconcileBeeperEvent({ kind: 'message.deleted', chatID: CHAT_ID, ids: [MESSAGE_ID] });
      const archived = await query('SELECT body, unsent_at FROM beeper_messages WHERE id = $1', [MESSAGE_ID]);
      expect(archived.rows[0].body).toBe('Missed event correction');
      expect(archived.rows[0].unsent_at).toBeTruthy();
      expect((await query('SELECT * FROM beeper_attachments WHERE message_id = $1', [MESSAGE_ID])).rows).toHaveLength(1);
      expect((await readThread(conversationId)).messages[0]).toMatchObject({ body: '', unsentAt: expect.any(String) });
    } finally {
      beeperSocketEvents.off('invalidate', listener);
      // Restore the fixture for the pre-existing forward-ingestion cases.
      await query("UPDATE beeper_messages SET body = 'Example message body', edited_at = NULL, unsent_at = NULL, observed_at = 'epoch' WHERE id = $1", [MESSAGE_ID]);
    }
  });

  it('keeps observed_at monotonic when a newer edit arrives with an older observation', async () => {
    const conversationId = (await query('SELECT conversation_id FROM beeper_messages WHERE id = $1', [MESSAGE_ID])).rows[0].conversation_id;
    try {
      await withTransaction(async (client) => {
        await upsertMirroredMessage(client, conversationId,
          normalizeMessageRow(messageFixture(), '2026-09-10T00:00:00Z'));
        const edited = { ...messageFixture({ text: 'Edited example' }), editedTimestamp: '2026-09-11T00:00:00Z' };
        await upsertMirroredMessage(client, conversationId, normalizeMessageRow(edited, '2026-09-05T00:00:00Z'));
      });
      const row = (await query('SELECT body, observed_at FROM beeper_messages WHERE id = $1', [MESSAGE_ID])).rows[0];
      expect(row.body).toBe('Edited example');
      expect(row.observed_at.toISOString()).toBe('2026-09-10T00:00:00.000Z');
    } finally {
      await query("UPDATE beeper_messages SET body = 'Example message body', edited_at = NULL, unsent_at = NULL, observed_at = 'epoch' WHERE id = $1", [MESSAGE_ID]);
    }
  });

  it('stamps a swept tombstone at chat-fetch time, not at sweep start', async () => {
    installFetch({
      chats: { items: [chatFixture('2026-10-01T10:00:00.000Z')], hasMore: false },
      messages: { items: [messageFixture({ isDeleted: true })], hasMore: false, newestCursor: 'cursor-fetch-time' },
    });
    const baseFetch = globalThis.fetch;
    // Models a slow multi-account sweep: the chat is reached well after the
    // sweep began, so a sweep-start stamp would predate the fetch.
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const { pathname } = new URL(url);
      // Keep the stored-row reconcile out of this case: only the chat sweep may write the tombstone.
      if (/\/messages\//.test(pathname)) return { ok: false, status: 404, text: async () => '{}' };
      if (pathname === '/v1/accounts') await new Promise((resolve) => setTimeout(resolve, 60));
      return baseFetch(url);
    }));
    const sweepStart = Date.now();
    try {
      await runBeeperSweep({ reason: 'db-test' });
      const row = (await query('SELECT unsent_at FROM beeper_messages WHERE id = $1', [MESSAGE_ID])).rows[0];
      expect(row.unsent_at.getTime() - sweepStart).toBeGreaterThanOrEqual(50);
    } finally {
      await query("UPDATE beeper_messages SET body = 'Example message body', edited_at = NULL, unsent_at = NULL, observed_at = 'epoch' WHERE id = $1", [MESSAGE_ID]);
    }
  });

  it('keeps the body and stamps unsent_at when the source unsends the message', async () => {
    installFetch({
      chats: { items: [chatFixture('2026-09-03T10:00:00.000Z')], hasMore: false },
      messages: { items: [messageFixture({ isDeleted: true })], hasMore: false, newestCursor: 'cursor-after-second-sweep' },
    });

    await runBeeperSweep({ reason: 'db-test' });

    const message = await query('SELECT * FROM beeper_messages WHERE id = $1', [MESSAGE_ID]);
    // The archive keeps what the source forgot: a tombstone, never a removal.
    expect(message.rows[0].body).toBe('Example message body');
    expect(message.rows[0].unsent_at).toBeTruthy();
  });

  it('does not re-page a chat whose lastActivity has not passed the stored watermark', async () => {
    const urls = installFetch({
      chats: { items: [chatFixture('2026-09-03T10:00:00.000Z')], hasMore: false },
      messages: { items: [], hasMore: false },
    });

    const result = await runBeeperSweep({ reason: 'db-test' });

    expect(result).toMatchObject({ chats: 0, messages: 0 });
    expect(urls.filter((url) => /\/messages$/.test(new URL(url).pathname))).toHaveLength(0);
  });

  // `beeper_sync_cursors` has no FK onto `beeper_conversations`, so the purge's
  // own DELETE is the only thing that removes a cursor row. A sweep already in
  // flight when the purge commits used to re-insert one — a window with zero
  // messages still wrote it — and the resurrected watermark made the chat look
  // caught-up forever, so the purged history never came back.
  it('writes no cursor row for a conversation purged out from under the sweep', async () => {
    const purgedChatId = `${nonce}-chat-purged`;
    const purgedChat = {
      ...chatFixture('2026-09-04T10:00:00.000Z'),
      id: purgedChatId,
      // No participants: the roster upsert runs AFTER the message fetch and
      // carries its own FK onto the conversation, so a roster entry would fail
      // the chat before the commit under test is ever reached.
      participants: { hasMore: false, total: 0, items: [] },
    };
    // The message fetch is the seam. `sweepChat` has committed the conversation
    // by then and has not yet opened the commit transaction, so deleting the row
    // here reproduces a purge landing mid-sweep exactly.
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const { pathname } = new URL(url);
      if (pathname === '/v1/accounts') return jsonResponse(ACCOUNTS);
      if (pathname === '/v1/bridges') return jsonResponse(BRIDGES);
      if (pathname === '/v1/chats') return jsonResponse({ items: [purgedChat], hasMore: false });
      if (/\/messages$/.test(pathname)) {
        const { rows: [{ id }] } = await query(
          'SELECT id FROM beeper_conversations WHERE account_id = $1 AND source_chat_id = $2',
          [ACCOUNT_ID, purgedChatId],
        );
        await purgeConversation(id);
        return jsonResponse({ items: [], hasMore: false, newestCursor: 'cursor-after-purge' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    await runBeeperSweep({ reason: 'db-test' });

    const conversation = await query(
      'SELECT id FROM beeper_conversations WHERE account_id = $1 AND source_chat_id = $2',
      [ACCOUNT_ID, purgedChatId],
    );
    expect(conversation.rows).toHaveLength(0);
    const cursor = await query(
      'SELECT * FROM beeper_sync_cursors WHERE account_id = $1 AND chat_id = $2',
      [ACCOUNT_ID, purgedChatId],
    );
    // Nothing resurrects the watermark, so the next sweep sees a never-swept
    // chat and mirrors it from scratch — what the purge confirmation promises.
    expect(cursor.rows).toHaveLength(0);
  });

  it('writes no sender touchpoints when purge wins after the sweep resolves its sender', async () => {
    const chatId = `${nonce}-chat-purged-with-sender`;
    const person = await createPerson({ name: 'Example Purge Sender' });
    const senderId = `${nonce}-user`;
    const resolved = beeperTribe.upsertConversationParticipants;
    let conversationId;
    const participants = vi.spyOn(beeperTribe, 'upsertConversationParticipants');
    try {
      await linkIdentity({ personId: person.id, kind: 'beeper-user', network: ACCOUNT_ID, handle: senderId });
      participants.mockImplementationOnce(async (...args) => {
        const result = await resolved(...args);
        expect(result.resolvedPersonIds.get(senderId)).toBe(person.id);
        [conversationId] = args;
        await purgeConversation(conversationId);
        return result;
      });
      installFetch({
        chats: { items: [{ ...chatFixture('2026-09-05T10:00:00.000Z'), id: chatId }], hasMore: false },
        messages: { items: [{ ...messageFixture(), chatID: chatId, id: `${chatId}-message` }], hasMore: false },
      });

      await runBeeperSweep({ reason: 'db-test' });

      expect(conversationId).toBeTruthy();
      expect((await query('SELECT id FROM beeper_conversations WHERE id = $1', [conversationId])).rows).toEqual([]);
      const touchpoints = await query(
        `SELECT id FROM tribe_touchpoints WHERE person_id = $1 AND metadata->>'conversationId' = $2`,
        [person.id, conversationId],
      );
      expect(touchpoints.rows).toEqual([]);
    } finally {
      participants.mockRestore();
      await query('DELETE FROM tribe_people WHERE id = $1', [person.id]);
    }
  });

  // `is_sender` is the only inbound/outbound signal a chat surface has —
  // `accounts[].user.id` differs from `senderID` on every network, so nothing
  // can be recomputed from the rest of the row. The unit suite can only assert
  // the upsert's SQL against a mocked client; the guarantee is a property of
  // the ROW after two sweeps, and that is what this pins.
  it('never downgrades a stored is_sender TRUE when a later sweep omits the field', async () => {
    const chatId = `${nonce}-chat-sender`;
    const messageId = `${nonce}-msg-sender`;
    const chatAt = (lastActivity) => ({
      ...chatFixture(lastActivity),
      id: chatId,
      participants: { hasMore: false, total: 0, items: [] },
    });
    const outbound = (withFlag) => ({
      id: messageId,
      chatID: chatId,
      accountID: ACCOUNT_ID,
      senderID: `${nonce}-self`,
      timestamp: '2026-09-05T10:00:00.000Z',
      sortKey: '000000002',
      text: 'Example outbound message',
      attachments: [],
      ...(withFlag ? { isSender: true } : {}),
    });

    installFetch({
      chats: { items: [chatAt('2026-09-05T10:00:00.000Z')], hasMore: false },
      messages: { items: [outbound(true)], hasMore: false, newestCursor: 'cursor-sender-1' },
    });
    await runBeeperSweep({ reason: 'db-test' });
    const first = await query('SELECT is_sender FROM beeper_messages WHERE id = $1', [messageId]);
    expect(first.rows[0].is_sender).toBe(true);

    // The field is optional on the inbound Message, and the normalizer reads an
    // omitted one as inbound — so a re-observation of the same message must not
    // flip a message the user actually sent onto the other side of the thread.
    installFetch({
      chats: { items: [chatAt('2026-09-06T10:00:00.000Z')], hasMore: false },
      messages: { items: [outbound(false)], hasMore: false, newestCursor: 'cursor-sender-2' },
    });
    await runBeeperSweep({ reason: 'db-test' });

    const second = await query('SELECT is_sender FROM beeper_messages WHERE id = $1', [messageId]);
    expect(second.rows[0].is_sender).toBe(true);
  });
  it('resumes a durable bounded rotation and retries failures without starving later rows', async () => {
    const conversation = await query('SELECT id FROM beeper_conversations WHERE account_id = $1 LIMIT 1', [ACCOUNT_ID]);
    const conversationId = conversation.rows[0].id;
    const ids = Array.from({ length: 21 }, (_, i) => MESSAGE_ID + '-rotation-' + String(i).padStart(2, '0'));
    await query(
      "INSERT INTO beeper_messages (id, conversation_id, body) SELECT id, $2, 'Original' FROM unnest($1::text[]) id",
      [ids, conversationId],
    );
    // Represents a restart: progress already exists in PostgreSQL, with no
    // process-local rotation state to restore.
    await query(
      `INSERT INTO beeper_reconcile_cursors (account_id, message_id, upper_bound) VALUES ($1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE SET message_id = EXCLUDED.message_id, upper_bound = EXCLUDED.upper_bound`,
      [ACCOUNT_ID, MESSAGE_ID, ids.at(-1)],
    );
    let failFirst = true;
    const fetched = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/v1/accounts') return jsonResponse(ACCOUNTS);
      if (pathname === '/v1/bridges') return jsonResponse(BRIDGES);
      if (pathname === '/v1/chats') return jsonResponse({ items: [], hasMore: false });
      const id = decodeURIComponent(pathname.split('/').at(-1));
      fetched.push(id);
      if (id === ids[0] && failFirst) return { ok: false, status: 404, text: async () => '{}' };
      return jsonResponse({ id, text: 'Reconciled', editedTimestamp: '2026-09-06T00:00:00Z' });
    }));
    await runBeeperSweep({ reason: 'db-test' });
    expect(fetched).toEqual(ids.slice(0, 20));
    expect((await query('SELECT body, unsent_at FROM beeper_messages WHERE id = $1', [ids[0]])).rows[0])
      .toMatchObject({ body: 'Original', unsent_at: null });
    fetched.length = 0;
    await runBeeperSweep({ reason: 'db-test' });
    expect(fetched).toEqual([ids[20]]);
    failFirst = false;
    await runBeeperSweep({ reason: 'db-test' }); // end-of-rotation reset
    await runBeeperSweep({ reason: 'db-test' });
    expect((await query('SELECT body FROM beeper_messages WHERE id = $1', [ids[0]])).rows[0].body).toBe('Reconciled');
  });

  it('keeps measured byte_length when upstream omits fileSize and resets fetch state on a replaced mxc_id', async () => {
    const conversationId = (await query('SELECT conversation_id FROM beeper_messages WHERE id = $1', [MESSAGE_ID])).rows[0].conversation_id;
    const upsert = (fixture, at) => withTransaction(async (client) => {
      await upsertMirroredMessage(client, conversationId, normalizeMessageRow(fixture, at), normalizeAttachmentRows(fixture));
    });
    const read = async () => (await query(
      'SELECT mxc_id, byte_length, mime_type, file_name, local_path, fetched_at, unavailable_at, fetch_error FROM beeper_attachments WHERE message_id = $1 AND idx = 0',
      [MESSAGE_ID])).rows[0];
    const bare = (over = {}) => {
      const m = messageFixture();
      m.attachments = [{ ...m.attachments[0], fileSize: undefined, mimeType: '', fileName: '', ...over }];
      return m;
    };
    try {
      await query("UPDATE beeper_messages SET unsent_at = NULL, observed_at = 'epoch' WHERE id = $1", [MESSAGE_ID]);
      await upsert(messageFixture(), '2026-10-01T00:00:00Z');
      // HEAD-probed size on a not-yet-downloaded row survives a sparse re-observation.
      await query('UPDATE beeper_attachments SET byte_length = 7777 WHERE message_id = $1', [MESSAGE_ID]);
      await upsert(bare(), '2026-10-02T00:00:00Z');
      expect(await read()).toMatchObject({ byte_length: '7777', mime_type: 'image/png', file_name: 'example.png' });
      // A downloaded row keeps its measured disk size even over a non-null upstream value.
      await query("UPDATE beeper_attachments SET local_path = 'x/example.bin', byte_length = 5000, fetched_at = NOW(), fetch_error = 'old' WHERE message_id = $1", [MESSAGE_ID]);
      await upsert(messageFixture(), '2026-10-03T00:00:00Z');
      expect(await read()).toMatchObject({ byte_length: '5000', local_path: 'x/example.bin' });
      // Replaced attachment: fetch state resets and upstream metadata wins.
      await query("UPDATE beeper_attachments SET unavailable_at = NOW() WHERE message_id = $1", [MESSAGE_ID]);
      await upsert(bare({ id: 'mxc://example.invalid/attachment-2', fileSize: 123, mimeType: 'image/jpeg', fileName: 'new.jpg' }), '2026-10-04T00:00:00Z');
      expect(await read()).toMatchObject({
        mxc_id: 'mxc://example.invalid/attachment-2', byte_length: '123', mime_type: 'image/jpeg', file_name: 'new.jpg',
        local_path: null, fetched_at: null, unavailable_at: null, fetch_error: null,
      });
    } finally {
      await query("UPDATE beeper_messages SET body = 'Example message body', edited_at = NULL, unsent_at = NULL, observed_at = 'epoch' WHERE id = $1", [MESSAGE_ID]);
      await query("UPDATE beeper_attachments SET mxc_id = 'mxc://example.invalid/attachment-1', mime_type = 'image/png', file_name = 'example.png', byte_length = 4096, local_path = NULL, fetched_at = NULL, unavailable_at = NULL, fetch_error = NULL WHERE message_id = $1", [MESSAGE_ID]);
    }
  });

  it('uses idx_beeper_messages_conversation_id via CROSS JOIN LATERAL without scanning other accounts or sorting full history', async () => {
    const explainAccount = `${nonce}-explain`;
    await query(
      `INSERT INTO beeper_accounts (account_id, network, display_name, status, bridge_id)
       VALUES ($1, 'Example Net', 'Explain Account', 'connected', 'example-bridge'),
              ($2, 'Example Net', 'Other Account', 'connected', 'example-bridge')
       ON CONFLICT (account_id) DO NOTHING`,
      [explainAccount, OTHER_ACCOUNT_ID],
    );
    try {
      const targetConvs = [];
      for (let i = 0; i < 2; i += 1) {
        const { rows } = await query(
          `INSERT INTO beeper_conversations (account_id, network, source_chat_id, title, type)
           VALUES ($1, 'Example Net', $2, $3, 'single')
           RETURNING id`,
          [explainAccount, `${explainAccount}-chat-${i}`, `Explain Chat ${i}`],
        );
        targetConvs.push(rows[0].id);
        const msgIds = Array.from({ length: 5 }, (_, j) => `${explainAccount}-c${i}-m${j}`);
        await query(
          `INSERT INTO beeper_messages (id, conversation_id, body)
           SELECT id, $2, 'Explain body' FROM unnest($1::text[]) AS id`,
          [msgIds, rows[0].id],
        );
      }

      const { rows: otherConvRows } = await query(
        `INSERT INTO beeper_conversations (account_id, network, source_chat_id, title, type)
         VALUES ($1, 'Example Net', $2, 'Other Chat', 'single')
         RETURNING id`,
        [OTHER_ACCOUNT_ID, `${OTHER_ACCOUNT_ID}-chat-0`],
      );
      // Place unrelated IDs before each target chat's messages, inside the batch bounds.
      // An ID-only scan would walk those rows before finding each chat's first match.
      const otherMsgIds = Array.from({ length: 512 }, (_, j) =>
        `${explainAccount}-c${j % targetConvs.length}-distractor-${j}`);
      await query(
        `INSERT INTO beeper_messages (id, conversation_id, body)
         SELECT id, $2, 'Other body' FROM unnest($1::text[]) AS id`,
        [otherMsgIds, otherConvRows[0].id],
      );

      await query('ANALYZE beeper_conversations');
      await query('ANALYZE beeper_messages');

      const explainPlan = async (sql, params) => withTransaction(async (client) => {
        await client.query('SET LOCAL enable_seqscan = off');
        await client.query('SET LOCAL enable_bitmapscan = off');
        const res = await client.query(`EXPLAIN (ANALYZE, TIMING OFF) ${sql}`, params);
        return res.rows.map((r) => r['QUERY PLAN']).join('\n');
      });

      const upperBoundSql = `
        SELECT MAX(lm.id) AS upper_bound
          FROM beeper_conversations c
          CROSS JOIN LATERAL (
            SELECT m.id
              FROM beeper_messages m
             WHERE m.conversation_id = c.id
             ORDER BY m.id DESC
             LIMIT 1
          ) lm
         WHERE c.account_id = $1`;
      const upperPlan = await explainPlan(upperBoundSql, [explainAccount]);
      expect(upperPlan).toMatch(/Index(?: Only)? Scan.*idx_beeper_messages_conversation_id/s);
      expect(upperPlan).not.toMatch(/Seq Scan/);
      // Exactly one LATERAL index probe per conversation belonging to explainAccount (2), never other accounts.
      const upperIndexLine = upperPlan.split('\n').find((line) => line.includes('idx_beeper_messages_conversation_id'));
      expect(upperIndexLine).toMatch(/actual rows=1 loops=2\b/);

      const batchSql = `
        SELECT lm.id, c.id AS conversation_id, c.source_chat_id
          FROM beeper_conversations c
          CROSS JOIN LATERAL (
            SELECT m.id
              FROM beeper_messages m
             WHERE m.conversation_id = c.id
               AND m.id > $2
               AND m.id <= $4
             ORDER BY m.id ASC
             LIMIT $3
          ) lm
         WHERE c.account_id = $1
         ORDER BY lm.id ASC
         LIMIT $3`;
      const upperBound = `${explainAccount}-c1-m4`;
      const batchPlan = await explainPlan(batchSql, [explainAccount, '', 4, upperBound]);
      expect(batchPlan).toMatch(/Index(?: Only)? Scan.*idx_beeper_messages_conversation_id/s);
      expect(batchPlan).not.toMatch(/Seq Scan/);
      const batchIndexLine = batchPlan.split('\n').find((line) => line.includes('idx_beeper_messages_conversation_id'));
      expect(batchIndexLine).toMatch(/actual rows=4 loops=2\b/);
      // Only the outer ordering needs a sort. Each inner limit contributes four rows.
      expect(batchPlan.match(/^\s*->\s+Sort\s/gm)).toHaveLength(1);
      expect(batchPlan).toMatch(/Nested Loop.*actual rows=8 loops=1/);

      const { rows: selected } = await query(batchSql, [explainAccount, '', 4, upperBound]);
      expect(selected.map((r) => r.id)).toEqual([
        `${explainAccount}-c0-m0`,
        `${explainAccount}-c0-m1`,
        `${explainAccount}-c0-m2`,
        `${explainAccount}-c0-m3`,
      ]);
      expect(selected.every((r) => targetConvs.includes(r.conversation_id))).toBe(true);
    } finally {
      await query('DELETE FROM beeper_accounts WHERE account_id = ANY($1::text[])', [[explainAccount, OTHER_ACCOUNT_ID]]);
    }
  });

  it('skips snooze UPDATEs on unchanged caught-up chats and batches changed snoozes via UNNEST', async () => {
    const snoozeAccount = `${nonce}-snooze`;
    const activity = '2026-09-01T00:00:00.000Z';
    const snoozeA = '2030-09-01T00:00:00.000Z';
    const snoozeB = '2030-10-01T00:00:00.000Z';
    const chatA = `${snoozeAccount}-chat-a`;
    const chatB = `${snoozeAccount}-chat-b`;
    const chatC = `${snoozeAccount}-chat-c`;
    const accounts = [{ accountID: snoozeAccount, network: 'Example Net', user: { id: 'u-self', fullName: 'Example Owner' } }];
    const bridges = { items: [{ id: 'example-bridge', network: 'examplenet', status: 'connected', accounts: [{ accountID: snoozeAccount }] }] };
    const makeChat = (id, snoozeUntil) => ({
      id,
      accountID: snoozeAccount,
      network: 'Example Net',
      title: `Chat ${id}`,
      type: 'single',
      lastActivity: activity,
      snooze: snoozeUntil ? { snoozeUntil } : null,
      participants: { hasMore: false, total: 0, items: [] },
    });

    const installChats = (chats) => {
      vi.stubGlobal('fetch', vi.fn(async (url) => {
        const { pathname } = new URL(url);
        if (pathname === '/v1/accounts') return jsonResponse(accounts);
        if (pathname === '/v1/bridges') return jsonResponse(bridges);
        if (pathname === '/v1/chats') return jsonResponse({ items: chats, hasMore: false });
        if (/\/messages$/.test(pathname)) return jsonResponse({ items: [], hasMore: false });
        if (/\/messages\//.test(pathname)) return { ok: false, status: 404, text: async () => '{}' };
        throw new Error(`unexpected fetch: ${url}`);
      }));
    };

    try {
      // Initial sweep seeds chatA (unsnoozed), chatB (snoozed), chatC (unsnoozed).
      // Provide one message in chatA so the cursor commits (not withheld by #81).
      vi.stubGlobal('fetch', vi.fn(async (url) => {
        const { pathname } = new URL(url);
        if (pathname === '/v1/accounts') return jsonResponse(accounts);
        if (pathname === '/v1/bridges') return jsonResponse(bridges);
        if (pathname === '/v1/chats') {
          return jsonResponse({
            items: [makeChat(chatA, null), makeChat(chatB, snoozeA), makeChat(chatC, null)],
            hasMore: false,
          });
        }
        if (/\/messages$/.test(pathname)) {
          const chatId = decodeURIComponent(pathname.split('/')[3]);
          return jsonResponse({
            items: [{ id: `${chatId}-m1`, senderID: 'user-1', text: 'seed', timestamp: activity }],
            hasMore: false,
            newestCursor: `cur-${chatId}`,
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }));
      await runBeeperSweep({ reason: 'db-test' });

      const { sqlLog, restore } = captureSqlQueries();
      try {
        // Unchanged steady-state sweep: 0 UPDATE beeper_conversations queries.
        installChats([makeChat(chatA, null), makeChat(chatB, snoozeA), makeChat(chatC, null)]);
        await runBeeperSweep({ reason: 'db-test' });
        expect(sqlLog.filter((s) => s.includes('UPDATE beeper_conversations'))).toHaveLength(0);

        // Changed snoozes: chatA gains snoozeB, chatB clears snooze, chatC stays unchanged -> 1 batched UPDATE.
        sqlLog.length = 0;
        installChats([makeChat(chatA, snoozeB), makeChat(chatB, null), makeChat(chatC, null)]);
        await runBeeperSweep({ reason: 'db-test' });
        const updates = sqlLog.filter((s) => s.includes('UPDATE beeper_conversations'));
        expect(updates).toHaveLength(1);
        expect(updates[0]).toContain('unnest($2::text[], $3::timestamptz[])');

        const { rows } = await query(
          `SELECT source_chat_id, snooze_until
             FROM beeper_conversations
            WHERE account_id = $1
            ORDER BY source_chat_id`,
          [snoozeAccount],
        );
        expect(rows.map((r) => ({
          id: r.source_chat_id,
          snooze: r.snooze_until ? r.snooze_until.toISOString() : null,
        }))).toEqual([
          { id: chatA, snooze: snoozeB },
          { id: chatB, snooze: null },
          { id: chatC, snooze: null },
        ]);
      } finally {
        restore();
      }
    } finally {
      await query('DELETE FROM beeper_accounts WHERE account_id = $1', [snoozeAccount]);
    }
  });

  it('batches multi-message/attachment commits while preserving stale rejection, tombstone bodies, and mxc_id resets', async () => {
    const batchAccount = `${nonce}-batch`;
    const batchChat = `${batchAccount}-chat`;
    const accounts = [{ accountID: batchAccount, network: 'Example Net', user: { id: 'u-self', fullName: 'Example Owner' } }];
    const bridges = { items: [{ id: 'example-bridge', network: 'examplenet', status: 'connected', accounts: [{ accountID: batchAccount }] }] };
    const staleId = `${batchAccount}-stale`;
    const tombId = `${batchAccount}-tomb`;
    const dupId = `${batchAccount}-dup`;
    const replaceId = `${batchAccount}-replace`;
    const freshId = `${batchAccount}-fresh`;

    const makeChat = (lastActivity) => ({
      id: batchChat,
      accountID: batchAccount,
      network: 'Example Net',
      title: 'Batch Chat',
      type: 'single',
      lastActivity,
      participants: { hasMore: false, total: 0, items: [] },
    });

    try {
      // Pass 1: seed initial rows.
      vi.stubGlobal('fetch', vi.fn(async (url) => {
        const { pathname } = new URL(url);
        if (pathname === '/v1/accounts') return jsonResponse(accounts);
        if (pathname === '/v1/bridges') return jsonResponse(bridges);
        if (pathname === '/v1/chats') return jsonResponse({ items: [makeChat('2026-10-01T00:00:00.000Z')], hasMore: false });
        if (/\/messages$/.test(pathname)) {
          return jsonResponse({
            items: [
              {
                id: staleId,
                senderID: 'user-1',
                text: 'Fresh authoritative body',
                timestamp: '2026-10-01T00:00:00.000Z',
                attachments: [{ id: 'mxc://example.invalid/stale-keep', mimeType: 'image/png', fileName: 'keep.png', fileSize: 111 }],
              },
              {
                id: tombId,
                senderID: 'user-1',
                text: 'Archived body before unsend',
                timestamp: '2026-10-01T00:01:00.000Z',
                attachments: [{ id: 'mxc://example.invalid/tomb-att', mimeType: 'image/png', fileName: 'tomb.png', fileSize: 222 }],
              },
              {
                id: replaceId,
                senderID: 'user-1',
                text: 'Has attachment to replace',
                timestamp: '2026-10-01T00:02:00.000Z',
                attachments: [{ id: 'mxc://example.invalid/old-mxc', mimeType: 'image/png', fileName: 'old.png', fileSize: 333 }],
              },
            ],
            hasMore: false,
            newestCursor: 'batch-cur-1',
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }));
      await runBeeperSweep({ reason: 'db-test' });

      // Simulate newer stored observation on staleId and cached fetch state on replaceId.
      await query("UPDATE beeper_messages SET observed_at = '2099-01-01T00:00:00Z' WHERE id = $1", [staleId]);
      await query(
        "UPDATE beeper_attachments SET local_path = 'ab/old.png', fetched_at = NOW(), unavailable_at = NOW(), fetch_error = 'stale error' WHERE message_id = $1",
        [replaceId],
      );

      // Pass 2: multi-page forward walk returning all 5 cases in one commitMessages transaction.
      let msgPage = 0;
      vi.stubGlobal('fetch', vi.fn(async (url) => {
        const { pathname } = new URL(url);
        if (pathname === '/v1/accounts') return jsonResponse(accounts);
        if (pathname === '/v1/bridges') return jsonResponse(bridges);
        if (pathname === '/v1/chats') return jsonResponse({ items: [makeChat('2026-10-02T00:00:00.000Z')], hasMore: false });
        if (/\/messages$/.test(pathname)) {
          msgPage++;
          if (msgPage === 1) {
            return jsonResponse({
              items: [
                {
                  id: staleId,
                  senderID: 'user-1',
                  text: 'Stale overwrite attempt',
                  timestamp: '2026-10-01T00:00:00.000Z',
                  attachments: [{ id: 'mxc://example.invalid/stale-new', mimeType: 'image/jpeg', fileName: 'bad.jpg', fileSize: 999 }],
                },
                {
                  id: tombId,
                  senderID: 'user-1',
                  isDeleted: true,
                  text: '',
                  timestamp: '2026-10-01T00:01:00.000Z',
                  attachments: [],
                },
                {
                  id: dupId,
                  senderID: 'user-1',
                  text: 'Older dup',
                  editedTimestamp: '2026-10-02T00:00:00.000Z',
                  timestamp: '2026-10-02T00:00:00.000Z',
                  attachments: [{ id: 'mxc://example.invalid/dup-old', mimeType: 'image/png', fileName: 'dup-old.png' }],
                },
              ],
              hasMore: true,
              newestCursor: 'batch-cur-mid',
            });
          }
          return jsonResponse({
            items: [
              {
                id: dupId,
                senderID: 'user-1',
                text: 'Winning dup edit',
                editedTimestamp: '2026-10-02T01:00:00.000Z',
                isSender: true,
                timestamp: '2026-10-02T00:00:00.000Z',
                attachments: [{ id: 'mxc://example.invalid/dup-win', mimeType: 'image/jpeg', fileName: 'dup-win.jpg' }],
              },
              {
                id: replaceId,
                senderID: 'user-1',
                text: 'Has attachment to replace',
                editedTimestamp: '2026-10-02T01:00:00.000Z',
                timestamp: '2026-10-01T00:02:00.000Z',
                attachments: [{ id: 'mxc://example.invalid/new-mxc', mimeType: 'image/webp', fileName: 'new.webp', fileSize: 444 }],
              },
              {
                id: freshId,
                senderID: 'user-2',
                text: 'Brand new message',
                timestamp: '2026-10-02T02:00:00.000Z',
                attachments: [
                  { id: 'mxc://example.invalid/f0', mimeType: 'image/png', fileName: 'f0.png', fileSize: 10 },
                  { id: 'mxc://example.invalid/f1', mimeType: 'image/png', fileName: 'f1.png', fileSize: 20 },
                ],
              },
            ],
            hasMore: false,
            newestCursor: 'batch-cur-2',
          });
        }
        if (/\/messages\//.test(pathname)) return { ok: false, status: 404, text: async () => '{}' };
        throw new Error(`unexpected fetch: ${url}`);
      }));

      const { sqlLog, restore } = captureSqlQueries();
      try {
        await runBeeperSweep({ reason: 'db-test' });
      } finally {
        restore();
      }

      // Single batched message upsert and single batched attachment upsert in the transaction.
      expect(sqlLog.filter((s) => s.includes('INSERT INTO beeper_messages'))).toHaveLength(1);
      expect(sqlLog.filter((s) => s.includes('INSERT INTO beeper_attachments'))).toHaveLength(1);

      const { rows: msgs } = await query(
        'SELECT id, body, unsent_at, is_sender FROM beeper_messages WHERE id = ANY($1::text[])',
        [[staleId, tombId, dupId, replaceId, freshId]],
      );
      const byId = Object.fromEntries(msgs.map((m) => [m.id, m]));
      expect(byId[staleId].body).toBe('Fresh authoritative body');
      expect(byId[tombId].body).toBe('Archived body before unsend');
      expect(byId[tombId].unsent_at).toBeTruthy();
      expect(byId[dupId].body).toBe('Winning dup edit');
      expect(byId[dupId].is_sender).toBe(true);
      expect(byId[freshId].body).toBe('Brand new message');

      const { rows: atts } = await query(
        `SELECT message_id, idx, mxc_id, mime_type, byte_length, file_name,
                local_path, fetched_at, unavailable_at, fetch_error
           FROM beeper_attachments
          WHERE message_id = ANY($1::text[])
          ORDER BY message_id, idx`,
        [[staleId, tombId, dupId, replaceId, freshId]],
      );
      const staleAtt = atts.find((a) => a.message_id === staleId);
      expect(staleAtt.mxc_id).toBe('mxc://example.invalid/stale-keep');
      const tombAtt = atts.find((a) => a.message_id === tombId);
      expect(tombAtt.mxc_id).toBe('mxc://example.invalid/tomb-att');
      const dupAtt = atts.find((a) => a.message_id === dupId);
      expect(dupAtt.mxc_id).toBe('mxc://example.invalid/dup-win');
      const replaceAtt = atts.find((a) => a.message_id === replaceId);
      expect(replaceAtt).toMatchObject({
        mxc_id: 'mxc://example.invalid/new-mxc',
        mime_type: 'image/webp',
        file_name: 'new.webp',
        local_path: null,
        fetched_at: null,
        unavailable_at: null,
        fetch_error: null,
      });
      expect(atts.filter((a) => a.message_id === freshId)).toHaveLength(2);
    } finally {
      await query('DELETE FROM beeper_accounts WHERE account_id = $1', [batchAccount]);
    }
  });

});
