// Pure, dependency-free helpers for the `naming.dissimilar-names` editorial
// check (#1291). Everything here operates on plain strings so it can be unit
// tested in isolation and reused by any check that needs to reason about how
// confusable two character names are. No imports — keeps the registry pure.

// Lowercased letters only ("O'Brien" → "obrien"), the canonical IDENTITY form.
// Used as a dedup/identity key across the editorial checks, so it must NOT strip
// articles — "the reader" and "a reader" are distinct identities. The similarity
// check compares on `comparisonName` (below) instead.
export const normalizeName = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

// Leading-article stripper for the *confusability* comparison only. A cast that
// uses epithet names ("THE CABARET SINGER", "THE CHAPTER SEVENTEEN READER") would
// otherwise read as 60+ names all starting with "the" — every pair sharing the
// first letter AND the 3-char opening, which on its own trips the 2-signal gate
// and floods the check. Comparing on the article-stripped form ("cabaret singer"
// / "chapter seventeen reader") judges the names readers actually disambiguate
// on. Only strips when something remains after the article (so a character
// literally named "The" still compares as "the").
const LEADING_ARTICLE_RE = /^(?:the|a|an)\s+/i;
export function stripLeadingArticle(s) {
  const str = String(s || '').trim();
  const stripped = str.replace(LEADING_ARTICLE_RE, '');
  return stripped.trim() ? stripped : str;
}

// Normalized form the similarity signals compare against: article-stripped, then
// reduced to lowercased letters. ("THE CABARET SINGER" → "cabaretsinger".)
export const comparisonName = (s) => normalizeName(stripLeadingArticle(s));

// The ordered vowel skeleton ("Rachel" → "ae"). Two names sharing this read as
// rhythmically similar even when the consonants differ (Blake / Jane → "ae").
export const vowelSkeleton = (s) => normalizeName(s).replace(/[^aeiou]/g, '');

// Classic Soundex phonetic key (e.g. "Smith"/"Smyth" → "S530"). A cheap stand-in
// for full double-metaphone that needs no dependency: two names with the same key
// sound alike enough to be confused when read aloud. Returns '' for input with no
// letters so a nameless entry never collides with another.
const SOUNDEX_CODES = {
  b: '1', f: '1', p: '1', v: '1',
  c: '2', g: '2', j: '2', k: '2', q: '2', s: '2', x: '2', z: '2',
  d: '3', t: '3',
  l: '4',
  m: '5', n: '5',
  r: '6',
};

export function soundex(s) {
  const letters = normalizeName(s);
  if (!letters) return '';
  const first = letters[0];
  let out = '';
  // Walk from the second letter, collapsing runs of the same digit. Per the
  // standard (NARA) algorithm: a vowel (or y) separates a run so two same-coded
  // consonants split by it both emit, while h and w are TRANSPARENT — they
  // neither emit nor break a run, so consonants separated only by h/w collapse to
  // one digit (e.g. "Ashcraft" → A261, the s/c pair split by h stays a single 2).
  // The first letter's own code is dropped but seeds `prev` so an immediately
  // following same-coded consonant collapses into it.
  let prev = SOUNDEX_CODES[first];
  for (let i = 1; i < letters.length && out.length < 3; i += 1) {
    const ch = letters[i];
    const code = SOUNDEX_CODES[ch];
    if (code !== undefined) {
      if (code !== prev) out += code;
      prev = code;
    } else if (ch !== 'h' && ch !== 'w') {
      prev = undefined; // vowel or y — separator
    }
    // h / w: transparent — leave `prev` unchanged
  }
  return (first + out).padEnd(4, '0').toUpperCase();
}

// Levenshtein edit distance — the minimum single-character insert/delete/substitute
// edits to turn `a` into `b`. Operates on the normalized forms so casing and
// punctuation don't inflate the distance. O(min(a,b)) space.
export function levenshtein(a, b) {
  const s = normalizeName(a);
  const t = normalizeName(b);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  let curr = new Array(t.length + 1);
  for (let i = 1; i <= s.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[t.length];
}

// Default thresholds for `nameSimilaritySignals` — mirrored by the registry
// check's configSchema defaults so the helper is usable standalone with sensible
// behavior and the UI knobs map 1:1 onto these option keys.
export const DEFAULT_SIGNAL_OPTS = Object.freeze({
  minEditDistance: 1, // flag pairs within this Levenshtein distance (0 disables)
  flagSameLength: true,
  vowelSkeletonCollision: true,
  usePhonetic: true,
});

// Analyze a name pair in a single pass: the confusability `signals` (each one a
// reason a reader could blur the two on the page) plus the two metrics that also
// drive the check's severity — the Levenshtein `distance` and whether the names
// share a `phoneticMatch`. Computing them here once lets the caller score severity
// without re-running soundex/levenshtein. Returns empty/Infinity/false when either
// name has no letters or the two normalize equal.
export function analyzeNamePair(a, b, opts = {}) {
  const { minEditDistance, flagSameLength, vowelSkeletonCollision, usePhonetic } = {
    ...DEFAULT_SIGNAL_OPTS,
    ...opts,
  };
  // Compare on the article-stripped form so epithet casts ("THE …") don't all
  // collide on their leading article (see comparisonName).
  const la = comparisonName(a);
  const lb = comparisonName(b);
  if (!la || !lb || la === lb) return { signals: [], distance: Infinity, phoneticMatch: false };
  const signals = [];
  // "same opening" (first 3 chars) STRICTLY IMPLIES "same first letter", so
  // counting both double-counts one similarity: any shared 3-char prefix would
  // alone reach the default 2-signal gate. Emit the more specific signal when it
  // applies, otherwise fall back to the first-letter signal — never both.
  const sameOpening = la.length >= 3 && lb.length >= 3 && la.slice(0, 3) === lb.slice(0, 3);
  if (sameOpening) signals.push('same opening');
  else if (la[0] === lb[0]) signals.push('same first letter');
  if (flagSameLength && la.length === lb.length) signals.push('same length');
  if (vowelSkeletonCollision) {
    const vsa = vowelSkeleton(la);
    if (vsa && vsa === vowelSkeleton(lb)) signals.push('same vowel pattern');
  }
  if (la.length >= 2 && la.slice(-2) === lb.slice(-2)) signals.push('same ending');
  const distance = levenshtein(la, lb);
  if (minEditDistance > 0 && distance <= minEditDistance) {
    signals.push(`near-identical spelling (edit distance ${distance})`);
  }
  const ka = usePhonetic ? soundex(la) : '';
  const phoneticMatch = ka !== '' && ka === soundex(lb);
  if (phoneticMatch) signals.push('same phonetic key');
  return { signals, distance, phoneticMatch };
}

// The confusability signal list for a name pair — the `signals` view of
// analyzeNamePair, for callers (and tests) that only need the reasons.
export const nameSimilaritySignals = (a, b, opts = {}) => analyzeNamePair(a, b, opts).signals;

// A first-letter histogram over a list of names: Map<letter, name[]> keyed by the
// lowercased first letter of the article-stripped name (entries with no letters
// are skipped). The check uses this to spot first-letter crowding — a cast where
// many names start the same way. Keying on the article-stripped form keeps an
// epithet cast ("THE CABARET SINGER", "THE CHAPTER SEVENTEEN READER") from all
// crowding under "T" on their shared leading article.
export function firstLetterHistogram(names) {
  const hist = new Map();
  for (const name of names) {
    const norm = comparisonName(name);
    if (!norm) continue;
    const letter = norm[0];
    if (!hist.has(letter)) hist.set(letter, []);
    hist.get(letter).push(name);
  }
  return hist;
}

// First-letter clusters worth flagging: letters shared by at least `minCount`
// names AND by at least `maxRatio` of the cast. Returns [{ letter, names, ratio }]
// sorted densest-first so the worst crowding surfaces as the first finding.
export function findFirstLetterClusters(names, { minCount = 3, maxRatio = 0.4 } = {}) {
  const total = names.filter((n) => comparisonName(n)).length;
  if (!total) return [];
  const clusters = [];
  for (const [letter, group] of firstLetterHistogram(names)) {
    const ratio = group.length / total;
    if (group.length >= minCount && ratio >= maxRatio) {
      clusters.push({ letter, names: group, ratio });
    }
  }
  return clusters.sort((x, y) => y.ratio - x.ratio || y.names.length - x.names.length);
}
