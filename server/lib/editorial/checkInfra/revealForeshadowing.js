/**
 * Reveal-gating, foreshadowing and setup/payoff stages + prompt summaries
 * (#2842 split of checkInfra.js). Covers the information-economy family:
 * info-dumping, object motivation/backstory/weight, style conformance,
 * interiority, Chekhov, premature reveal, and the endings/cliffhanger stage.
 */

import { revealGatedCanonRows } from './externals.js';

// Stage name for the info-dumping LLM check. The prompt ships in
// data.reference/prompts/stages/ and its config in stage-config.json; both
// propagate to existing installs via setup-data.js (missing-file copy +
// JSON_MERGE_TARGETS stage merge), so no migration is needed for a NEW stage.
export const INFO_DUMPING_STAGE = 'pipeline-editorial-info-dumping';

// Stage names for the two object-attachment LLM checks (#1288). Like the
// info-dumping stage, each prompt ships in data.reference/prompts/stages/ and
// its config in stage-config.json; both propagate to fresh installs via
// setup-data.js and to existing installs via migration 094 (boot runs
// migrations but NOT setup-data, so the migration is required — see
// scripts/migrations/094-object-attachment-check-stages.js).
export const OBJECT_MOTIVATION_STAGE = 'pipeline-editorial-object-motivation';
export const OBJECT_BACKSTORY_STAGE = 'pipeline-editorial-object-backstory';

// Stage name for the object weight-proportionality LLM check (#1624): judges
// whether an object's narrative weight (established backstory + payoff depth)
// matches its prominence in the prose — flagging a minor object given a heavy
// backstory ("a one-line locket with a 3-issue origin") or a climactic object
// with no lineage to earn it ("a heirloom that decides the finale, never set
// up"). Ships in data.reference/prompts/stages/ + stage-config.json (fresh
// installs via setup-data.js) and migrates to existing installs via migration
// 143 (boot runs migrations but NOT setup-data, so the migration is required).
// Like the two object-attachment checks above it feeds the canon's per-object
// significance/attachment summary as context and reads the stitched manuscript
// to weigh prose prominence against that established weight.
export const OBJECT_WEIGHT_STAGE = 'pipeline-editorial-object-weight-proportionality';

// Stage name for the style-guide conformance LLM check (#1303). Ships in
// data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 096 (boot runs
// migrations but NOT setup-data, so the migration is required).
export const STYLE_CONFORMANCE_STAGE = 'pipeline-editorial-style-conformance';

// Stage name for the protagonist-interiority LLM check (#1294). Ships in
// data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 099 (boot runs
// migrations but NOT setup-data, so the migration is required).
export const INTERIORITY_STAGE = 'pipeline-editorial-interiority';

// Stage name for the Chekhov's-guns setup/payoff LLM check (#1299). Ships in
// data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 100 (boot runs
// migrations but NOT setup-data, so the migration is required).
export const CHEKHOV_STAGE = 'pipeline-editorial-chekhov';

// Stage name for the premature-reveal editorial LLM check (#2178 — CWQE Phase
// 13). Ships in data.reference/prompts/stages/ + stage-config.json (fresh
// installs via setup-data.js) and migrates to existing installs via migration
// 168 (boot runs migrations but NOT setup-data, so the migration is required).
export const PREMATURE_REVEAL_STAGE = 'pipeline-editorial-premature-reveal';

// Render the reveal-gated canon (#2178) into a compact text block the
// premature-reveal check passes alongside the manuscript, so the model knows
// which facts are SECRETS not yet due and when each is meant to surface. Each
// row names the entry, its reveal issue (or hard spoiler), the spoiler-free
// surface stand-in the reader IS allowed to see, and the underlying fact that
// must NOT leak early. Pure + deterministic so it's unit-testable and its token
// cost counts into the per-chunk overhead. Returns '' when no canon is
// reveal-gated (the check gates on `canonHasRevealGated` so this won't be
// called with an empty set, but the guard keeps it safe).
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

// Render reveal-gated canon (#2178) as AUTHORED PAYOFFS for the Chekhov check —
// a gated entry's `revealIssue` is effectively an authored payoff point (the
// issue where the withheld fact is meant to fire). Folded into the Chekhov
// `authoredSetups` block so the check can flag a reveal that arrives with zero
// prior setup (an orphaned payoff). Only NUMERIC reveal gates render — a hard
// `spoiler` has no scheduled payoff issue to reconcile against. Returns '' when
// no numeric-gated entry exists (the block renders nothing). Pure.
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

// Stage name for the chapter-ending cliffhanger LLM check (#1298). Ships in
// data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 102 (boot runs
// migrations but NOT setup-data, so the migration is required).
export const ENDINGS_CLIFFHANGER_STAGE = 'pipeline-editorial-endings-cliffhanger';

// Render the authored reader-map hooks/payoffs (#1299) into a compact text block
// the Chekhov check passes alongside the manuscript so the model reconciles its
// DETECTED setups/payoffs against what the writer has already LOGGED — e.g. an
// authored hook with no detected payoff, or a detected payoff the writer never
// logged. Pure + deterministic so it's unit-testable and so its token cost can be
// counted into the per-chunk overhead. Returns '' when nothing is authored (the
// prompt's `{{#authoredSetups}}` section then renders nothing).
// Shared preamble for the authored-entry renderers below: an entry's
// `label — note` (or whichever is present), '' when neither is usable so
// callers can `.filter(Boolean)`.
function entryLabelNoteText(e) {
  const label = typeof e?.label === 'string' ? e.label.trim() : '';
  const note = typeof e?.note === 'string' ? e.note.trim() : '';
  return label && note ? `${label} — ${note}` : (label || note);
}

// Render one reader-map entry (hook or payoff) to a `- text (arc position N)` line.
// Shared by authoredSetupPayoffSummary + authoredPayoffsSummary. Returns '' for an
// entry with no usable label/note so callers can `.filter(Boolean)`.
function renderReaderMapEntryLine(e) {
  const text = entryLabelNoteText(e);
  if (!text) return '';
  // A coarse expected-location hint so the model can reason about WHERE an
  // authored hook should have paid off (reconciliation signal, #1299).
  const pos = Number.isFinite(e?.atArcPosition) ? ` (arc position ${e.atArcPosition})` : '';
  return `- ${text}${pos}`;
}

// Render one foreshadowing-ledger entry (#2172) to a `- text (plant issue N →
// reinforced issue M → payoff issue P)` line so the Chekhov check reconciles
// its detected plants/payoffs against the author-declared ledger instead of
// inferring every seed from scratch. Returns '' for an entry with no usable
// label/note so callers can `.filter(Boolean)`.
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

// Build the authored-foreshadowing-ledger block (#2172). Exported for the
// Chekhov check + unit tests; returns '' when nothing is authored so the
// prompt's `{{#authoredSetups}}` section renders nothing.
export function authoredForeshadowingSummary(foreshadowing) {
  const entries = Array.isArray(foreshadowing) ? foreshadowing : [];
  const lines = entries.map(renderForeshadowingEntryLine).filter(Boolean);
  if (!lines.length) return '';
  return `Authored foreshadowing ledger (planted seeds the writer logged — plant → reinforce → payoff):\n${lines.join('\n')}`;
}

// `foreshadowing` (#2172) is the author-declared plant→reinforce→payoff ledger
// on `series.arc.foreshadowing`; it's folded into the SAME authored-setups
// block the reader-map hooks/payoffs render into, so the Chekhov prompt
// consumes it through its existing `{{#authoredSetups}}` section without a
// template change.
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

// Render ONLY the authored reader-map payoffs (#1583) — the resolutions the writer
// LOGGED that the reader was promised. The climax / resolution-power check passes
// this (NOT authoredSetupPayoffSummary, which also bundles hooks) so the prompt's
// "payoffs the climax should deliver" framing stays accurate: a hook is a question
// the writer planted, not a climax obligation, so feeding hooks here would risk the
// model flagging an ordinary unanswered hook as a missing climax resolution. Pure +
// deterministic so it's unit-testable and its token cost can be counted into the
// per-chunk overhead. Returns '' when no payoff is authored (the prompt's
// `{{#authoredPayoffs}}` section then renders nothing and the check reasons from the
// prose + themes alone).
export function authoredPayoffsSummary(readerMap) {
  const payoffs = Array.isArray(readerMap?.payoffs) ? readerMap.payoffs : [];
  const payoffLines = payoffs.map(renderReaderMapEntryLine).filter(Boolean);
  if (!payoffLines.length) return '';
  return `Authored payoffs (resolutions the writer logged — what the reader was promised):\n${payoffLines.join('\n')}`;
}

