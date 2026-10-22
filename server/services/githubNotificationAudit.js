/**
 * Subscription audit for the GitHub notifications inbox (#12873): compare the
 * last 30 days of stored threads with what was done about them, and offer
 * one-tap changes (unwatch a repo, mute its handled threads) plus links for
 * settings the API cannot change. Nothing is applied without a tap, and every
 * applied change is logged with Undo. Accounts can opt in to a monthly report
 * of the same suggestions as a PortOS notification.
 */
import { query } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { AUDIT_WINDOW_DAYS, buildAuditSuggestions } from '../lib/githubNotificationAudit.js';
import { toPgJson } from '../lib/pgJson.js';
import { execGh } from './github.js';
import { getAccount, listAccounts, resolveGitHubAccountEnv } from './githubAccounts.js';
import { applyNotificationAction } from './githubNotifications.js';
import { addNotification, NOTIFICATION_TYPES, PRIORITY_LEVELS } from './notifications.js';

const GH_TIMEOUT_MS = 30_000;
const REPORT_EVERY_MS = AUDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

// The last audit per account. Rebuilt by running the audit again; it holds
// counts and repo names only.
const lastAudits = new Map();

async function accountEnv(account) {
  const { env, status } = await resolveGitHubAccountEnv(account);
  if (!env) {
    throw new ServerError(`gh cannot act as ${account.label} (${status}). Check the Accounts tab.`, { status: 409, code: 'GITHUB_ACCOUNT_UNAVAILABLE' });
  }
  return env;
}

// Audit mutes and their undo are logged as operator events tagged `via`; they
// are not the operator acting on a thread, so they never count as acted.
const OUTCOMES_SQL = `
  WITH recent AS (
    SELECT n.thread_id, n.repo_full_name, n.reason, n.decision, n.state,
      EXISTS (SELECT 1 FROM github_notification_events e
              WHERE e.account_id = n.account_id AND e.thread_id = n.thread_id AND e.actor = 'operator'
                AND COALESCE(e.detail->>'via', '') NOT IN ('audit', 'audit-undo')) AS operator_acted,
      EXISTS (SELECT 1 FROM github_notification_events e
              WHERE e.account_id = n.account_id AND e.thread_id = n.thread_id AND e.actor = 'automation' AND e.kind <> 'triaged') AS automation_acted
    FROM github_notifications n
    -- A global advisory names no repo, so there is no repo to watch or mute.
    WHERE n.account_id = $1 AND n.repo_full_name <> '' AND n.gh_updated_at > NOW() - make_interval(days => $2)
  )
  SELECT repo_full_name, reason, COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE operator_acted)::int AS acted,
    COUNT(*) FILTER (WHERE decision = 'handled-by-pr-workflow' OR automation_acted)::int AS handled,
    COALESCE(array_agg(thread_id ORDER BY thread_id) FILTER (WHERE decision = 'handled-by-pr-workflow' AND state = 'open'), '{}') AS handled_open
  FROM recent GROUP BY repo_full_name, reason`;

/** Full names of the repos the account watches, or null when GitHub would not list them. */
async function listWatchedRepos(account, env) {
  const out = await execGh(
    ['api', '--hostname', account.host, '--method', 'GET', 'user/subscriptions?per_page=100', '--paginate', '--jq', '.[].full_name'],
    GH_TIMEOUT_MS,
    { env },
  ).catch((error) => {
    console.log(`⏭️ Could not list watched repos for ${account.host}: ${error.message}`);
    return null;
  });
  return out === null ? null : out.split('\n').map((line) => line.trim()).filter((line) => REPO_RE.test(line));
}

// Only an unwatch stays applied across audits; a later audit's mute-handled
// card lists threads that are still open, so it is always new work.
async function openChanges(accountId) {
  const { rows } = await query(
    "SELECT kind, repo_full_name FROM github_notification_audit_changes WHERE account_id = $1 AND kind = 'unwatch' AND undone_at IS NULL",
    [accountId],
  );
  return new Set(rows.map((row) => `${row.kind}:${row.repo_full_name}`));
}

const withApplied = (audit, applied) => ({
  ...audit,
  suggestions: audit.suggestions.map((suggestion) => ({ ...suggestion, applied: Boolean(suggestion.applied) || applied.has(suggestion.id) })),
});

export async function runAccountAudit(accountId) {
  const account = await getAccount(accountId);
  const env = await accountEnv(account);
  const watchedRepos = await listWatchedRepos(account, env);
  const { rows } = await query(OUTCOMES_SQL, [account.id, AUDIT_WINDOW_DAYS]);
  const groups = rows.map((row) => ({
    repo: row.repo_full_name, reason: row.reason, total: row.total, acted: row.acted, handled: row.handled, handledOpen: row.handled_open,
  }));
  const audit = {
    accountId: account.id,
    accountLabel: account.label,
    ranAt: new Date().toISOString(),
    windowDays: AUDIT_WINDOW_DAYS,
    watchedListed: watchedRepos !== null,
    ...buildAuditSuggestions({ groups, watchedRepos, host: account.host }),
  };
  lastAudits.set(account.id, audit);
  console.log(`🔎 Audited GitHub notifications for ${account.host}: ${audit.summary.total} threads, ${audit.suggestions.length} suggestions`);
  return withApplied(audit, await openChanges(account.id));
}

export async function getLastAudit(accountId) {
  const account = await getAccount(accountId);
  const audit = lastAudits.get(account.id);
  return audit ? withApplied(audit, await openChanges(account.id)) : null;
}

/** Apply one audit card. Only a change the latest audit offered can be applied. */
export async function applyAuditSuggestion(accountId, suggestionId) {
  const account = await getAccount(accountId);
  const suggestion = lastAudits.get(account.id)?.suggestions.find((entry) => entry.id === suggestionId && entry.apply);
  if (!suggestion) throw new ServerError('Run the audit again; that suggestion is not in the latest one', { status: 409, code: 'GITHUB_AUDIT_STALE' });
  if (suggestion.applied || (await openChanges(account.id)).has(suggestion.id)) throw new ServerError('Already applied', { status: 409, code: 'GITHUB_AUDIT_APPLIED' });
  let detail = {};
  if (suggestion.kind === 'unwatch') {
    const env = await accountEnv(account);
    await execGh(['api', '--hostname', account.host, '--method', 'DELETE', `repos/${suggestion.repo}/subscription`], GH_TIMEOUT_MS, { env });
  } else {
    const muted = [];
    for (const threadId of suggestion.threadIds) {
      // A thread that is already gone from the inbox is skipped, not fatal.
      const ok = await applyNotificationAction(account.id, threadId, 'mute', { detail: { via: 'audit' }, learn: false })
        .then(() => true)
        .catch((error) => {
          console.log(`⏭️ Audit mute skipped thread ${threadId}: ${error.message}`);
          return false;
        });
      if (ok) muted.push(threadId);
    }
    detail = { threadIds: muted };
  }
  suggestion.applied = true;
  const { rows } = await query(
    'INSERT INTO github_notification_audit_changes (account_id, kind, repo_full_name, detail) VALUES ($1, $2, $3, $4::jsonb) RETURNING id',
    [account.id, suggestion.kind, suggestion.repo, toPgJson(detail)],
  );
  return { id: String(rows[0].id), kind: suggestion.kind, repo: suggestion.repo, ...detail };
}

export async function listAuditChanges() {
  const accounts = await listAccounts();
  const labels = new Map(accounts.map((account) => [account.id, account.label]));
  const { rows } = await query(
    'SELECT * FROM github_notification_audit_changes WHERE account_id = ANY($1::text[]) ORDER BY applied_at DESC, id DESC LIMIT 100',
    [accounts.map((account) => account.id)],
  );
  return rows.map((row) => ({
    id: String(row.id),
    accountId: row.account_id,
    accountLabel: labels.get(row.account_id) || row.account_id,
    kind: row.kind,
    repo: row.repo_full_name,
    threadCount: Array.isArray(row.detail?.threadIds) ? row.detail.threadIds.length : null,
    appliedAt: row.applied_at instanceof Date ? row.applied_at.toISOString() : row.applied_at,
    undone: Boolean(row.undone_at),
  }));
}

/** Re-watch the repo, or re-subscribe the muted threads. */
export async function undoAuditChange(id) {
  const change = (await query('SELECT * FROM github_notification_audit_changes WHERE id = $1', [id])).rows[0];
  if (!change) throw new ServerError('Audit change not found', { status: 404, code: 'GITHUB_AUDIT_CHANGE_NOT_FOUND' });
  if (change.undone_at) throw new ServerError('Already undone', { status: 409, code: 'GITHUB_AUDIT_CHANGE_UNDONE' });
  const account = await getAccount(change.account_id);
  if (change.kind === 'unwatch') {
    const env = await accountEnv(account);
    await execGh(['api', '--hostname', account.host, '--method', 'PUT', `repos/${change.repo_full_name}/subscription`, '-F', 'subscribed=true'], GH_TIMEOUT_MS, { env });
  } else {
    for (const threadId of change.detail?.threadIds || []) {
      await applyNotificationAction(account.id, threadId, 'resubscribe', { detail: { via: 'audit-undo' }, learn: false }).catch((error) => {
        console.log(`⏭️ Audit undo skipped thread ${threadId}: ${error.message}`);
      });
    }
  }
  await query('UPDATE github_notification_audit_changes SET undone_at = NOW() WHERE id = $1', [id]);
  return { id: String(id), undone: true };
}

/**
 * The optional monthly report (#12874): for each enabled account that opted
 * in, run the audit at most once per audit window and send its open
 * suggestions as a PortOS notification. It only suggests; applying still
 * takes a tap on the Audit tab. A report with no suggestions sends nothing.
 */
export async function sendDueAuditReports({ now = Date.now() } = {}) {
  const accounts = (await listAccounts()).filter((account) => account.enabled && account.mode !== 'disabled' && account.auditReport === true);
  if (!accounts.length) return [];
  const { rows } = await query(
    'SELECT account_id, last_sent_at FROM github_notification_audit_reports WHERE account_id = ANY($1::text[])',
    [accounts.map((account) => account.id)],
  );
  const lastSent = new Map(rows.map((row) => [row.account_id, new Date(row.last_sent_at).getTime()]));
  const results = [];
  for (const account of accounts) {
    if (now - (lastSent.get(account.id) ?? 0) < REPORT_EVERY_MS) continue;
    const audit = await runAccountAudit(account.id).catch((error) => {
      console.log(`⏭️ Monthly GitHub audit for ${account.host} skipped: ${error.message}`);
      return null;
    });
    if (!audit) continue;
    const open = audit.suggestions.filter((suggestion) => !suggestion.applied);
    if (open.length) {
      await addNotification({
        type: NOTIFICATION_TYPES.GITHUB_AUDIT,
        title: `GitHub audit: ${open.length} suggestion${open.length === 1 ? '' : 's'} for ${account.label}`,
        description: `From the last ${audit.windowDays} days of notifications. Nothing changes until you tap Apply.`,
        priority: PRIORITY_LEVELS.LOW,
        link: `/devtools/github/audit?account=${encodeURIComponent(account.id)}`,
        metadata: { accountId: account.id },
      });
    }
    await query(
      `INSERT INTO github_notification_audit_reports (account_id, last_sent_at) VALUES ($1, $2)
       ON CONFLICT (account_id) DO UPDATE SET last_sent_at = EXCLUDED.last_sent_at`,
      [account.id, new Date(now).toISOString()],
    );
    results.push({ accountId: account.id, suggestions: open.length });
  }
  return results;
}
