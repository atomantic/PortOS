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
  // "the cat's" counts identically to every other check). Tokenize each sentence
  // ONCE — both the length pass and the dominant-opener pass below read this.
  const sentenceTokenLists = sentences.map((s) => tokenizeWords(s.text));
  const sentenceLengths = sentenceTokenLists.map((toks) => toks.length);
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
  for (const toks of sentenceTokenLists) {
    const first = toks[0];
    if (!first) continue;
    openerCounts.set(first.lower, (openerCounts.get(first.lower) || 0) + 1);
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
// headers the manuscript stitcher emits. The header pattern intentionally mirrors
// `conflictIntensityTally` in checkInfra.js (its own local `headerRe`) — kept as a
// parallel literal here rather than a shared `/g` constant on purpose: a single
// exported `/g` regex instance carries mutable `lastIndex` state, so two `.exec`
// callers in different modules would corrupt each other's scan. If the stitcher's
// header shape ever changes, update both. Duplicate issue numbers (a
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

// The three drift-baseline modes (#2179, CWQE Phase 14). Which per-metric CENTER
// each drafted issue's z-score is measured against:
//   'drafted'   — the mean of the drafted issues (default; the original behavior).
//   'exemplars' — the style guide's voice EXEMPLARS' combined fingerprint (the
//                 CHOSEN voice), so an issue is flagged for drifting from the
//                 voice the author picked, not from the average of what got
//                 drafted (which itself may all have drifted the same way).
//   'blended'   — the midpoint of the two, splitting the difference.
// The spread (σ) is ALWAYS the drafted-issue σ regardless of mode — 1–3 short
// exemplar passages can't yield a meaningful population σ, and "how much this
// series naturally varies per metric" is a property of the drafted corpus. So an
// exemplar/blended run re-centers the target, keeping the drafted spread.
export const VOICE_BASELINE_MODES = Object.freeze(['drafted', 'exemplars', 'blended']);

// A combined exemplar fingerprint needs at least this many words to be a stable
// baseline — a one-line "exemplar" is too thin to center against, so below this
// the baseline is treated as absent (the run falls back to 'drafted').
const MIN_EXEMPLAR_WORDS = 40;

/**
 * Combine a style guide's voice exemplar passages into ONE fingerprint — the
 * statistical profile of the series' CHOSEN voice, used as the drift baseline in
 * `exemplars` / `blended` mode (#2179). Concatenates the passages (they are the
 * same register by construction) and fingerprints the whole, so the metric
 * profile reflects the exemplars' aggregate rhythm/diction. Pure.
 *
 * Returns `null` when there are no usable passages or the combined text is below
 * `MIN_EXEMPLAR_WORDS` (too thin to center against) — callers then fall back to
 * the drafted-mean baseline.
 *
 * @param {Array<{ passage?: string }>} voiceExemplars
 * @param {{ wells?: Array<{ name: string, words: Set<string> }> }} [opts]
 * @returns {{ metrics: Record<string, number>, words: number, passages: number } | null}
 */
export function computeExemplarBaseline(voiceExemplars, opts = {}) {
  const wells = Array.isArray(opts.wells) ? opts.wells : [];
  const passages = (Array.isArray(voiceExemplars) ? voiceExemplars : [])
    .map((e) => (typeof e?.passage === 'string' ? e.passage.trim() : ''))
    .filter(Boolean);
  if (!passages.length) return null;
  const combined = passages.join('\n\n');
  const fp = computeFingerprint(combined, { wells });
  if (fp.words < MIN_EXEMPLAR_WORDS) return null;
  return { metrics: fp.metrics, words: fp.words, passages: passages.length };
}

// Human label for a metric key (static descriptor label, or the well name).
export function metricLabel(key) {
  if (typeof key === 'string' && key.startsWith('well:')) {
    return `"${key.slice(5)}" vocabulary (per 1k words)`;
  }
  const desc = VOICE_METRICS.find((mm) => mm.key === key);
  return desc ? desc.label : key;
}

// The rendered unit suffix for a metric key (static descriptor unit, or '' for a
// well). Single source of truth so the drift outlier's `unit`, the finding text,
// and the matrix column header all agree.
export function metricUnit(key) {
  if (typeof key === 'string' && key.startsWith('well:')) return '';
  const desc = VOICE_METRICS.find((mm) => mm.key === key);
  return desc ? desc.unit : '';
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

/**
 * Self-describing column descriptor for a metric key — the label, unit, and the
 * plain-language phrasing for a value that runs high vs low against the series
 * mean, plus whether it's a vocabulary well. The single source of truth for
 * rendering a fingerprint-matrix column header (server and client), built on the
 * same `metricLabel` / `directionPhrase` / `metricUnit` primitives the finding
 * text (`describeDrift`) uses — so header tooltips can't silently diverge from the
 * finding cards.
 *
 * @param {string} key
 * @returns {{ key: string, label: string, unit: string, higher: string, lower: string, isWell: boolean }}
 */
export function describeMetricColumn(key) {
  return {
    key,
    label: metricLabel(key),
    unit: metricUnit(key),
    higher: directionPhrase(key, 'high'),
    lower: directionPhrase(key, 'low'),
    isWell: typeof key === 'string' && key.startsWith('well:'),
  };
}

// One-sentence finding text for a drift outlier — names the issue, the metric,
// the issue value vs the baseline center, the σ distance, and the plain-language
// direction ("prose has gone metronomic"). The baseline label reflects which
// center the outlier was measured against (#2179): the drafted-issue mean, the
// style guide's chosen-voice exemplars, or a blend of the two — so an
// exemplar-baseline finding reads "vs the style guide's chosen voice" instead of
// implying it drifted from the average of what got drafted.
export function describeDrift(o) {
  const label = metricLabel(o.metricKey);
  const dir = directionPhrase(o.metricKey, o.direction);
  const val = `${o.value}${o.unit || ''}`;
  // `center` is the baseline value; older callers/tests that pass only `mean`
  // still work (center falls back to mean).
  const centerVal = Number.isFinite(o.center) ? o.center : o.mean;
  const center = `${round2(centerVal)}${o.unit || ''}`;
  const baselineNoun = o.baselineMode === 'exemplars'
    ? "the style guide's chosen voice"
    : (o.baselineMode === 'blended' ? "the blend of the series mean and the chosen voice" : 'the series mean');
  return `Issue ${o.issue}'s ${label} is ${val} vs ${baselineNoun} of ${center} `
    + `(${Math.abs(o.z).toFixed(1)}σ ${o.direction === 'high' ? 'above' : 'below'}) — ${dir}. `
    + 'A statistical outlier against the series voice; confirm it is an earned modulation, not drift.';
}

/**
 * Compute the voice-drift outliers for a stitched manuscript. Pure — returns
 * structured results the `style.voice-drift` check maps to editorial findings (so
 * the severity/config policy lives in the check, not here).
 *
 * Small-N gate: with fewer than `minIssues` issues drafted, σ is too small to be
 * meaningful, so the check gates OFF and emits nothing — `{ gatedOff: true,
 * issueCount, outliers: [] }`. The default `minIssues` is 4, not 3, because the
 * LARGEST possible population z-score for N points is √(N−1) (one issue vs the
 * rest identical): at N=3 that ceiling is √2 ≈ 1.41 — below the default 1.5σ
 * threshold, so a 3-issue series could NEVER flag drift and the check would
 * silently be a no-op. At N=4 the ceiling is √3 ≈ 1.73, so drift is reachable. An
 * explicit `minIssues: 3` is still honored (it only matters with a lower
 * `threshold` — e.g. 1.0, where √2 clears it).
 *
 * For each metric, a series mean/σ is computed across issues; a metric whose σ is
 * ~0 (every issue identical) is skipped — no drift is possible. An issue is an
 * outlier on a metric when its value is more than `threshold`·σ from the CENTER.
 * Outliers are sorted by |z| descending so the most significant drift survives a
 * downstream `maxFindings` cap.
 *
 * `opts.baselineMode` (#2179) selects what CENTER each issue is measured against:
 * `'drafted'` (default — the drafted-issue mean), `'exemplars'` (the style
 * guide's chosen-voice exemplar profile), or `'blended'` (the midpoint). In the
 * exemplar/blended modes the σ is STILL the drafted-issue σ (see
 * `VOICE_BASELINE_MODES`) — only the center shifts — so an issue is flagged for
 * drifting from the *chosen* voice rather than from the average of what got
 * drafted. When the mode asks for exemplars but `opts.voiceExemplars` yields no
 * usable baseline, the run silently falls back to `'drafted'` and reports the
 * effective mode in `baselineMode` + `exemplarBaselineUsed: false`.
 *
 * @param {string} manuscript
 * @param {{ threshold?: number, minIssues?: number, wells?: Array<{ name: string, words: Set<string> }>,
 *   baselineMode?: 'drafted'|'exemplars'|'blended',
 *   voiceExemplars?: Array<{ passage?: string }> }} [opts]
 * @returns {{ gatedOff: boolean, issueCount: number, threshold: number,
 *   baselineMode: string, exemplarBaselineUsed: boolean,
 *   matrix: object, series: Record<string, {mean:number, std:number, center:number}>,
 *   outliers: Array<{ issue:number, metricKey:string, label:string, value:number,
 *     mean:number, center:number, std:number, z:number, direction:'high'|'low',
 *     unit:string, baselineMode:string }> }}
 */
export function computeVoiceDrift(manuscript, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) && opts.threshold > 0 ? opts.threshold : 1.5;
  const minIssues = Number.isInteger(opts.minIssues) && opts.minIssues >= 3 ? opts.minIssues : 4;
  const wells = opts.wells;
  const requestedMode = VOICE_BASELINE_MODES.includes(opts.baselineMode) ? opts.baselineMode : 'drafted';
  // Compute the exemplar baseline once (only when a non-drafted mode asked for
  // it). A thin/absent exemplar set → null → fall back to the drafted mean.
  const exemplarBaseline = requestedMode === 'drafted'
    ? null
    : computeExemplarBaseline(opts.voiceExemplars, { wells });
  const effectiveMode = exemplarBaseline ? requestedMode : 'drafted';

  const fullMatrix = voiceFingerprintMatrix(manuscript, { wells });
  // Drop empty / not-yet-drafted issue sections (a `# Issue N` header with no
  // prose behind it). Counting them would let a stub satisfy `minIssues` and
  // inject an all-zero row that pulls the series mean and flags the unwritten
  // issue as a wild outlier on every metric. Drift is computed over the drafted
  // issues only; the matrix returned is likewise restricted so renderFingerprintTable
  // agrees with the stats.
  const issues = fullMatrix.issues.filter((it) => it.words > 0 && it.sentences > 0);
  const matrix = { ...fullMatrix, issues };
  const { metricKeys } = matrix;

  const base = {
    issueCount: issues.length,
    threshold,
    baselineMode: effectiveMode,
    exemplarBaselineUsed: effectiveMode !== 'drafted',
  };

  if (issues.length < minIssues) {
    return { ...base, gatedOff: true, matrix, series: {}, outliers: [] };
  }

  const series = {};
  const outliers = [];

  for (const key of metricKeys) {
    const values = issues.map((it) => it.metrics[key] ?? 0);
    const mean = meanOf(values);
    const std = stdOf(values, mean);
    // The CENTER each issue's z-score is measured against. Drafted mode centers on
    // the drafted mean; exemplars mode on the chosen-voice profile; blended on the
    // midpoint. The exemplar value for a metric the exemplars don't carry falls
    // back to the drafted mean (never NaN). The σ is always the drafted spread.
    let center = mean;
    if (exemplarBaseline) {
      const exemplarVal = exemplarBaseline.metrics[key];
      const target = Number.isFinite(exemplarVal) ? exemplarVal : mean;
      center = effectiveMode === 'blended' ? (mean + target) / 2 : target;
    }
    series[key] = { mean: round2(mean), std: round2(std), center: round2(center) };
    // A metric with no drafted spread can't have a per-issue OUTLIER — and dividing
    // by ~0 σ would manufacture infinite z-scores — so skip it. Note the boundary
    // this leaves for the exemplar/blended baseline (#2179): when every drafted
    // issue shares the SAME value on a metric (σ≈0) but that shared value sits far
    // from the chosen-voice center, this per-issue z-score model emits nothing —
    // there's no per-issue outlier, the whole corpus is uniformly off. That
    // "uniformly-off-register" case wants a SERIES-level finding (a different shape
    // than the per-issue outliers here), tracked as a #2179 follow-up. It does NOT
    // affect the common case the feature targets: issues that drifted the same
    // DIRECTION still have natural per-metric variance (σ>0), so they still flag
    // against the chosen-voice center.
    if (std < 1e-9) continue;
    for (const it of issues) {
      const value = it.metrics[key] ?? 0;
      const z = (value - center) / std;
      if (Math.abs(z) <= threshold) continue;
      outliers.push({
        issue: it.issue,
        metricKey: key,
        label: metricLabel(key),
        value,
        mean,
        center,
        std,
        z,
        direction: z > 0 ? 'high' : 'low',
        unit: metricUnit(key),
        baselineMode: effectiveMode,
      });
    }
  }

  outliers.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  return { ...base, gatedOff: false, matrix, series, outliers };
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
    // When drift was measured against a non-drafted baseline (exemplars/blended),
    // the flagged cells sit against `center`, not `mean` — surface it as its own
    // row so the starred outliers are readable against the actual baseline.
    if (drift.exemplarBaselineUsed) {
      const label = drift.baselineMode === 'blended' ? 'blend' : 'voice';
      rows.push([label, ...keys.map((k) => `${series[k]?.center ?? series[k]?.mean ?? 0}`)]);
    }
  }
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  return [fmt(header), ...rows.map(fmt)].join('\n');
}
