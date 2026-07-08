/**
 * Per-series style guide (house style) — #1303.
 *
 * A structured companion to the free-text `series.styleNotes`. Where styleNotes
 * is tonal/visual prose, the style guide captures the *mechanical* house style —
 * tense, POV person, target audience, content rating, reading level, tone words,
 * and copy-edit conventions — so generation and editorial conformance checks
 * share one source of truth instead of re-deriving intent from free text.
 *
 * Lives at `series.styleGuide` (a top-level series field, sibling to
 * `styleNotes`). Sanitized on every series load/save by `sanitizeSeries`
 * (services/pipeline/series.js); rendered into generation contexts by
 * `renderStyleGuide` (folded into the already-rendered `styleNotes`, so no
 * stage-prompt template variable — and thus no migration — is needed); and
 * audited by the `style.*` editorial checks (lib/editorial/checkRegistry.js).
 *
 * This module is PURE — no side-effecting imports. Mirrors the sanitizer
 * conventions in storyArc.js: absent/invalid → null/absent so a partial payload
 * from an LLM or an older series.json never crashes a downstream reader, and an
 * all-empty guide collapses to `null` ("no style guide yet").
 */

import { isStr, trimTo } from './storyBible.js';

export const STYLE_GUIDE_LIMITS = Object.freeze({
  TONE_MAX: 60,
  TONES_MAX: 20,
  READING_LEVEL_MIN: 1,
  READING_LEVEL_MAX: 18,
  // Voice exemplars (#2179, CWQE Phase 14) — concrete prose anchors ("the
  // tuning fork") beat adjective lists. Passages run ~150–300 words; the cap is
  // ~2000 chars each and 3 apiece so the fixed per-call prompt overhead stays
  // tight (exemplars are injected into every draft/revision prompt). Each entry
  // is `{ passage, note }` — the note says what the passage demonstrates
  // (exemplar) or what's wrong with it (anti-exemplar: "too ornate").
  EXEMPLARS_MAX: 3,
  EXEMPLAR_PASSAGE_MAX: 2000,
  EXEMPLAR_NOTE_MAX: 200,
});

// Le Guin prose-craft doctrine (#2175, CWQE Phase 10) — always-on generation-side
// craft guidance, the prose sibling of the Sanderson's-Laws worldbuilding doctrine
// baked into `buildExpansionPrompt`. Ursula K. Le Guin's core lesson from *Steering
// the Craft*: style is not decoration laid over a story — the sound and rhythm of the
// sentences ARE the reader's experience of the world. Kept as short imperative rules
// (not essays) per the "prompts stay lean" rule; injected only into the prose/text
// writing stages (see composeStyleNotes' `proseCraft` option), never the structural
// arc/episode-seed planning stages where prose-level craft would be noise. This is
// baked-in doctrine, NOT a per-series field, so it needs no schema/migration.
export const PROSE_CRAFT_DOCTRINE = Object.freeze([
  'Prose craft (Le Guin — apply throughout):',
  '- Style is not ornament — it IS the story: the sound, rhythm, and syntax of the sentences create the world the reader lives in, so shape them deliberately.',
  '- Prefer strong, specific nouns and verbs to adjective/adverb padding. Cut dead adjective-noun clichés ("ancient wisdom", "piercing gaze", "heavy silence", "cold fury") — replace them with a concrete image or a sharper verb.',
  '- Let concrete sensory detail carry meaning; do not summarize an emotion the scene can show.',
  '- Vary sentence length and rhythm on purpose — short for impact, longer to build; never let every sentence fall into the same cadence.',
].join('\n'));

// Voice-discovery registers (#2179, CWQE Phase 14) — the distinct prose voices
// the "Discover voice" flow renders the SAME scene beat in, so the user (or the
// autonomous judge) can pick the one that fits by ear rather than by adjective.
// `id` is stable (persisted into the discovery result); `label`/`hint` steer
// the LLM and the side-by-side UI. Kept small and opinionated — 5 registers is
// the autonovel "~5 trial passages" default, enough contrast without a wall of
// near-identical drafts.
export const VOICE_REGISTERS = Object.freeze([
  { id: 'spare', label: 'Spare', hint: 'lean, plain, Hemingway-terse — short declaratives, concrete nouns, almost no adjectives' },
  { id: 'lyric', label: 'Lyric', hint: 'lush and musical — rhythmic, image-dense, sentences that build and breathe' },
  { id: 'wry', label: 'Wry', hint: 'dry, ironic, quietly funny — understatement and a knowing narrator' },
  { id: 'close-psychic', label: 'Close-psychic', hint: 'deep interiority — the narration lives inside the POV character\'s thoughts and sensations' },
  { id: 'cinematic', label: 'Cinematic', hint: 'camera-eye, present and kinetic — blocking, motion, and sensory cuts like a shooting script' },
]);
export const VOICE_REGISTER_IDS = Object.freeze(VOICE_REGISTERS.map((r) => r.id));

export const STYLE_GUIDE_TENSES = Object.freeze(['past', 'present']);
export const STYLE_GUIDE_POV_PERSONS = Object.freeze(['first', 'third-limited', 'third-omniscient', 'second']);
export const STYLE_GUIDE_AUDIENCES = Object.freeze(['children', 'middle-grade', 'YA', 'adult']);
export const STYLE_GUIDE_RATINGS = Object.freeze(['G', 'PG', 'PG-13', 'R', 'custom']);
export const STYLE_GUIDE_PROFANITY = Object.freeze(['none', 'mild', 'moderate', 'strong']);
export const STYLE_GUIDE_SPELLING = Object.freeze(['US', 'UK']);

// Human-readable labels for the prompt/render block + the editorial-check
// finding text, so generation and checks describe a value identically.
const POV_PERSON_LABELS = Object.freeze({
  first: 'first person',
  'third-limited': 'third-person limited',
  'third-omniscient': 'third-person omniscient',
  second: 'second person',
});
const AUDIENCE_LABELS = Object.freeze({
  children: 'children',
  'middle-grade': 'middle-grade',
  YA: 'young-adult (YA)',
  adult: 'adult',
});

const enumOrNull = (raw, allowed) => (allowed.includes(raw) ? raw : null);

// Tri-state boolean: only `true`/`false` count as a set value — anything else is
// "unspecified" (absent), so an LLM that omits a convention can't silently flip
// it off (matches the absent-vs-empty rule in CLAUDE.md).
const optBool = (raw) => (typeof raw === 'boolean' ? raw : null);

// Target grade level. Finite → clamped to [1,18]; otherwise null (unspecified)
// so "no target" stays distinguishable from "grade 0".
const optReadingLevel = (raw) => (Number.isFinite(raw)
  ? Math.max(STYLE_GUIDE_LIMITS.READING_LEVEL_MIN, Math.min(STYLE_GUIDE_LIMITS.READING_LEVEL_MAX, Math.round(raw)))
  : null);

function cleanTone(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const v of raw) {
    const s = trimTo(v, STYLE_GUIDE_LIMITS.TONE_MAX);
    const key = s.toLowerCase();
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= STYLE_GUIDE_LIMITS.TONES_MAX) break;
  }
  return out;
}

// Sanitize a list of voice exemplar / anti-exemplar passages (#2179). Each
// entry is `{ passage, note }`: `passage` is the concrete prose anchor (the
// tuning fork), `note` a one-line gloss of what it demonstrates (exemplar) or
// what's wrong with it (anti-exemplar). Drops entries with no passage, trims to
// the char caps, and caps the list length. Returns `[]` when nothing usable.
//
// Exported so the Writers Room (`services/writersRoom/local.js`) can carry the
// SAME voice-exemplar shape on a freeform work as the series style guide does —
// one sanitizer, one set of caps, no drift between the two surfaces (#2179
// Writers Room parity).
export function sanitizeVoiceExemplars(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue;
    const passage = trimTo(item.passage, STYLE_GUIDE_LIMITS.EXEMPLAR_PASSAGE_MAX);
    if (!passage) continue;
    const note = trimTo(item.note, STYLE_GUIDE_LIMITS.EXEMPLAR_NOTE_MAX);
    out.push(note ? { passage, note } : { passage });
    if (out.length >= STYLE_GUIDE_LIMITS.EXEMPLARS_MAX) break;
  }
  return out;
}

// Sanitize the copy-edit conventions sub-object. Returns null when nothing is
// set so a guide that declares only tense/POV doesn't carry an empty husk.
function sanitizeConventions(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  const oxfordComma = optBool(raw.oxfordComma);
  const spelling = enumOrNull(raw.spelling, STYLE_GUIDE_SPELLING);
  const italicizeThoughts = optBool(raw.italicizeThoughts);
  if (oxfordComma == null && spelling == null && italicizeThoughts == null) return null;
  return { oxfordComma, spelling, italicizeThoughts };
}

/**
 * Sanitize the optional `series.styleGuide` field. Returns `null` when the
 * guide carries no identifying content (every field absent/invalid) so callers
 * store `null` to mean "no style guide yet" — mirroring `sanitizeArc` /
 * `sanitizeReaderMap`. Legacy-tolerant: a series.json predating this field has
 * `styleGuide` absent → `sanitizeStyleGuide(undefined)` → null.
 */
export function sanitizeStyleGuide(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  const tense = enumOrNull(raw.tense, STYLE_GUIDE_TENSES);
  const povPerson = enumOrNull(raw.povPerson, STYLE_GUIDE_POV_PERSONS);
  const targetAudience = enumOrNull(raw.targetAudience, STYLE_GUIDE_AUDIENCES);
  const contentRating = enumOrNull(raw.contentRating, STYLE_GUIDE_RATINGS);
  const profanity = enumOrNull(raw.profanity, STYLE_GUIDE_PROFANITY);
  const readingLevel = optReadingLevel(raw.readingLevel);
  const tone = cleanTone(raw.tone);
  const conventions = sanitizeConventions(raw.conventions);
  const voiceExemplars = sanitizeVoiceExemplars(raw.voiceExemplars);
  const voiceAntiExemplars = sanitizeVoiceExemplars(raw.voiceAntiExemplars);
  if (
    tense == null && povPerson == null && targetAudience == null && contentRating == null
    && profanity == null && readingLevel == null && tone.length === 0 && conventions == null
    && voiceExemplars.length === 0 && voiceAntiExemplars.length === 0
  ) {
    return null;
  }
  return {
    tense, povPerson, targetAudience, contentRating, profanity, readingLevel, tone, conventions,
    voiceExemplars, voiceAntiExemplars,
  };
}

// Render the voice exemplar / anti-exemplar blocks (#2179). Concrete prose
// anchors do more to fix voice than any adjective list — so a "MATCH this
// voice" block of exemplars and a "NEVER drift toward this" block of
// anti-exemplars are appended to the house-style directives. Both are
// conditional: absent exemplars render nothing (so a guide with no passages
// carries no empty husk in the prompt). Returns `''` when neither is present.
//
// `carrier` is any object exposing `voiceExemplars` / `voiceAntiExemplars`
// arrays — the series style guide OR a Writers Room work manifest — so the two
// surfaces render byte-identical voice blocks (#2179 Writers Room parity).
export function renderVoiceExemplars(carrier) {
  if (!carrier || typeof carrier !== 'object') return '';
  const blocks = [];
  const exemplars = Array.isArray(carrier.voiceExemplars) ? carrier.voiceExemplars : [];
  const antiExemplars = Array.isArray(carrier.voiceAntiExemplars) ? carrier.voiceAntiExemplars : [];
  const renderPassage = (e) => (e.note ? `> ${e.passage}\n> — ${e.note}` : `> ${e.passage}`);
  if (exemplars.length) {
    blocks.push(`MATCH this voice — these passages are the tuning fork for the series' prose. Echo their rhythm, diction, and register; do not copy their content:\n${exemplars.map(renderPassage).join('\n\n')}`);
  }
  if (antiExemplars.length) {
    blocks.push(`NEVER drift toward this — these passages are in the wrong register for the series. Avoid what each note flags:\n${antiExemplars.map(renderPassage).join('\n\n')}`);
  }
  return blocks.join('\n\n');
}

/**
 * Render the style guide as a directive block for generation prompts. Returns a
 * single string (folded into the already-rendered `styleNotes` by the context
 * builders, so no stage-prompt template variable is added — and no migration is
 * needed) or `null` when the guide is empty/absent. Mirrors `renderTickingClock`
 * in storyArc.js.
 */
export function renderStyleGuide(styleGuide) {
  if (!styleGuide || typeof styleGuide !== 'object') return null;
  const directives = [];
  if (styleGuide.tense) directives.push(`Write in **${styleGuide.tense} tense**.`);
  if (styleGuide.povPerson) {
    directives.push(`Narrate in **${POV_PERSON_LABELS[styleGuide.povPerson] || styleGuide.povPerson}** point of view.`);
  }
  if (styleGuide.targetAudience) {
    directives.push(`Target audience: **${AUDIENCE_LABELS[styleGuide.targetAudience] || styleGuide.targetAudience}** — pitch vocabulary, sentence complexity, and subject matter accordingly.`);
  }
  if (styleGuide.contentRating && styleGuide.contentRating !== 'custom') {
    directives.push(`Keep content within a **${styleGuide.contentRating}** rating.`);
  }
  if (styleGuide.profanity) {
    directives.push(styleGuide.profanity === 'none'
      ? 'Use **no profanity**.'
      : `Profanity may be **${styleGuide.profanity}**, no stronger.`);
  }
  if (styleGuide.readingLevel != null) {
    directives.push(`Aim for roughly a **grade-${styleGuide.readingLevel} reading level**.`);
  }
  if (Array.isArray(styleGuide.tone) && styleGuide.tone.length) {
    directives.push(`Tone: ${styleGuide.tone.join(', ')}.`);
  }
  const conv = styleGuide.conventions;
  if (conv) {
    if (conv.spelling) directives.push(`Use **${conv.spelling} spelling**.`);
    if (conv.oxfordComma === true) directives.push('Use the Oxford (serial) comma.');
    else if (conv.oxfordComma === false) directives.push('Do not use the Oxford (serial) comma.');
    if (conv.italicizeThoughts === true) directives.push('Render internal thoughts in italics.');
    else if (conv.italicizeThoughts === false) directives.push('Do not italicize internal thoughts.');
  }
  const voiceBlock = renderVoiceExemplars(styleGuide);
  if (directives.length === 0 && !voiceBlock) return null;
  const header = directives.length
    ? `Series style guide (house style — follow exactly):\n${directives.map((d) => `- ${d}`).join('\n')}`
    : '';
  return [header, voiceBlock].filter(Boolean).join('\n\n');
}

/**
 * Compose a series' free-text `styleNotes` with the rendered structured style
 * guide into the single `styleNotes` string the stage templates already render
 * (`{{series.styleNotes}}`). Folding the guide in here means generation honors
 * tense/POV/rating/reading-level with NO new stage-prompt template variable —
 * and therefore no prompt migration — exactly as `appendTickingClock` folds the
 * countdown into the arc-level `shapeGuidance` block.
 *
 * The structured guide leads (deterministic house style first), the author's
 * free-text notes trail. Returns `''` when neither is present.
 *
 * `opts.proseCraft` (default false) appends the always-on Le Guin prose-craft
 * doctrine (#2175). It's opt-in per stage: the prose/text writing stages pass
 * `true` so drafting follows the craft rules; the structural arc/episode-seed
 * planning stages leave it off, since sentence-level craft guidance is noise
 * when the model is outlining beats rather than writing prose.
 */
export function composeStyleNotes(series, opts = {}) {
  const guide = renderStyleGuide(series?.styleGuide);
  const notes = isStr(series?.styleNotes) ? series.styleNotes.trim() : '';
  const craft = opts.proseCraft ? PROSE_CRAFT_DOCTRINE : '';
  return [guide, notes, craft].filter(Boolean).join('\n\n');
}
