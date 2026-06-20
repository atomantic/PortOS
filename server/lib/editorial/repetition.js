/**
 * Word-echo & sentence-rhythm deterministic primitives (#1306) for the editorial
 * check registry. Pure and dependency-free — mirrors ./proseTics.js, whose
 * `tokenizeWords` / `splitSentences` it reuses.
 *
 * Scanners backing the deterministic copy-edit checks:
 *   - findWordEchoes()      → `prose.word-echoes`     (distinctive word repeated in a window)
 *   - findRepeatedOpeners() → `prose.repeated-openers` (sentences starting the same word)
 *   - measureSentenceRhythm() → `prose.sentence-rhythm` (monotonous sentence length)
 */

import { tokenizeWords, splitSentences } from './proseTics.js';

// The most common English words — never an "echo" worth flagging when repeated.
// A repeated "the"/"and" is invisible; a repeated "obsidian" three sentences
// apart is the tic. Lowercase.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'nor', 'for', 'so', 'yet', 'of', 'to',
  'in', 'on', 'at', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'am', 'it', 'its', 'he', 'she', 'they', 'them', 'his', 'her',
  'their', 'him', 'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'this',
  'that', 'these', 'those', 'there', 'here', 'with', 'from', 'into', 'onto',
  'out', 'up', 'down', 'off', 'over', 'then', 'than', 'not', 'no', 'do',
  'does', 'did', 'has', 'have', 'had', 'will', 'would', 'can', 'could',
  'should', 'shall', 'may', 'might', 'must', 'if', 'when', 'while', 'all',
  'one', 'who', 'what', 'which', 'how', 'why', 'where', 'about', 'just', 'very',
  'some', 'any', 'each', 'both', 'more', 'most', 'such', 'only', 'own', 'too',
  'now', 'said', 'like', 'back', 'get', 'got',
]);

const isEchoCandidate = (lower) => lower.length >= 5 && !STOPWORDS.has(lower);

/**
 * Distinctive words repeated within a window of `windowWords` tokens. Returns
 * one finding per repeated word (the SECOND occurrence — the echo — anchored),
 * deduped per word so a word echoed five times reports once. Position-ordered.
 *
 * @param {string} text
 * @param {{ windowWords?: number, minLen?: number }} [opts]
 *   windowWords — how close two occurrences must be to count as an echo (default 50).
 *   minLen — minimum word length to consider (default 5).
 * @returns {Array<{ word: string, index: number, anchor: string, gap: number }>}
 */
export function findWordEchoes(text, opts = {}) {
  const tokens = tokenizeWords(text);
  if (!tokens.length) return [];
  const windowWords = Number.isInteger(opts.windowWords) && opts.windowWords > 0 ? opts.windowWords : 50;
  const minLen = Number.isInteger(opts.minLen) && opts.minLen > 0 ? opts.minLen : 5;
  const lastSeen = new Map(); // lower → token-position index
  const reported = new Set();
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const { lower } = tokens[i];
    if (lower.length < minLen || STOPWORDS.has(lower)) { lastSeen.set(lower, i); continue; }
    if (lastSeen.has(lower)) {
      const gap = i - lastSeen.get(lower);
      if (gap <= windowWords && !reported.has(lower)) {
        reported.add(lower);
        out.push({ word: tokens[i].word, index: tokens[i].index, anchor: tokens[i].word, gap });
      }
    }
    lastSeen.set(lower, i);
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * Runs of consecutive sentences that open with the same word ("He… He… He…").
 * Returns one finding per run of `minRun`+ sentences sharing an opener.
 *
 * @param {string} text
 * @param {{ minRun?: number }} [opts] minRun — sentences in a row to flag (default 3, min 2).
 * @returns {Array<{ word: string, index: number, anchor: string, count: number }>}
 */
export function findRepeatedOpeners(text, opts = {}) {
  const sentences = splitSentences(text);
  if (sentences.length < 2) return [];
  const minRun = Math.max(2, Number.isInteger(opts.minRun) ? opts.minRun : 3);
  // The opening word of each sentence (lowercased) + its offset.
  const openers = sentences.map((s) => {
    const m = /[A-Za-z][A-Za-z']*/.exec(s.text);
    return { word: m ? m[0] : '', lower: m ? m[0].toLowerCase() : '', index: s.index };
  });
  const out = [];
  let runStart = 0;
  for (let i = 1; i <= openers.length; i += 1) {
    const same = i < openers.length && openers[i].lower && openers[i].lower === openers[runStart].lower;
    if (!same) {
      const count = i - runStart;
      if (count >= minRun && openers[runStart].lower) {
        out.push({
          word: openers[runStart].word,
          index: openers[runStart].index,
          anchor: openers[runStart].word,
          count,
        });
      }
      runStart = i;
    }
  }
  return out;
}

/**
 * Sentence-rhythm measure over a passage. Computes per-sentence word counts and
 * their coefficient of variation (stddev / mean). A LOW coefficient means the
 * sentences are all about the same length — monotonous rhythm. Returns null when
 * there aren't enough sentences to judge.
 *
 * @param {string} text
 * @param {{ minSentences?: number }} [opts] minSentences — floor before judging (default 5).
 * @returns {{ count: number, mean: number, stddev: number, cv: number, lengths: number[] } | null}
 */
export function measureSentenceRhythm(text, opts = {}) {
  const sentences = splitSentences(text);
  const minSentences = Number.isInteger(opts.minSentences) && opts.minSentences > 1 ? opts.minSentences : 5;
  if (sentences.length < minSentences) return null;
  const lengths = sentences.map((s) => (s.text.match(/[A-Za-z][A-Za-z']*/g) || []).length);
  const count = lengths.length;
  const mean = lengths.reduce((a, b) => a + b, 0) / count;
  if (mean <= 0) return null;
  const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / count;
  const stddev = Math.sqrt(variance);
  return { count, mean, stddev, cv: stddev / mean, lengths };
}
