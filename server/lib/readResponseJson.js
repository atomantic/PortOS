import { safeJSONParse } from './fileUtils.js';

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
 *   - a valid JSON body parses normally;
 *   - an empty body returns `emptyValue` (default `{}`), distinct from a parse
 *     failure, so spreading callers don't pick up a spurious shape;
 *   - a non-JSON body returns `fallback` (default `{}`). `fallback` may be a
 *     function `(rawText) => value` when the fallback needs the body text —
 *     e.g. surfacing the server's error page as `{ error: rawText }`.
 *
 * Object-shaped callers (the common case — endpoints returning `{ data }`,
 * `{ models }`, `{ choices }`, …) need no options: a non-JSON body becomes
 * `{}`, so their existing `data.foo || []` defaults take over instead of
 * throwing on `null.foo`. Array-shaped callers pass `{ fallback: [], emptyValue: [] }`.
 *
 * @param {Response} response - an already-awaited fetch Response
 * @param {Object} [opts]
 * @param {*|function(string):*} [opts.fallback={}] - value (or text→value fn) for a non-JSON body
 * @param {*} [opts.emptyValue={}] - value for an empty body
 * @returns {Promise<*>} parsed JSON, or the fallback/empty value
 */
export async function readResponseJson(response, { fallback = {}, emptyValue = {} } = {}) {
  const text = await response.text();
  if (!text) return emptyValue;
  // Parse with a private sentinel so a successful parse is distinguishable from
  // a parse failure, and the (possibly function) fallback is only materialized
  // when the body genuinely isn't JSON — never eagerly on every success.
  const FAILED = Symbol('parse-failed');
  const parsed = safeJSONParse(text, FAILED);
  if (parsed !== FAILED) return parsed;
  return typeof fallback === 'function' ? fallback(text) : fallback;
}
