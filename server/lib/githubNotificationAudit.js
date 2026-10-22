/**
 * Suggestions for the GitHub notifications subscription audit (#12873). Pure:
 * the service aggregates the last 30 days of stored threads per repo × reason
 * and lists watched repos; this turns them into one-tap changes and links.
 * Nothing here is applied automatically.
 */

export const AUDIT_WINDOW_DAYS = 30;
const MIN_REPO_VOLUME = 5;
const NOISY_SUBSCRIBED = 10;
const CI_NOISE_FLOOR = 10;
// Reasons that come from watching a repo rather than from being involved.
const WATCH_REASONS = new Set(['subscribed', 'ci_activity', 'state_change']);

const sum = (rows, field) => rows.reduce((total, row) => total + (row[field] || 0), 0);

/**
 * `groups`: `{ repo, reason, total, acted, handled, handledOpen: [threadId] }`
 * rows; `watchedRepos`: full names the account watches (null when GitHub
 * could not list them). Returns `{ summary, suggestions }`; a suggestion with
 * `apply` is a change, one with `link` is advice for a setting the API cannot
 * change.
 */
export function buildAuditSuggestions({ groups = [], watchedRepos = null, host = 'github.com' }) {
  const watched = new Set((watchedRepos || []).map((repo) => repo.toLowerCase()));
  const byRepo = new Map();
  for (const group of groups) {
    if (!byRepo.has(group.repo)) byRepo.set(group.repo, []);
    byRepo.get(group.repo).push(group);
  }
  const suggestions = [];
  for (const [repo, rows] of byRepo) {
    const total = sum(rows, 'total');
    const acted = sum(rows, 'acted');
    const handled = sum(rows, 'handled');
    const watchDriven = sum(rows.filter((row) => WATCH_REASONS.has(row.reason)), 'total');
    const stats = { total, acted, handled };
    const isWatched = watched.has(repo.toLowerCase());
    if (isWatched && total >= MIN_REPO_VOLUME && acted === 0 && watchDriven / total >= 0.8) {
      suggestions.push({ id: `unwatch:${repo}`, kind: 'unwatch', repo, stats, apply: true });
    } else if (isWatched && sum(rows.filter((row) => row.reason === 'subscribed'), 'total') >= NOISY_SUBSCRIBED && acted / total < 0.2) {
      suggestions.push({ id: `custom-watch:${repo}`, kind: 'custom-watch', repo, stats, link: `https://${host}/${repo}` });
    }
    const handledOpen = rows.flatMap((row) => row.handledOpen || []);
    if (handledOpen.length) {
      suggestions.push({ id: `mute-handled:${repo}`, kind: 'mute-handled', repo, stats, threadIds: handledOpen.slice(0, 50), apply: true });
    }
  }
  const ci = groups.filter((group) => group.reason === 'ci_activity');
  const ciTotal = sum(ci, 'total');
  if (ciTotal >= CI_NOISE_FLOOR && sum(ci, 'acted') / ciTotal <= 0.1) {
    suggestions.push({
      id: 'actions-failed-only', kind: 'actions-failed-only', repo: null,
      stats: { total: ciTotal, acted: sum(ci, 'acted'), handled: sum(ci, 'handled') },
      link: `https://${host}/settings/notifications`,
    });
  }
  suggestions.sort((a, b) => b.stats.total - a.stats.total);
  return {
    summary: { total: sum(groups, 'total'), acted: sum(groups, 'acted'), handled: sum(groups, 'handled'), repos: byRepo.size },
    suggestions,
  };
}
