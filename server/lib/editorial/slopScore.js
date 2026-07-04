/**
 * Deterministic slop-scoring primitives (#2165 — CWQE Phase 1) for the editorial
 * check registry. Pure and dependency-free (no side-effecting imports) so it
 * stays unit-testable in isolation — mirrors ./cliches.js / ./proseTics.js /
 * ./repetition.js, whose `tokenizeWords` / `splitSentences` / `measureSentenceRhythm`
 * it reuses rather than re-implementing.
 *
 * This module EXTENDS the existing anti-slop primitives — it deliberately does
 * NOT duplicate:
 *   - proseTics.js  — filter/hedge/crutch words, -ly adverbs, passive voice,
 *                      repeated gestures.
 *   - cliches.js    — stock similes/idioms, cumulative modifier stacking.
 *   - repetition.js — word echoes, repeated sentence openers, and sentence-
 *                      length coefficient of variation (`measureSentenceRhythm`,
 *                      consumed by the `prose.sentence-rhythm` check).
 *
 * It adds the LLM-generation-specific "slop" signals autonovel's dual-immune-
 * system design catches: a tiered banned-word list, fiction-specific AI-tell
 * phrasing, rhetorical structural tics, and quantitative burstiness signals
 * (em-dash density, transition-opener ratio, paragraph-length uniformity,
 * section-break count). `computeSlopPenalty()` composites all of the above
 * — PLUS the sentence-length CV already measured by repetition.js — into a
 * single 0–10 penalty for Phase 3's `qualityScore = judgeOverall − slopPenalty`.
 *
 * Dedupe note: sentence-length CV is read from `measureSentenceRhythm`
 * (repetition.js) INSIDE `computeSlopPenalty` only — it is deliberately NOT
 * re-exposed as its own registry-check finding here. `prose.sentence-rhythm`
 * already owns that finding/anchor; the `prose.burstiness` check below reports
 * the OTHER quantitative signals (em-dash density, transition-opener ratio,
 * paragraph-length uniformity) so the two checks never double-report the same
 * anchor.
 */

import { tokenizeWords, splitSentences } from './proseTics.js';
import { measureSentenceRhythm } from './repetition.js';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeWord(p) {
  return typeof p === 'string' ? p.trim().toLowerCase() : '';
}

function toWordSet(words) {
  return new Set((Array.isArray(words) ? words : []).map(normalizeWord).filter(Boolean));
}

// Build a case-insensitive matcher for a list of single/multi-word (and
// hyphenated) phrase entries — mirrors proseTics.js's buildListMatcher, but
// also tolerates a hyphen where the seed used a space or vice versa
// ("ever-evolving" / "ever evolving") since generated prose is inconsistent
// about which it uses.
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
  const alt = entries
    .sort((a, b) => b.length - a.length)
    .map((e) => escapeRegExp(e).replace(/[\s-]+/g, '[\\s-]+'))
    .join('|');
  return new RegExp(`(?<!\\w)(?:${alt})(?!\\w)`, 'gi');
}

// ---------------------------------------------------------------------------
// Tiered banned-word lists.
// ---------------------------------------------------------------------------

// Tier 1 — hard-ban. Overused LLM-generation vocabulary; PENALIZED PER HIT
// regardless of context. Curated, not exhaustive; extendable (extraWords) /
// mutable (allowWords) per house style, mirroring the other word lists in
// this directory.
export const TIER1_BANNED_WORDS = Object.freeze([
  'delve', 'delves', 'delved', 'delving',
  'tapestry', 'tapestries',
  'myriad',
  'plethora',
  'utilize', 'utilizes', 'utilized', 'utilizing', 'utilization',
  'leverage', 'leverages', 'leveraged', 'leveraging',
  'boasts', 'boasting',
  'testament',
  'underscore', 'underscores', 'underscored', 'underscoring',
  'multifaceted',
  'intricate', 'intricacies',
  'nuanced',
  'unprecedented',
  'ever-evolving',
  'game-changer',
  'cutting-edge',
  'in the realm of',
  'in the world of',
  'navigate the complexities of',
  'stands as a testament',
]);

// Tier 2 — suspicious. Common enough in ordinary prose that a lone occurrence
// is not a tell; only a CLUSTER of `clusterThreshold`+ within one paragraph
// reads as synthetic (findSuspiciousWordClusters below).
export const TIER2_SUSPICIOUS_WORDS = Object.freeze([
  'robust', 'seamless', 'seamlessly', 'pivotal', 'vibrant', 'profound',
  'resonate', 'resonates', 'resonated', 'resonating', 'resonance',
  'illuminate', 'illuminates', 'illuminated', 'illuminating',
  'embark', 'embarks', 'embarked', 'embarking',
  'foster', 'fosters', 'fostered', 'fostering',
  'bolster', 'bolsters', 'bolstered', 'bolstering',
  'palpable', 'poignant', 'visceral', 'evocative', 'ethereal',
]);

/**
 * Tier 1 hard-ban occurrences — one entry per match (every hit counts, unlike
 * the deduped cliché scanner, mirroring proseTics.js's density-scaled word
 * lists).
 * @param {string} text
 * @param {{ allowWords?: string[], extraWords?: string[] }} [opts]
 * @returns {Array<{ entry: string, index: number, anchor: string }>}
 */
export function findBannedWordsTier1(text, opts = {}) {
  if (typeof text !== 'string' || !text) return [];
  const matcher = buildListMatcher(TIER1_BANNED_WORDS, opts);
  if (!matcher) return [];
  const out = [];
  let m;
  while ((m = matcher.exec(text)) !== null) {
    out.push({ entry: m[0].toLowerCase().replace(/[\s-]+/g, ' '), index: m.index, anchor: m[0] });
  }
  return out;
}

/**
 * Paragraph splitter — mirrors dialogue.js's `findUnattributedDialogueRuns`
 * paragraph split (manuscript prose is stored one paragraph per line,
 * separated by blank lines): each non-blank line is one paragraph, with its
 * absolute character offset.
 * @param {string} text
 * @returns {Array<{ text: string, index: number }>}
 */
export function splitParagraphs(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  const re = /[^\n]+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].trim()) out.push({ text: m[0], index: m.index });
  }
  return out;
}

/**
 * Tier 2 suspicious-word CLUSTERS — one finding per paragraph carrying
 * `clusterThreshold`+ distinct-or-repeated Tier 2 hits. An isolated Tier 2
 * word elsewhere in the paragraph is not reported.
 * @param {string} text
 * @param {{ allowWords?: string[], extraWords?: string[], clusterThreshold?: number }} [opts]
 * @returns {Array<{ words: string[], count: number, index: number, anchor: string }>}
 */
export function findSuspiciousWordClusters(text, opts = {}) {
  if (typeof text !== 'string' || !text) return [];
  const clusterThreshold = Number.isInteger(opts.clusterThreshold) && opts.clusterThreshold > 0
    ? opts.clusterThreshold
    : 3;
  const matcher = buildListMatcher(TIER2_SUSPICIOUS_WORDS, opts);
  if (!matcher) return [];
  const paragraphs = splitParagraphs(text);
  const out = [];
  for (const p of paragraphs) {
    matcher.lastIndex = 0;
    const hits = [];
    let m;
    while ((m = matcher.exec(p.text)) !== null) {
      hits.push({ word: m[0].toLowerCase(), index: p.index + m.index, anchor: m[0] });
    }
    if (hits.length >= clusterThreshold) {
      out.push({
        words: hits.map((h) => h.word),
        count: hits.length,
        index: hits[0].index,
        anchor: hits.map((h) => h.anchor).join(', '),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fiction AI-tell regexes — recognizable idioms/constructions that recur
// across LLM-generated prose. One finding per DISTINCT pattern (first
// occurrence) — a recurring idiom is one tic to fix, not many, mirroring
// cliches.js's dedupe-to-first-occurrence philosophy.
// ---------------------------------------------------------------------------
export const AI_TELL_PATTERNS = Object.freeze([
  {
    id: 'sense-of',
    label: 'vague "a sense of X" telling',
    re: /\ba sense of\s+[a-z]+(?:\s+[a-z]+){0,2}/gi,
    suggestion: 'Replace the vague abstraction with a concrete, dramatized detail specific to this moment.',
  },
  {
    id: 'couldnt-help-but',
    label: '"couldn\'t help but" hedge-tell',
    // [''] accepts both the straight apostrophe and the curly one word
    // processors (Word/Scrivener/Google Docs) auto-substitute — manuscript
    // text is not guaranteed to be normalized upstream (see dialogue.js's
    // similar DQUOTE straight+curly handling for double quotes).
    re: /\bcould(?:n['’]?t| not) help but\b/gi,
    suggestion: 'Commit to the action directly — cut the hedge and just show the character doing it.',
  },
  {
    id: 'eyes-widened',
    label: '"eyes widened" stock reaction',
    re: /\beyes?\s+widened\b/gi,
    suggestion: 'Vary the physical reaction, or cut it and let the dialogue/context carry the surprise.',
  },
  {
    id: 'breath-didnt-know',
    label: '"let out a breath (s)he didn\'t know" idiom',
    re: /\blet out (?:a|the) breath\b[^.!?\n]{0,60}\b(?:holding|held)\b/gi,
    suggestion: 'This idiom is now a recognizable AI tic — cut it or write the release of tension in fresher terms.',
  },
  {
    id: 'wave-of-emotion',
    label: '"a wave of X washed over" idiom',
    re: /\ba wave of\s+[a-z]+\s+(?:washed|crashed|swept) over\b/gi,
    suggestion: 'Dramatize the feeling through action or dialogue instead of naming an abstract wave.',
  },
  {
    id: 'heart-pounded-chest',
    label: '"heart pounded in his/her chest" stock tell',
    re: /\bheart\s+(?:pounded|hammered|thudded|slammed|raced)\s+(?:in|against)\s+(?:his|her|their|my|its)\s+chest\b/gi,
    suggestion: 'The chest location is implied — cut it, or ground the physical sensation in something more specific.',
  },
  {
    id: 'physical-named-emotion',
    label: 'physical tell immediately re-labeled with the named emotion',
    re: /\b(?:heart\s+\w+ed|throat\s+(?:tightened|closed)|stomach\s+(?:knotted|dropped|twisted)|chest\s+tightened)\b[^.!?\n]{0,30}\b(?:with|from|in)\b[^.!?\n]{0,15}\b(?:fear|joy|excitement|sadness|anger|grief|dread|anxiety|panic|relief|happiness|nervousness)\b/gi,
    suggestion: 'Pick one — the physical detail already shows the feeling; naming the emotion on top of it is double-dipping (show, don\'t also tell).',
  },
]);

/**
 * Fiction AI-tell occurrences — one per distinct pattern id (first
 * occurrence), position-ordered.
 * @param {string} text
 * @param {{ allowPatterns?: string[] }} [opts] allowPatterns — pattern `id`s to mute.
 * @returns {Array<{ id: string, label: string, index: number, anchor: string, suggestion: string }>}
 */
export function findAiTells(text, opts = {}) {
  if (typeof text !== 'string' || !text) return [];
  const allow = new Set((Array.isArray(opts.allowPatterns) ? opts.allowPatterns : []).map(normalizeWord));
  const out = [];
  for (const pattern of AI_TELL_PATTERNS) {
    if (allow.has(pattern.id)) continue;
    pattern.re.lastIndex = 0;
    const m = pattern.re.exec(text);
    if (m) out.push({ id: pattern.id, label: pattern.label, index: m.index, anchor: m[0], suggestion: pattern.suggestion });
  }
  return out.sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// Structural tics — rhetorical constructions that recur across LLM-generated
// prose independent of vocabulary choice.
// ---------------------------------------------------------------------------

// Shared raw-occurrence floor for rate/density gates below (negative-assertion
// density here, em-dash density further down, and re-used by the registered
// `prose.burstiness` check's own em-dash finding in checks/slop.js). A pure
// rate check with no minimum count reads a SINGLE ordinary occurrence in a
// short section as "dense" purely because the section is short enough to push
// the rate over threshold (e.g. 1 em dash in 65 words = 15.4/1000, over the 15
// default) — caught in review. Requiring at least 2 raw hits before applying
// the rate threshold keeps a lone, unremarkable occurrence from ever qualifying.
export const MIN_DENSITY_OCCURRENCES = 2;

const NOT_JUST_BUT_RE = /\bnot\s+(?:just|only)\b[^.!?\n]{1,100}?\bbut\b(?:\s+also)?[^.!?\n]{1,100}?[.!?]/gi;
// [''] accepts both the straight apostrophe and the curly one word processors
// (Word/Scrivener/Google Docs) auto-substitute — manuscript text is not
// guaranteed to be normalized upstream (see dialogue.js's similar DQUOTE
// straight+curly handling for double quotes).
const NOT_SAYING_RE = /\bI['’]?m\s+not\s+saying\b[^.!?\n]{1,100}?\bI['’]?m\s+saying\b[^.!?\n]{1,100}?[.!?]/gi;
const NEGATIVE_ASSERTION_RE = /\b(?:did|does)\s+not\s+[a-z]+\b|\b(?:didn['’]?t|doesn['’]?t)\s+[a-z]+\b/gi;
const THE_WAY_RE = /\bthe\s+way\s+(?:[a-z']+\s+){1,4}?(?:[a-z]+(?:ed|ing)|did|does|would|had|has|was|were|is|are|could|can|might|should)\b/gi;

/**
 * "Not just X, but Y" rhetorical construction — the single most overused LLM
 * sentence pattern.
 * @param {string} text
 * @returns {Array<{ index: number, anchor: string }>}
 */
export function findNotJustButPatterns(text) {
  if (typeof text !== 'string' || !text) return [];
  NOT_JUST_BUT_RE.lastIndex = 0;
  const out = [];
  let m;
  while ((m = NOT_JUST_BUT_RE.exec(text)) !== null) {
    out.push({ index: m.index, anchor: m[0].trim() });
  }
  return out;
}

/**
 * "I'm not saying X, I'm saying Y" hedge-then-assert construction.
 * @param {string} text
 * @returns {Array<{ index: number, anchor: string }>}
 */
export function findNotSayingPatterns(text) {
  if (typeof text !== 'string' || !text) return [];
  NOT_SAYING_RE.lastIndex = 0;
  const out = [];
  let m;
  while ((m = NOT_SAYING_RE.exec(text)) !== null) {
    out.push({ index: m.index, anchor: m[0].trim() });
  }
  return out;
}

/**
 * "Did not [verb]" / "didn't [verb]" negative-assertion occurrences (raw —
 * density is the tic, not any single occurrence; callers scale by frequency).
 * @param {string} text
 * @returns {Array<{ index: number, anchor: string }>}
 */
export function findNegativeAssertions(text) {
  if (typeof text !== 'string' || !text) return [];
  NEGATIVE_ASSERTION_RE.lastIndex = 0;
  const out = [];
  let m;
  while ((m = NEGATIVE_ASSERTION_RE.exec(text)) !== null) {
    out.push({ index: m.index, anchor: m[0] });
  }
  return out;
}

/**
 * "The way [subject] [verb]" implicit-comparison construction ("the way her
 * voice cracked", "the way he carried himself") — overused as a substitute for
 * direct description.
 * @param {string} text
 * @returns {Array<{ index: number, anchor: string }>}
 */
export function findTheWaySimiles(text) {
  if (typeof text !== 'string' || !text) return [];
  THE_WAY_RE.lastIndex = 0;
  const out = [];
  let m;
  while ((m = THE_WAY_RE.exec(text)) !== null) {
    out.push({ index: m.index, anchor: m[0] });
  }
  return out;
}

function countSentenceWords(s) {
  return (s.match(/[A-Za-z][A-Za-z']*/g) || []).length;
}

/**
 * Runs of `minRun`+ consecutive very short sentences ("Fast. Precise.
 * Deadly.") — the punchy triadic-fragment rhythm LLM prose overuses.
 * @param {string} text
 * @param {{ maxWords?: number, minRun?: number }} [opts]
 *   maxWords — a sentence at/under this word count counts as "short" (default 4).
 *   minRun — consecutive short sentences before a run is flagged (default 3, min 3).
 * @returns {Array<{ index: number, anchor: string, count: number }>}
 */
export function findTriadicShortSentences(text, opts = {}) {
  const sentences = splitSentences(text);
  if (sentences.length < 3) return [];
  const maxWords = Number.isInteger(opts.maxWords) && opts.maxWords > 0 ? opts.maxWords : 4;
  const minRun = Math.max(3, Number.isInteger(opts.minRun) ? opts.minRun : 3);
  const out = [];
  let runStart = -1;
  let runCount = 0;
  const flush = (endIdx) => {
    if (runCount >= minRun && runStart >= 0) {
      out.push({
        index: sentences[runStart].index,
        anchor: sentences.slice(runStart, endIdx).map((s) => s.text).join(' '),
        count: runCount,
      });
    }
    runStart = -1;
    runCount = 0;
  };
  for (let i = 0; i < sentences.length; i += 1) {
    const wc = countSentenceWords(sentences[i].text);
    if (wc > 0 && wc <= maxWords) {
      if (runStart === -1) runStart = i;
      runCount += 1;
    } else {
      flush(i);
    }
  }
  flush(sentences.length);
  return out;
}

/**
 * Combined structural-tic scan — merges the four per-pattern detectors above,
 * plus a density-gated negative-assertion entry (only included when there are
 * at least `MIN_DENSITY_OCCURRENCES` raw hits AND the `did not [verb]` rate
 * crosses `negativeAssertionDensityPer1000` — the raw-count floor keeps a
 * single ordinary negation in a short section from reading as a "dense run"
 * just because the section is short enough to push its rate over the
 * threshold; that signal is a rate ACROSS repetition, not a per-hit tic).
 * Position-ordered.
 * @param {string} text
 * @param {{ maxWords?: number, minRun?: number, negativeAssertionDensityPer1000?: number }} [opts]
 * @returns {Array<{ type: string, index: number, anchor: string, count?: number, density?: number }>}
 */
export function findStructuralTics(text, opts = {}) {
  if (typeof text !== 'string' || !text) return [];
  const out = [
    ...findNotJustButPatterns(text).map((h) => ({ type: 'not-just-but', ...h })),
    ...findNotSayingPatterns(text).map((h) => ({ type: 'not-saying', ...h })),
    ...findTheWaySimiles(text).map((h) => ({ type: 'the-way-simile', ...h })),
    ...findTriadicShortSentences(text, opts).map((h) => ({ type: 'triadic-short-sentences', ...h })),
  ];
  const negAssertions = findNegativeAssertions(text);
  if (negAssertions.length >= MIN_DENSITY_OCCURRENCES) {
    const words = tokenizeWords(text).length;
    const density = words > 0 ? (negAssertions.length / words) * 1000 : 0;
    const threshold = typeof opts.negativeAssertionDensityPer1000 === 'number'
      ? opts.negativeAssertionDensityPer1000
      : 4;
    if (density >= threshold) {
      out.push({
        type: 'negative-assertion-density',
        index: negAssertions[0].index,
        anchor: negAssertions[0].anchor,
        count: negAssertions.length,
        density: Math.round(density * 10) / 10,
      });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// Quantitative / statistical burstiness signals.
// ---------------------------------------------------------------------------

/**
 * Em-dash density per 1000 words. AI-generated prose leans heavily on the em
 * dash as an all-purpose punctuation crutch; a genuinely varied human draft
 * rarely sustains a high rate across a whole passage.
 * @param {string} text
 * @returns {{ count: number, words: number, rate: number }}
 */
export function emDashDensityPer1000(text) {
  if (typeof text !== 'string' || !text) return { count: 0, words: 0, rate: 0 };
  const words = tokenizeWords(text).length;
  const count = (text.match(/—/g) || []).length;
  const rate = words > 0 ? Math.round((count / words) * 1000 * 10) / 10 : 0;
  return { count, words, rate };
}

// Seed transition-opener vocabulary — sentence-initial connective tissue that,
// overused, reads as an essay's signposting rather than fiction's momentum.
export const TRANSITION_OPENERS = Object.freeze([
  'however', 'moreover', 'furthermore', 'additionally', 'meanwhile',
  'nevertheless', 'nonetheless', 'consequently', 'ultimately', 'indeed',
  'thus', 'therefore', 'in fact', 'of course', 'naturally', 'as a result',
  'in addition', 'even so', 'all the same',
]);

/**
 * Fraction of sentences that open with a transition/connective word or
 * phrase. A steady drumbeat of "However, … Moreover, … Ultimately, …" reads
 * as essay signposting rather than fiction's momentum.
 * @param {string} text
 * @param {{ extraOpeners?: string[] }} [opts]
 * @returns {{ ratio: number, count: number, total: number, index: number|null, anchor: string }}
 */
export function transitionOpenerRatio(text, opts = {}) {
  const sentences = splitSentences(text);
  if (!sentences.length) return { ratio: 0, count: 0, total: 0, index: null, anchor: '' };
  const extra = (Array.isArray(opts.extraOpeners) ? opts.extraOpeners : []).map(normalizeWord).filter(Boolean);
  const openers = [...new Set([...TRANSITION_OPENERS, ...extra])].sort((a, b) => b.length - a.length);
  let count = 0;
  let index = null;
  let anchor = '';
  for (const s of sentences) {
    const lower = s.text.toLowerCase();
    const hit = openers.find((o) => lower.startsWith(o));
    if (hit) {
      count += 1;
      if (index === null) {
        index = s.index;
        anchor = s.text.slice(0, Math.min(s.text.length, hit.length + 20)).trim();
      }
    }
  }
  return { ratio: count / sentences.length, count, total: sentences.length, index, anchor };
}

/**
 * Runs of `minRun`+ consecutive paragraphs whose word counts stay within
 * `tolerance` of the previous paragraph — a mechanically uniform paragraph
 * cadence a human draft rarely sustains.
 * @param {string} text
 * @param {{ minRun?: number, tolerance?: number }} [opts]
 *   minRun — consecutive similar-length paragraphs before a run is flagged (default 3).
 *   tolerance — fractional difference allowed between consecutive paragraphs (default 0.15).
 * @returns {Array<{ index: number, anchor: string, count: number, avgWords: number }>}
 */
export function paragraphLengthUniformity(text, opts = {}) {
  const paragraphs = splitParagraphs(text);
  const minRun = Math.max(3, Number.isInteger(opts.minRun) ? opts.minRun : 3);
  const tolerance = typeof opts.tolerance === 'number' ? opts.tolerance : 0.15;
  if (paragraphs.length < minRun) return [];
  const lengths = paragraphs.map((p) => tokenizeWords(p.text).length);
  const out = [];
  let runStart = 0;
  for (let i = 1; i <= paragraphs.length; i += 1) {
    const prevLen = lengths[i - 1];
    const curLen = i < paragraphs.length ? lengths[i] : null;
    const withinTolerance = curLen !== null && prevLen > 0
      && Math.abs(curLen - prevLen) / prevLen <= tolerance;
    if (!withinTolerance) {
      const runLen = i - runStart;
      if (runLen >= minRun) {
        out.push({
          index: paragraphs[runStart].index,
          anchor: paragraphs[runStart].text.slice(0, 120),
          count: runLen,
          avgWords: Math.round(lengths.slice(runStart, i).reduce((a, b) => a + b, 0) / runLen),
        });
      }
      runStart = i;
    }
  }
  return out;
}

// Scene/section-break markers: a line that is ONLY a break glyph run
// ("***", "* * *", "---", "###", "~~~").
const SECTION_BREAK_LINE_RE = /^\s*(?:\*\s*\*\s*\*+|-{3,}|_{3,}|~{3,}|#{1,6})\s*$/;

/**
 * Count of scene/section-break marker lines in the text.
 * @param {string} text
 * @returns {number}
 */
export function countSectionBreaks(text) {
  if (typeof text !== 'string' || !text) return 0;
  return text.split('\n').filter((line) => SECTION_BREAK_LINE_RE.test(line)).length;
}

// ---------------------------------------------------------------------------
// Composite score.
// ---------------------------------------------------------------------------

// Documented, clamped weights for the composite 0–10 penalty. Each signal
// contributes an independently capped amount so no single detector can blow
// out the whole score; the final sum is clamped to [0, 10].
export const SLOP_PENALTY_WEIGHTS = Object.freeze({
  tier1PerHit: 0.5,
  tier1Cap: 4,
  tier2PerCluster: 0.4,
  tier2Cap: 2,
  aiTellPerHit: 0.4,
  aiTellCap: 3,
  structuralTicPerHit: 0.3,
  structuralTicCap: 2,
  emDashThresholdPer1000: 15,
  emDashPenalty: 1,
  lowSentenceCvThreshold: 0.3,
  lowSentenceCvPenalty: 1,
  transitionRatioThreshold: 0.3,
  highTransitionRatioPenalty: 0.75,
  paragraphUniformityPenalty: 0.75,
  sectionBreakThresholdPer1000: 8,
  sectionBreakPenalty: 0.5,
});

/**
 * Composite deterministic slop penalty (0–10, clamped) for `text`, combining
 * every detector above — including `countSectionBreaks` — PLUS the
 * sentence-length CV already measured by `measureSentenceRhythm`
 * (repetition.js) — read here for scoring only, never re-emitted as its own
 * finding (see the module doc comment's dedupe note).
 *
 * @param {string} text
 * @param {object} [opts] passed through to every underlying detector
 *   (allowWords/extraWords/allowPatterns/clusterThreshold/etc.), plus an
 *   optional `weights` object to override individual `SLOP_PENALTY_WEIGHTS`.
 * @returns {number} penalty in [0, 10]
 */
export function computeSlopPenalty(text, opts = {}) {
  if (typeof text !== 'string' || !text.trim()) return 0;
  const w = { ...SLOP_PENALTY_WEIGHTS, ...(opts.weights || {}) };
  let penalty = 0;

  penalty += Math.min(findBannedWordsTier1(text, opts).length * w.tier1PerHit, w.tier1Cap);
  penalty += Math.min(findSuspiciousWordClusters(text, opts).length * w.tier2PerCluster, w.tier2Cap);
  penalty += Math.min(findAiTells(text, opts).length * w.aiTellPerHit, w.aiTellCap);
  penalty += Math.min(findStructuralTics(text, opts).length * w.structuralTicPerHit, w.structuralTicCap);

  const emDash = emDashDensityPer1000(text);
  if (emDash.count >= MIN_DENSITY_OCCURRENCES && emDash.rate >= w.emDashThresholdPer1000) penalty += w.emDashPenalty;

  const rhythm = measureSentenceRhythm(text);
  if (rhythm && rhythm.cv < w.lowSentenceCvThreshold) penalty += w.lowSentenceCvPenalty;

  const transitions = transitionOpenerRatio(text, opts);
  if (transitions.total > 0 && transitions.ratio > w.transitionRatioThreshold) penalty += w.highTransitionRatioPenalty;

  if (paragraphLengthUniformity(text, opts).length > 0) penalty += w.paragraphUniformityPenalty;

  const words = tokenizeWords(text).length;
  const breaks = countSectionBreaks(text);
  const breakRate = words > 0 ? (breaks / words) * 1000 : 0;
  if (breaks > 0 && breakRate >= w.sectionBreakThresholdPer1000) penalty += w.sectionBreakPenalty;

  return Math.max(0, Math.min(10, Math.round(penalty * 100) / 100));
}
