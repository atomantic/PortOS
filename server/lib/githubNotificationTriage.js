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
export const TRIAGE_RULES_VERSION = 6;

// Open threads with nothing left for you: closed or merged, folded into a
// newer CI notice, or owned by a PR workflow. They stay in the inbox (it
// mirrors GitHub's) until marked done, which the inbox can do in one tap.
export const FINISHED_DECISIONS = Object.freeze(['handled-by-pr-workflow', 'duplicate', 'suggest-mark-read']);

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
 * suspect, security alert, deployment approval, invitation, your own PR in a managed repo,
 * finished thread, CI, review request, mention elsewhere, then Needs you.
 *
 * `commenterTrust` is the latest commenter's trust when it differs from the
 * subject author. Activity on your own PR goes to the PR workflow that opened
 * and drives it, unless someone outside commented: that waits for you.
 */
export function decideThread({ reason, subjectType, subjectState, subjectMerged = false, trust, commenterTrust = null, suspect = false, repoOwned = false, repoManaged = false, ciBranch = null, defaultBranch = null, deploymentWaiting = null }) {
  if (suspect) return { decision: 'suspect', rule: 'spam-signal' };
  if (reason === 'security_alert') return { decision: 'surface-high', rule: 'security-alert' };
  // `deploymentWaiting` is null when the forge could not be asked: a
  // deployment that may still be blocked on you is never assumed finished.
  if (reason === 'approval_requested' && subjectType === 'WorkflowRun') {
    return deploymentWaiting === false
      ? { decision: 'suggest-mark-read', rule: 'finished-thread' }
      : { decision: 'surface-high', rule: 'deployment-approval' };
  }
  if (reason === 'invitation') return { decision: 'surface', rule: 'invitation-never-accepted' };
  if (reason === 'author' && subjectType === 'PullRequest' && trust === 'yours' && repoManaged && commenterTrust !== 'outside') {
    return { decision: 'handled-by-pr-workflow', rule: 'own-pr-in-managed-repo' };
  }
  const finished = subjectMerged === true || subjectState === 'closed';
  if (finished) return { decision: 'suggest-mark-read', rule: 'finished-thread' };
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

/**
 * The waiting run a deployment-approval thread is about. GitHub gives the
 * thread no subject url; its `updated_at` is the run's at the request. A run
 * re-requested later is still the one waiting across that time. `undefined`
 * when the runs could not be read.
 */
export function matchWaitingRun(runs, threadUpdatedAt) {
  if (!Array.isArray(runs)) return undefined;
  const at = new Date(threadUpdatedAt).getTime();
  const time = (value) => Date.parse(value || '');
  const valid = runs.filter((entry) => Number.isInteger(entry?.id) && entry.id > 0);
  return valid.find((entry) => time(entry.updatedAt) === at)
    || valid.filter((entry) => time(entry.createdAt) <= at && at <= time(entry.updatedAt))
      .sort((a, b) => time(b.createdAt) - time(a.createdAt))[0]
    || null;
}

/** The run fields the inbox shows, bounded; display only, never trust. */
export const workflowRunEvidence = (entry) => ({
  id: entry.id,
  name: typeof entry.name === 'string' ? entry.name.slice(0, 200) : null,
  displayTitle: typeof entry.displayTitle === 'string' ? entry.displayTitle.slice(0, 300) : null,
  headBranch: typeof entry.headBranch === 'string' ? entry.headBranch.slice(0, 255) : null,
  event: typeof entry.event === 'string' ? entry.event.slice(0, 50) : null,
});

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
const PINNED_RULES = new Set(['spam-signal', 'security-alert', 'invitation-never-accepted', 'deployment-approval']);
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
  // A closed or merged thread has nothing left to do, so it is done, not just
  // read; a folded CI repeat leaves its newest notice open.
  if (decision === 'suggest-mark-read' || decision === 'duplicate') return 'done';
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
const RULE_KINDS = new Set(['review-request', 'security-alert', 'issue-activity', 'ci-activity']);
// `ci-activity` rules name a GitHub action instead of starting an agent.
export const CI_RULE_ACTIONS = Object.freeze(['done', 'mute', 'leave']);
const RULE_REPO_RE = /^(?:\*|[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})$/;
// A review request still waiting on you; one you sorted as done or noise is not.
const REVIEW_DECISIONS = new Set(['suggest-review', 'suggest-untrusted-review', 'needs-you', 'surface']);
const REVIEW_TRUST = new Set(['yours', 'trusted']);
// Mirrored in CANDIDATE_SQL (githubNotificationAutopilot.js).
const FINISHED_SUBJECT_STATES = new Set(['merged', 'closed']);

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
  && typeof rule.repo === 'string' && RULE_REPO_RE.test(rule.repo)
  && (kind === 'ci-activity' ? CI_RULE_ACTIONS.includes(rule.action) : typeof rule.agent === 'boolean'));

// Built-in rules shown under every account. A rule the operator saves for the
// same kind and repo wins; with none, a CI notice is simply marked done.
export const DEFAULT_AGENT_RULES = Object.freeze([
  Object.freeze({ id: 'default-ci-activity', kind: 'ci-activity', repo: '*', action: 'done', builtin: true }),
]);

const isCiThread = (row) => row?.reason === 'ci_activity' || row?.subject_type === 'CheckSuite';

/**
 * What the account's rules do with a CI notification: `done`, `mute` or
 * `leave`. The repo's own rule, else the `*` rule, else the built-in default.
 * Suspect and closed-out threads are handled elsewhere, so this only reads
 * the thread's kind and repo.
 */
export function ciActivityAction({ account, row }) {
  if (!isCiThread(row)) return null;
  const rules = [...(Array.isArray(account?.agentRules) ? account.agentRules : []), ...DEFAULT_AGENT_RULES];
  return matchAgentRule(rules, 'ci-activity', row.repo_full_name)?.action || null;
}

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
 * Which lane an agent may resolve a thread in, or null for a closed or suspect
 * thread. A plan with `refused` names why it cannot go: a Private account's
 * threads go only once the operator sets `allowAgents` on it (the lanes use
 * their own providers, which its allow-list cannot bind, so the operator
 * accepts that), and the per-app lanes need the repo to be a PortOS managed
 * app. The pull number comes from the subject's API url and the link from the
 * stored html url, never from a title or body.
 *
 * Lanes: an outside PR's review request in a managed app goes to
 * `pr-reviewer`; a review request for a PR by you or a trusted author goes to
 * a review-only `/do:review` run
 * (`do-review`, opt-in for Autopilot through an agent rule); outside issue
 * activity to `issue-watcher`; a security alert to the app's
 * `dependency-updates`, or, in a repo of yours with no app or a global
 * advisory, a one-off `security-fix` run in a scratch clone. Any other open
 * thread goes to the generic `notification-resolve` run, refused unless its
 * author and latest commenter are you or trusted (or it is CI in a repo of
 * yours), so outside text reaches only the screened lanes; the tap re-checks
 * every commenter (threadDiscussionVouched). The account's
 * matching agent rule (`matchAgentRule`) adds its provider/model/effort pin.
 * Used by Autopilot and the inbox's Resolve with agent button.
 */
export function agentHandoff({ account, row }) {
  if (row?.state !== 'open' || row.suspect) return null;
  const evidence = row.evidence || {};
  const kind = threadAgentKind(row);
  const rule = matchAgentRule(account?.agentRules, kind, row.repo_full_name);
  let plan = null;
  if (kind === 'review-request' && REVIEW_DECISIONS.has(row.decision) && !FINISHED_SUBJECT_STATES.has(evidence.subjectState)) {
    const pullNumber = Number(PULL_PATH_RE.exec(String(row.subject_api_url || ''))?.[1]);
    // Only a PR by you or a trusted author goes to a plain /do:review run; an
    // outside PR goes to pr-reviewer, which screens untrusted content first and
    // needs a managed app (`needsApp` below refuses it otherwise).
    if (pullNumber > 0 && REVIEW_TRUST.has(row.trust)) plan = { lane: 'do-review', pullNumber, repo: row.repo_full_name, optIn: true };
    else if (pullNumber > 0 && row.decision === 'suggest-untrusted-review') plan = { lane: 'pr-reviewer', pullNumber };
  } else if (kind === 'issue-activity' && HANDOFF_ISSUE_DECISIONS.has(row.decision)
    && (row.trust === 'outside' || (evidence.commenter && !['yours', 'trusted'].includes(evidence.commenterTrust)))) {
    plan = { lane: 'issue-watcher' };
  } else if (kind === 'security-alert' && row.decision === 'surface-high') {
    // A managed app's own dependency lane reads the repo's Dependabot alerts and
    // PRs, not the thread. A repo of yours with no app, or an advisory that
    // names no repo, gets a one-off security fix run that works in a scratch clone.
    plan = evidence.repoManaged !== true && (evidence.repoOwned === true || !row.repo_full_name)
      ? { lane: 'security-fix', repo: row.repo_full_name || null }
      : { lane: 'dependency-updates' };
  }
  // A thread a specific lane took keeps that lane, refusal included: whatever
  // made it pick a screened lane never reaches the generic one instead.
  if (!plan) plan = genericHandoff(row, evidence);
  const pin = rulePin(rule);
  if (pin) plan.pin = pin;
  if (rule) plan.rule = { id: rule.id || null, agent: rule.agent };
  if (plan.refused) return plan;
  if (account?.trust === 'private' && account.allowAgents !== true) return { ...plan, refused: 'private-account' };
  const needsApp = !APP_FREE_AGENT_LANES.has(plan.lane);
  if (needsApp && evidence.repoManaged !== true) return { ...plan, refused: 'no-managed-app' };
  return plan;
}

/** The lane for any thread no specific lane fits (#13191): a one-off CoS task in a scratch clone. */
export const GENERIC_AGENT_LANE = 'notification-resolve';
/** Lanes that run without a managed app: a scratch clone, or `gh` in PR mode. */
export const APP_FREE_AGENT_LANES = Object.freeze(new Set(['security-fix', 'do-review', GENERIC_AGENT_LANE]));
const GENERIC_REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const VOUCHED_TRUST = new Set(['yours', 'trusted']);
// Subjects with no human author: CI runs in a repo of yours. A release is not
// one: a managed app's repo can be someone else's upstream, so its notes are not
// vouched for, nor is a subject whose author could not be read.
const NO_ACTOR_SUBJECTS = new Set(['CheckSuite', 'WorkflowRun']);

function genericRefusal(row, evidence) {
  // An agent already has it; a generic run that failed restores the old
  // decision (githubNotificationResolveTask.js), so a retry is allowed.
  if (row.decision === 'handed-off') return 'handed-off';
  if (FINISHED_DECISIONS.includes(row.decision) || FINISHED_SUBJECT_STATES.has(evidence.subjectState)) return 'finished';
  // Approving a deployment ships code: operator only (githubNotificationDeployment.js).
  if (row.reason === 'approval_requested' || evidence.rule === 'deployment-approval') return 'deployment-approval';
  // An agent with `gh` could accept it; invitations are never accepted automatically.
  if (row.reason === 'invitation') return 'invitation';
  // Security alerts have their own lanes; one they refused stays refused.
  if (row.reason === 'security_alert') return 'security-alert';
  if (!GENERIC_REPO_RE.test(row.repo_full_name || '')) return 'no-repo';
  const authorVouched = VOUCHED_TRUST.has(row.trust)
    || (row.trust === 'unknown' && evidence.repoOwned === true && evidence.metadataMissing !== true
      && (row.reason === 'ci_activity' || NO_ACTOR_SUBJECTS.has(row.subject_type)));
  if (!authorVouched) return 'outside-content';
  // Triage before #13191 did not record the latest commenter's trust; a thread
  // with a comment it did not record waits for new activity to re-check it.
  const hasComment = Boolean(row.latest_comment_api_url) && row.latest_comment_api_url !== row.subject_api_url;
  if (!Object.hasOwn(evidence, 'commenterTrust')) return hasComment || evidence.commenter ? 'comment-unchecked' : null;
  // An unreadable latest comment is recorded as outside with no commenter.
  if (evidence.commenterTrust !== null && !VOUCHED_TRUST.has(evidence.commenterTrust)) return 'outside-content';
  if (evidence.commenter && !VOUCHED_TRUST.has(evidence.commenterTrust)) return 'outside-content';
  return null;
}

function genericHandoff(row, evidence) {
  const plan = { lane: GENERIC_AGENT_LANE, repo: row.repo_full_name || null };
  const refused = genericRefusal(row, evidence);
  return refused ? { ...plan, refused } : plan;
}

/**
 * The provider/model/effort a run uses: the first of the per-run choice, the
 * agent rule's pin and the account's defaults that is set, taken whole so one
 * source's model never pairs with another's provider. A per-run choice of
 * `{}` (Auto everywhere) is set, and leaves the choice to CoS.
 */
export function agentRunPin({ perRun, rulePin: rule, defaults } = {}) {
  const pick = (source) => {
    const pin = {};
    for (const key of ['provider', 'model', 'effort']) if (typeof source?.[key] === 'string' && source[key]) pin[key] = source[key];
    return pin;
  };
  if (perRun && typeof perRun === 'object') return pick(perRun);
  for (const source of [rule, defaults]) {
    const pin = pick(source);
    if (Object.keys(pin).length) return pin;
  }
  return {};
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
  // The generic lane is on-tap only: an agent rule for it (#13192) is the only
  // way Autopilot may start one, and the review/issue/alert rules do not count.
  if (plan.lane === GENERIC_AGENT_LANE) return null;
  if (plan.optIn && plan.rule?.agent !== true) return null;
  return plan;
}
