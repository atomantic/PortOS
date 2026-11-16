/**
 * Read a `Response` body as JSON, tolerating a non-JSON/HTML error page (no `Unexpected token <` crash).
 */

import { safeJSONParse } from './fileUtils.js';

// Private sentinel marking a failed parse, distinct from any valid-body value (`null`/`{}`/`[]`); module-level so it isn't reallocated per call.
const PARSE_FAILED = Symbol('parse-failed');

/**
 * Read a fetch `Response` body as JSON, tolerating a non-JSON body: `response.json()` throws `Unexpected token <` on an HTML error page (a 500 during a service restart, a proxy/captive-portal error), masking the real error and, because most callers run outside the Express lifecycle, crashing the process.
 * This reads the raw text and parses via `safeJSONParse`: a valid object/array body parses; a blank body returns `emptyValue` (distinct from a parse failure, so spreading callers don't pick up a spurious shape); a non-JSON body returns `fallback` (default `{}`), which may be a function `(rawText) => value`
 * (e.g. `{ error: rawText }`). `emptyValue` defaults to `fallback` when that is a plain value (an array caller passes `{ fallback: [] }`), else `{}`.
 * Object-shaped callers (`{ data }`, `{ models }`, `{ choices }`) need no options (`data.foo || []` defaults take over instead of `null.foo` throwing); array callers pass `{ fallback: [] }`; a caller with a downstream truthiness contract (a route that 503s on falsy)
 * passes `{ fallback: null, emptyValue: null }` so a malformed body stays falsy. Only object/array JSON bodies are recognized (a bare primitive is a parse failure, inheriting `safeJSONParse`'s structural validation).
 */
export async function readResponseJson(response, { fallback = {}, emptyValue } = {}) {
  const resolvedEmpty = emptyValue !== undefined
    ? emptyValue
    : (typeof fallback === 'function' ? {} : fallback);

  const text = await response.text();
  if (!text.trim()) return resolvedEmpty;
  const parsed = safeJSONParse(text, PARSE_FAILED);
  if (parsed !== PARSE_FAILED) return parsed;
  return typeof fallback === 'function' ? fallback(text) : fallback;
}
