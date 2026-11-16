/**
 * `fetchByIds(path, ids, options)` — batch-fetch records through a list route's `?ids=a,b,c` filter
 * (dedupe, empty-list short-circuit, `{ items }` envelope unwrap).
 */

import { request } from './apiCore.js';

/**
 * The id list `fetchByIds` will actually request: trimmed, non-strings and blanks dropped, de-duplicated, first-seen order. Exported so a caller that re-orders the response (apiCatalog) indexes against the same normalized list.
 */
export const normalizeIds = (ids) => [...new Set(
  (Array.isArray(ids) ? ids : [])
    .map((id) => (typeof id === 'string' ? id.trim() : ''))
    .filter(Boolean),
)];

/**
 * Batch-fetch records by id through a list route's `?ids=a,b,c` filter (#4148), the client half of the server's `csvIdsParam`. Normalizes the ids, then unwraps a paginated `{ items }` envelope; ids the server omits (missing or soft-deleted) are absent, so index by `id` rather than assuming positional parity.
 * The trim and empty-list short-circuit are load-bearing: a present-but-blank `?ids=` reads as ABSENT server-side and would return the whole unfiltered list. Its own module (not `apiCore.js`) so suites that mock `./apiCore.js` wholesale still intercept the `request` this makes.
 */
export async function fetchByIds(path, ids = [], options) {
  const list = normalizeIds(ids);
  if (list.length === 0) return [];
  const params = new URLSearchParams({ ids: list.join(',') });
  const res = await request(`${path}?${params}`, options);
  return Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : []);
}
