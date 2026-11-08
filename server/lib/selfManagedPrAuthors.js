/**
 * pr-watcher's self-managed author list: PRs by these logins are left to their
 * author (who runs their own merge) until the PR has had no activity for the
 * configured number of minutes. Leaf module so the watcher and the task-metadata
 * sanitizer share one vocabulary without the watcher importing validation.
 */

export const SELF_MANAGED_PR_STALE_MINUTES_DEFAULT = 60;
export const SELF_MANAGED_PR_STALE_MINUTES_MAX = 7 * 24 * 60;
export const MAX_SELF_MANAGED_PR_AUTHORS = 50;
// A user login, or a GitHub App's `name[bot]` / gh's `app/name` author form.
const GITHUB_LOGIN_RE = /^(?:app\/)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

/** Lowercased, deduped, capped GitHub logins (non-array → []). Unlike normalizeReviewUsernames, no team slugs. */
export function normalizeSelfManagedPrAuthors(list) {
  if (!Array.isArray(list)) return [];
  const out = new Set();
  for (const raw of list) {
    const login = typeof raw === 'string' ? raw.trim().replace(/^@+/, '').toLowerCase() : '';
    if (GITHUB_LOGIN_RE.test(login)) out.add(login);
    if (out.size >= MAX_SELF_MANAGED_PR_AUTHORS) break;
  }
  return [...out];
}

export function isValidSelfManagedPrStaleMinutes(value) {
  return Number.isInteger(value) && value >= 1 && value <= SELF_MANAGED_PR_STALE_MINUTES_MAX;
}

/**
 * Whether a PR is by a self-managed author who has been active on it within the
 * stale window. An unparseable `updatedAt` cannot prove recent activity, so the
 * PR is not held.
 */
export function isSelfManagedPrActive(pr, { authors, staleMinutes } = {}, nowMs = Date.now()) {
  const login = typeof pr?.authorLogin === 'string' ? pr.authorLogin.toLowerCase() : '';
  if (!login || !authors?.includes(login)) return false;
  const updatedMs = Date.parse(pr.updatedAt || '');
  if (!Number.isFinite(updatedMs)) return false;
  return nowMs - updatedMs < (staleMinutes ?? SELF_MANAGED_PR_STALE_MINUTES_DEFAULT) * 60_000;
}
