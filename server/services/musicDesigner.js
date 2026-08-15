/**
 * Music designer — the two LLM steps behind the Music studio's stepped
 * Generate tab (#4305).
 *
 *   describeMusic()  short reference/vibe  → a rich, genre-dense musical
 *                    description suitable as an ACE-Step conditioning prompt.
 *   writeLyrics()    that description (+ the user's extra guidance) → original
 *                    lyrics in the `[verse]` / `[chorus]` section syntax the
 *                    lyric-aware engines expect.
 *
 * Both are plain-text generators — no JSON contract — and both return an `llm`
 * attribution block alongside the text, matching `roundsAI.js`'s shape.
 *
 * Meta-prompts ship as module constants and are overridable per call via
 * `template`. The override is stored in **settings** (`settings.music.designer`)
 * rather than `data/prompts/`, which deliberately keeps these off the
 * prompt-template migration path — a blank/whitespace override falls back to
 * the shipped constant here, server-side, so a cleared field can never send an
 * instruction-less prompt to a provider.
 *
 * Nothing here runs on its own: every call is driven by an explicit button
 * press in the same request (AI Provider Usage Policy — no cold bootstrap).
 */

import { ServerError } from '../lib/errorHandler.js';
import { assertProvider, resolveProviderAndModel, runPromptThroughProvider } from '../lib/promptRunner.js';

// Caps mirror the Generate form's own field limits so a designer round-trip
// can't produce text the generate route would then reject.
const MAX_CONCEPT = 8000;
const MAX_GUIDANCE = 4000;
const MAX_TEMPLATE = 8000;
const MAX_DESCRIPTION = 8000;
const MAX_LYRICS = 20000;

export const DEFAULT_DESCRIBE_TEMPLATE = 'Describe the given musical reference and description in richer detail in English, focusing primarily on the sound, instruments, feel, and the overall atmosphere. Also briefly describe the composition, instrumentation, beats, lyrical or instrumental style (maybe it doesn\'t have lyrics), and aesthetic. Keep it concise and genre-focused rather than overly technical.';

export const DEFAULT_LYRICS_TEMPLATE = 'Write original song lyrics that fit the musical description below. Use the section syntax the audio engine expects: a bracketed section tag alone on its line ([verse], [chorus], [bridge], [outro]) with that section\'s lines beneath it. Match the mood, genre, energy, and vocal style implied by the description, and keep the phrasing singable. Keep the lyrics original (do not reproduce copyrighted lyrics verbatim).';

const clean = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// A blank/whitespace override means "use the shipped default" — the UI clears
// the field to reset, and an empty instruction block would otherwise leave the
// provider with nothing but the raw concept text.
const pickTemplate = (template, fallback) => clean(template, MAX_TEMPLATE) || fallback;

// The output instruction lives OUTSIDE the overridable template on purpose: a
// user editing the meta-prompt is tuning the creative brief, not the wire
// format, and a fenced/preambled response would land verbatim in the textarea.
const section = (label, body) => (body ? `\n\n${label}:\n${body}` : '');

export function buildDescribePrompt({ concept, guidance, template } = {}) {
  return [
    pickTemplate(template, DEFAULT_DESCRIBE_TEMPLATE),
    section('MUSICAL REFERENCE / VIBE', clean(concept, MAX_CONCEPT) || '(none given)'),
    section('ADDITIONAL GUIDANCE FROM THE USER', clean(guidance, MAX_GUIDANCE)),
    '\n\nReturn ONLY the description as plain prose. No preamble, no headings, no bullet list, no markdown fence.',
  ].join('');
}

export function buildLyricsPrompt({ description, guidance, template } = {}) {
  return [
    pickTemplate(template, DEFAULT_LYRICS_TEMPLATE),
    section('MUSICAL DESCRIPTION', clean(description, MAX_DESCRIPTION) || '(none given)'),
    section('ADDITIONAL GUIDANCE FROM THE USER', clean(guidance, MAX_GUIDANCE)),
    '\n\nReturn ONLY the lyrics with their section tags. No preamble, no commentary, no markdown fence.',
  ].join('');
}

// Providers habitually wrap prose in a ``` fence despite the instruction above.
// Unwrap a response that is ENTIRELY one fence; leave anything else untouched
// so a lyric line that merely contains backticks survives.
function unfence(text) {
  const match = /^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/.exec(text || '');
  return match ? match[1] : (text || '');
}

/**
 * Expand a short reference/vibe into a rich musical description.
 *
 * @param {object} args
 * @param {string} args.concept — the user's short "what do you want?" text
 * @param {string} [args.guidance] — extra free-text direction
 * @param {string} [args.template] — meta-prompt override; blank → the default
 * @param {string} [args.providerId] — blank → the install's active provider
 * @param {string} [args.model]
 * @param {string} [args.effort] — reasoning effort; dropped by providers without one
 * @returns {Promise<{ description: string, llm: { provider: string, model: string|null } }>}
 */
export async function describeMusic({ concept, guidance, template, providerId, model, effort } = {}) {
  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  assertProvider(provider, { message: 'No AI provider available to describe the music', code: 'NO_PROVIDER' });

  const prompt = buildDescribePrompt({ concept, guidance, template });
  const { text, model: ranModel } = await runPromptThroughProvider({
    provider, model: selectedModel, effort, prompt, source: 'music-describe',
  });

  const description = clean(unfence(text), MAX_DESCRIPTION);
  if (!description) {
    throw new ServerError('The AI returned an empty description. Try rerunning or picking a stronger model.', { status: 502, code: 'LLM_EMPTY' });
  }
  console.log(`🎼 Described music via ${provider.id}/${ranModel || 'default'} (${description.length} chars)`);
  return { description, llm: { provider: provider.id, model: ranModel || null } };
}

/**
 * Write original lyrics grounded in an (already enriched) musical description.
 *
 * @param {object} args
 * @param {string} args.description — the enriched musical description
 * @param {string} [args.guidance] — "make the chorus about X", etc.
 * @param {string} [args.template] — meta-prompt override; blank → the default
 * @param {string} [args.providerId]
 * @param {string} [args.model]
 * @param {string} [args.effort]
 * @returns {Promise<{ lyrics: string, llm: { provider: string, model: string|null } }>}
 */
export async function writeLyrics({ description, guidance, template, providerId, model, effort } = {}) {
  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  assertProvider(provider, { message: 'No AI provider available to write lyrics', code: 'NO_PROVIDER' });

  const prompt = buildLyricsPrompt({ description, guidance, template });
  const { text, model: ranModel } = await runPromptThroughProvider({
    provider, model: selectedModel, effort, prompt, source: 'music-lyrics',
  });

  const lyrics = clean(unfence(text), MAX_LYRICS);
  if (!lyrics) {
    throw new ServerError('The AI returned empty lyrics. Try rerunning or picking a stronger model.', { status: 502, code: 'LLM_EMPTY' });
  }
  console.log(`🎤 Wrote lyrics via ${provider.id}/${ranModel || 'default'} (${lyrics.length} chars)`);
  return { lyrics, llm: { provider: provider.id, model: ranModel || null } };
}
