/**
 * `fetchByIds(path, ids, options)` — batch-fetch records through a list route's `?ids=a,b,c` filter
 * (dedupe, empty-list short-circuit, `{ items }` envelope unwrap).
 */

import { request } from './apiCore.js';

/**
 * The id list `fetchByIds` will actually request: trimmed, non-strings and
 * blanks dropped, de-duplicated, in first-seen order. Exported so a caller that
 * re-orders the response into its request order (apiCatalog) indexes against the
 * exact same normalized list rather than its own raw input.
 */
export const normalizeIds = (ids) => [...new Set(
  (Array.isArray(ids) ? ids : [])
    .map((id) => (typeof id === 'string' ? id.trim() : ''))
    .filter(Boolean),
)];

/**
 * Batch-fetch records by id through a list route's `?ids=a,b,c` filter (#4148) —
 * the client half of the server's shared `csvIdsParam` query param.
 *
 * Normalizes the ids (see above), then unwraps a paginated `{ items }` envelope
 * to a plain array. Ids the server omits (missing or soft-deleted) are simply
 * absent from the result, so callers index it by `id` rather than assuming
 * positional parity with the request.
 *
 * The trim and the empty-list short-circuit are load-bearing, not
 * micro-optimizations: a present-but-blank `?ids=` (which is what a
 * whitespace-only id serializes to) reads as ABSENT server-side, so issuing the
 * request anyway would return the whole unfiltered list — the exact over-fetch
 * these batch helpers exist to remove.
 *
 * Lives in its own module rather than inside `apiCore.js` so the suites that
 * mock `./apiCore.js` wholesale still intercept the `request` this makes.
 */
export async function fetchByIds(path, ids = [], options) {
  const list = normalizeIds(ids);
  if (list.length === 0) return [];
  const params = new URLSearchParams({ ids: list.join(',') });
  const res = await request(`${path}?${params}`, options);
  return Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : []);
}
