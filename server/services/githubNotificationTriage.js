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
import { applyLearnedRule, computeThreadTrust, decideThread, parseCiBranch, spamSignals } from '../lib/githubNotificationTriage.js';
import { parseGitRemoteUrl, readOriginRemoteUrl } from '../lib/gitRemote.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { toPgJson } from '../lib/pgJson.js';
import { execGh } from './github.js';
import { createGithubActorTrust } from './forgeActorTrust.js';
import { listAccounts } from './githubAccounts.js';

const GH_TIMEOUT_MS = 20_000;
// Each thread costs a few API calls; the rest wait for the next run.
const MAX_THREADS_PER_RUN = 25;
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}(?:\[bot\])?$/;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

const SUBJECT_JQ = '{author: .user.login, association: .author_association, state: .state, merged: (.merged // false)}';
const COMMENT_JQ = '{author: .user.login, association: .author_association, mentions: ([(.body // "") | scan("@[A-Za-z0-9][A-Za-z0-9-]*")] | length)}';

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
    // 204 for a member; any failure (404, no visibility) is "not a member".
    orgMember: (org, login) => once(`o:${org}/${login}`, () => run([`orgs/${org}/members/${login}`]).then(() => true).catch(() => false)),
    repoTrust: (repo) => once(`t:${repo}`, () => createGithubActorTrust({
      runGh: (args) => execGh(args, GH_TIMEOUT_MS, { env }), host, repoFullName: repo, currentUser: null,
    })),
    viewer: () => once('viewer', () => run(['user', '--jq', '.login']).then((out) => loginOrNull(out.trim())).catch(() => null)),
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
  // Trust attaches to the subject's author; a later commenter can only add
  // suspicion, never lift an outside PR into the trusted lane.
  const actorLogin = subjectAuthor || commenter;

  const trustOf = async (login) => {
    const isOwn = ownLogins.some((own) => own.toLowerCase() === login.toLowerCase());
    const actorHasWriteAccess = Boolean(!isOwn && repoOwned && repo) && await (await reader.repoTrust(repo)).isTrusted(login);
    const actorIsOrgMember = Boolean(!isOwn && account.trust === 'private' && repo) && await reader.orgMember(row.repo_owner, login);
    return computeThreadTrust({ actorLogin: login, ownLogins, repoOwned, actorHasWriteAccess, actorIsOrgMember, accountTrust: account.trust });
  };
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

  const trust = actorLogin ? await trustOf(actorLogin) : computeThreadTrust({ actorLogin: null });
  const signalSet = new Set(actorLogin
    ? await signalsFor(actorLogin, trust, subjectAuthor ? subject.association : comment?.association, subjectAuthor ? 0 : comment?.mentions ?? 0)
    : []);
  if (commenter && subjectAuthor && commenter.toLowerCase() !== subjectAuthor.toLowerCase()) {
    for (const signal of await signalsFor(commenter, await trustOf(commenter), comment.association, comment.mentions ?? 0)) signalSet.add(signal);
  }
  const signals = [...signalSet];

  const isCi = row.reason === 'ci_activity' || row.subject_type === 'CheckSuite';
  const ciBranch = isCi ? parseCiBranch(row.subject_title) : null;
  const defaultBranch = isCi && ciBranch && repo ? await reader.defaultBranch(repo) : null;
  const tabled = decideThread({
    reason: row.reason,
    subjectType: row.subject_type,
    subjectState: subject?.state || null,
    subjectMerged: subject?.merged === true,
    trust,
    suspect: signals.length > 0,
    repoOwned,
    repoManaged,
    ciBranch,
    defaultBranch,
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
      commenter: commenter && commenter !== actorLogin ? commenter : null,
      repoOwned,
      repoManaged,
      subjectState: subject ? (subject.merged === true ? 'merged' : subject.state || null) : null,
      ciBranch,
      metadataMissing: Boolean(subjectPath && !subject),
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
 * Triage this account's threads that are new or have new activity since their
 * last decision. Returns `{ triaged, decisions: { [decision]: n } }`.
 */
export async function triageAccountNotifications(account, env, { now = Date.now() } = {}) {
  const { rows } = await query(
    `SELECT * FROM github_notifications WHERE account_id = $1 AND (triaged_for IS NULL OR triaged_for < gh_updated_at)
     ORDER BY gh_updated_at DESC LIMIT ${MAX_THREADS_PER_RUN}`,
    [account.id],
  );
  if (!rows.length) return { triaged: 0, decisions: {} };
  const reader = createReader(account, env);
  const ctx = {
    account, reader, ownLogins: await ownLoginsFor(account, reader), managedKeys: await managedRepoKeys(), learnedRules: await loadLearnedRules(account.id), now,
  };
  const results = [];
  for (const row of rows) results.push({ row, result: await triageThread(row, ctx) });

  const decisions = {};
  await withTransaction(async (client) => {
    for (const { row, result } of results) {
      decisions[result.decision] = (decisions[result.decision] || 0) + 1;
      await client.query(
        `UPDATE github_notifications SET decision = $3, trust = $4, suspect = $5, evidence = $6::jsonb, triaged_for = $7, updated_at = NOW()
         WHERE account_id = $1 AND thread_id = $2`,
        [account.id, row.thread_id, result.decision, result.trust, result.suspect, toPgJson(result.evidence), row.gh_updated_at],
      );
      if (row.decision !== result.decision) {
        await client.query(
          `INSERT INTO github_notification_events (account_id, thread_id, actor, kind, detail) VALUES ($1, $2, 'automation', 'triaged', $3::jsonb)`,
          [account.id, row.thread_id, toPgJson({ decision: result.decision, rule: result.evidence.rule, mode: account.mode })],
        );
      }
    }
    await foldCiDuplicates(client, account.id);
  });
  return { triaged: results.length, decisions };
}
