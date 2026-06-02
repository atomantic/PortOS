import { safeJSONParse } from './fileUtils.js';

// Private sentinel marking a failed parse — distinct from any value `safeJSONParse`
// can return for a valid body (including `null`/`{}`/`[]`). Module-level so it
// isn't reallocated per call.
const PARSE_FAILED = Symbol('parse-failed');

/**
 * Read a fetch `Response` body as JSON, tolerating a non-JSON body.
 *
 * Calling `response.json()` directly throws `Unexpected token <` when the
 * server answers with an HTML error page (a 500 while a service restarts, a
 * proxy/captive-portal error) instead of JSON — masking the real error and,
 * because most of these callers run outside the Express request lifecycle,
 * crashing the Node process. This reads the raw text and parses it tolerantly
 * via `safeJSONParse`:
 *
 *   - a valid JSON object/array body parses normally;
 *   - a blank (empty or whitespace-only) body returns `emptyValue`, distinct
 *     from a parse failure, so spreading callers don't pick up a spurious shape;
 *   - a non-JSON body returns `fallback` (default `{}`). `fallback` may be a
 *     function `(rawText) => value` when the fallback needs the body text —
 *     e.g. surfacing the server's error page as `{ error: rawText }`.
 *
 * `emptyValue` defaults to `fallback` (when `fallback` is a plain value), so an
 * array caller only needs `{ fallback: [] }` to get `[]` for both empty and
 * non-JSON. A function `fallback` is for surfacing error text and doesn't apply
 * to a blank body, so `emptyValue` then defaults to `{}`.
 *
 * Object-shaped callers (the common case — endpoints returning `{ data }`,
 * `{ models }`, `{ choices }`, …) need no options: a non-JSON body becomes
 * `{}`, so their existing `data.foo || []` defaults take over instead of
 * throwing on `null.foo`. Array-shaped callers pass `{ fallback: [] }`. Callers
 * with a downstream truthiness contract (e.g. a route that 503s when this is
 * falsy) pass `{ fallback: null, emptyValue: null }` so a malformed body stays
 * falsy rather than masquerading as a valid empty value.
 *
 * Note: only object/array JSON bodies are recognized; a bare JSON primitive
 * (`"str"`, `42`, `true`, `null`) is treated as a parse failure and returns the
 * fallback (it inherits `safeJSONParse`'s structural validation). All current
 * callers return objects/arrays.
 *
 * @param {Response} response - a resolved fetch Response (body not yet consumed)
 * @param {Object} [opts]
 * @param {*|function(string):*} [opts.fallback={}] - value (or text→value fn) for a non-JSON body
 * @param {*} [opts.emptyValue] - value for a blank body (defaults to `fallback`, or `{}` when `fallback` is a function)
 * @returns {Promise<*>} parsed JSON, or the fallback/empty value
 */
export async function readResponseJson(response, { fallback = {}, emptyValue } = {}) {
  // A blank body is a distinct "successful but empty" case. It mirrors the
  // fallback shape so a caller specifies one value; a function fallback (used to
  // surface error text) can't apply to an empty body, so it falls back to `{}`.
  const resolvedEmpty = emptyValue !== undefined
    ? emptyValue
    : (typeof fallback === 'function' ? {} : fallback);

  const text = await response.text();
  if (!text.trim()) return resolvedEmpty;
  // Parse against the sentinel so a successful parse is distinguishable from a
  // parse failure, and the (possibly function) fallback is only materialized
  // when the body genuinely isn't JSON — never eagerly on every success.
  const parsed = safeJSONParse(text, PARSE_FAILED);
  if (parsed !== PARSE_FAILED) return parsed;
  return typeof fallback === 'function' ? fallback(text) : fallback;
}
