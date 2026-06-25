/**
 * Copy-edit prose-tic deterministic primitives (#1306) for the editorial check
 * registry. Pure and dependency-free (no side-effecting imports) so it stays
 * unit-testable in isolation — mirrors ./cliches.js and ./nameSimilarity.js.
 *
 * Word-level scanners backing the deterministic "copy-edit" check group in
 * checkRegistry.js:
 *   - findFilterWords()  → `prose.filter-words`   (distancing verbs)
 *   - findCrutchWords()  → `prose.crutch-words`   (intensifiers / fillers)
 *   - findAdverbs()      → `prose.adverbs`        (-ly adverbs + dialogue-tag adverbs)
 *   - findPassiveVoice() → `prose.passive-voice`  (be-verb + past-participle heuristic)
 *   - findGestures()     → `prose.repeated-gestures` (gesture tally + body-part autonomy)
 *
 * Sentence/window-level repetition scanners live in ./repetition.js, which reuses
 * the `tokenizeWords` / `splitSentences` primitives exported here.
 *
 * The LLM sibling `prose.telling-emotion` (named-emotion → dramatize) handles the
 * judgment case these pure scanners deliberately avoid (false-positive-prone).
 */

// ---------------------------------------------------------------------------
// Seed word/phrase lists. Each is curated, not exhaustive; a series can extend
// (extraWords) or mute (allowWords) entries per house style. Entries are
// lowercase, free of leading/trailing punctuation. Multi-word entries ("began
// to") are matched as whole-word phrases with flexible internal whitespace.
// ---------------------------------------------------------------------------

// Filter words — distancing verbs that put a layer of narration between the
// reader and the experience ("she saw the door open" → "the door opened").
export const FILTER_WORDS = Object.freeze([
  'saw', 'watched', 'noticed', 'realized', 'realised', 'felt', 'heard',
  'seemed', 'looked', 'wondered', 'thought', 'knew', 'decided', 'sensed',
  'observed', 'spotted', 'glimpsed', 'began to', 'started to',
]);

// Crutch / filler words — intensifiers and hedges that almost always delete
// cleanly. Bare "that" is deliberately OMITTED from the default: grammatical
// "that" (relative clauses) dominates its count and would swamp the density
// signal, so it ships behind the per-check `includeThat` toggle instead.
export const CRUTCH_WORDS = Object.freeze([
  'just', 'really', 'very', 'quite', 'somewhat', 'suddenly', 'actually',
  'basically', 'literally', 'simply', 'totally', 'definitely', 'certainly',
  'in order to',
]);

// Common gesture verbs — the body-language tics that, repeated, read as a
// nervous narrator twitch. Counted across the manuscript; an overused gesture
// is flagged. Stored as base verbs; the matcher also catches the -s/-ing forms.
export const GESTURE_WORDS = Object.freeze([
  'nod', 'smile', 'shrug', 'sigh', 'frown', 'grin', 'smirk', 'wince',
  'blink', 'gasp', 'chuckle', 'glance', 'gulp', 'gawk', 'scowl', 'grimace',
]);

// Dialogue-tag verbs — when one of these is immediately followed by an -ly
// adverb ("she said angrily"), the adverb is propping up a tag that should
// carry its weight through the dialogue itself. Higher-severity sub-signal.
const DIALOGUE_TAGS = Object.freeze([
  'said', 'asked', 'replied', 'whispered', 'shouted', 'muttered', 'murmured',
  'answered', 'called', 'cried', 'yelled', 'snapped', 'hissed', 'breathed',
  'added', 'continued', 'stated', 'remarked', 'demanded', 'growled',
]);

// Reporting tag adverbs (#1592) — those that describe the *manner / volume /
// pace* of delivery ("said quietly / softly / sharply"). These read as
// near-invisible stage directions: they tell the reader HOW the line was
// voiced, not what the character felt, so they are NOT the "telling" that
// "said angrily" is. A tag adverb in this set is classified `reporting`; every
// other tag adverb (the emotion-telling bucket — "angrily", "happily",
// "sorrowfully") names a feeling the dialogue itself should carry. Using a
// reporting allow-list (rather than enumerating every emotion adverb) keeps
// recall high: a novel emotion adverb still classifies as emotion-telling.
const REPORTING_TAG_ADVERBS = new Set([
  'quietly', 'softly', 'gently', 'sharply', 'slowly', 'quickly', 'calmly',
  'evenly', 'flatly', 'dryly', 'drily', 'curtly', 'firmly', 'loudly', 'faintly',
  'coolly', 'smoothly', 'hoarsely', 'breathlessly', 'lightly', 'plainly',
  'simply', 'crisply', 'thickly', 'tightly', 'levelly', 'briskly',
  'mildly', 'tonelessly', 'huskily', 'breathily',
]);

// Be-verbs for the passive-voice heuristic.
const BE_VERBS = Object.freeze([
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
]);

// Irregular past participles the -ed suffix rule misses. Not exhaustive — the
// passive check is advisory, so a missed participle just under-flags (safe).
const IRREGULAR_PARTICIPLES = new Set([
  'broken', 'taken', 'given', 'seen', 'done', 'gone', 'written', 'spoken',
  'chosen', 'frozen', 'stolen', 'driven', 'known', 'grown', 'thrown', 'blown',
  'drawn', 'worn', 'born', 'borne', 'torn', 'sworn', 'shown', 'hidden',
  'beaten', 'eaten', 'fallen', 'forgotten', 'gotten', 'held', 'kept', 'left',
  'lost', 'made', 'met', 'paid', 'put', 'said', 'sent', 'set', 'sold', 'told',
  'built', 'bought', 'brought', 'caught', 'taught', 'felt', 'found', 'hung',
  'led', 'meant', 'read', 'struck', 'swept', 'swung', 'understood', 'wound',
  'bound', 'ground', 'cut', 'hit', 'hurt', 'shut', 'split', 'spread', 'cast',
  'forbidden', 'forgiven', 'mistaken', 'shaken', 'woken', 'risen', 'ridden',
  'bitten', 'laid', 'lain',
]);

// Common -ly words that are NOT adverbs (nouns/adjectives) — the suffix rule
// would otherwise flag them. Lowercase. Bare "only" is excluded here so it
// stays the crutch-word check's concern, not the adverb check's.
const NON_ADVERB_LY = new Set([
  'only', 'family', 'reply', 'supply', 'apply', 'ally', 'rally', 'bully',
  'jelly', 'belly', 'lily', 'holy', 'ugly', 'italy', 'july', 'fly', 'ply',
  'sly', 'rely', 'comply', 'imply', 'multiply', 'assembly', 'anomaly',
  'monopoly', 'panoply', 'melancholy', 'early', 'lonely', 'lovely', 'silly',
  'chilly', 'jolly', 'folly', 'dolly', 'gully', 'sully', 'tally', 'wally',
  'telly', 'wholly', 'duly', 'truly', 'unduly', 'curly', 'burly',
  'surly', 'gnarly', 'pearly', 'hourly', 'daily', 'doily', 'gaily',
]);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeWord(p) {
  return typeof p === 'string' ? p.trim().toLowerCase() : '';
}

/**
 * Tokenize prose into words with their absolute character offsets. Apostrophes
 * are kept inside a word ("couldn't") so contractions stay whole. Exported so
 * ./repetition.js shares one tokenization with the word-level scanners.
 *
 * @param {string} text
 * @returns {Array<{ word: string, lower: string, index: number }>}
 */
export function tokenizeWords(text) {
  if (typeof text !== 'string' || !text) return [];
  const re = /[A-Za-z][A-Za-z']*/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ word: m[0], lower: m[0].toLowerCase(), index: m.index });
  }
  return out;
}

/**
 * Split prose into sentences with their absolute start offsets. A naive split
 * on sentence-ending punctuation (. ! ?) — good enough for rhythm/opening
 * scans; the editorial checks built on it are advisory. Exported for reuse.
 *
 * @param {string} text
 * @returns {Array<{ text: string, index: number }>}
 */
export function splitSentences(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  const re = /[^.!?]+[.!?]*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    if (!raw.trim()) continue;
    // Anchor the index at the first non-space char of the sentence.
    const lead = raw.length - raw.trimStart().length;
    out.push({ text: raw.trim(), index: m.index + lead });
  }
  return out;
}

// Build a case-insensitive matcher for a list of single-word and/or multi-word
// phrase entries. Single words get word boundaries; phrases match whole-word
// with flexible internal whitespace (like ./cliches.js). Returns null when the
// effective list (seed + extra − allow) is empty.
function buildListMatcher(seed, opts = {}) {
  const allow = new Set((Array.isArray(opts.allowWords) ? opts.allowWords : []).map(normalizeWord).filter(Boolean));
  const extra = (Array.isArray(opts.extraWords) ? opts.extraWords : []).map(normalizeWord).filter(Boolean);
  const seen = new Set();
  const entries = [];
  for (const w of [...seed, ...extra]) {
    const norm = normalizeWord(w);
    if (!norm || seen.has(norm) || allow.has(norm)) continue;
    seen.add(norm);
    entries.push(norm);
  }
  if (!entries.length) return null;
  // Longest-first so a phrase ("began to") wins over its leading word ("began").
  const alt = entries
    .sort((a, b) => b.length - a.length)
    .map((e) => escapeRegExp(e).replace(/\s+/g, '\\s+'))
    .join('|');
  return new RegExp(`(?<!\\w)(?:${alt})(?!\\w)`, 'gi');
}

// Generic occurrence scan over a word/phrase list. Returns every match with its
// offset + the canonical lowercased entry, in position order.
function scanList(text, seed, opts) {
  if (typeof text !== 'string' || !text) return [];
  const matcher = buildListMatcher(seed, opts);
  if (!matcher) return [];
  const out = [];
  let m;
  while ((m = matcher.exec(text)) !== null) {
    out.push({ entry: m[0].toLowerCase().replace(/\s+/g, ' '), index: m.index, anchor: m[0] });
  }
  return out;
}

/**
 * Filter-word occurrences (distancing verbs). One entry per match.
 * @param {string} text
 * @param {{ allowWords?: string[], extraWords?: string[] }} [opts]
 * @returns {Array<{ entry: string, index: number, anchor: string }>}
 */
export function findFilterWords(text, opts = {}) {
  return scanList(text, FILTER_WORDS, opts);
}

/**
 * Crutch/filler-word occurrences. Bare "that" is included only when
 * `opts.includeThat` is true (off by default — grammatical "that" is noisy).
 * @param {string} text
 * @param {{ allowWords?: string[], extraWords?: string[], includeThat?: boolean }} [opts]
 * @returns {Array<{ entry: string, index: number, anchor: string }>}
 */
export function findCrutchWords(text, opts = {}) {
  const seed = opts.includeThat ? [...CRUTCH_WORDS, 'that'] : CRUTCH_WORDS;
  return scanList(text, seed, opts);
}

// Is `lower` an -ly adverb? (ends in "ly", length ≥ 4, not in the non-adverb set)
function isLyAdverb(lower) {
  return lower.length >= 4 && lower.endsWith('ly') && !NON_ADVERB_LY.has(lower);
}

/**
 * Adverb occurrences. Returns every -ly adverb with a `dialogueTag` flag set
 * when it immediately follows a dialogue tag ("said angrily") — those are the
 * higher-severity ones (the tag should carry its weight through the dialogue).
 *
 * Each dialogue-tag adverb is further classified (#1592) via `tagAdverbKind`:
 *   - `'reporting'` — manner/volume of delivery ("said quietly"), an invisible
 *     stage direction that is NOT a tell;
 *   - `'emotion'`   — names a feeling ("said angrily"), which the dialogue + a
 *     beat should carry instead.
 * Non-tag adverbs carry `tagAdverbKind: null`. Callers flag only the emotion
 * bucket on tags by default.
 *
 * @param {string} text
 * @param {{ allowWords?: string[] }} [opts] allowWords mutes specific adverbs.
 * @returns {Array<{ word: string, index: number, anchor: string, dialogueTag: boolean, tagAdverbKind: ('reporting'|'emotion'|null) }>}
 */
export function findAdverbs(text, opts = {}) {
  const tokens = tokenizeWords(text);
  if (!tokens.length) return [];
  const allow = new Set((Array.isArray(opts.allowWords) ? opts.allowWords : []).map(normalizeWord).filter(Boolean));
  const tagSet = new Set(DIALOGUE_TAGS);
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (!isLyAdverb(t.lower) || allow.has(t.lower)) continue;
    const prev = i > 0 ? tokens[i - 1].lower : '';
    const dialogueTag = tagSet.has(prev);
    const tagAdverbKind = dialogueTag
      ? (REPORTING_TAG_ADVERBS.has(t.lower) ? 'reporting' : 'emotion')
      : null;
    out.push({ word: t.word, index: t.index, anchor: t.word, dialogueTag, tagAdverbKind });
  }
  return out;
}

// Is `lower` a likely past participle? (-ed suffix or a known irregular)
function isPastParticiple(lower) {
  if (IRREGULAR_PARTICIPLES.has(lower)) return true;
  return lower.length >= 4 && lower.endsWith('ed');
}

/**
 * Passive-voice candidates: a be-verb followed (allowing up to two intervening
 * adverbs) by a past participle — "was broken", "is quietly forgotten". A
 * heuristic, advisory only; returns the be-verb…participle span anchored.
 *
 * @param {string} text
 * @returns {Array<{ index: number, anchor: string, be: string, participle: string }>}
 */
export function findPassiveVoice(text) {
  const tokens = tokenizeWords(text);
  if (!tokens.length) return [];
  const beSet = new Set(BE_VERBS);
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (!beSet.has(tokens[i].lower)) continue;
    // Look ahead past up to two -ly adverbs for the participle.
    let j = i + 1;
    let skipped = 0;
    while (j < tokens.length && skipped < 2 && isLyAdverb(tokens[j].lower)) { j += 1; skipped += 1; }
    if (j < tokens.length && isPastParticiple(tokens[j].lower) && !beSet.has(tokens[j].lower)) {
      const start = tokens[i].index;
      const end = tokens[j].index + tokens[j].word.length;
      out.push({ index: start, anchor: text.slice(start, end), be: tokens[i].lower, participle: tokens[j].lower });
      i = j; // don't re-anchor the same participle
    }
  }
  return out;
}

// Generate the regular inflections of a base verb: the base, +s, +ed/+d,
// +ing, plus doubled-final-consonant (nod → nodded/nodding) and dropped-e
// (smile → smiled/smiling) forms. Returns lowercased, de-duped surface forms.
function inflect(base) {
  const b = base.toLowerCase();
  const forms = new Set([b, `${b}s`]);
  if (b.endsWith('e')) {
    // smile → smiles, smiled, smiling
    const stem = b.slice(0, -1);
    forms.add(`${b}d`);
    forms.add(`${stem}ing`);
  } else {
    forms.add(`${b}ed`);
    forms.add(`${b}ing`);
    // Single short CVC base doubles its final consonant: nod → nodded/nodding.
    if (/[^aeiou][aeiou][^aeiouwxy]$/.test(b)) {
      const dbl = b + b.slice(-1);
      forms.add(`${dbl}ed`);
      forms.add(`${dbl}ing`);
    }
    // -y → -ies / -ied handled loosely; gesture bases rarely end in -y, skip.
  }
  return [...forms];
}

// Gesture matcher: each base verb plus its regular inflections (see inflect()).
function gestureMatcher(seed, opts = {}) {
  const allow = new Set((Array.isArray(opts.allowWords) ? opts.allowWords : []).map(normalizeWord).filter(Boolean));
  const extra = (Array.isArray(opts.extraWords) ? opts.extraWords : []).map(normalizeWord).filter(Boolean);
  const seen = new Set();
  const forms = [];
  for (const w of [...seed, ...extra]) {
    const norm = normalizeWord(w);
    if (!norm || seen.has(norm) || allow.has(norm)) continue;
    seen.add(norm);
    for (const f of inflect(norm)) forms.push(f);
  }
  if (!forms.length) return null;
  // Longest-first so "nodding" wins over "nod" under leftmost-match alternation.
  const alt = [...new Set(forms)].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  return new RegExp(`\\b(?:${alt})\\b`, 'gi');
}

// Body-part-autonomy regex: a possessive + body part + an action verb, the
// "her eyes followed him across the room" / "his hand shot out" tic where a
// body part acts on its own. High-precision, advisory.
const BODY_PART_AUTONOMY_RE = new RegExp(
  '\\b(?:his|her|their|its|my|your)\\s+'
  + '(?:eyes?|gaze|hands?|fingers?|feet|foot|legs?|arms?|head|brows?|eyebrows?|lips?|mouth)\\s+'
  + '(?:\\w+ed|shot|flew|darted|wandered|roamed|traveled|travelled|followed|drifted|swept|raked|'
  + 'slid|crawled|danced|leapt|leaped|jumped|moved|trailed|locked|met|found|sought)\\b',
  'gi',
);

/**
 * Gesture tally + body-part-autonomy occurrences.
 * @param {string} text
 * @param {{ allowWords?: string[], extraWords?: string[] }} [opts]
 * @returns {{
 *   gestures: Array<{ base: string, index: number, anchor: string }>,
 *   bodyParts: Array<{ index: number, anchor: string }>
 * }}
 */
export function findGestures(text, opts = {}) {
  if (typeof text !== 'string' || !text) return { gestures: [], bodyParts: [] };
  const matcher = gestureMatcher(GESTURE_WORDS, opts);
  const gestures = [];
  if (matcher) {
    // Map each inflected surface form back to its base for tally grouping.
    const allow = new Set((Array.isArray(opts.allowWords) ? opts.allowWords : []).map(normalizeWord).filter(Boolean));
    const extra = (Array.isArray(opts.extraWords) ? opts.extraWords : []).map(normalizeWord).filter(Boolean);
    const formToBase = new Map();
    for (const b of [...GESTURE_WORDS, ...extra]) {
      const norm = normalizeWord(b);
      if (!norm || allow.has(norm)) continue;
      for (const f of inflect(norm)) if (!formToBase.has(f)) formToBase.set(f, norm);
    }
    let m;
    while ((m = matcher.exec(text)) !== null) {
      const lower = m[0].toLowerCase();
      gestures.push({ base: formToBase.get(lower) || lower, index: m.index, anchor: m[0] });
    }
  }
  const bodyParts = [];
  let bm;
  BODY_PART_AUTONOMY_RE.lastIndex = 0;
  while ((bm = BODY_PART_AUTONOMY_RE.exec(text)) !== null) {
    bodyParts.push({ index: bm.index, anchor: bm[0] });
  }
  return { gestures, bodyParts };
}
