/**
 * Shared JSON extraction utilities for LLM responses.
 *
 * LLM output is messy — CLI providers (notably Codex) prepend banner text
 * and echo the user prompt back to stdout before the model response. The
 * prompt itself often contains a JSON-shaped schema example whose braces
 * balance but whose contents are not valid JSON. Models also routinely
 * emit trailing commas, `[...]` placeholder elisions, and the Codex
 * `}}]` orphan-brace corruption pattern.
 *
 * This module collapses three near-identical extractors that all solved
 * the same problem:
 *   - worldBuilderExpand.js — string-aware brace walker + repair passes
 *   - mediaPromptRefiner.js#extractRefinementJson — brace walker without repairs
 *   - stageRunner.js#extractJson — greedy regex
 *
 * The richest implementation (worldBuilderExpand) is promoted here and
 * the three callers import from this file with optional shape predicates.
 */

import { stripCodeFences } from './aiProvider.js';

/**
 * Walk the string and return every top-level brace-balanced block, in
 * order. String-aware so braces/brackets inside JSON string values don't
 * throw off the depth counter. Returning every block lets the caller try
 * each in turn — preferring the one whose shape matches the expected
 * response over an in-prompt schema example.
 *
 * @param {string} s — input text
 * @param {object} [options]
 * @param {string} [options.startChar='{'] — opening delimiter ('{' or '[')
 * @param {string} [options.endChar='}']   — matching closing delimiter
 * @returns {string[]} — every balanced block found, in source order
 */
export function findBalancedBlocks(s, { startChar = '{', endChar = '}' } = {}) {
  if (typeof s !== 'string' || !s) return [];
  const blocks = [];
  let i = 0;
  while (i < s.length) {
    const start = s.indexOf(startChar, i);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = start; j < s.length; j += 1) {
      const ch = s[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === startChar) depth += 1;
      else if (ch === endChar) {
        depth -= 1;
        if (depth === 0) { end = j; break; }
      }
    }
    // Intentional bail on the first unbalanced segment. A well-formed
    // block COULD exist further along (e.g. an LLM that dumped partial
    // JSON, then prose, then a complete second JSON object), but for
    // PortOS's LLM-output use case the more common shape is "model
    // emitted one JSON and then trailed off" — surfacing the candidates
    // we have so far and letting the caller decide is safer than gluing
    // together fragments that span an unbalanced gap. If a future use
    // case needs scan-past-unbalanced behavior, add an opt-in option.
    if (end === -1) break;
    blocks.push(s.slice(start, end + 1));
    i = end + 1;
  }
  return blocks;
}

/**
 * Apply a regex `replace()` to the input ONLY OUTSIDE quoted JSON
 * string regions. Walks the input with the same string/escape awareness
 * as `findBalancedBlocks`, splits into alternating "code" and "string"
 * segments, runs the replace on each code segment, then reassembles.
 * Strings are passed through verbatim, so a JSON string containing
 * `,}` or `}}]` as content is preserved.
 */
function replaceOutsideStrings(input, pattern, replacement) {
  if (typeof input !== 'string' || !input) return input;
  const segments = [];
  let cursor = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') {
        // String just closed at index `i`. The open-quote → close-quote
        // range (inclusive) is a 'string' segment the replace can't touch.
        segments.push({ kind: 'string', text: input.slice(cursor, i + 1) });
        cursor = i + 1;
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      // About to enter a string at index `i`. Flush the preceding code
      // region so the replace can fire on it.
      if (i > cursor) segments.push({ kind: 'code', text: input.slice(cursor, i) });
      cursor = i;
      inString = true;
    }
  }
  // Flush trailing region. If the input ended mid-string (malformed JSON),
  // treat the unterminated tail as a string so the repair doesn't touch
  // it — the parse will fail anyway and the caller falls through.
  if (cursor < input.length) {
    segments.push({ kind: inString ? 'string' : 'code', text: input.slice(cursor) });
  }
  return segments.map((seg) => (
    seg.kind === 'code' ? seg.text.replace(pattern, replacement) : seg.text
  )).join('');
}

/**
 * Try JSON.parse on a candidate block. If it fails, apply cheap repairs
 * for observed LLM corruption patterns and try again:
 *   - Trailing commas before `}` or `]` (common LLM mistake).
 *   - `[...]` literal placeholder elisions echoed from prompt examples.
 *   - Codex CLI `}}]` orphan-brace corruption — an extra `}` snuck in
 *     between a variation's close-brace and the array's `]`. Swapping
 *     `}}]` → `}]}` (not dropping the brace) keeps the brace count
 *     correct so the outer container still closes.
 *
 * All repairs are STRING-AWARE: the regexes only touch characters
 * outside quoted JSON string values, so a string containing `,}` or
 * `}}]` as ordinary content is preserved.
 *
 * Returns `{ value }` on success (where `value` may be a valid JSON
 * `null`); returns `{ error }` if all repairs fail. The wrapper lets a
 * top-level `null` response flow through as a real parsed value rather
 * than colliding with a "did not parse" sentinel.
 *
 * @param {string} jsonText — candidate JSON text
 * @returns {{ value: unknown } | { error: Error }}
 */
export function tryParseWithRepair(jsonText) {
  if (typeof jsonText !== 'string') return { error: new Error('Non-string input') };
  // `[...]` placeholder cleanup runs before the first parse so a block
  // containing only that token (no other JSON errors) succeeds on the
  // first try instead of falling into the trailing-comma branch.
  const initial = replaceOutsideStrings(jsonText, /\[\s*\.\.\.\s*\]/g, '[]');
  const initialResult = safeParse(initial);
  if (!initialResult.error) return initialResult;

  const noTrailing = replaceOutsideStrings(initial, /,(\s*[}\]])/g, '$1');
  if (noTrailing !== initial) {
    const trailingResult = safeParse(noTrailing);
    if (!trailingResult.error) return trailingResult;
  }

  const fixedOrphan = replaceOutsideStrings(noTrailing, /}\s*}\s*]/g, '}]}');
  const orphanResult = safeParse(fixedOrphan);
  if (!orphanResult.error) return orphanResult;

  // Surface the last attempt's parse error so the caller can include the
  // concrete reason ("Unexpected token } in JSON at position 47") in its
  // error message rather than a generic "no JSON block found".
  return { error: orphanResult.error };
}

// Returns `{ value }` on success or `{ error }` on failure. The discriminated
// shape lets a JSON `null` literal flow through as a valid parsed value
// (some LLMs legitimately return `null`); a single-value-with-sentinel
// API can't distinguish "parsed `null`" from "did not parse."
function safeParse(text) {
  try { return { value: JSON.parse(text) }; } catch (error) { return { error }; }
}

/**
 * Extract the first matching JSON block from CLI-banner-prefixed LLM
 * output. Strips ```json / ``` fences, walks balanced blocks, applies
 * repairs, and returns the first block matching the optional shape
 * predicate (or the first block that parses at all when no predicate
 * is supplied).
 *
 * Returns `{ value: undefined, lastError, lastPreview }` if no block
 * parses — callers decide whether to throw a typed error (ServerError)
 * or attempt a different fallback.
 *
 * @param {string} text — raw LLM output
 * @param {object} [options]
 * @param {(parsed:unknown)=>boolean} [options.shapePredicate] — return true
 *   for blocks whose shape matches the caller's expected response. Used to
 *   skip in-prompt schema examples that parse cleanly but aren't the answer.
 * @param {'object'|'array'} [options.blockType='object'] — top-level shape
 *   to walk for (`{...}` vs `[...]`).
 * @returns {{ value:unknown, lastError?:Error, lastPreview?:string }}
 *   — `value` is the parsed block, or `undefined` when no block matches.
 *   On no-match, `lastError` + `lastPreview` (200-char excerpt of the last
 *   candidate text) are populated for use in caller error messages.
 */
export function extractJson(text, { shapePredicate, blockType = 'object' } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    return { value: undefined, lastError: new Error('Empty LLM response'), lastPreview: '' };
  }

  let s = stripCodeFences(text.trim());
  // stripCodeFences only catches leading/trailing fences. CLI banners
  // sometimes wrap the response in fences mid-stream — fall back to
  // a non-greedy match for the FIRST inner ```…``` block so we still
  // extract the inner JSON. NOTE: callers that may see fenced
  // prompt-echo content BEFORE the real response should skip this
  // helper and walk the full text directly (see stageRunner.extractJson)
  // — the first-fence heuristic locks onto the echoed schema and never
  // reaches the actual model output.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();

  const { startChar, endChar } = blockType === 'array'
    ? { startChar: '[', endChar: ']' }
    : { startChar: '{', endChar: '}' };

  const candidates = findBalancedBlocks(s, { startChar, endChar });
  if (!candidates.length) candidates.push(s);

  // `parsedHolder` carries the first parseable block as `{ value }` even
  // when it doesn't match shapePredicate, so a top-level `null` literal
  // can still flow through as a real parsed value on fallback.
  let parsedHolder;
  let lastError;
  let lastPreview = s.slice(0, 200);
  for (const block of candidates) {
    const result = tryParseWithRepair(block);
    if (result.error) {
      lastError = result.error;
      lastPreview = block.slice(0, 200);
      continue;
    }
    if (!shapePredicate || shapePredicate(result.value)) {
      return { value: result.value };
    }
    if (parsedHolder === undefined) parsedHolder = result;
  }

  if (parsedHolder !== undefined) return parsedHolder;
  return {
    value: undefined,
    lastError: lastError || new Error('No matching JSON block found'),
    lastPreview,
  };
}
