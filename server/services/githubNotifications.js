/**
 * GitHub notifications inbox (#12870): fetch each account's notification
 * threads into Postgres and apply the operator's one-tap thread actions.
 *
 * Only metadata is fetched here (repo, reason, subject title/type); no thread
 * body or linked page is read and no model sees any of it. Triage decides from
 * metadata; only an account switched to Assist has its undecided threads'
 * text screened and sorted (githubNotificationAssist.js).
 */
import { query, withTransaction } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { createSingleFlight } from '../lib/singleFlight.js';
import { GITHUB_NOTIFICATION_CADENCES } from '../lib/validation.js';
import {
  linkHeaderHasNext,
  parseGhIncludeOutput,
  pollIntervalSeconds,
  toNotificationRecord,
} from '../lib/githubNotificationParse.js';
import { execGh } from './github.js';
import { getAccount, listAccounts, resolveGitHubAccountEnv } from './githubAccounts.js';
import { githubNotificationEvents } from './githubNotificationEvents.js';
import { triageAccountNotifications } from './githubNotificationTriage.js';
import { assistAccountNotifications } from './githubNotificationAssist.js';
import { agentHandoff, HANDLED_DECISIONS, learnedDecisionForAction } from '../lib/githubNotificationTriage.js';
import { toPgJson } from '../lib/pgJson.js';

const GH_TIMEOUT_MS = 30_000;
const PER_PAGE = 50;
// GitHub lists at most 50 threads a page; past 250 unread the listing is
// truncated and read-state is not reconciled for threads it did not return.
const MAX_PAGES = 5;
const LIST_LIMIT = 200;

export const NOTIFICATION_VIEWS = Object.freeze(['needs-you', 'suspect', 'handled', 'all']);
// GitHub's floor between notification polls when it sends no X-Poll-Interval.
const MIN_POLL_SECONDS = 60;
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

// One flight per account, exclusive across its keys: a sync that may run
// Assist/Autopilot never joins (or overlaps) a fetch-only one, and vice versa.
const syncFlights = new Map();
const syncFlightFor = (accountId) => {
  if (!syncFlights.has(accountId)) syncFlights.set(accountId, createSingleFlight({ exclusive: true }));
  return syncFlights.get(accountId);
};

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
    subject_title, subject_api_url, html_url, unread, gh_updated_at, latest_comment_api_url
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
  ON CONFLICT (account_id, thread_id) DO UPDATE SET
    repo_full_name = EXCLUDED.repo_full_name,
    repo_owner = EXCLUDED.repo_owner,
    repo_private = EXCLUDED.repo_private,
    reason = EXCLUDED.reason,
    subject_type = EXCLUDED.subject_type,
    subject_title = EXCLUDED.subject_title,
    subject_api_url = EXCLUDED.subject_api_url,
    html_url = EXCLUDED.html_url,
    latest_comment_api_url = EXCLUDED.latest_comment_api_url,
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

// A sync requested without host control (#12952) fetches and triages only.
const SKIPPED_AUTOMATION = Object.freeze({ sorted: 0, acted: 0, handedOff: 0, agentRuns: 0, skipped: 'no-host-control' });

// Autopilot hands threads to their lanes first, so a thread a lane now owns
// is not also sorted by Assist. Loaded lazily: the hand-off reaches the CoS
// task schedule, which itself registers this module's scheduled check.
async function runAutomation(account, env, automate) {
  if (!automate) return SKIPPED_AUTOMATION;
  const autopilot = account.mode === 'autopilot'
    ? await (await import('./githubNotificationAutopilot.js')).autopilotAccountNotifications(account)
    : { handedOff: 0, agentRuns: 0 };
  const assist = await assistAccountNotifications(account, env, {
    act: (threadId, action, detail) => applyNotificationAction(account.id, threadId, action, { actor: 'automation', detail }),
  });
  return { ...assist, handedOff: autopilot.handedOff, agentRuns: autopilot.agentRuns };
}

async function syncAccountNow(account, automate) {
  const env = await requireAccountEnv(account);
  const cursor = (await query('SELECT last_modified FROM github_notification_sync WHERE account_id = $1', [account.id])).rows[0];
  const first = await fetchPage(account, env, 1, cursor?.last_modified || null);
  if (first.notModified) {
    await query('UPDATE github_notification_sync SET last_sync_at = NOW(), last_error = \'\', updated_at = NOW() WHERE account_id = $1', [account.id]);
    // Threads past the last run's triage cap still need a decision.
    const triage = await triageAccountNotifications(account, env);
    const assist = await runAutomation(account, env, automate);
    if (triage.triaged || assist.sorted || assist.acted || assist.handedOff) githubNotificationEvents.emit('changed', { accountId: account.id });
    return { accountId: account.id, changed: false, fetched: 0, triage, assist };
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
        r.subjectTitle, r.subjectApiUrl, r.htmlUrl, r.unread, r.ghUpdatedAt, r.latestCommentApiUrl,
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
  const triage = await triageAccountNotifications(account, env);
  const assist = await runAutomation(account, env, automate);
  githubNotificationEvents.emit('changed', { accountId: account.id });
  console.log(`📬 Synced ${records.length} GitHub notifications for ${account.host}${truncated ? ' (listing truncated)' : ''}, triaged ${triage.triaged}, sorted ${assist.sorted}, acted on ${assist.acted}, handed off ${assist.handedOff}`);
  return { accountId: account.id, changed: true, fetched: records.length, truncated, triage, assist };
}

/**
 * Fetch one account's unread notifications, coalescing concurrent requests.
 * `automate: false` (a caller without host control) skips Assist/Autopilot.
 */
export async function syncAccountNotifications(accountId, { automate = true } = {}) {
  const account = await getAccount(accountId);
  return syncFlightFor(account.id).run(automate, () => syncAccountNow(account, automate).catch(async (error) => {
    await recordSyncError(account.id, error.message).catch(() => {});
    throw error;
  }));
}

/** Sync every enabled account; one account's failure never hides another's result. */
export async function syncAllNotifications(options = {}) {
  const accounts = (await listAccounts()).filter((account) => account.enabled);
  const results = [];
  for (const account of accounts) {
    results.push(await syncAccountNotifications(account.id, options)
      .then((result) => ({ ...result, ok: true }))
      .catch((error) => ({ accountId: account.id, ok: false, error: error.message })));
  }
  return results;
}

// A thread with nothing left for you (something else has it, or it is closed
// or merged) is Handled while it is still open on GitHub.
const HANDLED_SQL = `decision IN (${HANDLED_DECISIONS.map((decision) => `'${decision}'`).join(', ')})`;
const VIEW_FILTERS = {
  'needs-you': `state = 'open' AND NOT suspect AND (decision IS NULL OR NOT ${HANDLED_SQL})`,
  suspect: "state = 'open' AND suspect",
  handled: `(state <> 'open' OR (NOT suspect AND ${HANDLED_SQL}))`,
  all: 'TRUE',
};

const toIso = (value) => (value instanceof Date ? value.toISOString() : value);

// The lane Resolve with agent would use, and why it cannot when refused.
const agentView = (account, row) => {
  const plan = account ? agentHandoff({ account, row }) : null;
  return plan ? { lane: plan.lane, refused: plan.refused || null } : null;
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
    decision: row.decision || null,
    trust: row.trust || null,
    suspect: row.suspect === true,
    rule: row.evidence?.rule || null,
    signals: Array.isArray(row.evidence?.signals) ? row.evidence.signals : [],
    agent: agentView(account, row),
    updatedAt: toIso(row.gh_updated_at),
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
      lastSyncAt: toIso(row.last_sync_at),
      lastError: row.last_error || null,
      pollIntervalSeconds: row.poll_interval_seconds,
    }])),
  };
}

/**
 * Teach a learned rule from an operator action that disagrees with the
 * thread's decision, and move the thread to that decision so Assist does not
 * act on it again.
 */
async function learnFromOperator(client, row, action) {
  const lesson = learnedDecisionForAction(action);
  if (!lesson || row.suspect || row.decision === lesson) return;
  await client.query(
    `INSERT INTO github_notification_rules (account_id, repo_full_name, reason, actor, decision) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (account_id, repo_full_name, reason, actor) DO UPDATE SET
       hits = CASE WHEN github_notification_rules.decision = EXCLUDED.decision THEN github_notification_rules.hits + 1 ELSE 1 END,
       decision = EXCLUDED.decision, updated_at = NOW()`,
    [row.account_id, row.repo_full_name.toLowerCase(), row.reason, String(row.evidence?.actor || '').toLowerCase(), lesson],
  );
  await client.query(
    `UPDATE github_notifications SET decision = $3, evidence = evidence || '{"rule":"learned"}'::jsonb WHERE account_id = $1 AND thread_id = $2`,
    [row.account_id, row.thread_id, lesson],
  );
}

/**
 * Apply one thread action on GitHub, then mirror it locally. The operator's
 * actions teach learned rules (unless `learn: false`, for a bulk audit change);
 * an automation's carry the decision behind it.
 */
export async function applyNotificationAction(accountId, threadId, action, { actor = 'operator', detail = {}, learn = actor === 'operator' } = {}) {
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
  const row = await withTransaction(async (client) => {
    if (learn) await learnFromOperator(client, existing, action);
    const result = await client.query(
      `UPDATE github_notifications SET
         unread = CASE WHEN $3::text IN ('read','done') THEN FALSE ELSE unread END,
         state = COALESCE($4::text, state),
         state_changed_at = CASE WHEN $4::text IS NULL THEN state_changed_at ELSE NOW() END,
         updated_at = NOW()
       WHERE account_id = $1 AND thread_id = $2 RETURNING *`,
      [account.id, threadId, action, spec.state],
    );
    await client.query(
      'INSERT INTO github_notification_events (account_id, thread_id, actor, kind, detail) VALUES ($1, $2, $3, $4, $5::jsonb)',
      [account.id, threadId, actor, action, toPgJson(detail)],
    );
    return result.rows[0];
  });
  githubNotificationEvents.emit('changed', { accountId: account.id });
  return toApi(row, new Map([[account.id, account]]));
}

// An automation action can be undone while the thread is still where it left
// it. GitHub has no "mark unread", so a read stays.
const UNDO_ACTIONS = { done: { action: 'reopen', state: 'done' }, mute: { action: 'resubscribe', state: 'muted' } };

/** Recent automation actions across accounts, newest first, for the Automations tab. */
export async function listAutomationActivity({ limit = 50 } = {}) {
  const accounts = await listAccounts();
  const labels = new Map(accounts.map((account) => [account.id, account.label]));
  const { rows } = await query(
    `SELECT e.id, e.account_id, e.thread_id, e.kind, e.detail, e.created_at, n.subject_title, n.repo_full_name, n.state
     FROM github_notification_events e JOIN github_notifications n ON n.account_id = e.account_id AND n.thread_id = e.thread_id
     WHERE e.actor = 'automation' AND e.kind = ANY($1::text[]) AND e.account_id = ANY($2::text[])
     ORDER BY e.created_at DESC, e.id DESC LIMIT $3`,
    [[...NOTIFICATION_ACTIONS, 'handed-off'], accounts.map((account) => account.id), limit],
  );
  return rows.map((row) => ({
    id: String(row.id),
    accountId: row.account_id,
    accountLabel: labels.get(row.account_id) || row.account_id,
    threadId: row.thread_id,
    action: row.kind,
    title: row.subject_title,
    repoFullName: row.repo_full_name,
    decision: row.detail?.decision || null,
    rule: row.detail?.rule || null,
    at: toIso(row.created_at),
    undoable: UNDO_ACTIONS[row.kind]?.state === row.state,
  }));
}

/** Reverse one automation action as the operator, which also teaches a learned rule. */
export async function undoAutomationAction(eventId) {
  const event = (await query("SELECT * FROM github_notification_events WHERE id = $1 AND actor = 'automation'", [eventId])).rows[0];
  if (!event) throw new ServerError('Automation action not found', { status: 404, code: 'GITHUB_AUTOMATION_ACTION_NOT_FOUND' });
  const undo = UNDO_ACTIONS[event.kind];
  if (!undo) throw new ServerError('GitHub cannot mark a thread unread again', { status: 409, code: 'GITHUB_AUTOMATION_NOT_UNDOABLE' });
  const row = (await query('SELECT state FROM github_notifications WHERE account_id = $1 AND thread_id = $2', [event.account_id, event.thread_id])).rows[0];
  if (row?.state !== undo.state) throw new ServerError('The thread has changed since; open it in the inbox instead', { status: 409, code: 'GITHUB_AUTOMATION_NOT_UNDOABLE' });
  return applyNotificationAction(event.account_id, event.thread_id, undo.action);
}

export async function listLearnedRules() {
  const accounts = await listAccounts();
  const labels = new Map(accounts.map((account) => [account.id, account.label]));
  const { rows } = await query(
    'SELECT * FROM github_notification_rules WHERE account_id = ANY($1::text[]) ORDER BY updated_at DESC LIMIT 200',
    [accounts.map((account) => account.id)],
  );
  return rows.map((row) => ({
    id: String(row.id),
    accountId: row.account_id,
    accountLabel: labels.get(row.account_id) || row.account_id,
    repoFullName: row.repo_full_name,
    reason: row.reason,
    actor: row.actor || null,
    decision: row.decision,
    hits: row.hits,
    updatedAt: toIso(row.updated_at),
  }));
}

export async function deleteLearnedRule(id) {
  const { rowCount } = await query('DELETE FROM github_notification_rules WHERE id = $1', [id]);
  if (!rowCount) throw new ServerError('Rule not found', { status: 404, code: 'GITHUB_NOTIFICATION_RULE_NOT_FOUND' });
  return { ok: true };
}

/** One thread with its triage evidence and action log, newest event first. */
export async function getNotification(accountId, threadId) {
  const account = await getAccount(accountId);
  const row = (await query('SELECT * FROM github_notifications WHERE account_id = $1 AND thread_id = $2', [account.id, threadId])).rows[0];
  if (!row) throw new ServerError('Notification not found', { status: 404, code: 'GITHUB_NOTIFICATION_NOT_FOUND' });
  const events = await query(
    'SELECT actor, kind, detail, created_at FROM github_notification_events WHERE account_id = $1 AND thread_id = $2 ORDER BY created_at DESC, id DESC LIMIT 50',
    [account.id, threadId],
  );
  return {
    ...toApi(row, new Map([[account.id, account]])),
    accountLabel: account.label,
    evidence: row.evidence || {},
    events: events.rows.map((event) => ({ actor: event.actor, kind: event.kind, detail: event.detail || {}, at: toIso(event.created_at) })),
  };
}

let lastScheduledSummary = null;

/**
 * The GitHub Notifications Check System task: sync and triage every enabled
 * account whose poll interval has elapsed. Observe mode records decisions
 * only; an Assist account also sorts and acts (githubNotificationAssist.js).
 */
export async function runScheduledNotificationCheck({ now = Date.now() } = {}) {
  const accounts = (await listAccounts()).filter((account) => account.enabled);
  const cursors = new Map((await query(
    'SELECT account_id, last_sync_at, poll_interval_seconds FROM github_notification_sync WHERE account_id = ANY($1::text[])',
    [accounts.map((account) => account.id)],
  )).rows.map((row) => [row.account_id, row]));
  const results = [];
  for (const account of accounts) {
    const cursor = cursors.get(account.id);
    const waitMs = Math.max(cursor?.poll_interval_seconds || 0, MIN_POLL_SECONDS) * 1000;
    if (cursor?.last_sync_at && now - new Date(cursor.last_sync_at).getTime() < waitMs) {
      results.push({ accountId: account.id, ok: true, skipped: 'poll-interval' });
      continue;
    }
    results.push(await syncAccountNotifications(account.id)
      .then((result) => ({ ...result, ok: true }))
      .catch((error) => ({ accountId: account.id, ok: false, error: error.message })));
  }
  lastScheduledSummary = describeScheduledCheck(results);
  // Only the scheduled check sends the opt-in monthly audit report.
  const { sendDueAuditReports } = await import('./githubNotificationAudit.js');
  await sendDueAuditReports({ now }).catch((error) => console.error(`❌ Monthly GitHub audit report failed: ${error.message}`));
  return results;
}

export function describeScheduledCheck(results) {
  const checked = results.filter((result) => result.ok && !result.skipped);
  const failed = results.filter((result) => !result.ok).length;
  const fetched = checked.reduce((sum, result) => sum + (result.fetched || 0), 0);
  const triaged = checked.reduce((sum, result) => sum + (result.triage?.triaged || 0), 0);
  const acted = checked.reduce((sum, result) => sum + (result.assist?.acted || 0), 0);
  const parts = [`checked ${checked.length} of ${results.length} account(s)`, `${fetched} new or updated`, `${triaged} triaged`];
  const handedOff = checked.reduce((sum, result) => sum + (result.assist?.handedOff || 0), 0);
  if (acted) parts.push(`${acted} handled`);
  const agentRuns = checked.reduce((sum, result) => sum + (result.assist?.agentRuns || 0), 0);
  if (handedOff) parts.push(`${handedOff} handed off in ${agentRuns} agent run(s)`);
  if (failed) parts.push(`${failed} failed`);
  return parts.join(', ');
}

// The check is the CoS System task `job-github-notifications`
// (autonomousJobs/defaults.js): one pass for the whole install.
const NOTIFICATION_CHECK_JOB_ID = 'job-github-notifications';

function cadenceOf(job) {
  if (!job?.enabled) return 'off';
  return job.cronExpression === GITHUB_NOTIFICATION_CADENCES['weekdays-15m'] ? 'weekdays-15m' : 'custom';
}

/** What the Automations tab shows: the check's cadence and each account's last run. */
export async function getAutomationsOverview() {
  const { getJob } = await import('./autonomousJobs.js');
  const [accounts, job] = await Promise.all([listAccounts(), getJob(NOTIFICATION_CHECK_JOB_ID)]);
  const ids = accounts.map((account) => account.id);
  const [syncRows, countRows] = await Promise.all([
    query('SELECT account_id, last_sync_at, last_error, poll_interval_seconds FROM github_notification_sync WHERE account_id = ANY($1::text[])', [ids]),
    query(
      `SELECT account_id, COUNT(*) FILTER (WHERE NOT suspect)::int AS needs_you, COUNT(*) FILTER (WHERE suspect)::int AS suspect,
         COUNT(*) FILTER (WHERE decision IS NULL)::int AS pending
       FROM github_notifications WHERE account_id = ANY($1::text[]) AND state = 'open' GROUP BY account_id`,
      [ids],
    ),
  ]);
  const syncById = new Map(syncRows.rows.map((row) => [row.account_id, row]));
  const countsById = new Map(countRows.rows.map((row) => [row.account_id, row]));
  return {
    cadence: cadenceOf(job),
    cronExpression: job?.cronExpression || null,
    lastSummary: lastScheduledSummary,
    accounts: accounts.map((account) => {
      const sync = syncById.get(account.id);
      const counts = countsById.get(account.id);
      return {
        id: account.id,
        label: account.label,
        host: account.host,
        trust: account.trust,
        mode: account.mode,
        enabled: account.enabled,
        lastSyncAt: toIso(sync?.last_sync_at) || null,
        lastError: sync?.last_error || null,
        pollIntervalSeconds: sync?.poll_interval_seconds ?? null,
        needsYou: counts?.needs_you || 0,
        suspect: counts?.suspect || 0,
        pending: counts?.pending || 0,
      };
    }),
  };
}

/** Turn the weekday 15-minute check on, or off. */
export async function setNotificationCadence(cadence) {
  const { updateJob } = await import('./autonomousJobs.js');
  const cron = GITHUB_NOTIFICATION_CADENCES[cadence];
  // Off keeps the job's cron, so turning it back on restores the same cadence.
  const job = await updateJob(NOTIFICATION_CHECK_JOB_ID, cron ? { enabled: true, cronExpression: cron } : { enabled: false });
  if (!job) throw new ServerError('The GitHub notifications System task is missing; restart PortOS to restore it', { status: 409, code: 'GITHUB_NOTIFICATION_JOB_MISSING' });
  return getAutomationsOverview();
}

/** Resolve with agent: hand one thread to its lane now, then return it. */
export async function resolveWithAgent(accountId, threadId) {
  const account = await getAccount(accountId);
  const { handOffThread } = await import('./githubNotificationAutopilot.js');
  await handOffThread(account, threadId);
  const row = (await query('SELECT * FROM github_notifications WHERE account_id = $1 AND thread_id = $2', [account.id, threadId])).rows[0];
  githubNotificationEvents.emit('changed', { accountId: account.id });
  return toApi(row, new Map([[account.id, account]]));
}
