/**
 * Music designer — the two LLM steps behind the Music studio's stepped
 * Generate tab (#4305).
 *
 *   describeMusic()  short reference/vibe  → a detailed structured caption
 *                    suitable for MiniMax Music 3 and the other generators.
 *   writeLyrics()    that description (+ the user's extra guidance) → original
 *                    lyrics in the `[verse]` / `[chorus]` section syntax the
 *                    lyric-aware engines expect.
 *   reviewLyrics()   a lyric draft → the revised sheet plus a short critique,
 *                    so a second (often stronger) model can tighten a draft a
 *                    cheaper one wrote (the autonomous run's lyric review).
 *
 * All are plain-text generators — no JSON contract — and all return an `llm`
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
import { assertProvider, resolveProviderAndModel, runPromptThroughProvider } from './promptRunner.js';
import { trimTo } from '../lib/textUtils.js';

// Caps mirror the Generate form's own field limits so a designer round-trip
// can't produce text the generate route would then reject.
const MAX_CONCEPT = 8000;
const MAX_GUIDANCE = 4000;
const MAX_TEMPLATE = 8000;
const MAX_DESCRIPTION = 8000;
const MAX_LYRICS = 20000;

// Caption shape follows MiniMax Music 3's official music-caption-rewriter
// contract. Keep it model-neutral enough to remain useful for ACE-Step and the
// other text-conditioned engines in the same picker.
export const DEFAULT_DESCRIBE_TEMPLATE = [
  'Rewrite the musical reference into a detailed, generation-oriented structured caption in English.',
  'Preserve every explicit requirement and exclusion while developing genre and subgenres, emotional arc, imagery, sonics, production character, core instruments, and spatial feel.',
  'Describe approximate tempo, meter or time signature, rhythmic subdivision, and groove when they matter. Use an exact BPM, key, scale, or time signature only when the user supplied it or clearly wants that precision; otherwise use a range or qualitative musical language.',
  'State the vocal plan explicitly. For instrumental music, say that it is instrumental, rule out vocals, and name the instrument or texture carrying the lead melodic role. For vocal music, describe lead configuration, timbre, register, delivery, harmonies, and restrained vocal effects.',
  'Treat the arrangement as a continuous section-by-section timeline: explain what enters, exits, changes, strips back, or intensifies, and keep transitions and instrument lifecycles musically plausible.',
  'Keep lyric words and lyrical subject matter out of the caption; the separate lyrics input owns them. Prefer concrete musical changes over decorative prose.',
].join(' ');

export const DEFAULT_LYRICS_TEMPLATE = [
  'Write original, singable song lyrics that fit the musical description below.',
  'Use only useful bracketed section tags such as [intro], [verse], [pre-chorus], [chorus], [post-chorus], [bridge], [instrumental], [solo], and [outro]. Every tag must sit alone on its own line, with any singable words beginning on the following line.',
  'Build a complete emotional and structural arc with enough sections for the intended song length; short lyrics can cause the music engine to end early.',
  'Keep tempo, meter, key, arrangement, and production instructions in the musical description rather than mixing them into lyric lines.',
  'Keep the lyrics original and do not reproduce copyrighted lyrics verbatim.',
].join(' ');

const DESCRIBE_OUTPUT_CONTRACT = [
  'Return ONLY the structured caption as plain text, normally 250–450 English words.',
  'Use exactly these three top-level headings in this order, each alone on its own line and without markdown markers:',
  'Global Metadata',
  'Cover basic attributes (genre, tempo, meter/groove, and only deliberate key/scale details), the global emotional progression, application imagery, and the sonic/production profile.',
  'Vocal Details',
  'Describe the vocal configuration and performance, or explicitly declare the piece instrumental and identify its lead melodic instrument or texture.',
  'Arrangement',
  'Describe primary and secondary instrument lifecycles, groove development, and a section-by-section energy timeline with concrete entrances, exits, transitions, textures, and spatial effects.',
  'No preamble, bullet list, song title, quoted lyrics, reasoning trace, or markdown fence.',
].join('\n');

// A blank/whitespace override means "use the shipped default" — the UI clears
// the field to reset, and an empty instruction block would otherwise leave the
// provider with nothing but the raw concept text.
const pickTemplate = (template, fallback) => trimTo(template, MAX_TEMPLATE) || fallback;

// The output instruction lives OUTSIDE the overridable template on purpose: a
// user editing the meta-prompt is tuning the creative brief, not the wire
// format, and a fenced/preambled response would land verbatim in the textarea.
const section = (label, body) => (body ? `\n\n${label}:\n${body}` : '');

export function buildDescribePrompt({ concept, guidance, template } = {}) {
  return [
    pickTemplate(template, DEFAULT_DESCRIBE_TEMPLATE),
    section('MUSICAL REFERENCE / VIBE', trimTo(concept, MAX_CONCEPT) || '(none given)'),
    section('ADDITIONAL GUIDANCE FROM THE USER', trimTo(guidance, MAX_GUIDANCE)),
    `\n\n${DESCRIBE_OUTPUT_CONTRACT}`,
  ].join('');
}

// Songs render at roughly 6 sung seconds per lyric line, so the line budget is
// what actually steers the finished length. Lives outside the overridable
// template (like the output contract) so a customised template still gets it.
export const DEFAULT_TARGET_SECONDS = 180;
const lengthContract = (targetSeconds) => {
  const sec = Math.min(600, Math.max(30, Math.round(Number(targetSeconds) || DEFAULT_TARGET_SECONDS)));
  const lines = Math.round(sec / 6);
  const minutes = sec % 60 === 0 ? `${sec / 60}` : (sec / 60).toFixed(1);
  return `\n\nTARGET LENGTH: the finished song should run about ${minutes} minute${minutes === '1' ? '' : 's'} (${sec} seconds). Write roughly ${lines} sung lyric lines in total (section tags excluded) and never more than ${Math.round(lines * 1.2)}; keep sections concise rather than adding verses. This overrides any instruction above to add more sections.`;
};

// The listener-facing request a song was commissioned from (an autonomous run's
// prompt). The musical description covers only sound, so without this the hook
// phrase, subject and imagery the user asked for never reach the lyricist.
const SONG_REQUEST_LABEL = 'SONG REQUEST (what the lyrics must deliver: honour every hook phrase, subject and image it names; ignore its purely musical or production details such as genre, tempo, instruments or artist names, which the musical description owns and which never belong in a lyric line)';

export function buildLyricsPrompt({ description, guidance, request, template, targetSeconds } = {}) {
  return [
    pickTemplate(template, DEFAULT_LYRICS_TEMPLATE),
    section(SONG_REQUEST_LABEL, trimTo(request, MAX_GUIDANCE)),
    section('MUSICAL DESCRIPTION', trimTo(description, MAX_DESCRIPTION) || '(none given)'),
    section('ADDITIONAL GUIDANCE FROM THE USER', trimTo(guidance, MAX_GUIDANCE)),
    lengthContract(targetSeconds),
    '\n\nReturn ONLY the lyrics with their section tags. No preamble, no commentary, no markdown fence.',
  ].join('');
}

// The review pass is not user-overridable (no `template`): it edits a draft in
// place, so its constraints are the contract rather than a creative brief.
export const LYRICS_REVIEW_SEPARATOR = '---';
const LYRICS_REVIEW_INSTRUCTIONS = [
  'You are a lyric editor. Review the draft song lyrics below against the musical description, then revise them.',
  'Keep the title and the song\'s subject. Keep every bracketed section tag and the section order; each tag stays alone on its own line.',
  'Keep the length roughly equal to the draft: about the same number of sung lines per section.',
  'Improve scansion and singability, sharpen weak or generic lines, give the chorus more punch, and make the argument of the song land more clearly.',
  'Never add new topics, characters or story beats the draft does not already contain. Keep the lyrics original.',
].join(' ');
// Only with a request, so a review without one (Music Studio) keeps its original prompt.
const LYRICS_REVIEW_REQUEST_CHECK = ' Exception: check the draft against the SONG REQUEST first. Any hook phrase, title phrase or required image it names that the draft lacks must appear in the revision (a named hook belongs in the chorus), and your notes must say what was missing.';
const LYRICS_REVIEW_OUTPUT_CONTRACT = [
  'Return the complete revised lyric sheet first, with its section tags.',
  `Then a line containing only ${LYRICS_REVIEW_SEPARATOR}`,
  'Then two to four short sentences of notes: what was weak in the draft and what you changed.',
  'No preamble, no other commentary, no markdown fence.',
].join('\n');

function buildLyricsReviewPrompt({ lyrics, description, guidance, request } = {}) {
  return [
    LYRICS_REVIEW_INSTRUCTIONS,
    trimTo(request, MAX_GUIDANCE) ? LYRICS_REVIEW_REQUEST_CHECK : '',
    section(SONG_REQUEST_LABEL, trimTo(request, MAX_GUIDANCE)),
    section('MUSICAL DESCRIPTION', trimTo(description, MAX_DESCRIPTION) || '(none given)'),
    section('ADDITIONAL GUIDANCE FROM THE USER', trimTo(guidance, MAX_GUIDANCE)),
    section('DRAFT LYRICS', trimTo(lyrics, MAX_LYRICS)),
    `\n\n${LYRICS_REVIEW_OUTPUT_CONTRACT}`,
  ].join('');
}

/**
 * Split a review response into the revised sheet and the notes: everything
 * before the last line that is only `---` is the lyrics, everything after it
 * the notes. No separator → the whole text is the lyrics and the notes are
 * empty (a model that skipped the critique still revised the song).
 */
function parseLyricsReview(text) {
  const body = unfence(text).replace(/\r\n?/g, '\n');
  const lines = body.split('\n');
  const cut = lines.findLastIndex((line) => line.trim() === LYRICS_REVIEW_SEPARATOR);
  if (cut < 0) return { lyrics: body.trim(), notes: '' };
  return { lyrics: unfence(lines.slice(0, cut).join('\n')).trim(), notes: lines.slice(cut + 1).join('\n').trim() };
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

  const description = trimTo(unfence(text), MAX_DESCRIPTION);
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
 * @param {string} [args.request] — the song request it is commissioned from (hook, subject, imagery)
 * @param {string} [args.template] — meta-prompt override; blank → the default
 * @param {number} [args.targetSeconds] — intended song length; default 180 (~3 min)
 * @param {string} [args.providerId]
 * @param {string} [args.model]
 * @param {string} [args.effort]
 * @returns {Promise<{ lyrics: string, llm: { provider: string, model: string|null } }>}
 */
export async function writeLyrics({ description, guidance, request, template, targetSeconds, providerId, model, effort } = {}) {
  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  assertProvider(provider, { message: 'No AI provider available to write lyrics', code: 'NO_PROVIDER' });

  const prompt = buildLyricsPrompt({ description, guidance, request, template, targetSeconds });
  const { text, model: ranModel } = await runPromptThroughProvider({
    provider, model: selectedModel, effort, prompt, source: 'music-lyrics',
  });

  const lyrics = trimTo(unfence(text), MAX_LYRICS);
  if (!lyrics) {
    throw new ServerError('The AI returned empty lyrics. Try rerunning or picking a stronger model.', { status: 502, code: 'LLM_EMPTY' });
  }
  console.log(`🎤 Wrote lyrics via ${provider.id}/${ranModel || 'default'} (${lyrics.length} chars)`);
  return { lyrics, llm: { provider: provider.id, model: ranModel || null } };
}

/**
 * Review a lyric draft and return the revised sheet plus a short critique.
 *
 * @param {object} args
 * @param {string} args.lyrics — the draft to revise
 * @param {string} [args.description] — the musical description it was written against
 * @param {string} [args.guidance]
 * @param {string} [args.request] — the song request the draft must honour
 * @param {string} [args.providerId]
 * @param {string} [args.model]
 * @param {string} [args.effort]
 * @returns {Promise<{ lyrics: string, notes: string, llm: { provider: string, model: string|null } }>}
 */
export async function reviewLyrics({ lyrics, description, guidance, request, providerId, model, effort } = {}) {
  if (!trimTo(lyrics, MAX_LYRICS)) {
    throw new ServerError('There are no lyrics to review.', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  assertProvider(provider, { message: 'No AI provider available to review lyrics', code: 'NO_PROVIDER' });

  const prompt = buildLyricsReviewPrompt({ lyrics, description, guidance, request });
  const { text, model: ranModel } = await runPromptThroughProvider({
    provider, model: selectedModel, effort, prompt, source: 'music-lyrics-review',
  });

  const parsed = parseLyricsReview(text);
  const revised = trimTo(parsed.lyrics, MAX_LYRICS);
  if (!revised) {
    throw new ServerError('The AI returned empty revised lyrics. Try rerunning or picking a stronger model.', { status: 502, code: 'LLM_EMPTY' });
  }
  const notes = trimTo(parsed.notes, MAX_GUIDANCE);
  console.log(`🎤 Reviewed lyrics via ${provider.id}/${ranModel || 'default'} (${revised.length} chars${notes ? ', with notes' : ''})`);
  return { lyrics: revised, notes, llm: { provider: provider.id, model: ranModel || null } };
}
