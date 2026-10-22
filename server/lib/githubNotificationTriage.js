/**
 * Rule-based triage for the GitHub notifications inbox (#12871). Pure: the
 * service gathers metadata with `gh` and this module turns it into a trust
 * level, spam signals and one decision.
 *
 * Security boundary: trust comes only from configured accounts, repository
 * ownership and forge permissions, never from a title, comment body, label or
 * GitHub's self-reported `author_association`. Content may only ADD suspicion
 * (a mass-mention count); it can never raise trust or clear a signal.
 */

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
]);

export const TRUST_LEVELS = Object.freeze(['yours', 'trusted', 'outside', 'unknown']);

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
 * suspect, security alert, invitation, finished thread, CI, review request,
 * mention elsewhere, then Needs you.
 */
export function decideThread({ reason, subjectType, subjectState, subjectMerged = false, trust, suspect = false, repoOwned = false, repoManaged = false, ciBranch = null, defaultBranch = null }) {
  if (suspect) return { decision: 'suspect', rule: 'spam-signal' };
  if (reason === 'security_alert') return { decision: 'surface-high', rule: 'security-alert' };
  if (reason === 'invitation') return { decision: 'surface', rule: 'invitation-never-accepted' };
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
