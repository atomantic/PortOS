/**
 * Render a deterministic cast-integrity report into a prompt block (#6415).
 *
 * The report itself comes from `characterIntegrity.js` and makes zero provider
 * calls. This module is only the prompt-facing projection of it, and it lives
 * in `lib/` because more than one reviewing surface needs the SAME block:
 * the Series foundation judge (`pipeline/foundationJudgeContext.js`) and the
 * FableLoom whole-series editor (`fableLoom/editorial.js`) both hand a model a
 * cast and a depth ruling, and a second copy of this renderer would let the two
 * drift into disagreeing about what a `light` character owes the story.
 *
 * PURE: no I/O, no provider calls, no record reads.
 */

/**
 * Why a character is held to a lighter standard, in the reviewer's own terms.
 * The issue is explicit that these are EXPLAINED requirements, not silent
 * excuses: a depth the prompt cannot justify reads as inconsistent scoring.
 */
export const INTEGRITY_DEPTH_NOTES = Object.freeze({
  explained: 'interior declared unknown/not-applicable with an author note — a finished assessment, ask nothing further',
  light: 'declared minor role or flat arc — conscious pursuit only, no origin-damage chain',
  full: 'full framework expected',
});

const joinedLength = (lines) => lines.reduce((total, line) => total + line.length + 1, 0);
const pluralLines = (count) => (count === 1 ? 'line' : 'lines');

/**
 * Render the deterministic report as a prompt block, bounded by `maxChars`.
 *
 * Rows carrying gaps are emitted first so a tight budget drops the clean ones —
 * a dropped clean line costs the reviewer nothing, where a dropped gap line
 * would hide the very thing the character dimension is scored on. The header
 * always survives, so a truncated block can never read as a full pass.
 *
 * `castLabel` names how the cast was scoped ("series-linked", "story-linked");
 * `budgetLabel` names the budget in the omission note, so each surface explains
 * the truncation in the terms its own prompt uses.
 */
export function renderCastIntegrity(report, {
  maxChars = Infinity,
  castLabel = 'series-linked',
  budgetLabel = 'judging budget',
} = {}) {
  const coverage = Array.isArray(report?.coverage) ? report.coverage : [];
  if (coverage.length === 0) return `(no ${castLabel} cast to measure)`;
  const byCharacter = new Map();
  for (const finding of (Array.isArray(report?.findings) ? report.findings : [])) {
    const own = byCharacter.get(finding.characterId) || [];
    own.push(`${finding.field} (${finding.kind})`);
    byCharacter.set(finding.characterId, own);
  }
  const withGaps = coverage.filter((row) => row.findingCount > 0).length;
  const head = [
    `Deterministic pass (no model call) over ${coverage.length} ${castLabel} characters — ${withGaps} carry gaps.`,
    `Depth rulings are BINDING: ${Object.entries(INTEGRITY_DEPTH_NOTES).map(([depth, note]) => `${depth} = ${note}`).join('; ')}.`,
  ];
  const rows = coverage
    .map((row) => {
      const gaps = byCharacter.get(row.characterId) || [];
      const detail = gaps.length
        ? `${gaps.length} gap${gaps.length === 1 ? '' : 's'}: ${gaps.join('; ')}`
        : `no gaps (${INTEGRITY_DEPTH_NOTES[row.depth] || INTEGRITY_DEPTH_NOTES.full})`;
      return { hasGaps: gaps.length > 0, line: `- **${row.characterName || 'Unnamed'}** [${row.depth}] — ${detail}` };
    })
    .sort((a, b) => Number(b.hasGaps) - Number(a.hasGaps));
  let remaining = maxChars - joinedLength(head);
  const kept = [];
  let index = 0;
  // Stop at the first row that does not fit rather than skipping ahead to a
  // shorter one: the sort put the gaps first, and a greedy fill would happily
  // drop a long gap line to keep a short clean one.
  while (index < rows.length && rows[index].line.length + 1 <= remaining) {
    kept.push(rows[index].line);
    remaining -= rows[index].line.length + 1;
    index += 1;
  }
  const omitted = rows.length - index;
  if (omitted > 0) kept.push(`  [${omitted} clean cast-integrity ${pluralLines(omitted)} omitted to fit the ${budgetLabel}]`);
  return [...head, ...kept].join('\n');
}
