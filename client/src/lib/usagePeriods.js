/**
 * The report windows every usage-cost surface offers, and the one `?period`
 * means when the URL carries none.
 *
 * Shared because the value is a URL param the user carries BETWEEN these pages.
 * Two copies had already disagreed on the default, so the same `?period=`-less
 * URL resolved to a different window depending on which page read it — and a
 * link copied from one page silently changed meaning on the other.
 */

export const USAGE_PERIOD_OPTIONS = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: 'all', label: 'All time' },
];

/** The window a URL with no `?period` means. Omitted from the URL, never set. */
export const DEFAULT_USAGE_PERIOD = '7d';

/** The period a URL's `?period` selects, falling back to the shared default. */
export const resolveUsagePeriod = (value) => (
  USAGE_PERIOD_OPTIONS.some((option) => option.id === value) ? value : DEFAULT_USAGE_PERIOD
);
