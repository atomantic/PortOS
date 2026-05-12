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
    // Unbalanced: bail rather than scanning past — a later block can't fix
    // the depth imbalance and the next outer caller can handle the partial
    // result.
    if (end === -1) break;
    blocks.push(s.slice(start, end + 1));
    i = end + 1;
  }
  return blocks;
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
 * Returns the parsed value on success, or `null` if all repairs fail.
 *
 * @param {string} jsonText — candidate JSON text
 * @returns {unknown|null} — parsed value or null
 */
export function tryParseWithRepair(jsonText) {
  if (typeof jsonText !== 'string') return null;
  // `[...]` placeholder cleanup runs before the first parse so a block
  // containing only that token (no other JSON errors) succeeds on the
  // first try instead of falling into the trailing-comma branch.
  const initial = jsonText.replace(/\[\s*\.\.\.\s*\]/g, '[]');
  const initialParse = safeParse(initial);
  if (initialParse !== undefined) return initialParse;

  const noTrailing = initial.replace(/,(\s*[}\]])/g, '$1');
  if (noTrailing !== initial) {
    const trailingParse = safeParse(noTrailing);
    if (trailingParse !== undefined) return trailingParse;
  }

  const fixedOrphan = noTrailing.replace(/}\s*}\s*]/g, '}]}');
  const orphanParse = safeParse(fixedOrphan);
  if (orphanParse !== undefined) return orphanParse;

  return null;
}

// `undefined` is the "did not parse" sentinel — using a sentinel rather
// than try/catch in callers lets `null` flow through as a valid parsed
// value (some LLMs legitimately return JSON `null`).
function safeParse(text) {
  try { return JSON.parse(text); } catch { return undefined; }
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
  // sometimes wrap the response in fences mid-stream — fall back to a
  // greedy fence match so we still extract the inner JSON.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();

  const { startChar, endChar } = blockType === 'array'
    ? { startChar: '[', endChar: ']' }
    : { startChar: '{', endChar: '}' };

  const candidates = findBalancedBlocks(s, { startChar, endChar });
  if (!candidates.length) candidates.push(s);

  let firstParsed;
  let lastPreview = s.slice(0, 200);
  for (const block of candidates) {
    const parsed = tryParseWithRepair(block);
    if (parsed !== null && parsed !== undefined) {
      if (!shapePredicate || shapePredicate(parsed)) {
        return { value: parsed };
      }
      if (firstParsed === undefined) firstParsed = parsed;
    } else {
      lastPreview = block.slice(0, 200);
    }
  }

  if (firstParsed !== undefined) return { value: firstParsed };
  return {
    value: undefined,
    lastError: new Error('No matching JSON block found'),
    lastPreview,
  };
}
