// Beeper conversation mirror DDL (#27). Machine-local mirror of the Beeper Desktop API
// (accounts, conversations, messages, participants, attachment metadata, per-chat sync
// cursors), plus two non-mirror tables: the credential vault (`beeper_credentials`, #31) and
// the send outbox (`beeper_outbox`).
//
// NEVER FEDERATED — enforced by beeperNeverFederates.test.js. No table here gets a
// `sync_sequence` column, a PEER_SUBSCRIBABLE_KINDS entry, a dataSync snapshot category, or a
// PORTOS_SCHEMA_VERSIONS entry.
//
// Source deletions are tombstones: an unsent message keeps its row, body and attachments and
// gains `unsent_at` (named for what the source reports), so the federation guard keys on
// `sync_sequence` alone and needs no soft-delete exemption.
export const beeperDdl = [
  // Account roster the settings card renders with Beeper closed. `loginID` (the bridge login
  // credential's own id) is never stored.
  `CREATE TABLE IF NOT EXISTS beeper_accounts (
    account_id TEXT PRIMARY KEY,
    network TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    bridge_id TEXT NOT NULL DEFAULT '',
    last_seen_at TIMESTAMPTZ,
    chat_cursor TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  `ALTER TABLE beeper_accounts ADD COLUMN IF NOT EXISTS chat_cursor TEXT`,

  // The ONE Beeper credential this install holds (#31): AES-256-GCM ciphertext via
  // `server/lib/vaultCrypto.js`, never `settings.json`, a plaintext file or a log line.
  // Single-row (`id = 'default'`): one Beeper account per install, so a second row would be an
  // identity no surface can choose between.
  //
  // `token_expires_at NULL` means "never expires" (only Beeper's own UI mints one, which is why
  // pasting a token is first-class). No refresh grant: an expired token is re-connected.
  // `scopes` and `client_id` serve the disconnect-time revocation call and are NEVER surfaced
  // to a client payload; `client_id` is a public identifier, empty for a pasted token.
  `CREATE TABLE IF NOT EXISTS beeper_credentials (
    id TEXT PRIMARY KEY,
    token_enc TEXT NOT NULL,
    token_expires_at TIMESTAMPTZ,
    scopes TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'pasted' CHECK (source IN ('oauth','pasted')),
    client_id TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // Synthetic UUID primary key so a later cross-network merge needn't repoint child rows;
  // `source_chat_id` is the Beeper-side identity. Pin/archive/mute/unread state is Beeper's own,
  // mirrored read-only. `type` is intentionally unconstrained (db.ddlParity.test.js forbids a
  // hardcoded enum) so a new Beeper chat type needs no constraint migration.
  `CREATE TABLE IF NOT EXISTS beeper_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id TEXT NOT NULL REFERENCES beeper_accounts (account_id) ON DELETE CASCADE,
    network TEXT NOT NULL DEFAULT '',
    source_chat_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'single',
    is_group BOOLEAN NOT NULL DEFAULT FALSE,
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    is_low_priority BOOLEAN NOT NULL DEFAULT FALSE,
    is_muted BOOLEAN NOT NULL DEFAULT FALSE,
    last_activity TIMESTAMPTZ,
    unread_count INTEGER NOT NULL DEFAULT 0,
    seen_at TIMESTAMPTZ,
    snooze_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (account_id, source_chat_id)
  )`,
  // Additive, for installs whose `beeper_conversations` predates the column. `seen_at` is the
  // LOCAL "seen in PortOS" watermark (#83): never written by the sweep nor mirrored from Beeper;
  // only opening a thread stamps it (`beeperConversations.markConversationSeen`). Unread badges
  // compare it against `COALESCE(last_activity, created_at)`; a watermark that zeroed
  // `unread_count` would be reverted by the next sweep, and a browser-only one would miss rail
  // aggregates and other devices. NULL = never opened in PortOS. NEVER writes to Beeper (no read
  // receipt crosses the wire).
  `ALTER TABLE beeper_conversations ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ`,
  // Beeper owns snooze state. NULL also covers older Desktop API versions.
  `ALTER TABLE beeper_conversations ADD COLUMN IF NOT EXISTS snooze_until TIMESTAMPTZ`,
  // Keyset-walk index: listConversations sorts on `COALESCE(last_activity, created_at)`, never
  // the raw column, so the index must be on that expression.
  `DROP INDEX IF EXISTS idx_beeper_conversations_account_activity`,
  // #81: the `created_at` fallback sorted activity-less chats at the TOP of the Inbox by their
  // shared mint time. `'epoch'::timestamptz` keeps the row-value keyset tuple shape (a real
  // `NULLS LAST` cannot) and sorts such chats LAST under `DESC`.
  `DROP INDEX IF EXISTS idx_beeper_conversations_activity_keyset`,
  `CREATE INDEX IF NOT EXISTS idx_beeper_conversations_activity_epoch_keyset ON beeper_conversations ((COALESCE(last_activity, 'epoch'::timestamptz)) DESC, id DESC)`,

  // Keyed on Beeper's own message id (TEXT; bridges don't guarantee a UUID). Full bodies persist
  // machine-local, per the store ADR.
  //
  // `is_sender` mirrors the API's `Message.isSender`, the ONLY reliable outbound/inbound signal:
  // `senderID` can't be compared with the local user because `accounts[].user.id` differs from it
  // on every network (#2).
  `CREATE TABLE IF NOT EXISTS beeper_messages (
    id TEXT PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES beeper_conversations (id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    sent_at TIMESTAMPTZ,
    edited_at TIMESTAMPTZ,
    unsent_at TIMESTAMPTZ,
    sort_key TEXT NOT NULL DEFAULT '',
    is_sender BOOLEAN NOT NULL DEFAULT FALSE,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  // Additive for installs whose `beeper_messages` predates the column (`CREATE TABLE IF NOT
  // EXISTS` is a no-op there). Default FALSE, not NULL: an unbackfilled row renders as inbound,
  // the right way round for a mostly-other-people mirror.
  `ALTER TABLE beeper_messages ADD COLUMN IF NOT EXISTS is_sender BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE beeper_messages ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch'`,
  // One index serves both thread pages (listMessages) and the per-conversation "latest message"
  // LATERAL: both order on `COALESCE(sent_at, created_at) DESC, id DESC` within a conversation.
  `DROP INDEX IF EXISTS idx_beeper_messages_conversation_sort`,
  `CREATE INDEX IF NOT EXISTS idx_beeper_messages_conversation_order ON beeper_messages (conversation_id, (COALESCE(sent_at, created_at)) DESC, id DESC)`,
  // Supports per-conversation id-ordered LATERAL probes in reconcileStoredMessages
  // without scanning other accounts or sorting full account message history.
  `CREATE INDEX IF NOT EXISTS idx_beeper_messages_conversation_id ON beeper_messages (conversation_id, id)`,

  // `observed_via` is required: the API truncates participant lists (20 in a listing, 100 in a
  // single-chat GET, no cursor), so a row set may be a subset and must not read as complete.
  // `tribe_person_id` is ON DELETE SET NULL: removing a Tribe person un-links the handle.
  `CREATE TABLE IF NOT EXISTS beeper_participants (
    conversation_id UUID NOT NULL REFERENCES beeper_conversations (id) ON DELETE CASCADE,
    source_user_id TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    handle TEXT NOT NULL DEFAULT '',
    tribe_person_id UUID REFERENCES tribe_people (id) ON DELETE SET NULL,
    observed_via TEXT NOT NULL CHECK (observed_via IN ('participant-list','message-sender')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (conversation_id, source_user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_beeper_participants_tribe_person ON beeper_participants (tribe_person_id) WHERE tribe_person_id IS NOT NULL`,

  // `(conversation_id, message_id, idx)` addresses one attachment. `mxc_id` is the DURABLE
  // source reference the byte mirror (#37) resolves via `GET /v1/assets/serve`; `srcURL` is NEVER
  // persisted (it decays; cache-state hint only). `keep` exempts an attachment from
  // least-recently-viewed eviction.
  `CREATE TABLE IF NOT EXISTS beeper_attachments (
    conversation_id UUID NOT NULL REFERENCES beeper_conversations (id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES beeper_messages (id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    mxc_id TEXT,
    mime_type TEXT NOT NULL DEFAULT '',
    byte_length BIGINT,
    file_name TEXT NOT NULL DEFAULT '',
    width INTEGER,
    height INTEGER,
    last_viewed_at TIMESTAMPTZ,
    keep BOOLEAN NOT NULL DEFAULT FALSE,
    local_path TEXT,
    fetched_at TIMESTAMPTZ,
    unavailable_at TIMESTAMPTZ,
    fetch_error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (conversation_id, message_id, idx)
  )`,
  // Attachment routes address a row by `(message_id, idx)`, but the PK leads with
  // `conversation_id`; this index leads with `message_id` to match.
  `CREATE INDEX IF NOT EXISTS idx_beeper_attachments_message ON beeper_attachments (message_id, idx)`,
  // Byte-mirror columns (#37), added for installs whose `beeper_attachments` predates them.
  // `local_path` is the store-relative path of the mirrored bytes
  // (`<sha256 prefix>/<sha256>.<ext>`); NULL (never '') while only the reference is held is the
  // lazy mirror's whole state machine. `unavailable_at`/`fetch_error` record a TERMINAL refusal
  // (502 on aged-out media, mapped to ASSET_UNAVAILABLE): it stops a re-fetch loop and exempts
  // the row from eviction, because bytes Beeper can no longer supply are the only copy.
  `ALTER TABLE beeper_attachments ADD COLUMN IF NOT EXISTS local_path TEXT`,
  `ALTER TABLE beeper_attachments ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ`,
  `ALTER TABLE beeper_attachments ADD COLUMN IF NOT EXISTS unavailable_at TIMESTAMPTZ`,
  `ALTER TABLE beeper_attachments ADD COLUMN IF NOT EXISTS fetch_error TEXT`,
  // `sha256` was never read back (the content-addressed path comes from the hash computed in
  // `streamAssetToStore`); only the column is dropped.
  `ALTER TABLE beeper_attachments DROP COLUMN IF EXISTS sha256`,
  `DROP INDEX IF EXISTS idx_beeper_attachments_sha256`,
  // Eviction sweep sums mirrored bytes and walks least-recently-viewed first among rows WITH
  // bytes (`evictToBudget` filters `local_path IS NOT NULL AND keep = FALSE AND unavailable_at
  // IS NULL AND mxc_id IS NOT NULL`, orders by `last_viewed_at ASC NULLS FIRST, fetched_at ASC
  // NULLS FIRST`; a never-viewed row is the BEST candidate). Predicate and NULLS placement must
  // match that query exactly or the index can't serve the ORDER BY.
  `CREATE INDEX IF NOT EXISTS idx_beeper_attachments_local ON beeper_attachments (local_path) WHERE local_path IS NOT NULL`,
  `DROP INDEX IF EXISTS idx_beeper_attachments_eviction`,
  `CREATE INDEX IF NOT EXISTS idx_beeper_attachments_eviction_candidates ON beeper_attachments (last_viewed_at ASC NULLS FIRST, fetched_at ASC NULLS FIRST) WHERE keep = FALSE AND local_path IS NOT NULL`,

  // `chat_id` is the Beeper-side chat id (= `source_chat_id`), not the synthetic
  // `beeper_conversations.id`: the backfill calls upstream by the source id and a cursor can
  // exist before the conversation row. Rows and cursor commit in one transaction (app-level contract).
  `CREATE TABLE IF NOT EXISTS beeper_sync_cursors (
    account_id TEXT NOT NULL REFERENCES beeper_accounts (account_id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL,
    cursor TEXT,
    last_activity TIMESTAMPTZ,
    last_swept_at TIMESTAMPTZ,
    PRIMARY KEY (account_id, chat_id)
  )`,

  // Machine-local rotating archive checkpoint, independent of forward ingestion.
  `CREATE TABLE IF NOT EXISTS beeper_reconcile_cursors (
    account_id TEXT PRIMARY KEY REFERENCES beeper_accounts (account_id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    upper_bound TEXT
  )`,

  `ALTER TABLE beeper_reconcile_cursors ADD COLUMN IF NOT EXISTS upper_bound TEXT`,

  // The outbound OUTBOX (#36). A row is written BEFORE the `POST /v1/chats/{chatID}/messages`
  // so intent survives a crash and one row serializes a double-click.
  //
  // `chat_id` is denormalized from `source_chat_id` so the row stays a record of what was sent
  // if the mirror row is replaced. `pending_message_id` is what the async send returns;
  // `message_id` is the id the confirmation settles on; distinct so an unconfirmed send stays
  // distinguishable.
  //
  // The state CHECK is deliberate: these are PortOS's own state machine, not a growing Beeper
  // vocabulary. `draft` has no writer yet (composer buffer is client-side); the send gate keys
  // on `approved`. A failed row is never retried: Beeper has no send idempotency key, so a
  // re-send is a NEW row.
  `CREATE TABLE IF NOT EXISTS beeper_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES beeper_conversations (id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL,
    body TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','approved','sending','awaiting-confirmation','sent','failed')),
    pending_message_id TEXT,
    message_id TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    approved_at TIMESTAMPTZ,
    send_requested_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `ALTER TABLE beeper_outbox ADD COLUMN IF NOT EXISTS send_requested_at TIMESTAMPTZ`,
  `CREATE INDEX IF NOT EXISTS idx_beeper_outbox_conversation_state ON beeper_outbox (conversation_id, state, created_at DESC)`,

  // #96 backfill — one idempotent statement, LAST in this array because it reads
  // `beeper_participants` and `tribe_identities` (created by the earlier `tribeDdl` list).
  // It promotes hand-made participant links that exist ONLY in the
  // `beeper_participants.tribe_person_id` cache to durable `kind='beeper-user'` claims, so a
  // purge + resweep can't lose them. No-op on a fresh database.
  //
  //   - The `NOT EXISTS` guard makes it ONE-SHOT: `ensureSchema()` re-runs the whole list per
  //     service call, and the uncorrelated subquery skips the join once ANY beeper-user claim
  //     exists (the app writes one on every link).
  //   - `ON CONFLICT DO NOTHING`: `linkParticipant` is the authority; never overwrite its claims.
  //   - `DISTINCT ON` + `ORDER BY updated_at DESC`: the most recent link wins when one Beeper
  //     user was linked to different people in different conversations.
  //   - The `tribe_people` join drops soft-deleted persons (no FK cascade fires), so a purge
  //     doesn't resurrect a link to a deleted person.
  `INSERT INTO tribe_identities (person_id, kind, network, handle, source, linked_at)
   SELECT DISTINCT ON (c.account_id, p.source_user_id)
          p.tribe_person_id, 'beeper-user', c.account_id, p.source_user_id, 'backfill', NOW()
   FROM beeper_participants p
   JOIN beeper_conversations c ON c.id = p.conversation_id
   JOIN tribe_people tp ON tp.id = p.tribe_person_id AND tp.deleted = FALSE
   WHERE p.tribe_person_id IS NOT NULL AND c.account_id <> ''
     AND NOT EXISTS (SELECT 1 FROM tribe_identities WHERE kind = 'beeper-user')
   ORDER BY c.account_id, p.source_user_id, p.updated_at DESC
   ON CONFLICT (kind, network, handle) DO NOTHING`,
];
