/**
 * Reveal-gating, foreshadowing and setup/payoff stages + prompt summaries: the
 * information-economy family (info-dumping, object motivation/backstory/weight, style
 * conformance, interiority, Chekhov, premature reveal, endings/cliffhanger).
 */

import { revealGatedCanonRows } from './externals.js';

// Info-dumping stage. A NEW stage reaches existing installs via setup-data.js
// (missing-file copy + JSON_MERGE_TARGETS stage merge), so it needs no migration.
export const INFO_DUMPING_STAGE = 'pipeline-editorial-info-dumping';

// Object-attachment checks. Prompts ship in data.reference/prompts/stages/ +
// stage-config.json; existing installs get them via migration 094 (boot runs
// migrations but NOT setup-data).
export const OBJECT_MOTIVATION_STAGE = 'pipeline-editorial-object-motivation';
export const OBJECT_BACKSTORY_STAGE = 'pipeline-editorial-object-backstory';

// Object weight-proportionality: does an object's established backstory and payoff
// depth match its prose prominence (migration 143)? Feeds the canon's per-object
// significance summary as context.
export const OBJECT_WEIGHT_STAGE = 'pipeline-editorial-object-weight-proportionality';

// Style-guide conformance (migration 096; boot runs migrations but NOT setup-data).
export const STYLE_CONFORMANCE_STAGE = 'pipeline-editorial-style-conformance';

// Protagonist interiority (migration 099).
export const INTERIORITY_STAGE = 'pipeline-editorial-interiority';

// Chekhov's-guns setup/payoff (migration 100).
export const CHEKHOV_STAGE = 'pipeline-editorial-chekhov';

// Premature-reveal check (migration 168).
export const PREMATURE_REVEAL_STAGE = 'pipeline-editorial-premature-reveal';

// Render the reveal-gated canon into a compact block so the premature-reveal check
// knows which facts are SECRETS not yet due: each row names the entry, its reveal
// issue (or hard spoiler), the allowed surface stand-in, and the fact that must not
// leak. Pure so its token cost counts into per-chunk overhead; '' when none gated.
export function revealGatedCanonSummary(canon) {
  const rows = revealGatedCanonRows(canon);
  if (!rows.length) return '';
  const lines = rows.map((r) => {
    const when = r.spoiler
      ? 'HARD SPOILER — must not appear in ANY drafted issue'
      : `revealed in Issue ${r.revealIssue} — must not appear before then`;
    const surface = r.surfaceDescriptor
      ? ` Pre-reveal, the reader may only know: "${r.surfaceDescriptor}".`
      : '';
    const fact = r.fact ? ` The gated fact (must NOT leak early): ${r.fact}.` : '';
    return `- ${r.kind} "${r.name}" (${when}).${surface}${fact}`;
  });
  return 'Reveal-gated canon (these facts are deliberately withheld — flag any that a first-time reader would '
    + 'learn from the prose before the fact is due):\n' + lines.join('\n');
}

// Render reveal-gated canon as AUTHORED PAYOFFS for the Chekhov check (a gate's
// `revealIssue` is the authored payoff point), so it can flag a reveal with no prior
// setup. Only NUMERIC gates render; a hard `spoiler` has no payoff issue. '' when none.
export function revealGatedPayoffsSummary(canon) {
  const rows = revealGatedCanonRows(canon).filter((r) => Number.isInteger(r.revealIssue));
  if (!rows.length) return '';
  const lines = rows.map((r) => {
    const what = r.fact || `the withheld fact about ${r.kind} "${r.name}"`;
    return `- ${r.kind} "${r.name}" — reveal-gated fact due to pay off in Issue ${r.revealIssue}: ${what}`;
  });
  return 'Authored reveal-gated payoffs (each gated fact is meant to be revealed — fire — in its named issue; '
    + 'flag a reveal that arrives with no prior setup):\n' + lines.join('\n');
}

// Chapter-ending cliffhanger check (migration 102).
export const ENDINGS_CLIFFHANGER_STAGE = 'pipeline-editorial-endings-cliffhanger';

// Shared preamble for the authored-entry renderers below: an entry's `label — note`
// (or whichever is present), '' when neither is usable so callers can `.filter(Boolean)`.
function entryLabelNoteText(e) {
  const label = typeof e?.label === 'string' ? e.label.trim() : '';
  const note = typeof e?.note === 'string' ? e.note.trim() : '';
  return label && note ? `${label} — ${note}` : (label || note);
}

// Render one reader-map entry (hook or payoff) to a `- text (arc position N)` line;
// '' when unusable.
function renderReaderMapEntryLine(e) {
  const text = entryLabelNoteText(e);
  if (!text) return '';
  // Coarse expected-location hint for reconciliation.
  const pos = Number.isFinite(e?.atArcPosition) ? ` (arc position ${e.atArcPosition})` : '';
  return `- ${text}${pos}`;
}

// Render one foreshadowing-ledger entry to a `- text (plant issue N → reinforced issue
// M → payoff issue P)` line so the Chekhov check reconciles against the author-declared
// ledger; '' when unusable.
function renderForeshadowingEntryLine(e) {
  const text = entryLabelNoteText(e);
  if (!text) return '';
  const span = [];
  if (Number.isFinite(e?.plantIssue)) span.push(`plant issue ${e.plantIssue}`);
  if (Array.isArray(e?.reinforceIssues) && e.reinforceIssues.length) {
    span.push(`reinforced issue ${e.reinforceIssues.join(', ')}`);
  }
  if (Number.isFinite(e?.payoffIssue)) span.push(`payoff issue ${e.payoffIssue}`);
  return span.length ? `- ${text} (${span.join(' → ')})` : `- ${text}`;
}

// Authored-foreshadowing-ledger block; '' when nothing is authored.
export function authoredForeshadowingSummary(foreshadowing) {
  const entries = Array.isArray(foreshadowing) ? foreshadowing : [];
  const lines = entries.map(renderForeshadowingEntryLine).filter(Boolean);
  if (!lines.length) return '';
  return `Authored foreshadowing ledger (planted seeds the writer logged — plant → reinforce → payoff):\n${lines.join('\n')}`;
}

// Authored reader-map hooks/payoffs plus the foreshadowing ledger (`series.arc.foreshadowing`)
// in one authored-setups block, so the Chekhov check can reconcile its DETECTED
// setups/payoffs against what the writer LOGGED without a template change. '' when none.
export function authoredSetupPayoffSummary(readerMap, foreshadowing) {
  const hooks = Array.isArray(readerMap?.hooks) ? readerMap.hooks : [];
  const payoffs = Array.isArray(readerMap?.payoffs) ? readerMap.payoffs : [];
  const hookLines = hooks.map(renderReaderMapEntryLine).filter(Boolean);
  const payoffLines = payoffs.map(renderReaderMapEntryLine).filter(Boolean);
  const ledgerBlock = authoredForeshadowingSummary(foreshadowing);
  if (!hookLines.length && !payoffLines.length && !ledgerBlock) return '';
  const parts = [];
  if (hookLines.length) parts.push(`Authored hooks (questions the writer planted):\n${hookLines.join('\n')}`);
  if (payoffLines.length) parts.push(`Authored payoffs (resolutions the writer logged):\n${payoffLines.join('\n')}`);
  if (ledgerBlock) parts.push(ledgerBlock);
  return parts.join('\n\n');
}

// Render ONLY authored reader-map payoffs for the climax / resolution-power check.
// Hooks are deliberately excluded (unlike authoredSetupPayoffSummary): an unanswered
// hook is not a climax obligation and would be flagged as a missing resolution.
// '' when no payoff is authored.
export function authoredPayoffsSummary(readerMap) {
  const payoffs = Array.isArray(readerMap?.payoffs) ? readerMap.payoffs : [];
  const payoffLines = payoffs.map(renderReaderMapEntryLine).filter(Boolean);
  if (!payoffLines.length) return '';
  return `Authored payoffs (resolutions the writer logged — what the reader was promised):\n${payoffLines.join('\n')}`;
}

