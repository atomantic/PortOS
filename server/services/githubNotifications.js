/**
 * GitHub notifications inbox (#12870): fetch each account's notification
 * threads into Postgres and apply the operator's one-tap thread actions.
 *
 * Only metadata is fetched (repo, reason, subject title/type); no thread body
 * or linked page is ever read here, and no model sees any of it. Triage and
 * automations build on these rows in later phases.
 */
import { query, withTransaction } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { createSingleFlight } from '../lib/singleFlight.js';
import {
  linkHeaderHasNext,
  parseGhIncludeOutput,
  pollIntervalSeconds,
  toNotificationRecord,
} from '../lib/githubNotificationParse.js';
import { execGh } from './github.js';
import { getAccount, listAccounts, resolveGitHubAccountEnv } from './githubAccounts.js';

const GH_TIMEOUT_MS = 30_000;
const PER_PAGE = 50;
// GitHub lists at most 50 threads a page; past 250 unread the listing is
// truncated and read-state is not reconciled for threads it did not return.
const MAX_PAGES = 5;
const LIST_LIMIT = 200;

export const NOTIFICATION_VIEWS = Object.freeze(['needs-you', 'handled', 'all']);
export const NOTIFICATION_ACTIONS = Object.freeze(['read', 'done', 'reopen', 'mute', 'unsubscribe', 'resubscribe']);

// method + path suffix + fields for each operator action; the state it leaves
// the stored row in. Thread ids are digits-only (validated at the route).
// `reopen` is local only: re-subscribing a done thread would opt into all of
// its future activity when the notification was a one-off mention.
const ACTION_SPECS = {
  reopen: { method: null, path: '', fields: [], state: 'open' },
  read: { method: 'PATCH', path: '', fields: [], state: null },
  done: { method: 'DELETE', path: '', fields: [], state: 'done' },
  mute: { method: 'PUT', path: '/subscription', fields: ['-F', 'ignored=true'], state: 'muted' },
  unsubscribe: { method: 'DELETE', path: '/subscription', fields: [], state: 'unsubscribed' },
  resubscribe: { method: 'PUT', path: '/subscription', fields: ['-F', 'ignored=false'], state: 'open' },
};

const syncFlight = createSingleFlight();

const isNotModified = (error) => /\bHTTP 304\b/.test(String(error?.ghStderr || error?.message || ''));

async function requireAccountEnv(account) {
  if (!account.enabled) {
    throw new ServerError(`${account.label} is turned off`, { status: 409, code: 'GITHUB_ACCOUNT_DISABLED' });
  }
  const { env, status } = await resolveGitHubAccountEnv(account);
  if (!env) {
    throw new ServerError(`gh cannot act as ${account.label} (${status}). Check the Accounts tab.`, {
      status: 409, code: 'GITHUB_ACCOUNT_UNAVAILABLE',
    });
  }
  return env;
}

async function fetchPage(account, env, page, ifModifiedSince) {
  const args = ['api', '--hostname', account.host, '--include', '--method', 'GET',
    `notifications?per_page=${PER_PAGE}&page=${page}`];
  if (ifModifiedSince) args.push('-H', `If-Modified-Since: ${ifModifiedSince}`);
  const output = await execGh(args, GH_TIMEOUT_MS, { env }).catch((error) => {
    if (ifModifiedSince && isNotModified(error)) return null;
    throw error;
  });
  if (output === null) return { notModified: true };
  const parsed = parseGhIncludeOutput(output);
  const threads = parsed ? safeJSONParse(parsed.body, null) : null;
  if (!parsed || !Array.isArray(threads)) {
    throw new ServerError(`GitHub returned an unreadable notification listing for ${account.label}`, {
      status: 502, code: 'GITHUB_NOTIFICATIONS_UNPARSEABLE',
    });
  }
  return { notModified: false, threads, headers: parsed.headers };
}

const UPSERT_SQL = `INSERT INTO github_notifications (
    account_id, thread_id, repo_full_name, repo_owner, repo_private, reason, subject_type,
    subject_title, subject_api_url, html_url, unread, gh_updated_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  ON CONFLICT (account_id, thread_id) DO UPDATE SET
    repo_full_name = EXCLUDED.repo_full_name,
    repo_owner = EXCLUDED.repo_owner,
    repo_private = EXCLUDED.repo_private,
    reason = EXCLUDED.reason,
    subject_type = EXCLUDED.subject_type,
    subject_title = EXCLUDED.subject_title,
    subject_api_url = EXCLUDED.subject_api_url,
    html_url = EXCLUDED.html_url,
    unread = EXCLUDED.unread,
    -- New activity brings back a thread marked done, and an unsubscribed one
    -- (GitHub re-subscribes on a fresh mention or review request). Muted stays.
    state = CASE WHEN github_notifications.state IN ('done', 'unsubscribed') AND EXCLUDED.gh_updated_at > github_notifications.gh_updated_at
      THEN 'open' ELSE github_notifications.state END,
    gh_updated_at = EXCLUDED.gh_updated_at,
    updated_at = NOW()`;

async function recordSyncError(accountId, message) {
  await query(
    `INSERT INTO github_notification_sync (account_id, last_error, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (account_id) DO UPDATE SET last_error = EXCLUDED.last_error, updated_at = NOW()`,
    [accountId, String(message).slice(0, 2000)],
  );
}

async function syncAccountNow(account) {
  const env = await requireAccountEnv(account);
  const cursor = (await query('SELECT last_modified FROM github_notification_sync WHERE account_id = $1', [account.id])).rows[0];
  const first = await fetchPage(account, env, 1, cursor?.last_modified || null);
  if (first.notModified) {
    await query('UPDATE github_notification_sync SET last_sync_at = NOW(), last_error = \'\', updated_at = NOW() WHERE account_id = $1', [account.id]);
    return { accountId: account.id, changed: false, fetched: 0 };
  }
  const threads = [...first.threads];
  let page = first;
  let pageNumber = 1;
  while (linkHeaderHasNext(page.headers.link) && pageNumber < MAX_PAGES) {
    pageNumber += 1;
    page = await fetchPage(account, env, pageNumber, null);
    threads.push(...page.threads);
  }
  const truncated = linkHeaderHasNext(page.headers.link);
  const records = threads.map((thread) => toNotificationRecord(thread, account.host)).filter(Boolean);

  await withTransaction(async (client) => {
    for (const r of records) {
      await client.query(UPSERT_SQL, [
        account.id, r.threadId, r.repoFullName, r.repoOwner, r.repoPrivate, r.reason, r.subjectType,
        r.subjectTitle, r.subjectApiUrl, r.htmlUrl, r.unread, r.ghUpdatedAt,
      ]);
    }
    // The listing holds only unread threads; one that dropped out was read
    // elsewhere. A truncated listing proves nothing about the rest.
    if (!truncated) {
      await client.query(
        'UPDATE github_notifications SET unread = FALSE, updated_at = NOW() WHERE account_id = $1 AND unread AND NOT (thread_id = ANY($2::text[]))',
        [account.id, records.map((r) => r.threadId)],
      );
    }
    await client.query(
      `INSERT INTO github_notification_sync (account_id, last_modified, poll_interval_seconds, last_sync_at, last_error, updated_at)
       VALUES ($1, $2, $3, NOW(), '', NOW())
       ON CONFLICT (account_id) DO UPDATE SET last_modified = EXCLUDED.last_modified,
         poll_interval_seconds = EXCLUDED.poll_interval_seconds, last_sync_at = NOW(), last_error = '', updated_at = NOW()`,
      [account.id, first.headers['last-modified'] || null, pollIntervalSeconds(first.headers['x-poll-interval'])],
    );
  });
  console.log(`📬 Synced ${records.length} GitHub notifications for ${account.host}${truncated ? ' (listing truncated)' : ''}`);
  return { accountId: account.id, changed: true, fetched: records.length, truncated };
}

/** Fetch one account's unread notifications, coalescing concurrent requests. */
export async function syncAccountNotifications(accountId) {
  const account = await getAccount(accountId);
  return syncFlight.run(account.id, () => syncAccountNow(account).catch(async (error) => {
    await recordSyncError(account.id, error.message).catch(() => {});
    throw error;
  }));
}

/** Sync every enabled account; one account's failure never hides another's result. */
export async function syncAllNotifications() {
  const accounts = (await listAccounts()).filter((account) => account.enabled);
  const results = [];
  for (const account of accounts) {
    results.push(await syncAccountNotifications(account.id)
      .then((result) => ({ ...result, ok: true }))
      .catch((error) => ({ accountId: account.id, ok: false, error: error.message })));
  }
  return results;
}

const VIEW_FILTERS = {
  'needs-you': "state = 'open'",
  handled: "state <> 'open'",
  all: 'TRUE',
};

const toApi = (row, accountsById) => {
  const account = accountsById.get(row.account_id);
  const login = account?.login?.toLowerCase();
  return {
    accountId: row.account_id,
    threadId: row.thread_id,
    repoFullName: row.repo_full_name,
    repoPrivate: row.repo_private,
    yourRepo: Boolean(login) && row.repo_owner.toLowerCase() === login,
    reason: row.reason,
    subjectType: row.subject_type,
    title: row.subject_title,
    htmlUrl: row.html_url,
    unread: row.unread,
    state: row.state,
    updatedAt: row.gh_updated_at instanceof Date ? row.gh_updated_at.toISOString() : row.gh_updated_at,
  };
};

export async function listNotifications({ accountId = null, view = 'needs-you' } = {}) {
  const accounts = await listAccounts();
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const ids = accountId ? [accountId] : accounts.map((account) => account.id);
  const [rows, syncRows] = await Promise.all([
    query(
      `SELECT * FROM github_notifications WHERE account_id = ANY($1::text[]) AND ${VIEW_FILTERS[view]}
       ORDER BY gh_updated_at DESC LIMIT ${LIST_LIMIT}`,
      [ids],
    ),
    query('SELECT account_id, last_sync_at, last_error, poll_interval_seconds FROM github_notification_sync WHERE account_id = ANY($1::text[])', [ids]),
  ]);
  return {
    notifications: rows.rows.map((row) => toApi(row, accountsById)),
    sync: Object.fromEntries(syncRows.rows.map((row) => [row.account_id, {
      lastSyncAt: row.last_sync_at instanceof Date ? row.last_sync_at.toISOString() : row.last_sync_at,
      lastError: row.last_error || null,
      pollIntervalSeconds: row.poll_interval_seconds,
    }])),
  };
}

/** Apply one operator action to a thread on GitHub, then mirror it locally. */
export async function applyNotificationAction(accountId, threadId, action) {
  const spec = ACTION_SPECS[action];
  const account = await getAccount(accountId);
  const existing = (await query('SELECT * FROM github_notifications WHERE account_id = $1 AND thread_id = $2', [account.id, threadId])).rows[0];
  if (!existing) {
    throw new ServerError('Notification not found', { status: 404, code: 'GITHUB_NOTIFICATION_NOT_FOUND' });
  }
  if (spec.method) {
    const env = await requireAccountEnv(account);
    await execGh(
      ['api', '--hostname', account.host, '--method', spec.method, `notifications/threads/${threadId}${spec.path}`, ...spec.fields],
      GH_TIMEOUT_MS,
      { env },
    );
  }
  const result = await query(
    `UPDATE github_notifications SET
       unread = CASE WHEN $3::text IN ('read','done') THEN FALSE ELSE unread END,
       state = COALESCE($4::text, state),
       state_changed_at = CASE WHEN $4::text IS NULL THEN state_changed_at ELSE NOW() END,
       updated_at = NOW()
     WHERE account_id = $1 AND thread_id = $2 RETURNING *`,
    [account.id, threadId, action, spec.state],
  );
  return toApi(result.rows[0], new Map([[account.id, account]]));
}
