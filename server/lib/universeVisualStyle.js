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

const tokenList = (values) => (Array.isArray(values) ? values : [])
  .map((token) => (typeof token === 'string' ? token.trim() : ''))
  .filter(Boolean);

// Trailing trim is load-bearing: the dedupe below splits a composed prompt on
// its separators, so every part after the first arrives with a leading space.
const normalize = (token) => token.toLowerCase().replace(/\s+/g, ' ').trim();

/** Split a comma-joined prompt/negative string back into trimmed tokens. */
export const splitPromptTokens = (text) => (typeof text === 'string' ? text : '')
  .split(',').map((token) => token.trim()).filter(Boolean);

// Every separator a composed prompt can put between two style tokens: the
// comma inside a joined token list, and the '. ' / newline that
// `composeStyledPrompt` and the compiler use to butt the style clause against
// the scene sentence. Splitting on all of them is what lets the dedupe below
// compare whole tokens instead of substrings.
const PROMPT_TOKEN_SEPARATORS = /[,.;\n]+/;

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
 * Drop style tokens the authored prompt already carries.
 *
 * The browser composes the same universe preset onto a scene prompt before
 * POSTing it, and the server-side compiler then prepends the canonical style
 * clause. Without a token-level pass the entire embrace list lands twice in
 * every render prompt (and the avoid list twice in every negative), which is
 * pure budget with no effect on the image.
 */
export function dropTokensPresentIn(tokens, authoredText) {
  const text = typeof authoredText === 'string' ? authoredText : '';
  if (!text.trim()) return tokenList(tokens);
  // Compare WHOLE tokens, never substrings: a plain `includes` would drop
  // `flat colors` because the scene sentence happens to say "flat colors of
  // dusk", silently stripping a style token the render still needed.
  const present = new Set(text.split(PROMPT_TOKEN_SEPARATORS)
    .map((part) => normalize(part)).filter(Boolean));
  return tokenList(tokens).filter((token) => !present.has(normalize(token)));
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
