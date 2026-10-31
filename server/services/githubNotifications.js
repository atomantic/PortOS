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
  workflowRunHtmlUrl,
} from '../lib/githubNotificationParse.js';
import { execGh } from './github.js';
import { getAccount, listAccounts, resolveGitHubAccountEnv } from './githubAccounts.js';
import { githubNotificationEvents } from './githubNotificationEvents.js';
import { triageAccountNotifications } from './githubNotificationTriage.js';
import { assistAccountNotifications } from './githubNotificationAssist.js';
import {
  agentHandoff, agentRunPin, DEFAULT_AGENT_RULES, FINISHED_DECISIONS, KIND_SQL, learnedDecisionForAction, normalizeAgentRules, PINNED_TRIAGE_RULES, threadAgentKind,
} from '../lib/githubNotificationTriage.js';
import { toPgJson } from '../lib/pgJson.js';
import { notificationPullRequestView } from '../lib/githubNotificationPullRequest.js';

const GH_TIMEOUT_MS = 30_000;
const PER_PAGE = 50;
// GitHub lists at most 50 threads a page; past 1,000 inbox threads the
// listing is truncated and threads it did not return are not reconciled.
const MAX_PAGES = 20;
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

// The stored Last-Modified cursor names the listing it came from. A cursor
// saved by an older sync format is not reused: a 304 against it would skip
// the first full read until something new arrived.
const LISTING_CURSOR_PREFIX = 'inbox:';
const listingCursor = (stored) => (typeof stored === 'string' && stored.startsWith(LISTING_CURSOR_PREFIX)
  ? stored.slice(LISTING_CURSOR_PREFIX.length) || null
  : null);

const isNotModified = (error) => /\bHTTP 304\b/.test(String(error?.ghStderr || error?.message || ''));

export async function requireAccountEnv(account) {
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

async function fetchPage(account, env, { all, page, ifModifiedSince }) {
  const args = ['api', '--hostname', account.host, '--include', '--method', 'GET',
    `notifications?${all ? 'all=true&' : ''}per_page=${PER_PAGE}&page=${page}`];
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

/**
 * Every page of one listing, up to MAX_PAGES. GitHub answers a conditional
 * request that is not a 304 with only the threads updated since the cursor,
 * so `complete` (the whole listing, safe to reconcile against) needs an
 * unconditional, untruncated read.
 */
async function fetchListing(account, env, { all, ifModifiedSince = null }) {
  let page = await fetchPage(account, env, { all, page: 1, ifModifiedSince });
  if (page.notModified) return { notModified: true };
  const { headers } = page;
  const threads = [...page.threads];
  let pageNumber = 1;
  while (linkHeaderHasNext(page.headers.link) && pageNumber < MAX_PAGES) {
    pageNumber += 1;
    page = await fetchPage(account, env, { all, page: pageNumber, ifModifiedSince });
    if (page.notModified) break;
    threads.push(...page.threads);
  }
  const truncated = page.notModified || linkHeaderHasNext(page.headers.link);
  return { notModified: false, threads, headers, truncated, complete: !ifModifiedSince && !truncated };
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
    -- Read on GitHub while open and unread here (PortOS's own read clears
    -- unread first, so never lands here). New activity or unread clears it.
    read_on_github_at = CASE
      WHEN EXCLUDED.unread OR EXCLUDED.gh_updated_at > github_notifications.gh_updated_at THEN NULL
      WHEN github_notifications.unread AND github_notifications.state = 'open' THEN COALESCE(github_notifications.read_on_github_at, NOW())
      ELSE github_notifications.read_on_github_at END,
    -- New activity brings back a thread marked done, and an unsubscribed one
    -- (GitHub re-subscribes on a fresh mention or review request). Muted stays.
    -- An unread thread is in GitHub's inbox (marking one done reads it), so it
    -- is not done here, unless that state was set after this listing was read.
    state = CASE WHEN github_notifications.state IN ('done', 'unsubscribed') AND EXCLUDED.gh_updated_at > github_notifications.gh_updated_at
      THEN 'open'
      WHEN github_notifications.state = 'done' AND EXCLUDED.unread
        AND (github_notifications.state_changed_at IS NULL OR github_notifications.state_changed_at < $14)
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
  // Observe still clears threads with nothing left to do, so a closed or
  // merged thread never waits on the operator; Assist does the same below.
  if (account.mode === 'observe') {
    const { cleared } = await markThreadsDone(account, FINISHED_OPEN_SQL, { actor: 'automation', limit: MAX_AUTO_DONE_PER_RUN });
    return { sorted: 0, acted: cleared, handedOff: 0, agentRuns: 0 };
  }
  const autopilot = account.mode === 'autopilot'
    ? await (await import('./githubNotificationAutopilot.js')).autopilotAccountNotifications(account, env)
    : { handedOff: 0, agentRuns: 0 };
  const assist = await assistAccountNotifications(account, env, {
    act: (threadId, action, detail) => applyNotificationAction(account.id, threadId, action, { actor: 'automation', detail }),
  });
  return { ...assist, handedOff: autopilot.handedOff, agentRuns: autopilot.agentRuns, ...(autopilot.merged ? { merged: autopilot.merged } : {}) };
}

const listedIds = (listing) => listing.threads.map((thread) => String(thread?.id));

// Only a complete listing says anything about the threads it does not name.
async function reconcileListings(client, accountId, { inbox, unread }) {
  let readOnGithub = 0;
  if (unread.complete) {
    // Reading a thread on GitHub does not move the `all=true` cursor, so a
    // thread that turned read there is only seen here (#13171).
    ({ rowCount: readOnGithub } = await client.query(
      `UPDATE github_notifications SET unread = FALSE, updated_at = NOW(),
         read_on_github_at = CASE WHEN state = 'open' THEN NOW() ELSE read_on_github_at END
       WHERE account_id = $1 AND unread AND NOT (thread_id = ANY($2::text[]))`,
      [accountId, listedIds(unread)],
    ));
  }
  // GitHub's `all=true` listing still includes threads marked done (as
  // read), so only a thread missing from the whole listing is known gone.
  if (inbox.complete) {
    await client.query(
      `UPDATE github_notifications SET unread = FALSE,
         state = CASE WHEN state = 'open' THEN 'done' ELSE state END,
         state_changed_at = CASE WHEN state = 'open' THEN NOW() ELSE state_changed_at END, updated_at = NOW()
       WHERE account_id = $1 AND (unread OR state = 'open') AND NOT (thread_id = ANY($2::text[]))`,
      [accountId, listedIds(inbox)],
    );
  }
  return readOnGithub;
}

async function syncAccountNow(account, automate) {
  const env = await requireAccountEnv(account);
  const cursor = (await query('SELECT last_modified FROM github_notification_sync WHERE account_id = $1', [account.id])).rows[0];
  const listedAt = new Date();
  const inbox = await fetchListing(account, env, { all: true, ifModifiedSince: listingCursor(cursor?.last_modified) });
  if (inbox.notModified) {
    // The cursor only moves on new activity, not on reads: re-read the small
    // unread listing so a thread read on GitHub leaves Needs you.
    const unread = await fetchListing(account, env, { all: false });
    const readOnGithub = await withTransaction(async (client) => {
      const count = await reconcileListings(client, account.id, { inbox, unread });
      await client.query('UPDATE github_notification_sync SET last_sync_at = NOW(), last_error = \'\', updated_at = NOW() WHERE account_id = $1', [account.id]);
      return count;
    });
    // Threads past the last run's triage cap still need a decision.
    const triage = await triageAccountNotifications(account, env);
    const assist = await runAutomation(account, env, automate);
    if (readOnGithub || triage.triaged || assist.sorted || assist.acted || assist.handedOff) githubNotificationEvents.emit('changed', { accountId: account.id });
    return { accountId: account.id, changed: false, fetched: 0, triage, assist };
  }
  // The `all=true` listing can run past MAX_PAGES and is a delta after the
  // first read; the unread listing is small and read whole, so every unread
  // thread reaches the inbox and `unread` mirrors GitHub.
  const unread = inbox.complete
    ? { threads: inbox.threads.filter((thread) => thread?.unread === true), truncated: false, complete: true }
    : await fetchListing(account, env, { all: false });
  const byId = new Map();
  for (const thread of [...inbox.threads, ...unread.threads]) {
    const record = toNotificationRecord(thread, account.host);
    if (record) byId.set(record.threadId, record);
  }
  const records = [...byId.values()];
  const truncated = inbox.truncated || unread.truncated;

  await withTransaction(async (client) => {
    for (const r of records) {
      await client.query(UPSERT_SQL, [
        account.id, r.threadId, r.repoFullName, r.repoOwner, r.repoPrivate, r.reason, r.subjectType,
        r.subjectTitle, r.subjectApiUrl, r.htmlUrl, r.unread, r.ghUpdatedAt, r.latestCommentApiUrl, listedAt,
      ]);
    }
    await reconcileListings(client, account.id, { inbox, unread });
    await client.query(
      `INSERT INTO github_notification_sync (account_id, last_modified, poll_interval_seconds, last_sync_at, last_error, updated_at)
       VALUES ($1, $2, $3, NOW(), '', NOW())
       ON CONFLICT (account_id) DO UPDATE SET last_modified = EXCLUDED.last_modified,
         poll_interval_seconds = EXCLUDED.poll_interval_seconds, last_sync_at = NOW(), last_error = '', updated_at = NOW()`,
      [account.id, inbox.headers['last-modified'] ? `${LISTING_CURSOR_PREFIX}${inbox.headers['last-modified']}` : null, pollIntervalSeconds(inbox.headers['x-poll-interval'])],
    );
  });
  const triage = await triageAccountNotifications(account, env);
  const assist = await runAutomation(account, env, automate);
  githubNotificationEvents.emit('changed', { accountId: account.id });
  console.log(`📬 Synced ${records.length} GitHub notifications for ${account.host}${truncated ? ' (listing truncated)' : ''}, triaged ${triage.triaged}, sorted ${assist.sorted}, acted on ${assist.acted}, handed off ${assist.handedOff}`);
  return { accountId: account.id, changed: true, fetched: records.length, truncated, triage, assist };
}

/**
 * Fetch one account's GitHub inbox (read and unread), coalescing concurrent requests.
 * `automate: false` (a caller without host control) skips Assist/Autopilot.
 */
// A 'disabled' account stays configured but this instance never fetches or processes its notifications.
const isActive = (account) => account.enabled && account.mode !== 'disabled';

export async function syncAccountNotifications(accountId, { automate = true } = {}) {
  const account = await getAccount(accountId);
  if (account.mode === 'disabled') return { accountId: account.id, changed: false, skipped: 'disabled' };
  return syncFlightFor(account.id).run(automate, () => syncAccountNow(account, automate).catch(async (error) => {
    await recordSyncError(account.id, error.message).catch(() => {});
    throw error;
  }));
}

/** Sync every enabled account; one account's failure never hides another's result. */
export async function syncAllNotifications(options = {}) {
  const accounts = (await listAccounts()).filter(isActive);
  const results = [];
  for (const account of accounts) {
    results.push(await syncAccountNotifications(account.id, options)
      .then((result) => ({ ...result, ok: true }))
      .catch((error) => ({ accountId: account.id, ok: false, error: error.message })));
  }
  return results;
}

// The inbox holds unread open threads, whatever their decision. The operator
// can clear finished or read threads in one tap without teaching a rule.
const FINISHED_SQL = `decision IN (${FINISHED_DECISIONS.map((decision) => `'${decision}'`).join(', ')})`;
const FINISHED_OPEN_SQL = `state = 'open' AND NOT suspect AND ${FINISHED_SQL}`;
const CLEARABLE_SQL = `state = 'open' AND NOT suspect AND (${FINISHED_SQL} OR NOT unread)`;
// Each mark-done is one gh call; the rest wait for the next sync.
const MAX_AUTO_DONE_PER_RUN = 50;
const OPEN_UNREAD_SQL = "state = 'open' AND unread AND read_on_github_at IS NULL";
const VIEW_FILTERS = {
  'needs-you': `${OPEN_UNREAD_SQL} AND NOT suspect`,
  suspect: `${OPEN_UNREAD_SQL} AND suspect`,
  handled: "(state <> 'open' OR NOT unread OR read_on_github_at IS NOT NULL)",
  all: 'TRUE',
};

const toIso = (value) => (value instanceof Date ? value.toISOString() : value);

// The lane Resolve with agent would use, why it cannot when refused, and the
// provider/model/effort its picker starts from (the rule's pin, else the
// account's agent defaults).
const agentView = (account, row) => {
  if (!account || row.state !== 'open') return null;
  if (row.suspect) return { lane: null, refused: 'suspect', pin: null };
  const plan = agentHandoff({ account, row });
  if (!plan) return null;
  const pin = agentRunPin({ rulePin: plan.pin, defaults: account.agentDefaults });
  return { lane: plan.lane, refused: plan.refused || null, pin: Object.keys(pin).length ? pin : null };
};

// A generic agent run that failed, for the inbox's Agent failed pill.
const agentFailedView = (row) => {
  const failed = row.state === 'open' ? row.evidence?.handoff?.failed : null;
  return failed?.taskId ? { taskId: failed.taskId, agentId: failed.agentId || null, at: failed.at || null } : null;
};

// A deployment approval's thread has no subject url; triage found its run.
const deploymentView = (account, row) => {
  const run = row.evidence?.workflowRun;
  const htmlUrl = account && run ? workflowRunHtmlUrl(row.repo_full_name, run.id, account.host) : null;
  return htmlUrl ? { runId: run.id, name: run.name, displayTitle: run.displayTitle, headBranch: run.headBranch, htmlUrl } : null;
};

// The thread's own state, so a row says what it is now: open, draft, merged,
// closed, and for an open PR GitHub's merge readiness (clean, blocked, ...).
// Null mergeState: GitHub had not computed it yet, or the thread is no PR.
const subjectStatusView = (row) => {
  const evidence = row.evidence || {};
  if (!evidence.subjectState) return null;
  return { state: evidence.subjectState, draft: evidence.subjectDraft === true, mergeState: evidence.mergeState || null };
};

const toApi = (row, accountsById) => {
  const account = accountsById.get(row.account_id);
  const login = account?.login?.toLowerCase();
  const deployment = row.state === 'open' ? deploymentView(account, row) : null;
  return {
    accountId: row.account_id,
    threadId: row.thread_id,
    repoFullName: row.repo_full_name,
    repoPrivate: row.repo_private,
    yourRepo: Boolean(login) && row.repo_owner.toLowerCase() === login,
    reason: row.reason,
    subjectType: row.subject_type,
    title: row.subject_title,
    htmlUrl: deployment?.htmlUrl || row.html_url,
    deployment,
    unread: row.unread,
    readOnGithub: Boolean(row.read_on_github_at) && row.state === 'open',
    state: row.state,
    decision: row.decision || null,
    trust: row.trust || null,
    suspect: row.suspect === true,
    rule: row.evidence?.rule || null,
    subjectStatus: subjectStatusView(row),
    signals: Array.isArray(row.evidence?.signals) ? row.evidence.signals : [],
    // The automation-rule kind, so a row can prefill Add automation rule (#13192).
    ruleKind: threadAgentKind(row),
    agent: agentView(account, row),
    agentFailed: agentFailedView(row),
    pullRequest: notificationPullRequestView(account, row),
    pullRequestAction: row.evidence?.pullRequestAction || null,
    pullRequestAttempt: row.evidence?.pullRequestAttempt || null,
    updatedAt: toIso(row.gh_updated_at),
  };
};

/** Local projection only: opening Actions never starts a GitHub sync or model call. */
export async function listActionableNotifications({ limit = 100 } = {}) {
  const accounts = (await listAccounts()).filter(isActive);
  if (!accounts.length) return [];
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const { rows } = await query(
    `SELECT * FROM github_notifications WHERE account_id = ANY($1::text[]) AND ${OPEN_UNREAD_SQL}
       AND NOT COALESCE(${FINISHED_SQL}, FALSE)
     ORDER BY gh_updated_at DESC, account_id, thread_id LIMIT $2`,
    [accounts.map((account) => account.id), limit],
  );
  return rows.map((row) => ({ ...toApi(row, accountsById), accountLabel: accountsById.get(row.account_id).label }));
}

export async function listNotifications({ accountId = null, view = 'needs-you' } = {}) {
  const accounts = (await listAccounts()).filter(isActive);
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const ids = accounts.filter((account) => !accountId || account.id === accountId).map((account) => account.id);
  const [rows, syncRows, countRows] = await Promise.all([
    query(
      `SELECT * FROM github_notifications WHERE account_id = ANY($1::text[]) AND ${VIEW_FILTERS[view]}
       ORDER BY gh_updated_at DESC LIMIT ${LIST_LIMIT}`,
      [ids],
    ),
    query('SELECT account_id, last_sync_at, last_error, poll_interval_seconds FROM github_notification_sync WHERE account_id = ANY($1::text[])', [ids]),
    // Every view's size for the inbox's summary, plus the open threads an agent has.
    query(
      `SELECT ${NOTIFICATION_VIEWS.map((name) => `COUNT(*) FILTER (WHERE ${VIEW_FILTERS[name]})::int AS "${name}"`).join(', ')},
         COUNT(*) FILTER (WHERE state = 'open' AND decision = 'handed-off')::int AS "with-agents",
         COUNT(*) FILTER (WHERE state = 'open' AND NOT suspect AND ${FINISHED_SQL})::int AS finished,
         COUNT(*) FILTER (WHERE ${CLEARABLE_SQL})::int AS clearable
       FROM github_notifications WHERE account_id = ANY($1::text[])`,
      [ids],
    ),
  ]);
  return {
    notifications: rows.rows.map((row) => toApi(row, accountsById)),
    counts: countRows.rows[0],
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
 * an automation's carry the decision behind it. A bulk caller passes `emit: false`
 * and announces the change once.
 */
export async function applyNotificationAction(accountId, threadId, action, { actor = 'operator', detail = {}, learn = actor === 'operator', emit = true } = {}) {
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
  if (emit) githubNotificationEvents.emit('changed', { accountId: account.id });
  return toApi(row, new Map([[account.id, account]]));
}

const ACCOUNT_FAILURES = new Set(['GITHUB_ACCOUNT_DISABLED', 'GITHUB_ACCOUNT_UNAVAILABLE']);

/**
 * Mark one account's open threads matching `whereSql` done on GitHub, newest
 * first, without teaching learned rules. One failed thread is counted, never
 * stops the rest; an account gh cannot act as fails them all the same way.
 */
async function markThreadsDone(account, whereSql, { actor = 'operator', limit = null } = {}) {
  const { rows } = await query(
    `SELECT thread_id, decision, evidence->>'rule' AS rule FROM github_notifications WHERE account_id = $1 AND ${whereSql}
     ORDER BY gh_updated_at DESC${limit ? ` LIMIT ${limit}` : ''}`,
    [account.id],
  );
  let cleared = 0;
  let failed = 0;
  for (const [index, row] of rows.entries()) {
    const detail = actor === 'automation' ? { decision: row.decision, rule: row.rule } : { decision: row.decision, bulk: 'finished' };
    const error = await applyNotificationAction(account.id, row.thread_id, 'done', { actor, learn: false, emit: false, detail })
      .then(() => null, (failure) => failure);
    if (!error) {
      cleared += 1;
      continue;
    }
    if (ACCOUNT_FAILURES.has(error.code)) {
      console.error(`❌ Could not mark finished GitHub notifications done for ${account.host}: ${error.message}`);
      failed += rows.length - index;
      break;
    }
    console.error(`❌ Could not mark GitHub notification ${row.thread_id} done for ${account.host}: ${error.message}`);
    failed += 1;
  }
  return { cleared, failed, matched: rows.length };
}

/**
 * Mark every open non-suspect finished or read thread done on GitHub (one
 * account, or all), as the operator but without teaching learned rules:
 * reading a thread does not decide how future threads should be handled.
 */
export async function clearFinishedNotifications({ accountId = null } = {}) {
  const accounts = (await listAccounts()).filter(isActive).filter((account) => !accountId || account.id === accountId);
  let cleared = 0;
  let failed = 0;
  for (const account of accounts) {
    const result = await markThreadsDone(account, CLEARABLE_SQL);
    cleared += result.cleared;
    failed += result.failed;
    if (result.matched) githubNotificationEvents.emit('changed', { accountId: account.id });
  }
  console.log(`🧹 Marked ${cleared} finished or read GitHub notification(s) done${failed ? `, ${failed} failed` : ''}`);
  return { cleared, failed };
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
  const accounts = (await listAccounts()).filter(isActive);
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
  const [syncRows, countRows, repoRows, openRows] = await Promise.all([
    query('SELECT account_id, last_sync_at, last_error, poll_interval_seconds FROM github_notification_sync WHERE account_id = ANY($1::text[])', [ids]),
    query(
      `SELECT account_id, COUNT(*) FILTER (WHERE NOT suspect)::int AS needs_you, COUNT(*) FILTER (WHERE suspect)::int AS suspect,
         COUNT(*) FILTER (WHERE decision IS NULL)::int AS pending
       FROM github_notifications WHERE account_id = ANY($1::text[]) AND state = 'open' GROUP BY account_id`,
      [ids],
    ),
    // The repos an agent rule can name without typing: those the inbox has seen.
    query(
      `SELECT account_id, array_agg(DISTINCT repo_full_name ORDER BY repo_full_name) AS repos
       FROM github_notifications WHERE account_id = ANY($1::text[]) AND repo_full_name <> '' GROUP BY account_id`,
      [ids],
    ),
    // Open threads per rule kind and repo, so the rule form can say how many a
    // rule matches now. `actionable` leaves out the threads a pinned triage rule
    // decided, which a done or mute rule never touches.
    query(
      `SELECT account_id, ${KIND_SQL} AS kind, lower(repo_full_name) AS repo, COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE NOT (COALESCE(evidence->>'rule', '') = ANY($2::text[])))::int AS actionable
       FROM github_notifications WHERE account_id = ANY($1::text[]) AND state = 'open' AND NOT suspect
         AND decision IS DISTINCT FROM 'handed-off'
       GROUP BY 1, 2, 3`,
      [ids, PINNED_TRIAGE_RULES],
    ),
  ]);
  const openById = new Map();
  for (const row of openRows.rows) {
    if (!openById.has(row.account_id)) openById.set(row.account_id, []);
    openById.get(row.account_id).push({ kind: row.kind, repo: row.repo, total: row.total, actionable: row.actionable });
  }
  const reposById = new Map(repoRows.rows.map((row) => [row.account_id, row.repos.slice(0, 200)]));
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
        allowAgents: account.allowAgents === true,
        agentDefaults: account.agentDefaults || null,
        agentRules: normalizeAgentRules(account.agentRules),
        defaultAgentRules: DEFAULT_AGENT_RULES,
        repos: reposById.get(account.id) || [],
        openByKind: openById.get(account.id) || [],
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

/**
 * Resolve with agent: hand one thread to its lane now, then return it.
 * `perRun` is the operator's provider/model/effort for this run, or undefined
 * to use the agent rule's pin or the account's defaults.
 */
export async function resolveWithAgent(accountId, threadId, perRun) {
  const account = await getAccount(accountId);
  const { handOffThread } = await import('./githubNotificationAutopilot.js');
  await handOffThread(account, threadId, perRun);
  const row = (await query('SELECT * FROM github_notifications WHERE account_id = $1 AND thread_id = $2', [account.id, threadId])).rows[0];
  githubNotificationEvents.emit('changed', { accountId: account.id });
  return toApi(row, new Map([[account.id, account]]));
}

export async function actOnPullRequest(accountId, threadId, options) {
  const account = await getAccount(accountId);
  const { actOnNotificationPullRequest } = await import('./githubNotificationPullRequest.js');
  const result = await actOnNotificationPullRequest(account, threadId, options);
  const row = (await query('SELECT * FROM github_notifications WHERE account_id = $1 AND thread_id = $2', [account.id, threadId])).rows[0];
  return { notification: toApi(row, new Map([[account.id, account]])), ...result };
}
