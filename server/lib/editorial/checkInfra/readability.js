/**
 * Deterministic reading-level helpers for the style-guide conformance check
 * (#1303) (#2842 split of checkInfra.js).
 */

import { splitScenes } from './externals.js';

// ---------------------------------------------------------------------------
// Deterministic helpers for the style-guide reading-level check (#1303). A
// self-contained Flesch–Kincaid grade-level estimate so the registry stays pure
// (no import out to the styleGuide lib). The heuristic is approximate — it only
// needs to catch "the prose reads several grades off the configured target".
// ---------------------------------------------------------------------------

// Hoisted out of countSyllables so the per-word loop over a full manuscript
// doesn't recompile them on every call.
const NON_ALPHA_RE = /[^a-z]/g;
const VOWEL_GROUP_RE = /[aeiouy]+/g;
const SENTENCE_END_RE = /[.!?]+/g;
const WORD_RE = /\b[a-zA-Z]+\b/g;

function countSyllables(word) {
  const w = String(word).toLowerCase().replace(NON_ALPHA_RE, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  // Drop a trailing silent 'e', then count vowel groups (each run of vowels is
  // ~one syllable). Floor at 1 — every real word has at least one.
  const groups = w.replace(/e$/, '').match(VOWEL_GROUP_RE);
  return Math.max(1, groups ? groups.length : 1);
}

// Flesch–Kincaid grade level for a manuscript corpus. Returns null when there
// are no words to measure (caller skips rather than flagging a phantom grade).
export function readingGradeLevel(text) {
  const clean = String(text || '');
  const sentences = (clean.match(SENTENCE_END_RE) || []).length || 1;
  const words = clean.match(WORD_RE) || [];
  if (words.length === 0) return null;
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  return 0.39 * (words.length / sentences) + 11.8 * (syllables / words.length) - 15.59;
}

// Per-scene reading-grade spread (#1625). The whole-corpus grade above is a single
// number for the entire series — it averages away the legitimate modulation a
// skilled writer uses (a quiet introspective scene reads lower, an action scene
// higher) AND it hides a lone scene that swings far outside the intended band.
// Splits the manuscript into scenes via the shared `splitScenes` (markdown
// headings — including the stitcher's `# Issue N` — and centered rules like
// "***") and measures each one, so the check can surface the outliers the corpus
// average conceals. Scenes shorter than `minWords` are skipped: a brief fragment's
// FK estimate is too noisy to judge. Returns one row per measurable scene
// (`{ ordinal, grade, words, text }`), or [] when none qualify.
export function readingLevelByScene(manuscript, minWords) {
  const floor = Number.isFinite(minWords) ? minWords : 120;
  const rows = [];
  for (const scene of splitScenes(String(manuscript || ''))) {
    const words = (scene.text.match(WORD_RE) || []).length;
    if (words < floor) continue;
    const grade = readingGradeLevel(scene.text);
    if (grade == null) continue;
    rows.push({ ordinal: scene.ordinal, grade: Math.round(grade * 10) / 10, words, text: scene.text });
  }
  return rows;
}

// First substantive line of a scene, trimmed to a short anchor so a per-scene
// finding lands on real prose the editor can locate. Skips blank lines; falls
// back to '' for a whitespace-only scene.
export function sceneReadingAnchor(text) {
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (t) return t.length > 80 ? `${t.slice(0, 80).trim()}…` : t;
  }
  return '';
}

// Compact bullet list of the conformance-relevant style-guide expectations, fed
// to the conformance LLM so it knows exactly what to measure the prose against.
// Inlined (not imported from styleGuide.js) to keep this registry pure. Returns
// '' when no conformance-relevant field is set (the check's gate also tests this).
export function styleGuideExpectations(sg) {
  if (!sg || typeof sg !== 'object') return '';
  const lines = [];
  if (sg.tense) lines.push(`- Tense: ${sg.tense}`);
  if (sg.povPerson) lines.push(`- Point-of-view person: ${sg.povPerson}`);
  if (sg.targetAudience) lines.push(`- Target audience: ${sg.targetAudience}`);
  if (sg.contentRating && sg.contentRating !== 'custom') lines.push(`- Content rating ceiling: ${sg.contentRating}`);
  if (sg.profanity) lines.push(`- Profanity allowed: ${sg.profanity}`);
  return lines.join('\n');
}

// True when the style guide carries at least one field the conformance LLM can
// measure prose against. Shared by the check's gate and run so they agree.
export const hasConformanceFields = (sg) => styleGuideExpectations(sg).length > 0;

