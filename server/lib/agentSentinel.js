/**
 * The `.agent-done` completion sentinel — shared name + parser.
 *
 * A finishing agent writes this file into its workspace to signal completion
 * (see agentTuiSpawning's sentinel poll). Historically it held a plain-markdown
 * task summary that gets appended to the agent's output. Programmatic-I/O task
 * types (see docs/plans/2026-07-09-programmatic-io-scheduled-tasks.md) also need
 * a STRUCTURED result back — e.g. Layered Intelligence's reasoner JSON — so the
 * sentinel may instead be a JSON object `{ summary, payload }` where `payload`
 * is the machine-readable result a `processTaskOutput` hook consumes.
 *
 * `parseSentinelPayload` is pure and back-compat: a plain-text sentinel yields
 * `{ summary: <text>, payload: null }`; a JSON object yields its `summary`
 * (string, if present) plus its `payload`. Anything that fails to shape up
 * (empty, non-object JSON like a bare array/number) degrades to text so an
 * existing markdown sentinel is never misread as structured.
 */

import { safeJSONParse } from './fileUtils.js';

export const DONE_SENTINEL_NAME = '.agent-done';

/**
 * Parse `.agent-done` contents into `{ summary, payload }`.
 *   - `summary`: human-readable text for the agent output/card (never null;
 *     falls back to the raw trimmed contents).
 *   - `payload`: the structured result for a task-type output hook, or null
 *     when the sentinel carried no JSON object (the common legacy case).
 * Pure — no I/O. `contents` may be null/undefined (missing file).
 */
export function parseSentinelPayload(contents) {
  const trimmed = typeof contents === 'string' ? contents.trim() : '';
  if (!trimmed) return { summary: '', payload: null };

  // Only a JSON OBJECT counts as structured. `safeJSONParse` with allowArray:false
  // returns the object, or null for a plain markdown summary / bare JSON
  // scalar/array / malformed content — so a legacy sentinel round-trips as text
  // (repo convention: reuse safeJSONParse, no bare try/catch).
  const parsed = safeJSONParse(trimmed, null, { allowArray: false });
  if (parsed) {
    const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
    const payload = 'payload' in parsed ? parsed.payload : null;
    return { summary, payload };
  }

  return { summary: trimmed, payload: null };
}

/**
 * Lenient fallback for a STRUCTURED sentinel that the strict
 * `parseSentinelPayload` couldn't read. A less-capable model (notably a local
 * one) commonly emits an almost-valid `{ summary, payload }` envelope — wrapped
 * in ```json fences, trailed by prose, or with raw newlines/tabs pasted into
 * the long markdown `body` string — which `JSON.parse` rejects, silently
 * dropping a real proposal as "unparseable-response". This runs the shared
 * robust LLM-JSON extractor (`jsonExtract.extractJson`: strips fences, walks
 * balanced blocks, repairs trailing commas / orphan braces / raw control
 * chars) over the raw contents and, ONLY when it recovers the documented
 * envelope shape (a `{ ..., "payload": ... }` object), surfaces its payload.
 *
 * Deliberately narrow: it requires the `payload` key so a legacy plain-markdown
 * sentinel that merely happens to contain a `{...}` block is never misread as
 * structured — that stays text (payload null). Async + a LAZY import of
 * jsonExtract so the barrel re-export of this module doesn't statically pull
 * jsonExtract's transitive services chain into every lib consumer / mocked
 * suite. Callers use it as a second tier after `parseSentinelPayload` returns a
 * null payload (see agentLifecycle's dispatchTaskOutputHook).
 *
 * @param {string|null|undefined} contents — raw `.agent-done` contents
 * @returns {Promise<{ summary: string, payload: unknown }>}
 */
export async function salvageSentinelPayload(contents) {
  const trimmed = typeof contents === 'string' ? contents.trim() : '';
  if (!trimmed || !trimmed.includes('{')) return { summary: trimmed, payload: null };

  // The documented sentinel envelope: a plain object carrying a `payload` key.
  const isEnvelope = (v) => v && typeof v === 'object' && !Array.isArray(v) && 'payload' in v;

  const { extractJson } = await import('./jsonExtract.js');
  const { value } = extractJson(trimmed, { shapePredicate: isEnvelope });
  // Re-verify the shape: extractJson falls back to the first block that merely
  // PARSED (ignoring the predicate) when none matched, so an incidental
  // non-envelope object must not be adopted as a payload.
  if (!isEnvelope(value)) return { summary: trimmed, payload: null };

  const summary = typeof value.summary === 'string' ? value.summary : '';
  return { summary, payload: value.payload };
}
