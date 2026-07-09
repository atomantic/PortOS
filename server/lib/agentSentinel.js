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
