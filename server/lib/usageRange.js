/**
 * Date-range resolution for the /devtools/usage cost report — pure, shared by
 * the usage route and any future consumer (dashboard widget, voice tool,
 * scheduled report) that needs "period → inclusive YYYY-MM-DD range".
 */

const PERIOD_DAYS = { '7d': 7, '30d': 30, '90d': 90 };

/**
 * Resolve validated usage-query params to an inclusive { from, to } date range
 * (YYYY-MM-DD, null = unbounded). Explicit from/to win; otherwise a preset
 * period counting back from today (default 7d, matching the page's charts).
 * Dates use the UTC calendar day, consistent with usage.js's dailyActivity keys.
 * @param {{ period?: '7d'|'30d'|'90d'|'all', from?: string, to?: string }} query
 * @returns {{ from: string|null, to: string|null }}
 */
export function resolveUsageRange({ period, from, to } = {}) {
  if (from || to) return { from: from || null, to: to || null };
  if (period === 'all') return { from: null, to: null };
  const days = PERIOD_DAYS[period] || PERIOD_DAYS['7d'];
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  return { from: start.toISOString().split('T')[0], to: null };
}
