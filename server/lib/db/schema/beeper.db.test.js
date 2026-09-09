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
 *   - the `kind='beeper-user'` backfill (#96) promotes a pre-existing cached
 *     link to a durable claim, skips soft-deleted people, and is idempotent
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
      // eslint-disable-next-line no-await-in-loop -- ordered inserts, one per state
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

  // #96 — the one backfill statement at the end of `beeperDdl`, which promotes
  // every pre-existing hand-made link (cached only on the mirror row, and so
  // destroyed by a purge) to a durable `kind='beeper-user'` claim. Runs on
  // every boot, so idempotence is the contract, not a nicety.
  describe('the beeper-user backfill (#96)', () => {
    const runBackfill = async () => {
      const { beeperDdl } = await import('./beeper.js');
      const statements = beeperDdl.filter((sql) => /INSERT INTO tribe_identities/.test(sql));
      expect(statements, 'beeperDdl no longer carries the beeper-user backfill').toHaveLength(1);
      await query(statements[0]);
    };

    // The statement's own guard is global — "any beeper-user claim exists"
    // means this install is already past the one-shot promotion — so a fixture
    // must start from a database where nothing has been promoted yet. Cheap
    // and safe: this is portos_test, and every claim these suites write is
    // torn down with its person.
    const clearClaims = () => query(`DELETE FROM tribe_identities WHERE kind = 'beeper-user'`);

    it('promotes a cached link to a claim, skips soft-deleted people, and re-runs cleanly', async () => {
      await clearClaims();
      await query(
        `INSERT INTO beeper_accounts (account_id, network, display_name, status, bridge_id)
         VALUES ($1, 'Example Network', 'Example Account', 'connected', 'example-bridge')`,
        [ACCOUNT_ID],
      );
      const { rows: convRows } = await query(
        `INSERT INTO beeper_conversations (account_id, network, source_chat_id, title, type)
         VALUES ($1, 'Example Network', 'chat-backfill', 'Example Chat', 'single')
         RETURNING id`,
        [ACCOUNT_ID],
      );
      const conversationId = convRows[0].id;

      const { rows: peopleRows } = await query(
        `INSERT INTO tribe_people (name) VALUES ($1), ($2) RETURNING id, name`,
        [`${nonce} Example Live Person`, `${nonce} Example Removed Person`],
      );
      const live = peopleRows.find((r) => r.name.endsWith('Live Person')).id;
      const removed = peopleRows.find((r) => r.name.endsWith('Removed Person')).id;
      await query('UPDATE tribe_people SET deleted = TRUE WHERE id = $1', [removed]);

      // Three pre-#96 rows: one hand-linked, one linked to a soft-deleted
      // person, one never linked at all.
      await query(
        `INSERT INTO beeper_participants (conversation_id, source_user_id, display_name, handle, tribe_person_id, observed_via)
         VALUES ($1, 'backfill-user-live', 'Example Live Person', '', $2, 'message-sender'),
                ($1, 'backfill-user-removed', 'Example Removed Person', '', $3, 'message-sender'),
                ($1, 'backfill-user-unlinked', 'Example Unlinked Person', '', NULL, 'message-sender')`,
        [conversationId, live, removed],
      );

      await runBackfill();

      const claims = async (sourceUserId) => {
        const { rows } = await query(
          `SELECT person_id FROM tribe_identities
           WHERE kind = 'beeper-user' AND network = $1 AND handle = $2`,
          [ACCOUNT_ID, sourceUserId],
        );
        return rows;
      };
      expect(await claims('backfill-user-live')).toEqual([{ person_id: live }]);
      expect(await claims('backfill-user-removed')).toEqual([]);
      expect(await claims('backfill-user-unlinked')).toEqual([]);

      // Idempotent: a second run (ensureSchema re-runs the whole DDL on every
      // call, not just per boot) neither errors nor duplicates the claim.
      await expect(runBackfill()).resolves.not.toThrow();
      expect(await claims('backfill-user-live')).toEqual([{ person_id: live }]);

      // …and it never re-points a claim the app owns: once any beeper-user
      // claim exists this install is past the promotion, so a link the user
      // has since moved by hand stays moved.
      await query('UPDATE tribe_people SET deleted = FALSE WHERE id = $1', [removed]);
      await query(
        `UPDATE tribe_identities SET person_id = $1, source = 'user'
         WHERE kind = 'beeper-user' AND network = $2 AND handle = 'backfill-user-live'`,
        [removed, ACCOUNT_ID],
      );
      await runBackfill();
      expect(await claims('backfill-user-live')).toEqual([{ person_id: removed }]);

      await query('DELETE FROM tribe_people WHERE id = ANY($1::uuid[])', [[live, removed]]);
      await query('DELETE FROM beeper_accounts WHERE account_id = $1', [ACCOUNT_ID]);
    });

    it('picks the most recently updated link when one Beeper user was hand-linked to two people', async () => {
      await clearClaims();
      await query(
        `INSERT INTO beeper_accounts (account_id, network, display_name, status, bridge_id)
         VALUES ($1, 'Example Network', 'Example Account', 'connected', 'example-bridge')`,
        [ACCOUNT_ID],
      );
      const conversationIds = [];
      for (const chat of ['chat-backfill-dupe-1', 'chat-backfill-dupe-2']) {
        // eslint-disable-next-line no-await-in-loop -- two ordered fixture inserts
        const { rows } = await query(
          `INSERT INTO beeper_conversations (account_id, network, source_chat_id, title, type)
           VALUES ($1, 'Example Network', $2, 'Example Chat', 'single')
           RETURNING id`,
          [ACCOUNT_ID, chat],
        );
        conversationIds.push(rows[0].id);
      }
      const { rows: peopleRows } = await query(
        `INSERT INTO tribe_people (name) VALUES ($1), ($2) RETURNING id, name`,
        [`${nonce} Example Claimed Person`, `${nonce} Example Other Person`],
      );
      const claimed = peopleRows.find((r) => r.name.endsWith('Claimed Person')).id;
      const other = peopleRows.find((r) => r.name.endsWith('Other Person')).id;

      // The SAME Beeper user hand-linked to two different people in two
      // conversations — the ambiguity the DISTINCT ON resolves, and the case
      // that would otherwise make one statement insert the same
      // (kind, network, handle) twice. The older row is the one that must lose.
      await query(
        `INSERT INTO beeper_participants (conversation_id, source_user_id, display_name, handle, tribe_person_id, observed_via, updated_at)
         VALUES ($1, 'backfill-user-dupe', 'Example Other Person', '', $3, 'message-sender', NOW() - INTERVAL '1 day'),
                ($2, 'backfill-user-dupe', 'Example Claimed Person', '', $4, 'message-sender', NOW())`,
        [conversationIds[0], conversationIds[1], other, claimed],
      );

      await expect(runBackfill()).resolves.not.toThrow();

      const { rows } = await query(
        `SELECT person_id, source FROM tribe_identities
         WHERE kind = 'beeper-user' AND network = $1 AND handle = 'backfill-user-dupe'`,
        [ACCOUNT_ID],
      );
      expect(rows).toEqual([{ person_id: claimed, source: 'backfill' }]);

      await query('DELETE FROM tribe_people WHERE id = ANY($1::uuid[])', [[claimed, other]]);
      await query('DELETE FROM beeper_accounts WHERE account_id = $1', [ACCOUNT_ID]);
    });
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
