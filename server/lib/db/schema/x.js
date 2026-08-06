// X account diagnostics and review-gated draft handoffs. Reads use the managed
// browser and store only bounded public snapshots; PortOS never stores an X
// password or publishes automatically.
export const xDdl = [
  `CREATE TABLE IF NOT EXISTS x_accounts (
    id UUID PRIMARY KEY,
    label TEXT NOT NULL,
    username TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    notes TEXT NOT NULL DEFAULT '',
    profile_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_sync_at TIMESTAMPTZ,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (username)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_x_accounts_username_ci ON x_accounts (LOWER(username))`,
  `CREATE TABLE IF NOT EXISTS x_posts (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES x_accounts (id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'post' CHECK (kind IN ('post','reply')),
    body TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    remote_created_at TIMESTAMPTZ,
    impressions INTEGER,
    engagements INTEGER,
    replies INTEGER NOT NULL DEFAULT 0,
    reposts INTEGER NOT NULL DEFAULT 0,
    likes INTEGER NOT NULL DEFAULT 0,
    bookmarks INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (account_id, remote_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_x_posts_account_received ON x_posts (account_id, received_at DESC)`,
  `CREATE TABLE IF NOT EXISTS x_drafts (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES x_accounts (id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','pending_review','approved','rejected','opened')),
    review_note TEXT NOT NULL DEFAULT '',
    result JSONB NOT NULL DEFAULT '{}'::jsonb,
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_x_drafts_account_state ON x_drafts (account_id, state, created_at DESC)`,
];
