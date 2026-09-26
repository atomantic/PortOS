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
 * `*.db.test.js` → runs ONLY via `npm run test:db` against `portos_test`
 * (registered in vitest.config.db.js's DB_TEST_INCLUDE — a `<name>.db.test.js`
 * file is not auto-globbed). Every fixture uses placeholder names/handles per
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
import { checkHealth, ensureSchema, close, query, withTransaction } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';

vi.mock('./settings.js', async (importOriginal) => {
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

vi.mock('./instanceFeatures.js', () => ({ isInstanceFeatureEnabled: async () => true }));
const { runBeeperSweep, reconcileBeeperEvent, upsertMirroredMessage, normalizeMessageRow } = await import('./beeperSync.js');
const { listMessages: readThread } = await import('./beeperConversations.js');
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

beforeAll(async () => {
  if (!dbReady) return;
  await query('DELETE FROM beeper_accounts WHERE account_id = $1', [ACCOUNT_ID]).catch(() => {});
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (dbReady) {
    // Cascades through conversations / messages / attachments / participants /
    // cursors.
    await query('DELETE FROM beeper_accounts WHERE account_id = $1', [ACCOUNT_ID]).catch(() => {});
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
        await query(
          'DELETE FROM beeper_conversations WHERE account_id = $1 AND source_chat_id = $2',
          [ACCOUNT_ID, purgedChatId],
        );
        await query(
          'DELETE FROM beeper_sync_cursors WHERE account_id = $1 AND chat_id = $2',
          [ACCOUNT_ID, purgedChatId],
        );
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

});
