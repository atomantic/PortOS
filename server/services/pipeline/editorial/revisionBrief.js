/**
 * Pipeline — Revision brief assembly (CWQE Phase 7, #2171).
 *
 * Pure assembly of the revision BRIEF the Series Autopilot's iterate-to-quality
 * loop hands the reviser for the weakest issue. Autonovel's revision phase proved
 * that a rewrite prompt structured as PROBLEM / WHAT TO KEEP / WHAT TO CHANGE /
 * VOICE RULES / TARGET — with an explicit WHAT TO KEEP section carrying the
 * strongest sentences + protected passage — is what stops a rewrite from
 * destroying the good material while fixing the weak.
 *
 * The brief composes the evidence sources the earlier phases already produced:
 *   - the calibrated judge snapshot (#2167): oneLineVerdict, per-dimension fixes,
 *     strongest/weakest sentences, topRevisions;
 *   - the adversarial-cut findings (#2168) grouped by cut type (the cuts ARE the
 *     revision plan);
 *   - optional reader-panel consensus notes (#2170) when available.
 *
 * No I/O and no LLM — the caller supplies the snapshots; this returns a string.
 * Unit-tested on plain fixtures.
 */

// Human labels for the 9 judge dimensions (mirrors pipelineJudge.JUDGE_DIMENSIONS
// order). Kept local so this module stays free of a service import — a tiny,
// stable map is cheaper than the coupling.
const DIMENSION_LABELS = Object.freeze({
  voiceAdherence: 'Voice adherence',
  beatCoverage: 'Beat coverage',
  characterVoice: 'Character voice',
  plantsSeeded: 'Plants seeded',
  proseQuality: 'Prose quality',
  continuity: 'Continuity',
  canonCompliance: 'Canon compliance',
  loreIntegration: 'Lore integration',
  engagement: 'Engagement',
});

const trimList = (arr, cap = 8) => (Array.isArray(arr) ? arr.filter((s) => typeof s === 'string' && s.trim()).slice(0, cap) : []);

/**
 * The weakest scored dimensions of a judge snapshot, ascending by score, capped
 * at `n`. Only dimensions carrying an actionable note (fix or weakestMoment) are
 * returned — a low score with no guidance isn't useful in the brief. Pure.
 */
export function weakestDimensions(judge, n = 3) {
  const dims = judge?.dimensions && typeof judge.dimensions === 'object' ? judge.dimensions : {};
  return Object.keys(DIMENSION_LABELS)
    .map((key) => {
      const d = dims[key] || {};
      return {
        key,
        label: DIMENSION_LABELS[key],
        score: Number.isFinite(Number(d.score)) ? Number(d.score) : null,
        fix: typeof d.fix === 'string' ? d.fix.trim() : '',
        weakestMoment: typeof d.weakestMoment === 'string' ? d.weakestMoment.trim() : '',
      };
    })
    .filter((d) => d.score != null && (d.fix || d.weakestMoment))
    .sort((a, b) => a.score - b.score)
    .slice(0, n);
}

/**
 * Group adversarial-cut comments by their cut type (subtype). Returns a
 * Map-like plain object `{ TYPE: [quote, …] }`, quotes deduped + capped. Pure.
 */
export function groupCutsByType(cutComments) {
  const groups = {};
  for (const c of (Array.isArray(cutComments) ? cutComments : [])) {
    const type = (typeof c?.subtype === 'string' && c.subtype.trim()) ? c.subtype.trim() : 'UNCLASSIFIED';
    const quote = (typeof c?.anchorQuote === 'string' && c.anchorQuote.trim())
      ? c.anchorQuote.trim()
      : (typeof c?.problem === 'string' ? c.problem.trim() : '');
    if (!quote) continue;
    (groups[type] ||= []);
    if (!groups[type].includes(quote)) groups[type].push(quote);
  }
  return groups;
}

/**
 * Assemble the revision brief string for one issue from the judge snapshot, the
 * open adversarial-cut findings, and optional reader-panel consensus notes.
 *
 * @param {object}   p
 * @param {object}   p.issue           the issue record ({ number, title })
 * @param {object}   p.judge           the judge snapshot (#2167) for the issue
 * @param {Array}    [p.cutComments]   open adversarial-cut review comments (#2168)
 * @param {string[]} [p.panelConsensus] reader-panel consensus notes (#2170)
 * @param {number}   [p.currentChars]  current draft length (drives the TARGET line)
 * @returns {string} the brief
 */
export function buildRevisionBrief({ issue, judge, cutComments = [], panelConsensus = [], currentChars = null } = {}) {
  const num = issue?.number != null ? `#${issue.number}` : '';
  const title = typeof issue?.title === 'string' ? issue.title : '';
  const heading = `REVISION BRIEF — Issue ${num}${title ? `: ${title}` : ''}`.trim();
  const j = judge && typeof judge === 'object' ? judge : {};
  const lines = [heading, ''];

  // PROBLEM — the verdict + the weakest dimensions' fixes.
  lines.push('PROBLEM');
  if (typeof j.oneLineVerdict === 'string' && j.oneLineVerdict.trim()) {
    lines.push(`- Verdict: ${j.oneLineVerdict.trim()}`);
  }
  if (Number.isFinite(Number(j.qualityScore))) {
    lines.push(`- Current quality score: ${j.qualityScore} (judge ${j.overall ?? '?'} − slop ${j.slopPenalty ?? 0}).`);
  }
  for (const d of weakestDimensions(j, 3)) {
    lines.push(`- ${d.label} (${d.score}/10): ${d.fix || d.weakestMoment}`);
  }
  lines.push('');

  // WHAT TO KEEP — protect the strongest material so the rewrite can't gut it.
  lines.push('WHAT TO KEEP (do not weaken these)');
  const strongest = trimList(j.strongestSentences, 3);
  if (strongest.length) {
    for (const s of strongest) lines.push(`- Keep this beat/voice: "${s}"`);
  } else {
    lines.push('- Preserve the issue\'s strongest voice and its landed beats — tighten around them, don\'t replace them.');
  }
  lines.push('');

  // WHAT TO CHANGE — the concrete edit list: judge revisions, weak sentences, cuts.
  lines.push('WHAT TO CHANGE');
  const revisions = trimList(j.topRevisions, 3);
  for (const r of revisions) lines.push(`- ${r}`);
  const weakest = trimList(j.weakestSentences, 3);
  for (const w of weakest) lines.push(`- Rework this line: "${w}"`);
  const cutGroups = groupCutsByType(cutComments);
  for (const type of Object.keys(cutGroups)) {
    const quotes = cutGroups[type].slice(0, 4);
    lines.push(`- Cut (${type}): ${quotes.map((q) => `"${q.length > 120 ? `${q.slice(0, 120)}…` : q}"`).join('; ')}`);
  }
  const consensus = trimList(panelConsensus, 4);
  for (const c of consensus) lines.push(`- Reader panel: ${c}`);
  if (revisions.length === 0 && weakest.length === 0 && Object.keys(cutGroups).length === 0 && consensus.length === 0) {
    lines.push('- No specific edits surfaced — tighten prose, remove over-explanation, and vary sentence rhythm.');
  }
  lines.push('');

  // VOICE RULES — carry the voice-adherence fix so the reviser stays on-voice.
  lines.push('VOICE RULES');
  const voiceFix = j.dimensions?.voiceAdherence?.fix;
  if (typeof voiceFix === 'string' && voiceFix.trim()) {
    lines.push(`- ${voiceFix.trim()}`);
  } else {
    lines.push('- Hold the series voice, tense, and POV exactly as established. Do not drift register.');
  }
  lines.push('');

  // TARGET — tighten toward the judge's fat estimate when we know the length.
  lines.push('TARGET');
  if (Number.isFinite(Number(currentChars)) && Number(currentChars) > 0) {
    lines.push(`- Current length ≈ ${Number(currentChars).toLocaleString()} chars. Cut fat; do not pad. Aim tighter, not longer.`);
  } else {
    lines.push('- Cut fat; keep the issue tight. Do not pad to hit a length.');
  }

  return lines.join('\n');
}

export const __testing = { DIMENSION_LABELS, trimList };
