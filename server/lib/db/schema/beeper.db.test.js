/**
 * Postgres-backed tests for the Beeper conversation-mirror schema (#27):
 *   - ensureSchema() creates every beeper_* table and is idempotent on re-run
 *   - the full FK chain (account → conversation → message → participant →
 *     attachment, plus the sync-cursor row) inserts and cascade-deletes cleanly
 *   - the `observed_via` CHECK constraint rejects an out-of-set value
 *   - `UNIQUE (account_id, source_chat_id)` holds on beeper_conversations
 *   - `beeper_credentials` (#31) stores one row keyed on a fixed id, accepts a
 *     NULL expiry (the no-expiry pasted token), and rejects an unknown `source`
 *   - `beeper_outbox` (#36) accepts every state of PortOS's own send machine,
 *     rejects one outside it, and cascade-deletes with its conversation
 *
 * `*.db.test.js` → runs ONLY via `npm run test:db` against `portos_test`, never
 * the real `portos` DB (the db.js runner guard + the suite skip below enforce
 * this). The DB is shared across worktrees, so every row created here uses a
 * per-run nonce and the whole chain is torn down in afterAll via one cascade
 * delete on the account row.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { checkHealth, ensureSchema, close, query } from '../../db.js';
import { requireDbOrSkip } from '../../dbTestGate.js';

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
const runDb = requireDbOrSkip('lib/db/schema/beeper.db.test', dbReady, skipReason);

const nonce = `beeper-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ACCOUNT_ID = nonce;

afterAll(async () => {
  if (dbReady) {
    // ON DELETE CASCADE on every child FK means this one delete tears down
    // the conversation, message, participant, attachment, and cursor rows
    // inserted below.
    await query('DELETE FROM beeper_accounts WHERE account_id = $1', [ACCOUNT_ID]).catch(() => {});
    await close();
  }
});

describe.skipIf(!runDb)('beeper conversation-mirror schema (#27)', () => {
  it('ensureSchema() is idempotent on re-run', async () => {
    await expect(ensureSchema()).resolves.not.toThrow();
  });

  it('creates every beeper_* table', async () => {
    const { rows } = await query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'beeper_%'
       ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'beeper_accounts',
      'beeper_attachments',
      'beeper_conversations',
      'beeper_credentials',
      'beeper_messages',
      'beeper_outbox',
      'beeper_participants',
      'beeper_reconcile_cursors',
      'beeper_sync_cursors',
    ]);
  });

  it('inserts the full account → conversation → message → participant → attachment chain and cascade-deletes it', async () => {
    await query(
      `INSERT INTO beeper_accounts (account_id, network, display_name, status, bridge_id)
       VALUES ($1, 'Example Network', 'Example Account', 'connected', 'example-bridge')`,
      [ACCOUNT_ID],
    );

    const { rows: convRows } = await query(
      `INSERT INTO beeper_conversations
         (account_id, network, source_chat_id, title, type, is_group, unread_count)
       VALUES ($1, 'Example Network', 'chat-1', 'Example Chat', 'single', FALSE, 2)
       RETURNING id`,
      [ACCOUNT_ID],
    );
    const conversationId = convRows[0].id;

    await query(
      `INSERT INTO beeper_messages (id, conversation_id, sender_id, body, sort_key)
       VALUES ($1, $2, 'user-1', 'hello from a test', '1')`,
      [`msg-${nonce}`, conversationId],
    );

    await query(
      `INSERT INTO beeper_participants
         (conversation_id, source_user_id, display_name, handle, observed_via)
       VALUES ($1, 'user-1', 'Example User', '@example', 'message-sender')`,
      [conversationId],
    );

    await query(
      `INSERT INTO beeper_attachments
         (conversation_id, message_id, idx, mxc_id, mime_type, file_name)
       VALUES ($1, $2, 0, 'mxc://example/abc', 'image/png', 'photo.png')`,
      [conversationId, `msg-${nonce}`],
    );

    await query(
      `INSERT INTO beeper_sync_cursors (account_id, chat_id, cursor)
       VALUES ($1, 'chat-1', 'opaque-cursor-value')`,
      [ACCOUNT_ID],
    );

    const before = await query('SELECT COUNT(*)::int AS n FROM beeper_messages WHERE conversation_id = $1', [conversationId]);
    expect(before.rows[0].n).toBe(1);

    // Deleting the account should cascade through every child table.
    await query('DELETE FROM beeper_accounts WHERE account_id = $1', [ACCOUNT_ID]);

    const afterConv = await query('SELECT COUNT(*)::int AS n FROM beeper_conversations WHERE id = $1', [conversationId]);
    const afterMsg = await query('SELECT COUNT(*)::int AS n FROM beeper_messages WHERE conversation_id = $1', [conversationId]);
    const afterPart = await query('SELECT COUNT(*)::int AS n FROM beeper_participants WHERE conversation_id = $1', [conversationId]);
    const afterAttach = await query('SELECT COUNT(*)::int AS n FROM beeper_attachments WHERE conversation_id = $1', [conversationId]);
    const afterCursor = await query('SELECT COUNT(*)::int AS n FROM beeper_sync_cursors WHERE account_id = $1', [ACCOUNT_ID]);
    expect(afterConv.rows[0].n).toBe(0);
    expect(afterMsg.rows[0].n).toBe(0);
    expect(afterPart.rows[0].n).toBe(0);
    expect(afterAttach.rows[0].n).toBe(0);
    expect(afterCursor.rows[0].n).toBe(0);
  });

  // #31's vaulted credential. Ciphertext is opaque to the DB, so this covers
  // only what the SCHEMA promises: one row per install (PRIMARY KEY on the
  // fixed id, upsert-replaced), a nullable expiry meaning "never expires", and
  // a provenance CHECK that refuses an unclassified credential.
  it('holds exactly one beeper_credentials row, with a nullable expiry and a checked source', async () => {
    const credentialId = `cred-${nonce}`;
    await query(
      `INSERT INTO beeper_credentials (id, token_enc, token_expires_at, scopes, source, client_id)
       VALUES ($1, 'v1:iv:tag:ct', NULL, 'read write', 'pasted', '')`,
      [credentialId],
    );
    await query(
      `INSERT INTO beeper_credentials (id, token_enc, token_expires_at, scopes, source, client_id)
       VALUES ($1, 'v1:iv2:tag2:ct2', NOW() + INTERVAL '1 day', 'read write', 'oauth', 'client-1')
       ON CONFLICT (id) DO UPDATE SET
         token_enc = EXCLUDED.token_enc,
         token_expires_at = EXCLUDED.token_expires_at,
         source = EXCLUDED.source,
         client_id = EXCLUDED.client_id`,
      [credentialId],
    );
    const { rows } = await query('SELECT * FROM beeper_credentials WHERE id = $1', [credentialId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('oauth');
    expect(rows[0].token_expires_at).not.toBeNull();

    await expect(
      query(
        `INSERT INTO beeper_credentials (id, token_enc, source) VALUES ($1, 'v1:x:y:z', 'guessed')`,
        [`${credentialId}-bad`],
      ),
    ).rejects.toThrow();

    await query('DELETE FROM beeper_credentials WHERE id = $1', [credentialId]);
  });

  // #36's outbound outbox. The CHECK is the schema's half of "a failed send is
  // never re-sent in place": every state the send path can reach is in the set,
  // and anything else — including a hopeful `queued` from a later refactor —
  // fails loudly at the boundary instead of quietly bypassing the send gate.
  it('accepts every outbox state, rejects one outside the set, and cascades with its conversation', async () => {
    await query(
      `INSERT INTO beeper_accounts (account_id, network, display_name, status, bridge_id)
       VALUES ($1, 'Example Network', 'Example Account', 'connected', 'example-bridge')`,
      [ACCOUNT_ID],
    );
    const { rows: convRows } = await query(
      `INSERT INTO beeper_conversations (account_id, network, source_chat_id, title, type)
       VALUES ($1, 'Example Network', 'chat-outbox', 'Example Chat', 'single')
       RETURNING id`,
      [ACCOUNT_ID],
    );
    const conversationId = convRows[0].id;

    for (const state of ['draft', 'approved', 'sending', 'awaiting-confirmation', 'sent', 'failed']) {
      // ordered inserts, one per state
      await query(
        `INSERT INTO beeper_outbox (conversation_id, chat_id, body, state)
         VALUES ($1, 'chat-outbox', 'placeholder body', $2)`,
        [conversationId, state],
      );
    }

    await expect(
      query(
        `INSERT INTO beeper_outbox (conversation_id, chat_id, body, state)
         VALUES ($1, 'chat-outbox', 'placeholder body', 'queued')`,
        [conversationId],
      ),
    ).rejects.toThrow();

    const before = await query('SELECT COUNT(*)::int AS n FROM beeper_outbox WHERE conversation_id = $1', [conversationId]);
    expect(before.rows[0].n).toBe(6);

    await query('DELETE FROM beeper_accounts WHERE account_id = $1', [ACCOUNT_ID]);
    const after = await query('SELECT COUNT(*)::int AS n FROM beeper_outbox WHERE conversation_id = $1', [conversationId]);
    expect(after.rows[0].n).toBe(0);
  });

  it('rejects a participant observed_via outside the participant-list/message-sender set', async () => {
    await query(
      `INSERT INTO beeper_accounts (account_id, network, display_name, status, bridge_id)
       VALUES ($1, 'Example Network', 'Example Account', 'connected', 'example-bridge')`,
      [ACCOUNT_ID],
    );
    const { rows: convRows } = await query(
      `INSERT INTO beeper_conversations (account_id, network, source_chat_id, title, type)
       VALUES ($1, 'Example Network', 'chat-bad-observed', 'Example Chat', 'single')
       RETURNING id`,
      [ACCOUNT_ID],
    );
    await expect(
      query(
        `INSERT INTO beeper_participants (conversation_id, source_user_id, observed_via)
         VALUES ($1, 'user-1', 'guessed')`,
        [convRows[0].id],
      ),
    ).rejects.toThrow();
    await query('DELETE FROM beeper_accounts WHERE account_id = $1', [ACCOUNT_ID]);
  });

  it('enforces UNIQUE (account_id, source_chat_id) on beeper_conversations', async () => {
    await query(
      `INSERT INTO beeper_accounts (account_id, network, display_name, status, bridge_id)
       VALUES ($1, 'Example Network', 'Example Account', 'connected', 'example-bridge')`,
      [ACCOUNT_ID],
    );
    await query(
      `INSERT INTO beeper_conversations (account_id, network, source_chat_id, title, type)
       VALUES ($1, 'Example Network', 'chat-dupe', 'Example Chat', 'single')`,
      [ACCOUNT_ID],
    );
    await expect(
      query(
        `INSERT INTO beeper_conversations (account_id, network, source_chat_id, title, type)
         VALUES ($1, 'Example Network', 'chat-dupe', 'Example Chat Again', 'single')`,
        [ACCOUNT_ID],
      ),
    ).rejects.toThrow();
    await query('DELETE FROM beeper_accounts WHERE account_id = $1', [ACCOUNT_ID]);
  });
});
