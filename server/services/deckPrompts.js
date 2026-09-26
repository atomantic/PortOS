/**
 * Deck prompt authoring — two LLM passes over a deck's card roster.
 *
 * 1. `castDeckFromUniverse` (only for a universe-linked deck): place the
 *    universe's cast, places and objects onto the cards that suit them (a
 *    protagonist on The Fool or the King of Hearts, the haunted lighthouse on
 *    The Tower…). One call for the whole deck so the assignment is coherent —
 *    the output is compact (card key → canon id).
 * 2. `generateDeckCardPrompts`: write the SUBJECT prompt for each requested
 *    card, chunked so a 79-card tarot deck never asks for 79 prompts in one
 *    response. Each chunk sees the full roster (with any canon assignment) so
 *    it can keep the set consistent, but writes prompts only for its subset.
 *
 * Prompts describe the subject only: the deck's embrace influences + layout
 * clause are prepended at render time by `composeCardRenderPrompt`, mirroring
 * the universe-variation contract.
 */

import { extractJson } from '../lib/jsonExtract.js';
import { ServerError } from '../lib/errorHandler.js';
import { stripPromptControlChars, buildUniverseStyleContext } from './universeBuilder/compile.js';
import { truncDesc } from '../lib/universePromptRenderers.js';
import {
  DECK_KIND, DECK_KIND_LABELS, deckCardIdentityPrompt, deckCardOrientation, deckCardOrientationPrompt,
} from '../lib/deckTemplates.js';
import { DECK_CARD_PROMPT_MAX } from '../lib/deckValidation.js';

// Keep each response bounded while amortizing the full-roster context over
// fewer sequential calls; a 79-card tarot deck is five calls.
export const PROMPTS_PER_CALL = 16;
const CANON_KINDS = Object.freeze([
  { field: 'characters', kind: 'character', header: 'CHARACTERS' },
  { field: 'places', kind: 'place', header: 'PLACES' },
  { field: 'objects', kind: 'object', header: 'OBJECTS' },
]);

// The prompt runner is the heaviest subtree a deck touches; load it per call.
const promptRunner = () => import('./promptRunner.js');

const safe = (v) => stripPromptControlChars(typeof v === 'string' ? v : '');

const noProvider = () => ({
  message: 'No AI provider is configured for prompt generation. Add one under Settings → Providers.',
  code: 'NO_PROVIDER',
  status: 503,
});

const invalidJson = (what, { lastError, lastPreview }) => new ServerError(
  `The model returned invalid JSON for ${what}. Try a different model or rerun.`,
  { status: 502, code: 'LLM_INVALID_JSON', context: { details: { reason: lastError?.message || 'no matching JSON object', preview: lastPreview || '' } } },
);

/** Compact `[id] name — descriptor` roster of a universe's canon, per kind. */
export function renderCanonRoster(universe) {
  const sections = [];
  for (const { field, header } of CANON_KINDS) {
    const entries = Array.isArray(universe?.[field]) ? universe[field] : [];
    if (!entries.length) continue;
    const lines = entries.map((e) => {
      const desc = e.physicalDescription || e.description || e.significance || e.slugline || '';
      const role = e.role ? ` [${safe(e.role)}]` : '';
      return `  - [${e.id}] ${safe(e.name || e.slugline || '(unnamed)')}${role}${desc ? `: ${truncDesc(safe(desc))}` : ''}`;
    });
    sections.push(`${header}:\n${lines.join('\n')}`);
  }
  return sections.join('\n');
}

const canonIndex = (universe) => {
  const map = new Map();
  for (const { field, kind } of CANON_KINDS) {
    for (const e of (Array.isArray(universe?.[field]) ? universe[field] : [])) {
      if (e?.id) map.set(String(e.id), { kind, id: String(e.id), name: safe(e.name || e.slugline || '') });
    }
  }
  return map;
};

const rosterLine = (card) => {
  const canon = card.canonRef?.name ? ` → ${safe(card.canonRef.name)} (${card.canonRef.kind})` : '';
  const motif = card.motif ? ` — traditional motif: ${safe(card.motif)}` : '';
  return `  - ${card.key}: ${safe(card.name)}${canon}${motif}`;
};

const deckContext = (deck) => {
  const embrace = Array.isArray(deck.influences?.embrace) ? deck.influences.embrace : [];
  const orientation = deckCardOrientation(deck);
  const lines = [
    `DECK: "${safe(deck.name)}" (${DECK_KIND_LABELS[deck.kind] || deck.kind})`,
    deck.description ? `CONCEPT: ${safe(deck.description)}` : '',
    deck.styleNotes ? `ART DIRECTION: ${safe(deck.styleNotes)}` : '',
    embrace.length ? `STYLE TOKENS (prepended automatically at render time): ${safe(embrace.join(', '))}` : '',
    deck.layoutPrompt ? `SHARED LAYOUT (also prepended automatically): ${safe(deck.layoutPrompt)}` : '',
    orientation ? `FACE ORIENTATION (also prepended automatically): ${safe(deckCardOrientationPrompt(deck))}` : '',
  ].filter(Boolean);
  return `# Deck\n${lines.join('\n')}\n`;
};

export function buildCastPrompt({ deck, cards, universe }) {
  const universeBlock = buildUniverseStyleContext(universe, {
    includePremise: true, includeEmbrace: false, escape: true, headerSuffix: 'the deck illustrates this universe',
  });
  const kindRules = deck.kind === DECK_KIND.TAROT
    ? '- Major arcana take the universe\'s most significant figures, places and turning points; court cards (Page/Knight/Queen/King) take secondary characters; numbered pips may take objects or places, or stay unassigned.'
    : '- Court cards (Jack/Queen/King) and Aces take characters; Jokers take tricksters or outsiders; numbered pips may take objects or places, or stay unassigned.';
  return `You are casting a ${DECK_KIND_LABELS[deck.kind] || deck.kind} deck from a fictional universe's canon. Decide which canon entry, if any, each card should depict.
${deckContext(deck)}${universeBlock}
# Canon (assign by the bracketed id)
${renderCanonRoster(universe) || '(no canon entries)'}

# Cards
${cards.map(rosterLine).join('\n')}

# Output contract
Return a SINGLE JSON object: { "assignments": [ { "key": "<card key>", "id": "<canon id or null>", "why": "<one short clause>" } ] } — one entry per card listed above.

# Rules
${kindRules}
- Match a card's traditional meaning or rank to the entry's role in the story; never assign the same character to two cards unless the deck has more court slots than characters.
- The card back ("back") is never assigned.
- "id" must be one of the bracketed ids above, or null. Output JUST the JSON object — no markdown, no commentary.`;
}

export function buildCardPromptsPrompt({ deck, roster, targets, universe }) {
  const universeBlock = universe
    ? `${buildUniverseStyleContext(universe, { includePremise: true, includeEmbrace: false, escape: true, headerSuffix: 'the deck illustrates this universe' })}\n# Canon this deck draws on\n${renderCanonRoster(universe) || '(none)'}\n`
    : '';
  const kindRules = deck.kind === DECK_KIND.TAROT
    ? '- Keep each card recognizable as its tarot archetype (use the traditional motif as the skeleton) while dressing it in the deck\'s world; numbered pips show that many of the suit\'s emblem arranged meaningfully.\n- Cards of one suit should share a visual through-line (a recurring emblem, setting or color accent) so the suit reads as a family.'
    : '- Playing-card identity is exact: for each numbered rank 2–10, state exactly that many pips of the named suit in the classic arrangement given on its target line, with the suit shape and color; never add, omit or substitute pips. Pips are flat printed suit symbols on the card face — never disguise them as scene objects (lanterns, pennants, windows, leaves), and never put any other suit-shaped object in the scene, border or background, because every extra suit shape reads as an extra pip. The world or canon scene is a restrained vignette behind or between the pips. Aces show one large suit pip, face cards show the named rank as a full figure, and Jokers are jesters of this world.\n- Cards of one suit share a visual through-line (a recurring setting, color accent or non-suit-shaped emblem) so the suit reads as a family.';
  const targetLines = targets.map((c) => {
    const canon = c.canonRef?.name ? ` → depict ${safe(c.canonRef.name)} (${c.canonRef.kind})` : '';
    const identity = deckCardIdentityPrompt(deck, c);
    const fixedIdentity = identity ? ` — REQUIRED VISUAL IDENTITY: ${safe(identity)}` : '';
    return `  - ${c.key}: ${safe(c.name)}${canon}${fixedIdentity}`;
  });
  return `You are a prompt engineer writing image-generation prompts for the cards of a ${DECK_KIND_LABELS[deck.kind] || deck.kind} deck.
${deckContext(deck)}${universeBlock}
# Full roster (for consistency — "→" marks a canon entry already cast on that card)
${roster.map(rosterLine).join('\n')}

# Write prompts for THESE cards only
${targetLines.join('\n')}

# Output contract
Return a SINGLE JSON object: { "prompts": [ { "key": "<card key>", "prompt": "<string, max 600 chars>" } ] } — exactly one entry per card in the list above.

# Rules
- "prompt" describes the SUBJECT of the card only — figures, pose, setting, symbols, composition, the suit emblem count — as comma-separated renderable phrases. The deck's style tokens, shared layout and face-orientation instructions are prepended automatically at render time, so do NOT repeat style, medium, palette, border, index/title or orientation instructions.
${kindRules}
- For playing cards, the REQUIRED VISUAL IDENTITY on each target line is authoritative; open the subject prompt with its exact pip count, arrangement and suit description even when the canon scene or visual motif suggests another arrangement.
- When a card is cast with a canon entry, depict that entry faithfully to its description; otherwise invent a subject that belongs in this deck's world.
- No text instructions, no camera jargon. Never use double-quote characters inside a prompt string.
- Output JUST the JSON object — no markdown, no commentary.`;
}

const STRICT_JSON_REMINDER = '\n\n# Your previous reply was not valid JSON. Reply with ONLY the JSON object, with every string in double quotes and no double-quote characters inside any string.';

/**
 * The runner's Tier-2 hooks (`responseSchema` + `repair`, issue #2350): on a
 * response that misses the shape, first the deterministic extraction, then the
 * caller's own salvage; on a request re-issue, the strict-JSON reminder. The
 * runner owns the single re-request and the Tier-3 provider fallback.
 */
const jsonRepair = ({ shapePredicate, salvage }) => ({ phase, text, prompt }) => {
  if (phase === 'request') return { prompt: `${prompt}${STRICT_JSON_REMINDER}` };
  const { value } = extractJson(text || '', { shapePredicate });
  const recovered = value !== undefined ? value : salvage?.(text || '');
  return recovered ? { text: JSON.stringify(recovered) } : null;
};

/**
 * Salvage `{ key, prompt }` pairs from a reply whose JSON is structurally
 * broken — the observed failure is a model dropping the "prompt" key
 * (`"key":"wands-ace":"a single…"`) or leaving a raw double quote inside a
 * prompt. A card prompt is prose, so pairing each key with the string that
 * follows it recovers every card the model actually wrote. Returns null when
 * nothing pairs, so the caller falls through to the retry.
 */
export function salvagePromptPairs(text) {
  if (typeof text !== 'string') return null;
  const pairs = [];
  const re = /"key"\s*:\s*"([^"\n]+)"\s*[,:]\s*(?:"prompt"\s*:\s*)?"((?:[^"\\]|\\.)*)"/g;
  for (const m of text.matchAll(re)) pairs.push({ key: m[1], prompt: m[2].replace(/\\"/g, '"') });
  return pairs.length ? { prompts: pairs } : null;
}

const runJson = async ({ provider, selectedModel, effort, prompt, source, shapePredicate, what, salvage = null, onActivity = null }) => {
  const { runPromptThroughProvider } = await promptRunner();
  let result;
  let activityReported = false;
  try {
    result = await runPromptThroughProvider({
      provider, model: selectedModel, effort: effort || undefined, prompt, source,
      responseSchema: shapePredicate,
      repair: jsonRepair({ shapePredicate, salvage }),
      // Progress is observational. Never send provider output text over the
      // deck progress stream; the caller only learns that output has started.
      ...(onActivity ? { onData: () => {
        if (activityReported) return;
        activityReported = true;
        onActivity?.();
      } } : {}),
    });
  } catch (err) {
    if (err?.schemaFailure) throw invalidJson(what, { lastError: err, lastPreview: '' });
    throw err;
  }
  const extracted = extractJson(result.text || '', { shapePredicate });
  if (extracted.value === undefined) throw invalidJson(what, extracted);
  return { value: extracted.value, llm: { provider: result.provider?.id || provider.id, model: result.model || null } };
};

/**
 * @returns {Promise<{ assignments: [{ cardId, canonRef }], llm }>}
 */
export async function castDeckFromUniverse({ deck, cards, universe, providerId, model, effort } = {}) {
  const { resolveProviderAndModel, assertProvider } = await promptRunner();
  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  assertProvider(provider, noProvider());
  const eligible = cards.filter((c) => c.key !== 'back');
  const { value, llm } = await runJson({
    provider, selectedModel, effort,
    prompt: buildCastPrompt({ deck, cards: eligible, universe }),
    source: 'deck-cast',
    shapePredicate: (o) => o && Array.isArray(o.assignments),
    what: 'deck casting',
  });
  const index = canonIndex(universe);
  const byKey = new Map(eligible.map((c) => [c.key, c]));
  const assignments = [];
  for (const entry of value.assignments) {
    const card = byKey.get(String(entry?.key || ''));
    if (!card) continue;
    const ref = entry?.id == null ? null : index.get(String(entry.id)) || null;
    assignments.push({ cardId: card.id, canonRef: ref });
  }
  console.log(`🃏 deck cast "${deck.name}": ${assignments.filter((a) => a.canonRef).length}/${eligible.length} cards assigned`);
  return { assignments, llm };
}

/**
 * @returns {Promise<{ prompts: [{ cardId, prompt }], llm }>}
 */
export async function generateDeckCardPrompts({
  deck, roster, targets, universe = null, providerId, model, effort,
  onBatchStart = null, onActivity = null, onChunk = null,
} = {}) {
  const { resolveProviderAndModel, assertProvider } = await promptRunner();
  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  assertProvider(provider, noProvider());
  const prompts = [];
  let llm = null;
  const chunks = Math.ceil(targets.length / PROMPTS_PER_CALL);
  for (let i = 0; i < targets.length; i += PROMPTS_PER_CALL) {
    const chunk = targets.slice(i, i + PROMPTS_PER_CALL);
    const chunkNumber = Math.floor(i / PROMPTS_PER_CALL) + 1;
    await onBatchStart?.({
      chunk: chunkNumber,
      chunks,
      requested: targets.length,
    });
    const { value, llm: ran } = await runJson({
      provider, selectedModel, effort,
      prompt: buildCardPromptsPrompt({ deck, roster, targets: chunk, universe }),
      source: 'deck-card-prompts',
      shapePredicate: (o) => o && Array.isArray(o.prompts),
      what: 'card prompts',
      salvage: salvagePromptPairs,
      onActivity: () => onActivity?.({ chunk: chunkNumber, chunks, requested: targets.length }),
    });
    llm = ran;
    const byKey = new Map(chunk.map((c) => [c.key, c]));
    const written = [];
    for (const entry of value.prompts) {
      const card = byKey.get(String(entry?.key || ''));
      const prompt = typeof entry?.prompt === 'string' ? entry.prompt.trim().slice(0, DECK_CARD_PROMPT_MAX) : '';
      if (card && prompt) written.push({ cardId: card.id, prompt });
    }
    prompts.push(...written);
    // Let the caller persist and report each completed provider call, including
    // a valid response that contained no usable prompts.
    await onChunk?.(written, {
      chunk: chunkNumber,
      chunks,
      requested: targets.length,
    });
  }
  console.log(`🃏 deck prompts "${deck.name}": ${prompts.length}/${targets.length} cards written`);
  return { prompts, llm };
}

export const __testing = { jsonRepair };
