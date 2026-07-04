/**
 * Statistical voice fingerprint (#2166 — CWQE Phase 2) for the editorial check
 * registry. Pure and dependency-free (no side-effecting imports — only the
 * sibling editorial primitives) so it stays unit-testable in isolation, mirroring
 * ./slopScore.js / ./repetition.js / ./proseTics.js.
 *
 * This is the cheap DETERMINISTIC complement to the LLM `style.voice-consistency`
 * check (checks/proseStyle.js — subjective narrator tone). Where that check ASKS a
 * model whether the tone wobbled, this one MEASURES a fixed metric vector per issue
 * (sentence rhythm, fragment/long-sentence rates, paragraph shape, dialogue ratio,
 * em-dash rate, abstract-noun/simile density, dominant opener, optional vocabulary
 * "wells"), computes the series-wide mean/σ per metric, and names exactly which
 * issue drifted, on which metric, and in which direction. autonovel used this to
 * catch chapters whose sentence rhythm or vocabulary register silently diverged
 * from the established series voice.
 *
 * Reuses (never re-implements) the shared tokenizers: `tokenizeWords` /
 * `splitSentences` from ./proseTics.js and `splitParagraphs` /
 * `emDashDensityPer1000` from ./slopScore.js — so a fingerprint counts words and
 * segments sentences/paragraphs exactly the way every other deterministic check
 * does.
 */

import { tokenizeWords, splitSentences } from './proseTics.js';
import { splitParagraphs, emDashDensityPer1000 } from './slopScore.js';

// Word suffixes that mark an abstract / nominalized noun. Overusing them ("the
// realization of the situation") is the register signal a drifting issue shifts
// on. A coarse suffix heuristic (no POS tagger) — advisory, like every editorial
// deterministic check. Guarded by a minimum stem length below so short words
// (e.g. "ship", "dom", "ity") don't false-match.
const ABSTRACT_NOUN_SUFFIXES = Object.freeze([
  'tion', 'sion', 'ment', 'ness', 'ity', 'ance', 'ence', 'ism',
  'ship', 'hood', 'dom', 'acy', 'ude', 'ology',
]);
// A stem must have at least this many letters BEFORE the suffix, so "action" and
// "nation" count (real abstract nouns) but "dom"/"ship"/"tion" as whole short
// words don't.
const ABSTRACT_MIN_STEM = 2;

// Simile markers: an explicit "like a/an/the …" comparison, or an "as ADJ as …"
// frame. Deliberately narrow — bare "like" (a filler/verb) and bare "as" (a
// conjunction) are NOT counted, only these two comparison frames — so the density
// tracks figurative reach, not filler.
const SIMILE_LIKE_RE = /\blike\s+(?:a|an|the)\b/gi;
const SIMILE_AS_AS_RE = /\bas\s+[A-Za-z]+\s+as\b/gi;
// Any run of characters inside straight or curly double-quotes — the dialogue
// span. Non-greedy so adjacent quoted lines stay separate.
const DIALOGUE_SPAN_RE = /[“"]([^“”"]*)[”"]/g;

const round2 = (n) => Math.round(n * 100) / 100;
const round1 = (n) => Math.round(n * 10) / 10;

// Population mean / std (divide by N, not N−1): the issues ARE the whole series
// population, not a sample of a larger one, so σ is the population deviation.
function meanOf(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
function stdOf(values, mean) {
  if (values.length < 2) return 0;
  const m = typeof mean === 'number' ? mean : meanOf(values);
  const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * The fixed metric vector every issue is fingerprinted on. Order here IS the
 * column order of `voiceFingerprintMatrix`. Each descriptor carries a `label`
 * (human name), a `unit` suffix for rendered values, and a `higher` phrase
 * describing what a high value MEANS (its opposite is auto-derived), so a drift
 * finding can read "prose has gone metronomic" instead of "cv is low".
 *
 * `wells` metrics are appended dynamically at compute time (one `well:<name>` per
 * configured vocabulary well) — they are not part of this static list.
 */
export const VOICE_METRICS = Object.freeze([
  { key: 'sentenceLenMean', label: 'sentence-length mean', unit: ' words', higher: 'longer sentences', lower: 'shorter sentences' },
  { key: 'sentenceLenStd', label: 'sentence-length spread (σ)', unit: ' words', higher: 'more varied sentence lengths', lower: 'more uniform sentence lengths' },
  { key: 'sentenceLenCV', label: 'sentence-length variation (CV)', unit: '', higher: 'more rhythmic variety', lower: 'metronomic, same-length prose' },
  { key: 'fragmentPct', label: 'fragment rate (< 5 words)', unit: '%', higher: 'more sentence fragments', lower: 'fewer sentence fragments' },
  { key: 'longSentencePct', label: 'long-sentence rate (> 30 words)', unit: '%', higher: 'more long, winding sentences', lower: 'fewer long sentences' },
  { key: 'paragraphLenMean', label: 'paragraph-length mean', unit: ' words', higher: 'longer paragraphs', lower: 'shorter paragraphs' },
  { key: 'paragraphLenStd', label: 'paragraph-length spread (σ)', unit: ' words', higher: 'more varied paragraph lengths', lower: 'more uniform paragraph lengths' },
  { key: 'dialogueRatio', label: 'dialogue ratio', unit: '%', higher: 'more dialogue-driven prose', lower: 'more narration-driven prose' },
  { key: 'emDashRate', label: 'em-dash rate (per 1k words)', unit: '', higher: 'heavier em-dash use', lower: 'lighter em-dash use' },
  { key: 'abstractNounDensity', label: 'abstract-noun density (per 1k words)', unit: '', higher: 'a more abstract, nominal register', lower: 'a more concrete register' },
  { key: 'simileDensity', label: 'simile density (per 1k words)', unit: '', higher: 'more figurative comparison', lower: 'less figurative comparison' },
  { key: 'dominantOpenerPct', label: 'dominant sentence-opener share', unit: '%', higher: 'sentences that mostly open the same way', lower: 'more varied sentence openings' },
]);

const STATIC_METRIC_KEYS = Object.freeze(VOICE_METRICS.map((m) => m.key));

/**
 * Parse a vocabulary-wells spec into `[{ name, words: Set<string> }]`. The spec
 * is a per-check-config string (series-configurable via the per-series check
 * override) declaring register categories a series wants coverage tracked for:
 *
 *   `trade: forge, anvil, temper; body: pulse, sinew, marrow`
 *
 * Categories are `;`-separated, `name: words` split on the first `:`, words
 * `,`-separated (whitespace tolerated). Empty/malformed fragments are skipped
 * (never throws) so a hand-typed spec can't break the check. Returns [] for a
 * blank/absent spec.
 *
 * @param {string} spec
 * @returns {Array<{ name: string, words: Set<string> }>}
 */
export function parseVoiceWells(spec) {
  if (typeof spec !== 'string' || !spec.trim()) return [];
  const out = [];
  const seen = new Set();
  for (const chunk of spec.split(';')) {
    const colon = chunk.indexOf(':');
    if (colon === -1) continue;
    const name = chunk.slice(0, colon).trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    const words = chunk
      .slice(colon + 1)
      .split(',')
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean);
    if (!words.length) continue;
    seen.add(name);
    out.push({ name, words: new Set(words) });
  }
  return out;
}

// Count of tokens (word objects from tokenizeWords) whose lowercase form is in
// the well's set — the raw hit count, turned into a per-1k density below.
function wellHits(tokens, well) {
  let n = 0;
  for (const t of tokens) if (well.words.has(t.lower)) n += 1;
  return n;
}

/**
 * The prose fingerprint of a single block of text — the metric vector for one
 * issue. Pure. Returns `{ words, sentences, paragraphs, metrics: { key: number } }`
 * where `metrics` carries every `VOICE_METRICS` key plus one `well:<name>` per
 * configured well. An empty/near-empty block yields a fingerprint whose metrics
 * are all 0 (never NaN), so a matrix row is always numeric.
 *
 * @param {string} text
 * @param {{ wells?: Array<{ name: string, words: Set<string> }> }} [opts]
 */
export function computeFingerprint(text, opts = {}) {
  const src = typeof text === 'string' ? text : '';
  const wells = Array.isArray(opts.wells) ? opts.wells : [];
  const tokens = tokenizeWords(src);
  const totalWords = tokens.length;
  const sentences = splitSentences(src);
  const paragraphs = splitParagraphs(src);

  // Sentence-length metrics (words per sentence via the shared word tokenizer, so
  // "the cat's" counts identically to every other check).
  const sentenceLengths = sentences.map((s) => tokenizeWords(s.text).length);
  const sMean = meanOf(sentenceLengths);
  const sStd = stdOf(sentenceLengths, sMean);
  const sCount = sentenceLengths.length;
  const fragmentPct = sCount ? (sentenceLengths.filter((n) => n > 0 && n < 5).length / sCount) * 100 : 0;
  const longPct = sCount ? (sentenceLengths.filter((n) => n > 30).length / sCount) * 100 : 0;

  // Paragraph-length metrics (words per paragraph).
  const paragraphLengths = paragraphs.map((p) => tokenizeWords(p.text).length);
  const pMean = meanOf(paragraphLengths);
  const pStd = stdOf(paragraphLengths, pMean);

  // Dialogue ratio: fraction of words that fall inside double-quoted spans.
  let dialogueWords = 0;
  let m;
  DIALOGUE_SPAN_RE.lastIndex = 0;
  while ((m = DIALOGUE_SPAN_RE.exec(src)) !== null) {
    dialogueWords += tokenizeWords(m[1]).length;
  }
  const dialogueRatio = totalWords ? (dialogueWords / totalWords) * 100 : 0;

  const emDashRate = emDashDensityPer1000(src).rate;

  // Abstract-noun density per 1k words (suffix heuristic + min-stem guard).
  let abstractHits = 0;
  for (const t of tokens) {
    const w = t.lower;
    for (const suf of ABSTRACT_NOUN_SUFFIXES) {
      if (w.length >= suf.length + ABSTRACT_MIN_STEM && w.endsWith(suf)) { abstractHits += 1; break; }
    }
  }
  const abstractNounDensity = totalWords ? round1((abstractHits / totalWords) * 1000) : 0;

  // Simile density per 1k words (the two comparison frames).
  const simileHits = (src.match(SIMILE_LIKE_RE) || []).length + (src.match(SIMILE_AS_AS_RE) || []).length;
  const simileDensity = totalWords ? round1((simileHits / totalWords) * 1000) : 0;

  // Dominant sentence-opener share: the most common sentence-initial word, as a
  // fraction of sentences. High = every sentence opens the same way ("He … He …").
  const openerCounts = new Map();
  for (const s of sentences) {
    const first = tokenizeWords(s.text)[0];
    if (!first) continue;
    const key = first.lower;
    openerCounts.set(key, (openerCounts.get(key) || 0) + 1);
  }
  let dominantOpener = 0;
  for (const c of openerCounts.values()) if (c > dominantOpener) dominantOpener = c;
  const dominantOpenerPct = sCount ? (dominantOpener / sCount) * 100 : 0;

  const metrics = {
    sentenceLenMean: round2(sMean),
    sentenceLenStd: round2(sStd),
    sentenceLenCV: sMean > 0 ? round2(sStd / sMean) : 0,
    fragmentPct: round1(fragmentPct),
    longSentencePct: round1(longPct),
    paragraphLenMean: round2(pMean),
    paragraphLenStd: round2(pStd),
    dialogueRatio: round1(dialogueRatio),
    emDashRate,
    abstractNounDensity,
    simileDensity,
    dominantOpenerPct: round1(dominantOpenerPct),
  };

  // Optional vocabulary wells — coverage per 1k words per configured category.
  for (const well of wells) {
    metrics[`well:${well.name}`] = totalWords ? round1((wellHits(tokens, well) / totalWords) * 1000) : 0;
  }

  return { words: totalWords, sentences: sCount, paragraphs: paragraphLengths.length, metrics };
}

// Split the stitched manuscript into per-issue text blocks on the `# Issue N`
// headers the manuscript stitcher emits (the same header shape
// `conflictIntensityTally` in checkInfra.js keys on). Duplicate issue numbers (a
// chunk boundary that repeats a header) accumulate into ONE block so an issue
// isn't split into two thin, noisy fingerprints. Returns [] when there are no
// headers (the drift check then gates off — a single unlabelled blob can't drift
// against itself).
const ISSUE_HEADER_RE = /^#+\s*Issue\s+(\d+)\b[^\n]*$/gim;
export function splitManuscriptByIssue(manuscript) {
  const text = typeof manuscript === 'string' ? manuscript : '';
  if (!text.trim()) return [];
  const marks = [];
  let match;
  ISSUE_HEADER_RE.lastIndex = 0;
  while ((match = ISSUE_HEADER_RE.exec(text)) !== null) {
    // `headerStart` = where the `# Issue N` line begins (so the PREVIOUS issue's
    // body ends before it); `bodyStart` = just after the header line.
    marks.push({ issue: Number(match[1]), headerStart: match.index, bodyStart: ISSUE_HEADER_RE.lastIndex });
  }
  if (!marks.length) return [];
  const byIssue = new Map();
  for (let i = 0; i < marks.length; i += 1) {
    const bodyEnd = i + 1 < marks.length ? marks[i + 1].headerStart : text.length;
    const body = text.slice(marks[i].bodyStart, bodyEnd);
    byIssue.set(marks[i].issue, (byIssue.get(marks[i].issue) || '') + body);
  }
  return [...byIssue.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([issue, body]) => ({ issue, text: body }));
}

/**
 * Fingerprint every issue in a stitched manuscript. Returns
 * `{ issues: [{ issue, words, sentences, metrics }], metricKeys, wells }` sorted
 * by issue number. `metricKeys` is the full ordered key list (static metrics then
 * `well:*`), so the UI/table renders a stable column order. Pure.
 *
 * @param {string} manuscript
 * @param {{ wells?: Array<{ name: string, words: Set<string> }> }} [opts]
 */
export function voiceFingerprintMatrix(manuscript, opts = {}) {
  const wells = Array.isArray(opts.wells) ? opts.wells : [];
  const blocks = splitManuscriptByIssue(manuscript);
  const issues = blocks.map(({ issue, text }) => {
    const fp = computeFingerprint(text, { wells });
    return { issue, words: fp.words, sentences: fp.sentences, metrics: fp.metrics };
  });
  const metricKeys = [...STATIC_METRIC_KEYS, ...wells.map((w) => `well:${w.name}`)];
  return { issues, metricKeys, wells: wells.map((w) => w.name) };
}

// Human label for a metric key (static descriptor label, or the well name).
export function metricLabel(key) {
  if (typeof key === 'string' && key.startsWith('well:')) {
    return `"${key.slice(5)}" vocabulary (per 1k words)`;
  }
  const desc = VOICE_METRICS.find((mm) => mm.key === key);
  return desc ? desc.label : key;
}

// Directional phrase for a drift: what a value ABOVE / BELOW the series mean means
// for this metric. Wells share a generic phrasing (no static descriptor).
function directionPhrase(key, direction) {
  if (typeof key === 'string' && key.startsWith('well:')) {
    return direction === 'high'
      ? `leans harder on the "${key.slice(5)}" register`
      : `uses the "${key.slice(5)}" register less`;
  }
  const desc = VOICE_METRICS.find((mm) => mm.key === key);
  if (!desc) return direction === 'high' ? 'runs high' : 'runs low';
  return direction === 'high' ? desc.higher : desc.lower;
}

// One-sentence finding text for a drift outlier — names the issue, the metric,
// the issue value vs the series mean, the σ distance, and the plain-language
// direction ("prose has gone metronomic").
export function describeDrift(o) {
  const label = metricLabel(o.metricKey);
  const dir = directionPhrase(o.metricKey, o.direction);
  const val = `${o.value}${o.unit || ''}`;
  const mean = `${round2(o.mean)}${o.unit || ''}`;
  return `Issue ${o.issue}'s ${label} is ${val} vs the series mean of ${mean} `
    + `(${o.z.toFixed(1)}σ ${o.direction === 'high' ? 'above' : 'below'}) — ${dir}. `
    + 'A statistical outlier against the series voice; confirm it is an earned modulation, not drift.';
}

/**
 * Compute the voice-drift outliers for a stitched manuscript. Pure — returns
 * structured results the `style.voice-drift` check maps to editorial findings (so
 * the severity/config policy lives in the check, not here).
 *
 * Small-N gate: with fewer than `minIssues` issues drafted, σ is meaningless
 * (a two-point "series" always shows each point as ±1σ), so the check gates OFF
 * and emits nothing — `{ gatedOff: true, issueCount, outliers: [] }`.
 *
 * For each metric, a series mean/σ is computed across issues; a metric whose σ is
 * ~0 (every issue identical) is skipped — no drift is possible. An issue is an
 * outlier on a metric when its value is more than `threshold`·σ from the mean.
 * Outliers are sorted by |z| descending so the most significant drift survives a
 * downstream `maxFindings` cap.
 *
 * @param {string} manuscript
 * @param {{ threshold?: number, minIssues?: number, wells?: Array<{ name: string, words: Set<string> }> }} [opts]
 * @returns {{ gatedOff: boolean, issueCount: number, threshold: number,
 *   matrix: object, series: Record<string, {mean:number, std:number}>,
 *   outliers: Array<{ issue:number, metricKey:string, label:string, value:number,
 *     mean:number, std:number, z:number, direction:'high'|'low', unit:string }> }}
 */
export function computeVoiceDrift(manuscript, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) && opts.threshold > 0 ? opts.threshold : 1.5;
  const minIssues = Number.isInteger(opts.minIssues) && opts.minIssues >= 3 ? opts.minIssues : 3;
  const matrix = voiceFingerprintMatrix(manuscript, { wells: opts.wells });
  const { issues, metricKeys } = matrix;

  if (issues.length < minIssues) {
    return { gatedOff: true, issueCount: issues.length, threshold, matrix, series: {}, outliers: [] };
  }

  const series = {};
  const outliers = [];
  const unitOf = (key) => {
    if (typeof key === 'string' && key.startsWith('well:')) return '';
    const d = VOICE_METRICS.find((mm) => mm.key === key);
    return d ? d.unit : '';
  };

  for (const key of metricKeys) {
    const values = issues.map((it) => it.metrics[key] ?? 0);
    const mean = meanOf(values);
    const std = stdOf(values, mean);
    series[key] = { mean: round2(mean), std: round2(std) };
    // A metric with no spread can't have an outlier — and dividing by ~0 σ would
    // manufacture infinite z-scores. Skip it.
    if (std < 1e-9) continue;
    for (const it of issues) {
      const value = it.metrics[key] ?? 0;
      const z = (value - mean) / std;
      if (Math.abs(z) <= threshold) continue;
      outliers.push({
        issue: it.issue,
        metricKey: key,
        label: metricLabel(key),
        value,
        mean,
        std,
        z,
        direction: z > 0 ? 'high' : 'low',
        unit: unitOf(key),
      });
    }
  }

  outliers.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  return { gatedOff: false, issueCount: issues.length, threshold, matrix, series, outliers };
}

/**
 * Render a fingerprint matrix as a plain-text aligned table (issues as rows,
 * metrics as columns, outlier cells marked with `*`). Used for debug/logging and
 * covered by tests; the interactive UI table is a separate surface. Returns '' for
 * an empty matrix.
 *
 * @param {ReturnType<typeof computeVoiceDrift>} drift
 */
export function renderFingerprintTable(drift) {
  if (!drift || !drift.matrix || !drift.matrix.issues.length) return '';
  const { matrix, series } = drift;
  const keys = matrix.metricKeys;
  const outlierSet = new Set((drift.outliers || []).map((o) => `${o.issue}:${o.metricKey}`));
  const header = ['issue', ...keys.map(metricLabel)];
  const rows = matrix.issues.map((it) => [
    `#${it.issue}`,
    ...keys.map((k) => {
      const v = it.metrics[k] ?? 0;
      return outlierSet.has(`${it.issue}:${k}`) ? `${v}*` : `${v}`;
    }),
  ]);
  if (series && Object.keys(series).length) {
    rows.push(['mean', ...keys.map((k) => `${series[k]?.mean ?? 0}`)]);
    rows.push(['σ', ...keys.map((k) => `${series[k]?.std ?? 0}`)]);
  }
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  return [fmt(header), ...rows.map(fmt)].join('\n');
}
