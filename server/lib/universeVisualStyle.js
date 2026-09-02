/**
 * The one definition of the style a universe contributes to an IMAGE prompt.
 *
 * A universe carries two different style surfaces and they are NOT
 * interchangeable:
 *
 * - `influences.embrace` / `influences.avoid` — curated, comma-joined visual
 *   tokens authored in the Universe Builder's chip inputs specifically so a
 *   diffusion/image model can consume them directly.
 * - `styleNotes` — free-text direction written for the WRITING stages: tone,
 *   staging, pacing, what a culture's scenes must establish. It routinely
 *   names canon entities that are nowhere near the current shot ("Stage
 *   <character> as a massive but local physical presence…") and craft notes an
 *   image model cannot act on ("keep translation slow, funny, imperfect").
 *   Injected into a render it burns prompt budget and drags unrelated canon
 *   into the frame, so it never enters an image prompt.
 *
 * The pipeline's visual stages already worked this way; this module makes the
 * rule shared so the FableLoom compiler, character reference/blueprint sheets
 * and LoRA dataset renders can't drift back to the free-text field.
 *
 * `universeCanon.js#buildStyleClause` is the sibling for LLM TEXT prompts —
 * there `styleNotes` is exactly the right context and stays included.
 */

import { escapeRegExp } from './textUtils.js';

const tokenList = (values) => (Array.isArray(values) ? values : [])
  .map((token) => (typeof token === 'string' ? token.trim() : ''))
  .filter(Boolean);

const normalize = (token) => token.toLowerCase().replace(/\s+/g, ' ').trim();

/** Split a comma-joined prompt/negative string back into trimmed tokens. */
export const splitPromptTokens = (text) => (typeof text === 'string' ? text : '')
  .split(',').map((token) => token.trim()).filter(Boolean);

/** Curated visual token lists for a universe (`[]` for a missing universe). */
export function universeVisualStyleTokens(universe) {
  return {
    embrace: tokenList(universe?.influences?.embrace),
    avoid: tokenList(universe?.influences?.avoid),
  };
}

/**
 * Positive style clause for an image prompt.
 *
 * `override` / `mode` mirror `series.stylePromptOverride` +
 * `stylePromptOverrideMode` ('prepend' | 'append' | 'override') so a series can
 * lead, trail, or replace the universe's tokens — the same composition the
 * client's `universeStylePreset` applies.
 */
export function buildVisualStyleClause(universe, { override = '', mode = 'prepend' } = {}) {
  const trimmedOverride = typeof override === 'string' ? override.trim() : '';
  const embrace = trimmedOverride && mode === 'override'
    ? ''
    : universeVisualStyleTokens(universe).embrace.join(', ');
  const parts = mode === 'append' ? [embrace, trimmedOverride] : [trimmedOverride, embrace];
  return parts.filter(Boolean).join('. ');
}

/**
 * Remove a style clause the authored prompt already leads with.
 *
 * The browser composes the same universe preset onto a scene prompt before
 * POSTing it (`composeStyledPrompt`), and the compiler prepends the canonical
 * clause too — so without this the whole token list lands twice in every
 * render. Strip the browser's copy rather than the compiler's: diffusion models
 * weight earlier tokens heaviest, and only the compiler's copy sits in front of
 * the canon context where that conditioning is worth anything.
 *
 * Matching is on the JOINED clause, not token by token, which is what keeps a
 * token carrying its own punctuation (`M.C. Escher`) intact — a per-token
 * split on '.' would never match it and would emit it a second time.
 */
export function stripStyleClause(text, clause) {
  const source = typeof text === 'string' ? text : '';
  const trimmed = typeof clause === 'string' ? clause.trim() : '';
  if (!trimmed || !source) return source;
  // Whitespace in the composed prompt need not match the stored token spacing,
  // and the clause is followed by the separator composeStyledPrompt inserted.
  const pattern = new RegExp(`^\\s*${escapeRegExp(trimmed).replace(/\s+/g, '\\s+')}\\s*[.,;]?\\s*`, 'i');
  return source.replace(pattern, '').trim();
}

/**
 * Union several comma-joined negative-prompt sources, deduped at TOKEN level.
 *
 * A plain `unique()` over the sources compares whole strings, so an authored
 * negative that is itself a joined token list never matches the individual
 * universe tokens and the whole list repeats.
 */
export function mergeNegativePromptTokens(sources) {
  const seen = new Set();
  const merged = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const tokens = Array.isArray(source) ? tokenList(source) : splitPromptTokens(source);
    for (const token of tokens) {
      const key = normalize(token);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(token);
    }
  }
  return merged;
}

/**
 * The labeled aesthetic line the canon render prompts (character reference and
 * blueprint sheets, LoRA dataset images) have always led with. `''` when the
 * universe has no curated tokens, so callers keep their own fallback line.
 */
export function universeAestheticLine(universe, options) {
  const clause = buildVisualStyleClause(universe, options);
  return clause ? `Universe aesthetic: ${clause}` : '';
}
