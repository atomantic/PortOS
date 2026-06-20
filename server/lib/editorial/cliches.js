/**
 * Cliché + overwriting deterministic primitives (#1308) for the editorial check
 * registry. Pure and dependency-free (no side-effecting imports) so it stays
 * unit-testable in isolation — mirrors ./nameSimilarity.js.
 *
 * Two scanners back two deterministic checks in checkRegistry.js:
 *   - findCliches()          → `prose.cliches`           (stock simile/idiom phrases)
 *   - findModifierStacking() → `prose.modifier-stacking` (overwriting: 3+ stacked modifiers)
 *
 * Their LLM sibling `prose.dead-metaphor` handles the judgment cases these pure
 * scanners can't: mixed/dead metaphors, novel clichés the seed list misses, and
 * purple-prose overwriting beyond a simple adjective run.
 */

// Seed cliché phrase list — stock similes/idioms that pull readers out of the
// prose. Curated, not exhaustive; a series can extend it (extraPhrases) or mute
// entries for voice/genre (allowPhrases). Phrases are matched whole-word and
// case-insensitively, with flexible internal whitespace, against the manuscript.
// Keep entries lowercase and free of leading/trailing punctuation.
export const CLICHE_PHRASES = Object.freeze([
  'heart pounding like a drum',
  'time stood still',
  'little did they know',
  'little did she know',
  'little did he know',
  'all hell broke loose',
  'at the end of the day',
  'calm before the storm',
  'avoid like the plague',
  'blood ran cold',
  'heart skipped a beat',
  'in the nick of time',
  'fell on deaf ears',
  'needle in a haystack',
  'tip of the iceberg',
  'weight of the world',
  'dead of night',
  'crack of dawn',
  'white as a sheet',
  'quiet as the grave',
  'easier said than done',
  'only time will tell',
  'every fiber of her being',
  'every fiber of his being',
  'tears streamed down',
  'a single tear',
  'butterflies in her stomach',
  'butterflies in his stomach',
  'heart of gold',
  'nerves of steel',
  'deafening silence',
  'ice in his veins',
  'ice in her veins',
  'world came crashing down',
  'against all odds',
  'by the skin of his teeth',
  'like a deer in the headlights',
  'thick as thieves',
  'head over heels',
  'weak in the knees',
  'breath caught in her throat',
  'breath caught in his throat',
  "couldn't believe her eyes",
  "couldn't believe his eyes",
  'without a second thought',
  'in the blink of an eye',
  'raining cats and dogs',
  'the apple of his eye',
  'cold sweat',
  'few and far between',
  'last but not least',
  'when push comes to shove',
  'lo and behold',
  'needless to say',
  'a force to be reckoned with',
  'wrong side of the bed',
  'hook line and sinker',
  'tip of the tongue',
  'better late than never',
]);

// Common short adjectives that lack a tell-tale adjective suffix — the suffix
// heuristic below misses these, so they're enumerated. Lowercase.
const COMMON_ADJECTIVES = new Set([
  'big', 'small', 'old', 'new', 'young', 'tall', 'short', 'long', 'wide',
  'deep', 'high', 'low', 'huge', 'tiny', 'thin', 'thick', 'soft', 'hard',
  'warm', 'cold', 'hot', 'cool', 'dark', 'light', 'pale', 'bright', 'dull',
  'dim', 'grim', 'vast', 'wet', 'dry', 'fat', 'lean', 'rich', 'poor', 'fine',
  'rough', 'smooth', 'sharp', 'flat', 'round', 'square', 'fierce', 'gentle',
  'quiet', 'loud', 'still', 'slow', 'quick', 'fast', 'weak', 'strong', 'proud',
  'plain', 'odd', 'sweet', 'bitter', 'sour', 'clean', 'dirty', 'fresh', 'stale',
  'red', 'blue', 'green', 'black', 'white', 'gray', 'grey', 'brown', 'gold',
  'golden', 'silver', 'crimson', 'azure', 'amber',
  // Frequent descriptive adjectives ending in -y — enumerated rather than caught
  // by a blanket -y suffix rule (which would sweep up -y nouns: city, body, army).
  'shiny', 'pretty', 'ugly', 'happy', 'angry', 'weary', 'dreary', 'empty',
  'heavy', 'busy', 'lazy', 'dirty', 'dusty', 'rusty', 'foggy', 'misty', 'murky',
  'silky', 'wispy', 'gloomy', 'creepy', 'spooky', 'sleepy', 'lonely', 'lovely',
]);

// Adjective / participle suffixes that reliably mark a descriptive modifier.
// Bare -y and -s are deliberately excluded (too noisy: "city", "boys");
// -ing/-ed are included because the no-comma run requirement below excludes the
// gerund/verb-list shapes that would otherwise be false positives.
const MODIFIER_SUFFIX = /(?:ous|ful|ive|ent|ant|ical|ic|less|able|ible|ish|ese|like|some|ward|most|ed|ing|ly)$/i;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A phrase matches with word boundaries on each edge and flexible internal
// whitespace, so "time   stood\nstill" still trips "time stood still". Internal
// non-word characters (apostrophes) are matched literally.
function clichePattern(phrase) {
  const escaped = escapeRegExp(phrase.trim()).replace(/\s+/g, '\\s+');
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

function normalizePhrase(p) {
  return typeof p === 'string' ? p.trim().toLowerCase() : '';
}

/**
 * Find stock-cliché phrase occurrences in `text`. Returns the FIRST occurrence
 * of each distinct phrase (deduped — a cliché repeated five times is one tic to
 * fix, not five findings), sorted by position.
 *
 * @param {string} text
 * @param {{ allowPhrases?: string[], extraPhrases?: string[] }} [opts]
 *   allowPhrases — house-style allowlist; muted (case-insensitive) so an
 *     intentional cliché in a character's voice doesn't flag.
 *   extraPhrases — series-specific additions to the seed list.
 * @returns {Array<{ phrase: string, index: number, anchor: string }>}
 *   phrase — the canonical seed/extra phrase; anchor — the verbatim text matched.
 */
export function findCliches(text, opts = {}) {
  if (typeof text !== 'string' || !text) return [];
  const allow = new Set((Array.isArray(opts.allowPhrases) ? opts.allowPhrases : []).map(normalizePhrase).filter(Boolean));
  const extra = (Array.isArray(opts.extraPhrases) ? opts.extraPhrases : [])
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean);
  // Seed + extras, deduped by normalized form, with the house-style allowlist removed.
  const seen = new Set();
  const phrases = [];
  for (const p of [...CLICHE_PHRASES, ...extra]) {
    const norm = normalizePhrase(p);
    if (!norm || seen.has(norm) || allow.has(norm)) continue;
    seen.add(norm);
    phrases.push(p);
  }
  const found = [];
  for (const phrase of phrases) {
    const m = clichePattern(phrase).exec(text);
    if (m) found.push({ phrase, index: m.index, anchor: m[0] });
  }
  return found.sort((a, b) => a.index - b.index);
}

function isModifierWord(word) {
  const w = word.toLowerCase();
  return COMMON_ADJECTIVES.has(w) || MODIFIER_SUFFIX.test(w);
}

/**
 * Find runs of `minStack`+ consecutive single-word modifiers separated only by
 * single spaces (no commas, within one sentence) — the cumulative-adjective
 * "big red shiny new" overwriting tell. Comma-coordinate lists and
 * cross-sentence spans are intentionally NOT flagged here (left to the LLM
 * sibling) to keep the deterministic scanner high-precision and advisory.
 *
 * @param {string} text
 * @param {{ minStack?: number }} [opts] minStack — run length to flag (default 3, min 3).
 * @returns {Array<{ words: string[], index: number, anchor: string, count: number }>}
 */
export function findModifierStacking(text, opts = {}) {
  if (typeof text !== 'string' || !text) return [];
  const minStack = Math.max(3, Number.isInteger(opts.minStack) ? opts.minStack : 3);
  const runs = [];
  // Walk space-delimited tokens, tracking each token's absolute offset so a run
  // can be anchored verbatim. A comma (or any non-space gap) breaks the run.
  const tokenRe = /\S+/g;
  let m;
  let runStart = -1; // char offset of the first word in the current run
  let runWords = []; // bare modifier words in the current run
  let prevEnd = -1; // char offset just past the previous token
  const flush = () => {
    if (runWords.length >= minStack && runStart >= 0) {
      const end = prevEnd;
      runs.push({
        words: runWords.slice(),
        index: runStart,
        anchor: text.slice(runStart, end),
        count: runWords.length,
      });
    }
    runStart = -1;
    runWords = [];
  };
  while ((m = tokenRe.exec(text)) !== null) {
    const raw = m[0];
    const start = m.index;
    // Separator since the previous token: a run only continues across a single
    // space. A comma, newline, sentence break, or any trailing punctuation on the
    // previous token ends the current run.
    const gap = prevEnd >= 0 ? text.slice(prevEnd, start) : '';
    const cleanGap = gap === ' ';
    // The bare alphabetic word (strip surrounding punctuation); trailing
    // punctuation on a token (comma, period) also ends the run after it.
    const bare = raw.replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, '');
    // Trailing punctuation (a comma after this modifier, or sentence-ending
    // .!?) closes the run after it — sentence breaks attach their punctuation to
    // the preceding token, so this also stops a run at a sentence boundary.
    const hadTrailingPunct = /[^A-Za-z']$/.test(raw);
    const isMod = bare.length > 0 && isModifierWord(bare);

    if (isMod && (runWords.length === 0 || cleanGap)) {
      if (runWords.length === 0) runStart = start;
      runWords.push(bare);
    } else {
      flush();
      if (isMod) {
        runStart = start;
        runWords = [bare];
      }
    }
    prevEnd = start + raw.length;
    // Trailing punctuation (comma after this modifier, end of sentence) closes
    // the run even when the next token is also a modifier.
    if (hadTrailingPunct) flush();
  }
  flush();
  return runs;
}
