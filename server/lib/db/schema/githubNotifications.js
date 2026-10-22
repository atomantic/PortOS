// GitHub notifications inbox (#12870). Machine-local mirror of each configured
// GitHub account's notification threads (`data/github-accounts.json`), plus
// the per-account fetch cursor. NEVER FEDERATED: which threads a login sees is
// a property of that login on that machine, and triage state written by one
// machine's automations must not replay on another.
//
// Thread text is metadata GitHub sends (repo, reason, subject title/type and
// API urls); bodies are never stored here. `state` is the operator's (or a
// later automation's) disposition; `unread` mirrors GitHub.
export const githubNotificationsDdl = [
  `CREATE TABLE IF NOT EXISTS github_notifications (
    account_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    repo_full_name TEXT NOT NULL,
    repo_owner TEXT NOT NULL DEFAULT '',
    repo_private BOOLEAN NOT NULL DEFAULT FALSE,
    reason TEXT NOT NULL DEFAULT '',
    subject_type TEXT NOT NULL DEFAULT '',
    subject_title TEXT NOT NULL DEFAULT '',
    subject_api_url TEXT,
    html_url TEXT NOT NULL DEFAULT '',
    unread BOOLEAN NOT NULL DEFAULT TRUE,
    gh_updated_at TIMESTAMPTZ NOT NULL,
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','done','muted','unsubscribed')),
    state_changed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (account_id, thread_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_github_notifications_account_updated ON github_notifications (account_id, gh_updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS github_notification_sync (
    account_id TEXT PRIMARY KEY,
    last_modified TEXT,
    poll_interval_seconds INTEGER,
    last_sync_at TIMESTAMPTZ,
    last_error TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
];
