/**
 * Copy-edit prose-tic deterministic primitives (#1306) for the editorial check
 * registry. Pure and dependency-free (no side-effecting imports) so it stays
 * unit-testable in isolation — mirrors ./cliches.js and ./nameSimilarity.js.
 *
 * Word-level scanners backing the deterministic "copy-edit" check group in
 * checkRegistry.js:
 *   - findFilterWords()  → `prose.filter-words`   (distancing verbs)
 *   - findHedgeWords()   → `prose.hedge-words`    (hedge / weasel distance markers)
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
  // Modal-perception and reflexive constructions are the same distancing tic in
  // phrase form ("she could see the door" → "the door stood open"; "he found
  // himself running" → "he ran"). Matched as whole phrases (longest-first).
  'could see', 'could hear', 'could feel', 'could smell', 'could tell',
  'found himself', 'found herself', 'found themselves', 'found myself',
]);

// Hedge / weasel distance markers (#1621) — the SECOND distancing bucket that
// `prose.filter-words` (perception verbs) misses. Three families of softeners
// that quietly back the reader out of the moment:
//   - metaphorical distance — "it was as if he knew", "somewhere deep inside",
//     "almost felt", "part of him";
//   - dialogue / cognitive hedges — "I kind of think", "sort of felt",
//     "more or less", "I suppose";
//   - cognitive weasel words — "surely", "no doubt", "obviously", "of course".
// Density-scaled like the other word lists and user-extendable (extraWords) /
// mutable (allowWords). Multi-word entries match as whole phrases with flexible
// internal whitespace, longest-first (so "as if" wins over a bare "if").
export const HEDGE_WORDS = Object.freeze([
  // Metaphorical distance — narration that gestures AT a feeling from arm's length.
  'as if', 'as though', 'almost', 'somehow', 'somewhat', 'deep inside',
  'deep down', 'somewhere inside', 'somewhere deep', 'part of him',
  'part of her', 'part of them', 'something inside', 'in a way', 'in some way',
  // Dialogue / cognitive hedges — the speaker (or narrator) softens the claim.
  'kind of', 'sort of', 'more or less', 'i guess', 'i suppose', 'i think',
  'i feel like', 'maybe', 'perhaps', 'possibly', 'probably',
  // Cognitive weasel words — assert certainty in place of earning it on the page.
  'surely', 'no doubt', 'obviously', 'clearly', 'of course', 'naturally',
  'undoubtedly', 'evidently', 'presumably', 'needless to say', 'arguably',
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

// Setting / weather / atmosphere subjects (#1593). When the grammatical subject
// of a be-verb + participle is one of these, the construction is almost always an
// intentional mood/atmosphere image ("the sky was streaked with red", "the room
// was bathed in light", "the street was lined with trees") rather than a weak
// agentive passive. Classified `mood` so the check can suppress/downgrade it.
const SETTING_SUBJECTS = new Set([
  'sky', 'skies', 'sun', 'moon', 'stars', 'star', 'light', 'lights', 'sunlight',
  'moonlight', 'starlight', 'dawn', 'dusk', 'twilight', 'horizon', 'rain', 'snow',
  'wind', 'winds', 'air', 'fog', 'mist', 'haze', 'cloud', 'clouds', 'storm',
  'world', 'ground', 'earth', 'floor', 'ceiling', 'wall', 'walls', 'room',
  'hall', 'street', 'streets', 'road', 'path', 'valley', 'mountain', 'mountains',
  'hills', 'hill', 'forest', 'woods', 'sea', 'ocean', 'water', 'waters', 'river',
  'lake', 'field', 'fields', 'garden', 'meadow', 'landscape', 'silence', 'quiet',
  'darkness', 'shadow', 'shadows', 'night', 'morning', 'evening', 'afternoon',
  'day', 'sunset', 'sunrise', 'surface', 'distance', 'town', 'city', 'village',
]);

// Stative / predicate-adjective participles (#1593). A be-verb + one of these
// reads as a state-of-being adjective ("she was exhausted", "he was determined",
// "the bread was gone"), not an agentive passive — the dominant false-positive
// class for the be-verb + past-participle heuristic. Curated to entries that are
// overwhelmingly adjectival as a predicate; classified `stative` so the check can
// suppress them by default. (A trailing "by <agent>" overrides this to `weak`.)
const STATIVE_PARTICIPLES = new Set([
  // Emotional / mental states
  'tired', 'exhausted', 'worried', 'scared', 'frightened', 'terrified',
  'excited', 'interested', 'bored', 'confused', 'surprised', 'amazed',
  'astonished', 'pleased', 'satisfied', 'delighted', 'annoyed', 'frustrated',
  'embarrassed', 'ashamed', 'relieved', 'concerned', 'determined', 'depressed',
  'devastated', 'overwhelmed', 'thrilled', 'disappointed', 'shocked', 'stunned',
  'intrigued', 'fascinated', 'alarmed', 'troubled', 'convinced', 'resigned',
  'accustomed', 'amused', 'comforted', 'distracted', 'flustered',
  // Physical / positional states
  'gone', 'dressed', 'seated', 'married', 'finished', 'done', 'located',
  'situated', 'positioned', 'prepared', 'gathered',
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

// Normalize a house-style/extra word list into a Set for O(1) membership in the
// token-loop scanners. Tolerates a non-array (returns an empty Set).
function toWordSet(words) {
  return new Set((Array.isArray(words) ? words : []).map(normalizeWord).filter(Boolean));
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
  const allow = toWordSet(opts.allowWords);
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
 * Hedge / weasel distance-marker occurrences (#1621). One entry per match. Shares
 * the same allow/extra plumbing as the other word lists, so a series can mute a
 * noisy default ("almost") or add house-style hedges.
 * @param {string} text
 * @param {{ allowWords?: string[], extraWords?: string[] }} [opts]
 * @returns {Array<{ entry: string, index: number, anchor: string }>}
 */
export function findHedgeWords(text, opts = {}) {
  return scanList(text, HEDGE_WORDS, opts);
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
 * @param {{ allowWords?: string[], extraWords?: string[] }} [opts] allowWords mutes
 *   specific adverbs; extraWords flags series-specific words that the `-ly`
 *   heuristic misses (irregular adverbs like "fast"/"well"/"hard").
 * @returns {Array<{ word: string, index: number, anchor: string, dialogueTag: boolean, tagAdverbKind: ('reporting'|'emotion'|null) }>}
 */
export function findAdverbs(text, opts = {}) {
  const tokens = tokenizeWords(text);
  if (!tokens.length) return [];
  const allow = toWordSet(opts.allowWords);
  const extra = toWordSet(opts.extraWords);
  const tagSet = new Set(DIALOGUE_TAGS);
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if ((!isLyAdverb(t.lower) && !extra.has(t.lower)) || allow.has(t.lower)) continue;
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

// Atmospheric "rendering" participles (#1593). These describe a setting being
// visually rendered into a mood — "the sky was STREAKED with red", "the room was
// BATHED in light", "the street was LINED with trees". A setting subject ALONE is
// not enough ("the room was searched" / "the city was attacked" share the subject
// but are genuine action passives), so `mood` requires the participle itself to be
// one of these atmospheric verbs.
const MOOD_PARTICIPLES = new Set([
  'streaked', 'bathed', 'lined', 'dotted', 'washed', 'tinged', 'tinted',
  'cloaked', 'veiled', 'shrouded', 'framed', 'dappled', 'draped', 'filled',
  'painted', 'suffused', 'flooded', 'blanketed', 'carpeted', 'studded',
  'wreathed', 'gilded', 'edged', 'rimmed', 'crowned', 'swathed', 'illuminated',
  'silhouetted', 'bordered', 'fringed', 'speckled', 'splashed', 'drenched',
  'soaked', 'coated', 'covered', 'wrapped', 'softened', 'muffled', 'hushed',
]);

// Temporal/deictic nouns that follow "by" as a time phrase, not an agent ("she
// was exhausted BY MORNING"). When one of these follows "by", the construction
// is not an agentive passive, so it does not override stative/mood suppression.
const NON_AGENT_BY = new Set([
  'morning', 'noon', 'midday', 'afternoon', 'evening', 'night', 'nightfall',
  'midnight', 'dawn', 'dusk', 'sunrise', 'sunset', 'sundown', 'twilight',
  'daybreak', 'then', 'now', 'today', 'tonight', 'tomorrow', 'yesterday',
]);

// Determiners skipped when reading the head noun of a "by <…>" phrase, so
// "by the morning" resolves to the temporal "morning", not the determiner.
const BY_DETERMINERS = new Set(['the', 'a', 'an']);

// How far past the participle to look for a "by <agent>" phrase, allowing an
// intervening adverb and a determiner ("decorated elaborately by the artist").
const PASSIVE_LOOKAHEAD = 4;

// Whether the subject governing a be-verb at token index `i` is a setting noun.
// The subject is the token right before the be-verb ("the sky was", "her eyes
// were" → "sky"/"eyes"), so a known setting/atmosphere noun there is one of the
// two signals (with an atmospheric complement) for an intentional mood image.
function hasSettingSubject(tokens, i) {
  return i > 0 && SETTING_SUBJECTS.has(tokens[i - 1].lower);
}

/**
 * Passive-voice candidates: a be-verb followed (allowing up to two intervening
 * adverbs) by a past participle — "was broken", "is quietly forgotten". A
 * heuristic, advisory only; returns the be-verb…participle span anchored.
 *
 * Each candidate is classified (#1593) so the check can suppress likely-intentional
 * passives and keep the cheap heuristic as the base tier:
 *   - `'weak'`    — a genuine agentive passive ("the door was opened"); always
 *                   `'weak'` when a "by <agent>" phrase follows the participle.
 *   - `'stative'` — a predicate-adjective state of being ("she was exhausted"),
 *                   not an action done to the subject — the dominant FP class.
 *   - `'mood'`    — a setting/weather/atmosphere image: a setting subject AND an
 *                   atmospheric rendering participle ("the sky was STREAKED",
 *                   "the room was BATHED in light"). A setting subject alone is
 *                   not enough ("the room was searched" stays `'weak'`).
 * `byAgent` is true when an explicit "by <agent>" follows the participle (allowing
 * an intervening adverb, "decorated elaborately by Mira").
 *
 * @param {string} text
 * @param {{ allowWords?: string[], extraWords?: string[] }} [opts] allowWords mutes
 *   participles a series never wants flagged (archaic/house-style "-ed" forms read
 *   as adjectives — "blessed", "beloved"); extraWords adds domain-specific irregular
 *   participles the "-ed"/known-irregular heuristic misses ("begun", "hewn").
 * @returns {Array<{ index: number, anchor: string, be: string, participle: string, classification: ('weak'|'stative'|'mood'), byAgent: boolean }>}
 */
export function findPassiveVoice(text, opts = {}) {
  const tokens = tokenizeWords(text);
  if (!tokens.length) return [];
  const beSet = new Set(BE_VERBS);
  const allow = toWordSet(opts.allowWords);
  const extra = toWordSet(opts.extraWords);
  // A participle is recognized when the heuristic OR a series `extraWords` entry
  // matches, unless the series allow-listed it.
  const isParticiple = (lower) => (isPastParticiple(lower) || extra.has(lower)) && !allow.has(lower);
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (!beSet.has(tokens[i].lower)) continue;
    // Look ahead past up to two -ly adverbs for the participle.
    let j = i + 1;
    let skipped = 0;
    while (j < tokens.length && skipped < 2 && isLyAdverb(tokens[j].lower)) { j += 1; skipped += 1; }
    if (j < tokens.length && isParticiple(tokens[j].lower) && !beSet.has(tokens[j].lower)) {
      const start = tokens[i].index;
      const end = tokens[j].index + tokens[j].word.length;
      const participle = tokens[j].lower;
      // Small window just past the participle, where a "by <agent>" phrase would
      // sit. Stop at a sentence/line boundary so the next sentence ("…exhausted.
      // By morning…") can't leak a false agent in — tokenizeWords drops
      // punctuation, so the boundary is read from the raw text gap between tokens.
      const after = [];
      for (let k = j + 1; k < tokens.length && after.length < PASSIVE_LOOKAHEAD; k += 1) {
        const prev = tokens[k - 1];
        if (/[.!?\n]/.test(text.slice(prev.index + prev.word.length, tokens[k].index))) break;
        after.push(tokens[k]);
      }
      // An explicit "by <agent>" (with an optional intervening adverb) is the
      // unambiguous agentive passive — it wins over stative/mood classification.
      // The agent must be inside the same-sentence window and must not be a time
      // phrase ("by morning", "by the dawn"), which is not an agent — so skip a
      // leading determiner to read the head noun.
      const byPos = after.findIndex((t) => t.lower === 'by');
      const byObj = byPos === -1 ? [] : after.slice(byPos + 1);
      const headTok = byObj[0] && BY_DETERMINERS.has(byObj[0].lower) ? byObj[1] : byObj[0];
      const byAgent = !!headTok && !NON_AGENT_BY.has(headTok.lower);
      let classification = 'weak';
      if (!byAgent) {
        // A mood image needs BOTH a setting subject AND an atmospheric rendering
        // participle — a setting subject alone over-suppresses real action
        // passives ("the room was searched", "the city was attacked").
        if (MOOD_PARTICIPLES.has(participle) && hasSettingSubject(tokens, i)) classification = 'mood';
        else if (STATIVE_PARTICIPLES.has(participle)) classification = 'stative';
      }
      out.push({ index: start, anchor: text.slice(start, end), be: tokens[i].lower, participle, classification, byAgent });
      i = j; // don't re-anchor the same participle
    }
  }
  return out;
}

// Filter passive-voice candidates for the density check (#1593). With
// `suppressIntentional` (the default), only genuine `'weak'` agentive passives
// are counted — `'stative'` predicate-adjectives and `'mood'` setting images are
// dropped as intentional. Set it false to fall back to the raw heuristic (count
// every be-verb + participle). Pure so the check and tests share one filter.
export function filterPassiveVoice(hits, { suppressIntentional = true } = {}) {
  if (!Array.isArray(hits)) return [];
  if (!suppressIntentional) return hits;
  return hits.filter((h) => h.classification === 'weak');
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
  const allow = toWordSet(opts.allowWords);
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
    const allow = toWordSet(opts.allowWords);
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
