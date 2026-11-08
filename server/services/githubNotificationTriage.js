/**
 * Observe-mode triage for the GitHub notifications inbox (#12871): gather
 * metadata for each new or updated thread with `gh`, compute trust and spam
 * signals, and record one decision. Nothing here writes to GitHub, hands work
 * off, or calls a model; later modes act on these recorded decisions.
 *
 * What is read: the subject's author/state, the latest comment's author and
 * a count of @mentions in it (the body itself is never stored), the actor's
 * account age, the actor's permission on an owned repo, org membership for a
 * Private account, and a repo's default branch. Every url comes from
 * `repoApiPath`, so notification data can never aim `gh` at another host.
 */
import { query, withTransaction } from '../lib/db.js';
import { repoApiPath } from '../lib/githubNotificationParse.js';
import { applyLearnedRule, computeThreadTrust, decideThread, matchWaitingRun, parseCiBranch, spamSignals, TRIAGE_RULES_VERSION, workflowRunEvidence } from '../lib/githubNotificationTriage.js';
import { parseGitRemoteUrl, readOriginRemoteUrl } from '../lib/gitRemote.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { toPgJson } from '../lib/pgJson.js';
import { execGh } from './github.js';
import { createGithubActorTrust } from './forgeActorTrust.js';
import { listAccounts } from './githubAccounts.js';

const GH_TIMEOUT_MS = 20_000;
// Each thread costs a few API calls; the rest wait for the next run. The first
// sync reads the whole inbox, read threads included.
const MAX_THREADS_PER_RUN = 60;
// Open threads a rules-version bump re-decides without new activity: version 2
// changed your own PRs and finished threads (now marked done, not just read);
// version 3 leaves a bot's comment on your own PR to the PR workflow; version
// 4 finishes a review request on a merged or closed PR; version 5 matches a
// deployment approval to its waiting run; version 6 trusts GitHub's own bots
// and, where the account opts in, everyone on an Enterprise instance; version 7
// re-checks commenter trust on legacy commented threads (#13213); version 9
// records a PR's draft and merge state for the inbox row. A thread
// handed off keeps its hand-off; one whose hand-off was refused (a Private
// account without agents) is re-decided like any other. One an Assist model sorted is not
// read again, except your own PR: the rule table decides those, so a verdict
// from before the rule existed must not keep one in front of you.
const REDECIDE_SQL = `(state = 'open' AND decision IS DISTINCT FROM 'handed-off'
  AND ((reason = 'author' AND subject_type = 'PullRequest' AND trust = 'yours')
    OR (decision = 'suggest-mark-read' AND COALESCE(evidence->>'rule', '') NOT LIKE 'ai-%')
    OR (reason = 'review_requested' AND evidence->>'subjectState' IN ('merged', 'closed'))
    OR reason = 'approval_requested'
    OR trust = 'outside'
    OR (subject_type = 'PullRequest' AND COALESCE(evidence->>'rulesVersion', '0') <> '${TRIAGE_RULES_VERSION}')
    OR (latest_comment_api_url IS NOT NULL AND NOT (evidence ? 'commenterTrust'))))`;
// A deployment waiting on you is re-checked every sync: approving or rejecting
// it on GitHub does not touch the notification thread.
const WAITING_DEPLOYMENT_SQL = "(state = 'open' AND decision IS DISTINCT FROM 'handed-off' AND evidence->>'rule' = 'deployment-approval')";
// Operator and automation action records written outside triage. A re-triage of
// the same GitHub activity (a trust change, a rules bump) rebuilds the rest of
// the evidence but must keep these: a hand-off is how the finished resolve task
// finds its thread, and an attempt is what stops a repeated PR action.
const TURN_EVIDENCE_KEYS = ['handoff', 'pullRequestAction', 'pullRequestAttempt'];
const WAITING_RUNS_JQ = '[.workflow_runs[] | {id, name, displayTitle: .display_title, headBranch: .head_branch, event, actor: .actor.login, actorType: .actor.type, createdAt: .created_at, updatedAt: .updated_at}]';
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}(?:\[bot\])?$/;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

const SUBJECT_JQ = '{author: .user.login, authorType: .user.type, association: .author_association, state: .state, merged: (.merged // false), draft: (.draft // false), mergeableState: .mergeable_state}';
const COMMENT_JQ = '{author: .user.login, authorType: .user.type, association: .author_association, mentions: ([(.body // "") | scan("@[A-Za-z0-9][A-Za-z0-9-]*")] | length)}';

const isBotLogin = (login) => /\[bot\]$/i.test(login);
const loginOrNull = (value) => (typeof value === 'string' && LOGIN_RE.test(value) ? value : null);

/** PortOS managed apps keyed by their repo, as lower-cased `host/owner/repo`. */
export async function managedAppsByRepoKey() {
  const { getAllApps } = await import('./apps.js');
  const apps = await getAllApps({ includeArchived: false }).catch(() => []);
  const byKey = new Map();
  for (const app of apps) {
    if (!app.repoPath) continue;
    const parsed = parseGitRemoteUrl(await readOriginRemoteUrl(app.repoPath).catch(() => null));
    if (parsed) byKey.set(`${parsed.host}/${parsed.owner}/${parsed.repo}`.toLowerCase(), app);
  }
  return byKey;
}

const managedRepoKeys = async () => new Set((await managedAppsByRepoKey()).keys());

/** Per-run, per-account reader that caches each forge answer once. */
function createReader(account, env) {
  const host = account.host;
  const run = (args) => execGh(['api', '--hostname', host, '--method', 'GET', ...args], GH_TIMEOUT_MS, { env });
  const json = async (path, jq) => safeJSONParse(await run([path, '--jq', jq]).catch(() => null), null, { logError: false });
  const memo = new Map();
  const once = (key, load) => {
    if (!memo.has(key)) memo.set(key, load());
    return memo.get(key);
  };
  return {
    subject: (path) => (path ? once(`s:${path}`, () => json(path, SUBJECT_JQ)) : null),
    comment: (path) => (path ? once(`c:${path}`, () => json(path, COMMENT_JQ)) : null),
    userCreatedAt: (login) => once(`u:${login}`, () => run([`users/${login}`, '--jq', '.created_at']).then((out) => out.trim() || null).catch(() => null)),
    defaultBranch: (repo) => once(`b:${repo}`, () => run([`repos/${repo}`, '--jq', '.default_branch']).then((out) => out.trim() || null).catch(() => null)),
    // Whether this account can push to (and so merge in) the repo; null when unread.
    canPush: (repo) => once(`p:${repo}`, () => run([`repos/${repo}`, '--jq', '.permissions.push'])
      .then((out) => ({ true: true, false: false })[out.trim()] ?? null).catch(() => null)),
    // 204 for a member; any failure (404, no visibility) is "not a member".
    orgMember: (org, login) => once(`o:${org}/${login}`, () => run([`orgs/${org}/members/${login}`]).then(() => true).catch(() => false)),
    repoTrust: (repo) => once(`t:${repo}`, () => createGithubActorTrust({
      runGh: (args) => execGh(args, GH_TIMEOUT_MS, { env }), host, repoFullName: repo, currentUser: null,
    })),
    viewer: () => once('viewer', () => run(['user', '--jq', '.login']).then((out) => loginOrNull(out.trim())).catch(() => null)),
    // null when the forge could not be read, so a failure is never "none waiting".
    waitingRuns: (repo) => once(`w:${repo}`, () => json(`repos/${repo}/actions/runs?status=waiting&per_page=50`, WAITING_RUNS_JQ)
      .then((runs) => (Array.isArray(runs) ? runs : null))),
  };
}

async function ownLoginsFor(account, reader) {
  const logins = (await listAccounts())
    .filter((entry) => entry.host === account.host && entry.login)
    .map((entry) => entry.login);
  if (!account.login) {
    const viewer = await reader.viewer();
    if (viewer) logins.push(viewer);
  }
  return logins;
}

const learnedRuleKey = (repo, reason, actor) => `${repo.toLowerCase()}#${reason}#${(actor || '').toLowerCase()}`;

async function loadLearnedRules(accountId) {
  const { rows } = await query('SELECT repo_full_name, reason, actor, decision, hits FROM github_notification_rules WHERE account_id = $1', [accountId]);
  return new Map(rows.map((rule) => [learnedRuleKey(rule.repo_full_name, rule.reason, rule.actor), { decision: rule.decision, hits: rule.hits }]));
}

// One actor's trust on a thread's repo, from forge permissions only.
async function rateActor({ account, reader, ownLogins, repo, repoOwned, repoOwner }, login, actorType = null) {
  const isOwn = ownLogins.some((own) => own.toLowerCase() === login.toLowerCase());
  const actorHasWriteAccess = Boolean(!isOwn && repoOwned && repo) && await (await reader.repoTrust(repo)).isTrusted(login);
  const actorIsOrgMember = Boolean(!isOwn && account.trust === 'private' && repo) && await reader.orgMember(repoOwner, login);
  return computeThreadTrust({
    actorLogin: login, actorType, ownLogins, repoOwned, actorHasWriteAccess, actorIsOrgMember,
    accountTrust: account.trust, trustInstanceUsers: account.trustInstanceUsers === true,
  });
}

/**
 * Whether a login owns the repo, by name or as a public member of its owning
 * org. Forge identity only; GitHub's `author_association` never counts.
 */
async function isRepoOwner(reader, repoOwner, login) {
  if (!repoOwner || !login) return false;
  if (login.toLowerCase() === repoOwner.toLowerCase()) return true;
  return reader.orgMember(repoOwner, login);
}

const DISCUSSION_SUBJECT_RE = /^repos\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/(issues|pulls)\/(\d{1,9})$/;
const VOUCHED_TRUST = new Set(['yours', 'trusted']);

/**
 * Whether everyone who commented on or reviewed a thread's issue or pull
 * request is you or trusted, read at the moment of a Resolve with agent tap
 * (#13191). Triage rates only the latest comment, but an agent told to read
 * the thread reads all of it, so the generic lane re-checks every author.
 * Only logins are fetched, never bodies. An unreadable list, a login that is
 * not one, or a commented subject that is not an issue or pull request is
 * not vouched for.
 */
export async function threadDiscussionVouched(account, env, row) {
  const repo = REPO_RE.test(row.repo_full_name || '') ? row.repo_full_name : null;
  const match = DISCUSSION_SUBJECT_RE.exec(repoApiPath(row.subject_api_url, account.host) || '');
  if (!repo || !match) return !row.latest_comment_api_url;
  const [, kind, number] = match;
  const paths = [`repos/${repo}/issues/${number}/comments`];
  if (kind === 'pulls') paths.push(`repos/${repo}/pulls/${number}/comments`, `repos/${repo}/pulls/${number}/reviews`);
  // login → the forge's user.type (Bot/User), which GitHub-native bot trust needs.
  const actors = new Map();
  for (const path of paths) {
    const out = await execGh(['api', '--hostname', account.host, '--method', 'GET', path, '--paginate', '--jq', '.[] | "\\(.user.login)\\t\\(.user.type)"'], GH_TIMEOUT_MS, { env })
      .catch(() => null);
    if (out === null) return false;
    for (const line of out.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
      const [login, type] = line.split('\t');
      if (!loginOrNull(login)) return false;
      actors.set(login, type === 'Bot' || type === 'User' ? type : null);
    }
  }
  if (!actors.size) return true;
  const reader = createReader(account, env);
  const ctx = { account, reader, ownLogins: await ownLoginsFor(account, reader), repo, repoOwned: row.evidence?.repoOwned === true, repoOwner: row.repo_owner };
  // On your own PR the repo's owner reviewing it is the work, as in agentHandoff.
  const ownPullRequest = kind === 'pulls' && row.trust === 'yours';
  for (const [login, type] of actors) {
    if (VOUCHED_TRUST.has(await rateActor(ctx, login, type))) continue;
    if (ownPullRequest && type === 'User' && await isRepoOwner(reader, row.repo_owner, login)) continue;
    return false;
  }
  return true;
}

async function triageThread(row, ctx) {
  const { account, reader, ownLogins, managedKeys, learnedRules, now } = ctx;
  const repo = REPO_RE.test(row.repo_full_name) ? row.repo_full_name : null;
  const owner = row.repo_owner.toLowerCase();
  const repoManaged = repo ? managedKeys.has(`${account.host}/${repo}`.toLowerCase()) : false;
  const repoOwned = repoManaged || ownLogins.some((login) => login.toLowerCase() === owner);

  const subjectPath = repoApiPath(row.subject_api_url, account.host);
  const commentPath = repoApiPath(row.latest_comment_api_url, account.host);
  const subject = await reader.subject(subjectPath);
  const comment = commentPath && commentPath !== subjectPath ? await reader.comment(commentPath) : null;
  const subjectAuthor = loginOrNull(subject?.author);
  const commenter = loginOrNull(comment?.author);
  const isDeployment = row.reason === 'approval_requested' && row.subject_type === 'WorkflowRun';
  const waitingRun = isDeployment && repo ? matchWaitingRun(await reader.waitingRuns(repo), row.gh_updated_at) : undefined;
  // Trust attaches to the subject's author (for a deployment, whoever started
  // the run); a later commenter can only add suspicion, never lift an outside
  // PR into the trusted lane.
  const actorLogin = subjectAuthor || loginOrNull(waitingRun?.actor) || commenter;

  const trustOf = (login, actorType = null) => rateActor({ account, reader, ownLogins, repo, repoOwned, repoOwner: row.repo_owner }, login, actorType);
  // Any other thread from this repo counts as history, whatever its age: rows
  // from one sync share a created_at, so an age comparison would see none.
  let priorThreadsInRepo = null;
  const priorThreads = async () => {
    priorThreadsInRepo ??= Number((await query(
      'SELECT COUNT(*)::int AS n FROM github_notifications WHERE account_id = $1 AND repo_full_name = $2 AND thread_id <> $3',
      [account.id, row.repo_full_name, row.thread_id],
    )).rows[0].n);
    return priorThreadsInRepo;
  };
  const signalsFor = async (login, loginTrust, association, mentionCount) => (loginTrust === 'outside'
    ? spamSignals({
      trust: loginTrust,
      actorCreatedAt: await reader.userCreatedAt(login),
      actorAssociation: association,
      mentionCount,
      repoOwned,
      priorThreadsInRepo: await priorThreads(),
      reason: row.reason,
      now,
    })
    : []);

  const actorType = subjectAuthor ? subject.authorType : (waitingRun?.actor && actorLogin === loginOrNull(waitingRun.actor) ? waitingRun.actorType : comment?.authorType);
  const trust = actorLogin ? await trustOf(actorLogin, typeof actorType === 'string' ? actorType : null) : computeThreadTrust({ actorLogin: null });
  const signalSet = new Set(actorLogin
    ? await signalsFor(actorLogin, trust, subjectAuthor ? subject.association : comment?.association, subjectAuthor ? 0 : comment?.mentions ?? 0)
    : []);
  // A latest comment that could not be read counts as outside, so your own PR
  // never leaves Needs you on a comment nobody checked.
  let commenterTrust = commentPath && commentPath !== subjectPath && !commenter ? 'outside' : null;
  if (commenter && subjectAuthor && commenter.toLowerCase() !== subjectAuthor.toLowerCase()) {
    // A bot (a CI or review app) commenting on your own PR in your repo was
    // installed there by you, so it is the PR workflow's business, not an
    // outside reply waiting on you. The repo's collaborator list never names it.
    commenterTrust = isBotLogin(commenter) && repoOwned && trust === 'yours' ? 'unknown' : await trustOf(commenter, typeof comment.authorType === 'string' ? comment.authorType : null);
    for (const signal of await signalsFor(commenter, commenterTrust, comment.association, comment.mentions ?? 0)) signalSet.add(signal);
  }
  const signals = [...signalSet];
  // A reply on your own PR in a repo you do not own, from that repo's owner.
  const commenterMaintainer = Boolean(commenter && trust === 'yours' && !repoOwned && row.subject_type === 'PullRequest'
    && commenterTrust === 'outside' && comment?.authorType === 'User') && await isRepoOwner(reader, row.repo_owner, commenter);
  const isOpenPullRequest = row.subject_type === 'PullRequest' && subject?.state === 'open' && subject?.merged !== true;
  const viewerCanPush = isOpenPullRequest && repo ? await reader.canPush(repo) : null;

  const isCi = row.reason === 'ci_activity' || row.subject_type === 'CheckSuite';
  const ciBranch = isCi ? parseCiBranch(row.subject_title) : null;
  const defaultBranch = isCi && ciBranch && repo ? await reader.defaultBranch(repo) : null;
  const tabled = decideThread({
    reason: row.reason,
    subjectType: row.subject_type,
    subjectState: subject?.state || null,
    subjectMerged: subject?.merged === true,
    trust,
    commenterTrust,
    suspect: signals.length > 0,
    repoOwned,
    repoManaged,
    ciBranch,
    defaultBranch,
    deploymentWaiting: waitingRun === undefined ? null : Boolean(waitingRun),
  });
  const { decision, rule } = applyLearnedRule(tabled, learnedRules.get(learnedRuleKey(row.repo_full_name, row.reason, actorLogin)));
  return {
    decision,
    trust,
    suspect: signals.length > 0,
    evidence: {
      rule,
      signals,
      actor: actorLogin,
      actorType: typeof actorType === 'string' ? actorType : null,
      commenter: commenter && commenter !== actorLogin ? commenter : null,
      // Always recorded (null: no other commenter) so the generic agent lane
      // can tell a vouched thread from one triaged before it was kept (#13191).
      commenterTrust,
      commenterMaintainer,
      repoOwned,
      repoManaged,
      subjectState: subject ? (subject.merged === true ? 'merged' : subject.state || null) : null,
      subjectDraft: subject?.draft === true,
      mergeState: typeof subject?.mergeableState === 'string' ? subject.mergeableState : null,
      viewerCanPush,
      statusCheckedAt: new Date(now).toISOString(),
      ciBranch,
      metadataMissing: Boolean(subjectPath && !subject) || (isDeployment && waitingRun === undefined),
      ...(waitingRun ? { workflowRun: workflowRunEvidence(waitingRun) } : {}),
      rulesVersion: TRIAGE_RULES_VERSION,
    },
  };
}

// Fold repeat default-branch CI notices for the same repo and branch into the
// newest one, so a red main shows once.
async function foldCiDuplicates(client, accountId) {
  const { rows } = await client.query(
    `SELECT thread_id, repo_full_name, evidence->>'ciBranch' AS branch FROM github_notifications
     WHERE account_id = $1 AND state = 'open' AND decision = 'surface' AND evidence->>'rule' = 'ci-default-branch'
     ORDER BY gh_updated_at DESC`,
    [accountId],
  );
  const newest = new Map();
  for (const row of rows) {
    const key = `${row.repo_full_name}#${row.branch}`;
    if (!newest.has(key)) {
      newest.set(key, row.thread_id);
      continue;
    }
    await client.query(
      `UPDATE github_notifications SET decision = 'duplicate', evidence = evidence || jsonb_build_object('foldedInto', $3::text), updated_at = NOW()
       WHERE account_id = $1 AND thread_id = $2`,
      [accountId, row.thread_id, newest.get(key)],
    );
  }
}

/**
 * Re-decide every open thread on the next check, after a change to who the
 * account trusts; the trust a thread was triaged under is otherwise kept until
 * new activity.
 */
export async function retriageOpenThreads(accountId) {
  // A hand-off holds until new GitHub activity, like REDECIDE_SQL.
  const { rowCount } = await query(
    "UPDATE github_notifications SET triaged_for = NULL, updated_at = NOW() WHERE account_id = $1 AND state = 'open' AND decision IS DISTINCT FROM 'handed-off'",
    [accountId],
  );
  return rowCount;
}

// A PR's merge readiness changes without any notification (the base moves, a
// check finishes), so open PR threads are re-read on a slow cadence. GitHub
// computes mergeability lazily: a read can answer `unknown` and start the
// computation, which the next pass picks up.
const STATUS_REFRESH_MS = 10 * 60 * 1000;
const MAX_STATUS_REFRESH_PER_RUN = 20;

/**
 * Re-read the state, draft and merge readiness of open pull-request threads
 * whose status is older than STATUS_REFRESH_MS. A PR found merged or closed
 * is queued for re-triage so its finished rule applies. Returns the count of
 * rows whose status changed.
 */
export async function refreshOpenPullRequestStatus(account, env, { now = Date.now() } = {}) {
  const cutoff = new Date(now - STATUS_REFRESH_MS).toISOString();
  const { rows } = await query(
    `SELECT * FROM github_notifications WHERE account_id = $1 AND state = 'open' AND NOT suspect
       AND subject_type = 'PullRequest' AND evidence->>'subjectState' = 'open'
       AND COALESCE(evidence->>'statusCheckedAt', '') < $2
     ORDER BY evidence->>'statusCheckedAt' ASC NULLS FIRST, gh_updated_at DESC LIMIT ${MAX_STATUS_REFRESH_PER_RUN}`,
    [account.id, cutoff],
  );
  if (!rows.length) return 0;
  const reader = createReader(account, env);
  let changed = 0;
  for (const row of rows) {
    const subject = await reader.subject(repoApiPath(row.subject_api_url, account.host));
    const statusCheckedAt = new Date(now).toISOString();
    // An unreadable PR (deleted, access lost) is still stamped, so it rotates
    // out of the window instead of starving every other PR.
    const status = subject ? {
      subjectState: subject.merged === true ? 'merged' : subject.state || null,
      subjectDraft: subject.draft === true,
      mergeState: typeof subject.mergeableState === 'string' ? subject.mergeableState : null,
      statusCheckedAt,
    } : { statusCheckedAt };
    const finished = Boolean(subject) && status.subjectState !== 'open';
    const moved = Boolean(subject) && ['subjectState', 'subjectDraft', 'mergeState'].some((key) => (row.evidence?.[key] ?? null) !== status[key]);
    // Only the status keys change, and only on the row as read.
    const { rowCount } = await query(
      `UPDATE github_notifications SET evidence = evidence || $3::jsonb,
         triaged_for = CASE WHEN $4::boolean THEN NULL ELSE triaged_for END, updated_at = NOW()
       WHERE account_id = $1 AND thread_id = $2 AND evidence = $5::jsonb`,
      [account.id, row.thread_id, toPgJson(status), finished, toPgJson(row.evidence)],
    );
    if (rowCount && moved) changed += 1;
  }
  return changed;
}

// No new GitHub activity since the last decision (never decided counts: nothing
// newer than a decision exists to supersede an action recorded on the row).
const isSameActivity = (row) => row.triaged_for == null || new Date(row.triaged_for).getTime() >= new Date(row.gh_updated_at).getTime();

function carryTurnEvidence(row, evidence) {
  if (!isSameActivity(row)) return evidence;
  // A refused hand-off pins nothing: a changed rule or trust may now allow it.
  const kept = Object.fromEntries(TURN_EVIDENCE_KEYS
    .filter((key) => row.evidence?.[key] !== undefined && !(key === 'handoff' && row.evidence.handoff?.skipped))
    .map((key) => [key, row.evidence[key]]));
  return { ...evidence, ...kept };
}

/**
 * Triage this account's threads that are new or have new activity since their
 * last decision. Returns `{ triaged, decisions: { [decision]: n } }`.
 */
export async function triageAccountNotifications(account, env, { now = Date.now() } = {}) {
  const { rows } = await query(
    `SELECT * FROM github_notifications WHERE account_id = $1 AND (triaged_for IS NULL OR triaged_for < gh_updated_at
       OR (${REDECIDE_SQL} AND COALESCE((evidence->>'rulesVersion')::int, 0) < $2) OR ${WAITING_DEPLOYMENT_SQL})
     ORDER BY gh_updated_at DESC LIMIT ${MAX_THREADS_PER_RUN}`,
    [account.id, TRIAGE_RULES_VERSION],
  );
  if (!rows.length) return { triaged: 0, decisions: {} };
  const reader = createReader(account, env);
  const ctx = {
    account, reader, ownLogins: await ownLoginsFor(account, reader), managedKeys: await managedRepoKeys(), learnedRules: await loadLearnedRules(account.id), now,
  };
  // A hand-off holds until new activity; a row selected only because its stamp was cleared is re-stamped, not re-decided.
  const held = rows.filter((row) => row.decision === 'handed-off' && isSameActivity(row));
  const results = [];
  for (const row of rows) if (!held.includes(row)) results.push({ row, result: await triageThread(row, ctx) });

  const decisions = {};
  let triaged = 0;
  await withTransaction(async (client) => {
    for (const row of held) {
      await client.query(
        `UPDATE github_notifications SET triaged_for = $3 WHERE account_id = $1 AND thread_id = $2 AND decision = 'handed-off'`,
        [account.id, row.thread_id, row.gh_updated_at],
      );
    }
    for (const { row, result } of results) {
      // Triage spent seconds in `gh` after reading this row. Write only if the row
      // is still as read: a hand-off, learned decision, PR action or Assist verdict
      // landing meanwhile wins, and the next check re-triages this thread.
      const evidence = carryTurnEvidence(row, result.evidence);
      const { rowCount } = await client.query(
        `UPDATE github_notifications SET decision = $3, trust = $4, suspect = $5, evidence = $6::jsonb, triaged_for = $7, updated_at = NOW()
         WHERE account_id = $1 AND thread_id = $2
           AND state = $8 AND decision IS NOT DISTINCT FROM $9 AND evidence = $10::jsonb`,
        [account.id, row.thread_id, result.decision, result.trust, result.suspect, toPgJson(evidence), row.gh_updated_at, row.state, row.decision, toPgJson(row.evidence)],
      );
      if (!rowCount) continue;
      triaged += 1;
      decisions[result.decision] = (decisions[result.decision] || 0) + 1;
      if (row.decision !== result.decision) {
        await client.query(
          `INSERT INTO github_notification_events (account_id, thread_id, actor, kind, detail) VALUES ($1, $2, 'automation', 'triaged', $3::jsonb)`,
          [account.id, row.thread_id, toPgJson({ decision: result.decision, rule: result.evidence.rule, mode: account.mode })],
        );
      }
    }
    await foldCiDuplicates(client, account.id);
  });
  return { triaged, decisions };
}
