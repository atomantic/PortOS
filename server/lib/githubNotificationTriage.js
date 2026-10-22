/**
 * Rule-based triage for the GitHub notifications inbox (#12871). Pure: the
 * service gathers metadata with `gh` and this module turns it into a trust
 * level, spam signals and one decision.
 *
 * Security boundary: trust comes only from configured accounts, repository
 * ownership and forge permissions, never from a title, comment body, label or
 * GitHub's self-reported `author_association`. Content may only ADD suspicion
 * (a mass-mention count); it can never raise trust or clear a signal.
 *
 * Assist mode (#12872) adds three inputs, none of which can raise trust:
 * a learned rule (the operator's own past correction), a model verdict from a
 * fixed enum, and the one automatic action `assistAction` allows.
 * Autopilot (#12874) only picks a lane with `autopilotHandoff`; the lane
 * re-screens its own input.
 */
import { isUntrustedContentProvider } from './untrustedContent.js';
import { isLocalInstanceEndpoint } from './localEndpoint.js';

export const TRIAGE_DECISIONS = Object.freeze([
  'suspect',
  'surface-high',
  'surface',
  'needs-you',
  'suggest-review',
  'suggest-untrusted-review',
  'suggest-mark-read',
  'handled-by-pr-workflow',
  'duplicate',
  'suggest-done',
  'suggest-mute',
  'handed-off',
]);

export const TRUST_LEVELS = Object.freeze(['yours', 'trusted', 'outside', 'unknown']);

// Bump when a rule change should re-decide threads that have no new activity;
// open threads triaged under an older version are triaged again.
export const TRIAGE_RULES_VERSION = 3;

// Decisions that leave nothing for you: something else has the thread, or it
// is already closed or merged. They sit under Handled instead of Needs you,
// even in Observe before anything acts on GitHub.
export const HANDLED_DECISIONS = Object.freeze(['handled-by-pr-workflow', 'duplicate', 'handed-off', 'suggest-mark-read']);

const NEW_ACCOUNT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
export const MASS_MENTION_THRESHOLD = 10;
// GitHub's own label for an actor with no history in the repo. Used only to
// add suspicion on repos the operator does not own, never to grant trust.
const NO_HISTORY_ASSOCIATIONS = new Set(['NONE', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR']);
const MENTION_REASONS = new Set(['mention', 'team_mention']);

const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : null);

/**
 * `yours` for one of the operator's own logins on the host, `trusted` for an
 * actor the forge reports with write access to an owned repo (or, on a Private
 * account, a member of the repo's org), `outside` otherwise, `unknown` when
 * the thread has no human actor (CI, releases).
 */
export function computeThreadTrust({ actorLogin, ownLogins = [], repoOwned = false, actorHasWriteAccess = false, actorIsOrgMember = false, accountTrust = 'public' }) {
  const actor = lower(actorLogin);
  if (!actor) return 'unknown';
  if (ownLogins.some((login) => lower(login) === actor)) return 'yours';
  if (repoOwned && actorHasWriteAccess === true) return 'trusted';
  if (accountTrust === 'private' && actorIsOrgMember === true) return 'trusted';
  return 'outside';
}

/** Fixed spam checks; any hit makes the thread Suspect. */
export function spamSignals({ trust, actorCreatedAt, actorAssociation, mentionCount = 0, repoOwned = false, priorThreadsInRepo = 0, reason, now = Date.now() }) {
  if (trust === 'yours' || trust === 'trusted') return [];
  const signals = [];
  const created = Date.parse(actorCreatedAt || '');
  if (Number.isFinite(created) && now - created < NEW_ACCOUNT_DAYS * DAY_MS) signals.push('new-account');
  if (!repoOwned && NO_HISTORY_ASSOCIATIONS.has(String(actorAssociation || '').toUpperCase())) signals.push('first-time-actor');
  if (Number.isInteger(mentionCount) && mentionCount >= MASS_MENTION_THRESHOLD) signals.push('mass-mention');
  if (!repoOwned && priorThreadsInRepo === 0 && MENTION_REASONS.has(reason)) signals.push('unrelated-repo');
  return signals;
}

/**
 * The branch a GitHub Actions notification is about. Only used to fold
 * repeat CI notices together, never for trust.
 */
export function parseCiBranch(title) {
  const match = String(title || '').match(/ for ([\w./-]{1,255}) branch\b/);
  return match ? match[1] : null;
}

/**
 * One decision from the fixed rule table (reason × source). First match wins:
 * suspect, security alert, invitation, your own PR in a managed repo,
 * finished thread, CI, review request, mention elsewhere, then Needs you.
 *
 * `commenterTrust` is the latest commenter's trust when it differs from the
 * subject author. Activity on your own PR goes to the PR workflow that opened
 * and drives it, unless someone outside commented: that waits for you.
 */
export function decideThread({ reason, subjectType, subjectState, subjectMerged = false, trust, commenterTrust = null, suspect = false, repoOwned = false, repoManaged = false, ciBranch = null, defaultBranch = null }) {
  if (suspect) return { decision: 'suspect', rule: 'spam-signal' };
  if (reason === 'security_alert') return { decision: 'surface-high', rule: 'security-alert' };
  if (reason === 'invitation') return { decision: 'surface', rule: 'invitation-never-accepted' };
  if (reason === 'author' && subjectType === 'PullRequest' && trust === 'yours' && repoManaged && commenterTrust !== 'outside') {
    return { decision: 'handled-by-pr-workflow', rule: 'own-pr-in-managed-repo' };
  }
  const finished = subjectMerged === true || subjectState === 'closed';
  if (finished && reason !== 'review_requested') return { decision: 'suggest-mark-read', rule: 'finished-thread' };
  if (reason === 'ci_activity' || subjectType === 'CheckSuite') {
    if (ciBranch && defaultBranch && ciBranch === defaultBranch) return { decision: 'surface', rule: 'ci-default-branch' };
    if (repoManaged && ciBranch) return { decision: 'handled-by-pr-workflow', rule: 'ci-watched-by-pr-workflow' };
    return { decision: 'needs-you', rule: 'ci-other' };
  }
  if (reason === 'review_requested') {
    if (trust === 'yours' || trust === 'trusted') return { decision: 'suggest-review', rule: 'review-trusted-author' };
    if (repoOwned) return { decision: 'suggest-untrusted-review', rule: 'review-outside-author' };
    return { decision: 'needs-you', rule: 'review-elsewhere' };
  }
  if (MENTION_REASONS.has(reason) && !repoOwned) return { decision: 'surface', rule: 'mention-elsewhere' };
  return { decision: 'needs-you', rule: 'default' };
}

// What a model may answer for a thread the rule table left undecided. Any
// other output fails the response schema and the thread stays with you.
export const ASSIST_VERDICTS = Object.freeze(['surface', 'done', 'suggest-mute']);
const VERDICT_DECISIONS = Object.freeze({ surface: 'surface', done: 'suggest-done', 'suggest-mute': 'suggest-mute' });

export function decisionFromVerdict(verdict) {
  const decision = VERDICT_DECISIONS[verdict];
  return decision ? { decision, rule: `ai-${verdict}` } : null;
}

// A learned rule replays the operator's own choice for a repo, reason and
// actor; it never overrides a spam signal, a security alert or an invitation.
const LEARNED_DECISIONS = Object.freeze(['surface', 'suggest-done', 'suggest-mute']);
const PINNED_RULES = new Set(['spam-signal', 'security-alert', 'invitation-never-accepted']);
const ACTION_LESSONS = Object.freeze({ done: 'suggest-done', unsubscribe: 'suggest-done', mute: 'suggest-mute', reopen: 'surface', resubscribe: 'surface' });

/** The decision an operator action teaches, or null when it teaches nothing (a plain read). */
export const learnedDecisionForAction = (action) => ACTION_LESSONS[action] || null;

// One correction is enough to bring threads back to you; quieting them
// automatically takes the same correction twice.
const LEARN_QUIET_AFTER = 2;

/** `learned` is a stored rule `{ decision, hits }`, or undefined. */
export function applyLearnedRule(result, learned) {
  if (!learned || !LEARNED_DECISIONS.includes(learned.decision) || PINNED_RULES.has(result.rule)) return result;
  if (learned.decision !== 'surface' && !(learned.hits >= LEARN_QUIET_AFTER)) return result;
  return { decision: learned.decision, rule: 'learned' };
}

/**
 * The one GitHub write Assist may make for a thread, or null to leave it for
 * the operator. Suspect threads are never acted on. Outside threads are acted
 * on only when the forge reports them closed or merged, which no content can
 * fake; a mute needs a trusted source or the operator's own learned rule.
 */
export function assistAction({ decision, rule, trust, suspect = false, state = 'open' }) {
  if (suspect || state !== 'open') return null;
  // A closed or merged thread has nothing left to do, so it is done, not just read.
  if (decision === 'suggest-mark-read') return 'done';
  if (trust === 'outside') return null;
  const vouched = trust === 'yours' || trust === 'trusted' || rule === 'learned';
  if (decision === 'handled-by-pr-workflow') return 'done';
  if (decision === 'suggest-done' && vouched) return 'done';
  if (decision === 'suggest-mute' && vouched) return 'mute';
  return null;
}

/**
 * The provider a thread's text may go to. A Public account uses the
 * `github-notification` source policy as-is (`provider: null`). A Private
 * account only reaches its `allowedProviders`, or local endpoints when that is
 * unset, and a source pin outside that set fails closed.
 */
export function selectNotificationProvider({ account, providers = [], policy = {} }) {
  if (account?.trust !== 'private') return { provider: null, model: null };
  const allowed = Array.isArray(account.allowedProviders) ? new Set(account.allowedProviders) : null;
  const eligible = providers.filter((provider) => isUntrustedContentProvider(provider, 'github-notification')
    && (allowed ? allowed.has(provider.id) : isLocalInstanceEndpoint(provider.endpoint)));
  const candidates = policy.providerId ? eligible.filter((provider) => provider.id === policy.providerId) : eligible;
  for (const provider of candidates) {
    const model = policy.model || provider.defaultModel;
    if (model) return { provider, model };
  }
  return { code: 'github-notification-provider-not-allowed' };
}

// A thread goes to the lane that already owns its kind of work. Issue
// activity qualifies while it would otherwise wait for you.
const HANDOFF_ISSUE_DECISIONS = new Set(['needs-you', 'surface']);
const PULL_PATH_RE = /\/pulls\/(\d{1,9})$/;

// The notification kinds an agent rule can name (GITHUB_AGENT_RULE_KINDS in
// lib/validation.js), and the kind of a thread, or null when no rule applies.
const RULE_KINDS = new Set(['review-request', 'security-alert', 'issue-activity']);
const RULE_REPO_RE = /^(?:\*|[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})$/;
// A review request still waiting on you; one you sorted as done or noise is not.
const REVIEW_DECISIONS = new Set(['suggest-review', 'suggest-untrusted-review', 'needs-you', 'surface']);
const REVIEW_TRUST = new Set(['yours', 'trusted']);

function threadAgentKind(row) {
  if (row?.reason === 'security_alert') return 'security-alert';
  if (row?.reason === 'review_requested' && row.subject_type === 'PullRequest') return 'review-request';
  if (row?.subject_type === 'Issue') return 'issue-activity';
  return null;
}

/**
 * The account's agent rule for a kind of thread in a repo: the repo's own rule,
 * else the `*` rule, else null. A malformed stored rule is ignored.
 */
const validRules = (rules, kind) => (Array.isArray(rules) ? rules : []).filter((rule) => rule
  && RULE_KINDS.has(rule.kind) && rule.kind === kind
  && typeof rule.repo === 'string' && RULE_REPO_RE.test(rule.repo) && typeof rule.agent === 'boolean');

function matchAgentRule(rules, kind, repo) {
  if (!kind) return null;
  const valid = validRules(rules, kind);
  const name = String(repo || '').toLowerCase();
  return (name && valid.find((rule) => rule.repo.toLowerCase() === name)) || valid.find((rule) => rule.repo === '*') || null;
}

/**
 * Which repos Autopilot hands a kind of thread off in, for its candidate query:
 * every repo except `except` when `all`, else only the `only` repos (lowercase).
 * The `*` rule sets the default; a kind with no `*` rule is on unless `optIn`.
 * Mirrors `matchAgentRule` + `autopilotHandoff`, so a row a rule keeps from an
 * agent never takes a slot in the run.
 */
export function agentRuleScope(rules, kind, { optIn = false } = {}) {
  const valid = validRules(rules, kind);
  const star = valid.find((rule) => rule.repo === '*');
  const all = star ? star.agent : !optIn;
  const repos = (agent) => valid.filter((rule) => rule.repo !== '*' && rule.agent === agent).map((rule) => rule.repo.toLowerCase());
  return all ? { all, except: repos(false), only: [] } : { all, except: [], only: repos(true) };
}

const rulePin = (rule) => {
  const pin = {};
  for (const key of ['provider', 'model', 'effort']) if (typeof rule?.[key] === 'string' && rule[key]) pin[key] = rule[key];
  return Object.keys(pin).length ? pin : null;
};

/**
 * Which lane an agent may resolve a thread in, or null when no lane fits. A
 * plan with `refused` names why it cannot go: a Private account's threads go
 * only once the operator sets `allowAgents` on it (the lanes use their own
 * providers, which its allow-list cannot bind, so the operator accepts that), and
 * the per-app lanes need the repo to be a PortOS managed app. Suspect and closed
 * threads never qualify. The pull number comes from the subject's API url and
 * the link from the stored html url, never from a title or body.
 *
 * Lanes: an outside PR's review request in a managed app goes to
 * `pr-reviewer`; a review request for a PR by you or a trusted author goes to
 * a review-only `/do:review` run
 * (`do-review`, opt-in for Autopilot through an agent rule); outside issue
 * activity to `issue-watcher`; a security alert to the app's
 * `dependency-updates`, or, in a repo of yours with no app or a global
 * advisory, a one-off `security-fix` run in a scratch clone. The account's
 * matching agent rule (`matchAgentRule`) adds its provider/model/effort pin.
 * Used by Autopilot and the inbox's Resolve with agent button.
 */
export function agentHandoff({ account, row }) {
  if (row?.state !== 'open' || row.suspect) return null;
  const evidence = row.evidence || {};
  const kind = threadAgentKind(row);
  const rule = matchAgentRule(account?.agentRules, kind, row.repo_full_name);
  let plan = null;
  if (kind === 'review-request' && REVIEW_DECISIONS.has(row.decision)) {
    const pullNumber = Number(PULL_PATH_RE.exec(String(row.subject_api_url || ''))?.[1]);
    // Only a PR by you or a trusted author goes to a plain /do:review run; an
    // outside PR goes to pr-reviewer, which screens untrusted content first and
    // needs a managed app (`needsApp` below refuses it otherwise).
    if (pullNumber > 0 && REVIEW_TRUST.has(row.trust)) plan = { lane: 'do-review', pullNumber, repo: row.repo_full_name, optIn: true };
    else if (pullNumber > 0 && row.decision === 'suggest-untrusted-review') plan = { lane: 'pr-reviewer', pullNumber };
  } else if (kind === 'issue-activity' && HANDOFF_ISSUE_DECISIONS.has(row.decision) && (row.trust === 'outside' || evidence.commenter)) {
    plan = { lane: 'issue-watcher' };
  } else if (kind === 'security-alert' && row.decision === 'surface-high') {
    // A managed app's own dependency lane reads the repo's Dependabot alerts and
    // PRs, not the thread. A repo of yours with no app, or an advisory that
    // names no repo, gets a one-off security fix run that works in a scratch clone.
    plan = evidence.repoManaged !== true && (evidence.repoOwned === true || !row.repo_full_name)
      ? { lane: 'security-fix', repo: row.repo_full_name || null }
      : { lane: 'dependency-updates' };
  }
  if (!plan) return null;
  const pin = rulePin(rule);
  if (pin) plan.pin = pin;
  if (rule) plan.rule = { id: rule.id || null, agent: rule.agent };
  if (account?.trust === 'private' && account.allowAgents !== true) return { ...plan, refused: 'private-account' };
  const needsApp = plan.lane !== 'security-fix' && plan.lane !== 'do-review';
  if (needsApp && evidence.repoManaged !== true) return { ...plan, refused: 'no-managed-app' };
  return plan;
}

/**
 * Autopilot's plan for a thread: `agentHandoff` in Autopilot mode, minus
 * anything an agent rule switched off, and minus an opt-in lane no rule
 * switched on.
 */
export function autopilotHandoff({ account, row }) {
  if (account?.mode !== 'autopilot') return null;
  const plan = agentHandoff({ account, row });
  if (!plan || plan.rule?.agent === false) return null;
  if (plan.optIn && plan.rule?.agent !== true) return null;
  return plan;
}
