/**
 * Editorial check shared infrastructure (#1829).
 *
 * Extracted from checkRegistry.js: the imports, constants, stage names, and
 * pure summary/helper functions that the EDITORIAL_CHECKS entries (now in
 * ./checks/*.js) and the registry tail depend on. Kept side-effect-free so the
 * check files import from here without a cycle through checkRegistry.js (whose
 * EDITORIAL_CHECKS array spreads the check files — importing infra back from the
 * registry would hit a TDZ on eagerly-evaluated configSchemas).
 */
import { z } from 'zod';
import { estimateTokens } from '../contextBudget.js';
import { renderCharacterArcsForPrompt } from '../seriesCharacterArc.js';
import { parseComicScript } from '../comicScriptParser.js';
import {
  analyzeComicLettering,
  DEFAULT_LETTERING_THRESHOLDS,
} from './letteringDensity.js';
import { analyzeBalloonAttribution } from './balloonAttribution.js';
import { analyzeNamePair, comparisonName, findFirstLetterClusters, normalizeName } from './nameSimilarity.js';
import { findCliches, findModifierStacking } from './cliches.js';
import { findSaidBookisms, findUnattributedDialogueRuns, attributeDialogueByOwner, findDialogueTagVariety, splitScenes } from './dialogue.js';
import { findItalicThoughts } from './italicThoughts.js';
import {
  findFilterWords,
  findHedgeWords,
  findCrutchWords,
  findAdverbs,
  findPassiveVoice,
  filterPassiveVoice,
  findGestures,
} from './proseTics.js';
import {
  findWordEchoes,
  findRepeatedOpeners,
  measureSentenceRhythm,
} from './repetition.js';
import {
  findBannedWordsTier1,
  findSuspiciousWordClusters,
  findAiTells,
  findNotJustButPatterns,
  findNotSayingPatterns,
  findNegativeAssertions,
  findTheWaySimiles,
  findTriadicShortSentences,
  findStructuralTics,
  emDashDensityPer1000,
  transitionOpenerRatio,
  paragraphLengthUniformity,
  countSectionBreaks,
  MIN_DENSITY_OCCURRENCES,
} from './slopScore.js';
import {
  analyzePanelRhythm,
  comicPageTurnSummary,
  authoredRevealSummary,
} from './comicPacing.js';
import { findAxisReversals, findShotTypeMonotony, summarizeStoryboardShots } from './shotContinuity.js';
import { revealGatedCanonRows, canonHasRevealGated } from '../storyBible.js';

// Re-exported so ./checks/*.js and ./checkRegistry.js import everything from here.
export {
  DEFAULT_LETTERING_THRESHOLDS,
  MIN_DENSITY_OCCURRENCES,
  analyzeBalloonAttribution,
  analyzeComicLettering,
  analyzeNamePair,
  analyzePanelRhythm,
  attributeDialogueByOwner,
  authoredRevealSummary,
  comicPageTurnSummary,
  comparisonName,
  countSectionBreaks,
  emDashDensityPer1000,
  estimateTokens,
  filterPassiveVoice,
  findAdverbs,
  findAiTells,
  findAxisReversals,
  findBannedWordsTier1,
  findCliches,
  findCrutchWords,
  findDialogueTagVariety,
  findFilterWords,
  findFirstLetterClusters,
  findGestures,
  findHedgeWords,
  findItalicThoughts,
  findModifierStacking,
  findNegativeAssertions,
  findNotJustButPatterns,
  findNotSayingPatterns,
  findPassiveVoice,
  findRepeatedOpeners,
  findSaidBookisms,
  findShotTypeMonotony,
  findStructuralTics,
  findSuspiciousWordClusters,
  findTheWaySimiles,
  findTriadicShortSentences,
  findUnattributedDialogueRuns,
  findWordEchoes,
  measureSentenceRhythm,
  normalizeName,
  paragraphLengthUniformity,
  parseComicScript,
  renderCharacterArcsForPrompt,
  splitScenes,
  summarizeStoryboardShots,
  transitionOpenerRatio,
  canonHasRevealGated,
  revealGatedCanonRows,
  z,
};


export const CHECK_SCOPES = Object.freeze(['series', 'issue', 'scene', 'noun']);

// A check's `scope` may be a single scope string OR an array of scopes (#1628).
// A dual-scope check is one rule meaningful at more than one granularity — e.g.
// `relationships.reciprocity` reasons series-wide but could also flag a newly
// added relationship per issue — declared `scope: ['series', 'issue']` instead of
// being split into two near-duplicate checks. These helpers normalize either form
// so every consumer (the load-time guard, the catalog grouping, the dry-run plan)
// fans a check across exactly its declared scopes.
//
// `normalizeCheckScopes` returns the declared scopes deduped and in canonical
// CHECK_SCOPES order; an unknown/empty input returns []. `primaryCheckScope`
// returns the first declared scope (canonical order) for the consumers that still
// bucket/sort by a single value — for a single-scope check it is just that scope.
export function normalizeCheckScopes(scope) {
  const raw = Array.isArray(scope) ? scope : (scope == null ? [] : [scope]);
  return CHECK_SCOPES.filter((s) => raw.includes(s));
}

export const primaryCheckScope = (scope) => normalizeCheckScopes(scope)[0] || null;

export const CHECK_KINDS = Object.freeze(['deterministic', 'llm']);
export const CHECK_SEVERITIES = Object.freeze(['high', 'medium', 'low']);
export const SEVERITIES = CHECK_SEVERITIES;

// The inputs a check can read, declared per-check via `sources` (#1387). The
// staleness runner (server/services/pipeline/editorial/checkRunner.js) fingerprints
// EXACTLY a check's declared sources, so a finding only goes stale when content
// the check actually analyzed drifts — editing the style guide no longer marks a
// naming finding stale, and editing the ticking clock no longer marks every
// canon-only finding stale. Every token here must have a matching resolver in the
// runner's `SOURCE_RESOLVERS` (a load-time guard there fails fast if they drift).
//   - 'manuscript'              — the stitched manuscript corpus (implies needsManuscript)
//   - 'canon'                   — the universe/series canon (characters, relationships, objects)
//   - 'continuityBible'         — the series CONTINUITY-BIBLE facts ledger (#1305): the
//                                 extracted ground-truth facts the timeline/canon-contradiction
//                                 check (#1581) reconciles the prose against — `[{ category,
//                                 subject, statement, issueNumber }]` across the bible's
//                                 categories (physical, age, dates/elapsed time, location,
//                                 possession, world rules, who-knows-what). The runner fetches
//                                 it via `getFactsLedger` (gated on this source) and injects
//                                 `ctx.continuityBible` (the facts array).
//   - 'series.styleGuide'       — the series style guide (tense/POV/rating/reading level)
//   - 'series.arc.tickingClock' — the series arc's ticking clock
//   - 'reverseOutline'          — the cached reverse-outline scene segmentation (#1286);
//                                 scenes carry components/povCharacter/charactersPresent.
//                                 The runner fetches it (gated on this source) and injects
//                                 `ctx.reverseOutline` (the scenes array).
//   - 'reverseOutline.plotlines' — the cached reverse-outline's PLOTLINE list (#1286):
//                                 `[{ id, label, kind, color }]` plus the per-scene
//                                 `plotlineId`/`secondaryPlotlineId` tags. The runner fetches
//                                 the outline (gated on this source) and injects
//                                 `ctx.reverseOutlinePlotlines`. The plot-structure check (#1310)
//                                 reconciles dropped subplots against these tagged plotlines —
//                                 which start and then fizzle without a resolution scene.
//   - 'series.arc.readerMap'    — the series arc's authored reader-map (#1299): the
//                                 writer-logged hooks (questions planted) and payoffs
//                                 (their resolutions). The Chekhov check reconciles its
//                                 detected setups/payoffs against these authored ones.
//   - 'editorialArcs'           — the detected per-character arc directions from the series
//                                 editorial analysis aggregate (#1295). The runner fetches it
//                                 (gated on this source) and injects `ctx.editorialArcs`
//                                 (`[{ name, arcDirection, issueCount, isProtagonist }]`). This
//                                 is the coarse, DETECTED arc signal — distinct from the
//                                 AUTHORED `series.characterArcs` model below.
//   - 'series.characterArcs'    — the AUTHORED per-character story arcs (#1293):
//                                 `series.characterArcs[]` (`{ characterId, characterName,
//                                 want, need, startState, endState, transitions[] }`). The
//                                 arc.transitions check reconciles detected change moments
//                                 against these authored transitions + flat-arc warnings.
//   - 'storyboard.shots'        — the per-issue storyboard shot lists
//                                 (`stages.storyboards.scenes[].shots[]`) the
//                                 visual-continuity check (#1315) reasons over:
//                                 each shot carries `shotType` / `screenDirection`
//                                 / `continuityFromShotId` (server/lib/shotGrammar.js).
//                                 Served off the already-loaded `ctx.issues` (no
//                                 extra I/O); the runner injects `ctx.storyboardScenes`
//                                 (a flat list of `{ issueNumber, scene }` for every
//                                 issue that has storyboard scenes).
//   - 'comicScript'             — every issue's AUTHORITATIVE comic content, keyed by
//                                 issue number: the edited comic-pages split
//                                 (`stages.comicPages.pages[]`) when present, else the
//                                 generated `stages.comicScript.output`. The
//                                 lettering-density check (#1313) counts per-panel/per-page
//                                 word + balloon load over it (caption/dialogue/SFX only).
//                                 Both comic-source checks read the same parsed pages via
//                                 `comicLetteringIssues(ctx.issues)` (`[{ number, pages }]`);
//                                 the runner fingerprints ONLY the lettering fields for this
//                                 token, so a visual-description edit doesn't stale a
//                                 lettering finding.
//   - 'comicScript.pacing'      — the same parsed comic pages, for the page-turn-beats
//                                 LLM check (#1314), which reads each panel's visual
//                                 `description` (+ caption/dialogue/SFX text) for its prompt
//                                 digest. Distinct token from 'comicScript' because that
//                                 broader read means a description edit must stale a page-turn
//                                 finding while the lettering token stays put (and vice-versa).
//   - 'comicScript.layout'      — LAYOUT ONLY (per-page panel COUNT) for the panel-rhythm
//                                 check (#1314), which reads nothing but counts. Separate from
//                                 'comicScript.pacing' so a text-only edit (reword a caption /
//                                 description without adding/removing a panel) does NOT stale a
//                                 rhythm finding — the splash/crowding/grid verdict can't have
//                                 changed. All three comic tokens share `ctx.issues` (no extra I/O).
export const EDITORIAL_SOURCES = Object.freeze([
  'manuscript',
  'canon',
  'continuityBible',
  'series.styleGuide',
  'series.arc.tickingClock',
  'series.arc.readerMap',
  // The authored foreshadowing ledger (#2172): the arc-overview-emitted
  // plant → reinforce → payoff seeds the Chekhov check reconciles its detected
  // setups/payoffs against. Lives on the already-loaded series record (no extra
  // I/O); fingerprinting it stales Chekhov findings when the author edits the ledger.
  'series.arc.foreshadowing',
  'series.arc.themes',
  // The author-supplied real-world fact reference the opt-in research.fact-accuracy
  // check reconciles the prose against (#1588). Lives on the already-loaded series
  // record (no extra I/O); fingerprinting it stales fact findings when the author
  // edits the reference.
  'series.factReference',
  'reverseOutline',
  'reverseOutline.plotlines',
  'editorialArcs',
  'series.characterArcs',
  'storyboard.shots',
  'comicScript',
  'comicScript.pacing',
  'comicScript.layout',
  // Each issue's PROSE-stage text SPECIFICALLY (#1589) — NOT the default manuscript
  // precedence (comicScript ▸ teleplay ▸ prose), which for a hybrid issue returns
  // the comic script. The comic↔prose-sync check reads this to compare prose against
  // the comic; fingerprinting it separately means a prose edit stales a sync finding
  // without a comic-only edit doing so (and vice-versa, via comicScript.pacing).
  'prose',
]);

// Default per-run finding cap for user-defined checks (#1346) — mirrors the
// built-in LLM checks' `maxFindings` default so a long manuscript can't flood
// the review. Defined up here so the custom-check prompt builder and config
// schema (both below) share one source.
export const CUSTOM_CHECK_MAX_FINDINGS_DEFAULT = 12;

// The serializable config-field types a check can declare for its UI form.
// `configSchema` (a Zod schema) stays the validation authority on the server;
// `configFields` is the wire-safe *render* descriptor the Editorial Checks UI
// reads to build the per-check config form (the Zod schema can't cross the wire).
// Keep this in lockstep with the controls EditorialCheckCard's ConfigField
// renders — only advertise a type the UI can actually draw (no 'select' until
// the <select> control + an `options` contract land).
export const CHECK_FIELD_TYPES = Object.freeze(['number', 'boolean', 'text']);

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

// Stage name for the cliché / dead-metaphor / overwriting LLM check (#1308).
// Ships in data.reference/prompts/stages/ + stage-config.json (fresh installs
// via setup-data.js) and migrates to existing installs via migration 101 (boot
// runs migrations but NOT setup-data, so the migration is required). The
// deterministic siblings (prose.cliches, prose.modifier-stacking) need no stage.
export const DEAD_METAPHOR_STAGE = 'pipeline-editorial-dead-metaphor';

// Stage names for the four LLM prose anti-pattern checks (#1300). Each prompt
// ships in data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migrations 103–106 (boot
// runs migrations but NOT setup-data, so the migration is required — see
// scripts/migrations/103-…js … 106-…js). The deterministic sibling
// (prose.italic-thoughts) needs no stage.
export const OPENING_START_STAGE = 'pipeline-editorial-opening-start';
export const MIRROR_DESCRIPTION_STAGE = 'pipeline-editorial-mirror-description';
export const DIALOGUE_PLEASANTRIES_STAGE = 'pipeline-editorial-dialogue-pleasantries';
export const KILL_YOUR_DARLINGS_STAGE = 'pipeline-editorial-kill-your-darlings';

// Stage name for the adversarial-cuts prose-tightening LLM check (#2168). Ships
// in data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js); new file so no migration needed. Asks a ruthless editor
// persona to cut 8–12% of the text, classifying each cut (FAT, REDUNDANT,
// OVER-EXPLAIN, GENERIC, TELL, STRUCTURAL). Safe types (OVER-EXPLAIN, REDUNDANT)
// can be batch-applied mechanically.
export const ADVERSARIAL_CUTS_STAGE = 'pipeline-editorial-adversarial-cuts';

// The six cut types the adversarial-cuts check returns, ordered by safe-to-auto-
// apply (the first two are the "safe majority" per the design doc). The applier
// defaults to OVER-EXPLAIN + REDUNDANT only; other types require manual review.
export const CUT_TYPES = Object.freeze([
  'OVER-EXPLAIN',
  'REDUNDANT',
  'FAT',
  'GENERIC',
  'TELL',
  'STRUCTURAL',
]);
// The subset that can be auto-applied without manual review.
export const SAFE_CUT_TYPES = Object.freeze(['OVER-EXPLAIN', 'REDUNDANT']);

// Stage names for the two scene-grounding LLM checks (#1309): sensory balance
// (all-visual / sensory-bare scenes) and white-room (ungrounded, setting-less
// scenes). Each prompt ships in data.reference/prompts/stages/ + stage-config.json
// (fresh installs via setup-data.js) and migrates to existing installs via
// migration 107 (boot runs migrations but NOT setup-data, so the migration is
// required). Both consume the reverse-outline scene segmentation as context and
// degrade to a whole-issue manuscript scan when no outline exists.
export const SENSORY_BALANCE_STAGE = 'pipeline-editorial-sensory-balance';
export const WHITE_ROOM_STAGE = 'pipeline-editorial-white-room';

// Stage name for the interiority-balance LLM check (#1623): visually dense but
// emotionally empty scenes — heavy on description, light on POV reaction. Ships
// in data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 142 (boot runs
// migrations but NOT setup-data, so the migration is required). Like the two
// scene-grounding checks above it consumes the reverse-outline scene
// segmentation as context and degrades to a whole-issue manuscript scan when no
// outline exists.
export const INTERIORITY_BALANCE_STAGE = 'pipeline-editorial-interiority-balance';

// Stage name for the character-arc transition-detection LLM check (#1293). Ships
// in data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 109 (boot runs
// migrations but NOT setup-data, so the migration is required). Reads the
// stitched manuscript plus the reverse-outline scene map and the AUTHORED
// per-character arcs to surface genuine change moments + flat-arc warnings.
export const ARC_TRANSITIONS_STAGE = 'pipeline-editorial-arc-transitions';

// Stage name for the character-arc regression / premature-closure LLM check
// (#1619). Ships in data.reference/prompts/stages/ + stage-config.json (fresh
// installs via setup-data.js) and migrates to existing installs via migration 141
// (boot runs migrations but NOT setup-data, so the migration is required). Reads
// the stitched manuscript plus the reverse-outline scene map and the AUTHORED
// per-character arcs, tracks each character's progress across the issues, and
// flags regression (growth then an unmotivated revert), a circular arc (ends
// where it began), or premature closure (an arc resolved early then flat for the
// rest of the series). Complements arc.transitions (which detects the change
// MOMENTS) by judging the SHAPE of each character's progress across the whole arc.
export const ARC_REGRESSION_STAGE = 'pipeline-editorial-arc-regression';

// Stage name for the telling-not-showing-emotion LLM check (#1306). Ships in
// data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 110 (boot runs
// migrations but NOT setup-data, so the migration is required). The deterministic
// copy-edit siblings (prose.filter-words, prose.crutch-words, prose.adverbs,
// prose.passive-voice, prose.repeated-gestures, prose.word-echoes,
// prose.sentence-rhythm) need no stage.
export const TELLING_EMOTION_STAGE = 'pipeline-editorial-telling-emotion';

// Stage names for the two dialogue-craft LLM checks (#1307): on-the-nose /
// subtext-free dialogue, and per-character voice distinctiveness. Each prompt
// ships in data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migrations 112–113 (boot
// runs migrations but NOT setup-data, so the migration is required). The
// deterministic siblings (dialogue.said-bookisms, dialogue.attribution-clarity)
// need no stage.
export const ON_THE_NOSE_STAGE = 'pipeline-editorial-on-the-nose';
export const VOICE_DISTINCTIVENESS_STAGE = 'pipeline-editorial-voice-distinctiveness';

// Finding subtypes for `dialogue.on-the-nose` (#1626) — the stage prompt classifies
// each subtext-free line into *why* it reads on-the-nose so the writer gets specific,
// actionable feedback instead of a flat "on-the-nose" label. Surfaced on the finding
// (and persisted comment) as `subtype`; the runner validates the model's value against
// this allow-list and drops anything off-list (→ null) so a stray label can't leak through.
export const ON_THE_NOSE_SUBTYPES = ['exposition', 'emotion-tell', 'relationship-report'];

// Stage name for the narrator voice / tone-consistency LLM check (#1586) — the
// narration-level sibling of voice-distinctiveness (which covers per-CHARACTER
// dialogue). Ships in data.reference/prompts/stages/ + stage-config.json (fresh
// installs via setup-data.js) and migrates to existing installs via migration 134
// (boot runs migrations but NOT setup-data, so the migration is required).
export const VOICE_CONSISTENCY_STAGE = 'pipeline-editorial-voice-consistency';

// Render each canon character's authored voice fields into a compact text block
// the voice-distinctiveness LLM check passes alongside the manuscript, so the
// model can flag lines that contradict a character's recorded speechPattern /
// speechAccent (closing the "voice fields feed generation only" gap, #1307) and
// reason about whether characters sound distinct from one another. Pure +
// deterministic so it's unit-testable and its token cost can be counted into the
// per-chunk overhead. Returns '' when no character carries a voice field (the
// prompt's {{#voiceProfiles}} section then renders nothing and the check
// degrades to a pure interchangeability scan).
export function characterVoiceProfiles(canon) {
  const chars = Array.isArray(canon?.characters) ? canon.characters : [];
  const lines = [];
  for (const c of chars) {
    if (!c || typeof c !== 'object') continue;
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (!name) continue;
    const pattern = typeof c.speechPattern === 'string' ? c.speechPattern.trim() : '';
    const accent = typeof c.speechAccent === 'string' ? c.speechAccent.trim() : '';
    if (!pattern && !accent) continue;
    const parts = [`- ${name}`];
    if (pattern) parts.push(`speech pattern: ${pattern}`);
    if (accent) parts.push(`accent/dialect: ${accent}`);
    lines.push(parts.join(' — '));
  }
  if (!lines.length) return '';
  return `Authored character voices (canon speechPattern / speechAccent):\n${lines.join('\n')}`;
}

// Render the series style guide's INTENDED narrative voice — the authored `tone`
// words (e.g. "witty", "grim", "lyrical") — into a compact block the narrator
// voice-consistency check (#1586) passes alongside the manuscript, so the model
// can measure each issue's narration against the declared intent, not just
// against the other issues. Pure + deterministic so it's unit-testable and its
// token cost counts into the per-chunk overhead. Type-guarded (styleGuide rides
// peer sync, so a hand-edited / older-peer guide could carry a non-array `tone`
// or non-string entries). Returns '' when the guide declares no tone (the
// prompt's {{#intendedVoice}} section then renders nothing and the check degrades
// to a pure cross-issue consistency scan).
export function intendedVoiceSummary(styleGuide) {
  const raw = Array.isArray(styleGuide?.tone) ? styleGuide.tone : [];
  const tone = raw
    .filter((t) => typeof t === 'string' && t.trim())
    .map((t) => t.trim());
  if (!tone.length) return '';
  return `Style guide — intended narrative tone/voice: ${tone.join(', ')}.`;
}

// Render each canon character's contradiction-relevant FACTS into a compact text
// block the timeline / canon-contradiction check (#1581) passes alongside the
// manuscript, so the model can reconcile the prose against the established bible:
// a character the bible records at age 16 who reads "in her 30s" on the page, a
// role/status the prose contradicts, or a description the prose breaks. Pure +
// deterministic so it's unit-testable and its token cost can be counted into the
// per-chunk overhead. Type-guarded throughout (canon rides peer sync, so a
// hand-edited / older-peer character could carry a non-string field a bare
// `.trim()` would throw on — and `age` is commonly stored as a number). Reuses
// `characterNameTokens` so name + aliases render with the same trim/de-dup the
// matcher uses. Returns '' when no character carries both a usable name AND a
// renderable fact (the prompt's `{{#canonStates}}` section then renders nothing
// and the check reasons from the prose + scene map alone).
const CANON_STATE_FACT_CHARS = 240;
export function canonCharacterStatesSummary(canon) {
  const chars = Array.isArray(canon?.characters) ? canon.characters : [];
  const cleanStr = (v) => (typeof v === 'string' ? v.trim() : '');
  const rows = [];
  for (const c of chars) {
    if (!c || typeof c !== 'object') continue;
    // Require a real name — an alias-only row isn't a named character (mirrors
    // canonRosterNamesSummary, which skips nameless rows). characterNameTokens then
    // returns the trimmed name first, followed by de-duped aliases.
    if (typeof c.name !== 'string' || !c.name.trim()) continue;
    const [name, ...aliases] = characterNameTokens(c);
    const facts = [];
    // `age` is often a number in the bible — accept a finite number or a non-empty string.
    const age = typeof c.age === 'number' && Number.isFinite(c.age) ? String(c.age) : cleanStr(c.age);
    if (age) facts.push(`age ${age}`);
    const role = cleanStr(c.role);
    if (role) facts.push(`role: ${role}`);
    const status = cleanStr(c.status);
    if (status) facts.push(`status: ${status}`);
    // physicalDescription is the richer bible field; fall back to a generic description.
    const description = (cleanStr(c.physicalDescription) || cleanStr(c.description)).slice(0, CANON_STATE_FACT_CHARS);
    if (description) facts.push(`described as: ${description}`);
    if (!facts.length) continue;
    const who = aliases.length ? `${name} (also: ${aliases.join(', ')})` : name;
    rows.push(`- ${who} — ${facts.join('; ')}`);
  }
  if (!rows.length) return '';
  return `Canon character facts (the established bible — reconcile the prose against these):\n${rows.join('\n')}`;
}

// Render each canon character's PERSONALITY-relevant traits into a compact text
// block the character-consistency check (#1582) passes alongside the manuscript,
// so the model can flag an UNEARNED shift: a reserved character suddenly cracking
// jokes, an established fear/allergy silently contradicted, a voice that drifts
// off the authored speech pattern. Distinct from `canonCharacterStatesSummary`
// (age/role/status/described-as — the contradiction-of-FACTS grounding the
// timeline check reads) and from `characterVoiceProfiles` (speech only): this is
// the temperament/traits grounding. Pure + deterministic so it's unit-testable
// and its token cost can be counted into the per-chunk overhead. Type-guarded
// throughout (canon rides peer sync, so a hand-edited / older-peer character
// could carry a non-string field a bare `.trim()` would throw on, and
// mannerisms/likes/dislikes are commonly arrays). Reuses `characterNameTokens` so
// name + aliases render with the same trim/de-dup the matcher uses. Returns ''
// when no character carries both a usable name AND a renderable trait (the
// prompt's `{{#canonTraits}}` section then renders nothing and the check reasons
// from the prose alone).
const CANON_TRAIT_FACT_CHARS = 240;
export function canonCharacterTraitsSummary(canon) {
  const chars = Array.isArray(canon?.characters) ? canon.characters : [];
  const cleanStr = (v) => (typeof v === 'string' ? v.trim() : '');
  // mannerisms / likes / dislikes are commonly arrays of short strings in the
  // bible; render the first few as a comma list. Tolerates a plain string too.
  const cleanList = (v) => {
    if (typeof v === 'string') return v.trim();
    if (!Array.isArray(v)) return '';
    return v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean).slice(0, 5).join(', ');
  };
  const rows = [];
  for (const c of chars) {
    if (!c || typeof c !== 'object') continue;
    // Require a real name — an alias-only row isn't a named character (mirrors
    // canonCharacterStatesSummary). characterNameTokens returns the trimmed name
    // first, followed by de-duped aliases.
    if (typeof c.name !== 'string' || !c.name.trim()) continue;
    const [name, ...aliases] = characterNameTokens(c);
    const facts = [];
    const personality = cleanStr(c.personality).slice(0, CANON_TRAIT_FACT_CHARS);
    if (personality) facts.push(`personality: ${personality}`);
    const specialTraits = cleanStr(c.specialTraits).slice(0, CANON_TRAIT_FACT_CHARS);
    if (specialTraits) facts.push(`fixed traits: ${specialTraits}`);
    const mannerisms = cleanList(c.mannerisms);
    if (mannerisms) facts.push(`mannerisms: ${mannerisms}`);
    const motivations = cleanStr(c.motivations).slice(0, CANON_TRAIT_FACT_CHARS);
    if (motivations) facts.push(`motivations: ${motivations}`);
    const likes = cleanList(c.likes);
    if (likes) facts.push(`likes: ${likes}`);
    const dislikes = cleanList(c.dislikes);
    if (dislikes) facts.push(`dislikes: ${dislikes}`);
    const speechPattern = cleanStr(c.speechPattern);
    if (speechPattern) facts.push(`speech: ${speechPattern}`);
    if (!facts.length) continue;
    const who = aliases.length ? `${name} (also: ${aliases.join(', ')})` : name;
    rows.push(`- ${who} — ${facts.join('; ')}`);
  }
  if (!rows.length) return '';
  return `Canon character traits (the established bible — a shift away from these must be earned on the page):\n${rows.join('\n')}`;
}

// Human-readable labels for the continuity-bible fact categories (#1305). Inlined
// (not imported from server/services/pipeline/continuityBible.js) to keep this
// registry PURE — that module pulls in I/O + an SSE runner. Mirrors its
// `FACT_CATEGORIES`; a category absent from this map falls back to its raw id, so
// a new bible category still renders (just without a prettied label) until it's
// added here.
const CONTINUITY_CATEGORY_LABELS = Object.freeze({
  physical: 'Physical traits',
  age: 'Ages & birthdays',
  timeline: 'Dates & elapsed time',
  location: 'Locations & geography',
  possession: 'Possessions & wardrobe',
  'world-rule': 'World rules',
  knowledge: 'Who knows what, when',
});

// Render the continuity-bible facts ledger (#1305) into a compact text block the
// timeline / canon-contradiction check (#1581) passes alongside the manuscript, so
// the model reconciles the prose against the established ground-truth facts the
// bible already extracted — ages/birthdays, dates & elapsed time, locations, world
// rules, who-knows-what — which the shallow per-character canon fields don't carry.
// Facts are grouped by category (in the stable category order) and tagged with the
// issue they were established in, when known, so the model can reason about WHEN a
// fact held. Pure + deterministic so it's unit-testable and its token cost can be
// counted into the per-chunk overhead. Type-guarded throughout (the ledger rides
// peer sync, so a hand-edited / older-peer fact could carry a non-string field).
// Returns '' when there are no usable facts (the prompt's `{{#continuityLedger}}`
// section then renders nothing and the check falls back to the canon fields + prose).
export function continuityLedgerSummary(facts) {
  const list = Array.isArray(facts) ? facts : [];
  const byCategory = new Map();
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const category = typeof f.category === 'string' ? f.category.trim() : '';
    const subject = typeof f.subject === 'string' ? f.subject.trim() : '';
    const statement = typeof f.statement === 'string' ? f.statement.trim() : '';
    if (!category || !statement) continue;
    const where = Number.isInteger(f.issueNumber) ? ` (Issue ${f.issueNumber})` : '';
    const line = subject ? `- ${subject}: ${statement}${where}` : `- ${statement}${where}`;
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(line);
  }
  if (!byCategory.size) return '';
  // Render known categories in their canonical order first, then any unknown
  // category (a newer-peer addition) after, so the block is stable + complete.
  const order = [...Object.keys(CONTINUITY_CATEGORY_LABELS), ...byCategory.keys()];
  const seen = new Set();
  const blocks = [];
  for (const category of order) {
    if (seen.has(category) || !byCategory.has(category)) continue;
    seen.add(category);
    const label = CONTINUITY_CATEGORY_LABELS[category] || category;
    blocks.push(`${label}:\n${byCategory.get(category).join('\n')}`);
  }
  return `Continuity bible facts (established ground truth — reconcile the prose against these):\n\n${blocks.join('\n\n')}`;
}

// Stage name for the plot-structure & momentum LLM check (#1310). Ships in
// data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 111 (boot runs
// migrations but NOT setup-data, so the migration is required). Reads the
// stitched manuscript plus the reverse-outline scene map + plotline coverage and
// the authored reader-map/arc to surface macro pathologies — passive protagonist,
// deus ex machina, idiot plot, flat/unclear stakes, sagging middle, and dropped
// subplots reconciled against the tagged plotlines.
export const PLOT_STRUCTURE_STAGE = 'pipeline-editorial-plot-structure';

// Stage names for the worldbuilding-doctrine LLM check pair (#2175). Both ship in
// data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and reach existing installs via the multi-stage seed migration
// 167 (boot runs migrations but NOT setup-data, so the migration is required or
// the check throws "Stage not found" on first run). Both reconcile the prose against the
// canon world summary (`canonWorldSummary`) + the continuity-bible world-rule
// facts so an established-and-planted rule is NOT flagged:
//   - unforeshadowed-solution: a plot problem solved by a rule/power the reader was
//     never shown — deus ex machina's worldbuilding sibling.
//   - cost-free-power: an ability used at a decisive moment with no cost/limitation
//     on the page (violates "limitations > powers").
export const WORLD_UNFORESHADOWED_SOLUTION_STAGE = 'pipeline-editorial-world-unforeshadowed-solution';
export const WORLD_COST_FREE_POWER_STAGE = 'pipeline-editorial-world-cost-free-power';

// Stage name for the series-wide pacing / intensity escalation-curve LLM check
// (#1618). Ships in data.reference/prompts/stages/ + stage-config.json (fresh
// installs via setup-data.js) and migrates to existing installs via migration 140
// (boot runs migrations but NOT setup-data, so the migration is required). Reads
// the stitched manuscript plus the reverse-outline scene map and a deterministic
// per-issue conflict-marker density tally, and scores the per-issue dramatic
// intensity to flag a flat curve (issue 1 ≈ issue N), a front-loaded climax (the
// biggest beat lands early), or stakes that plateau / de-escalate across the arc.
// Complements plot.structure-momentum (flat stakes as one signal among many) by
// focusing the lens on the whole-series escalation shape.
export const PACING_ESCALATION_STAGE = 'pipeline-editorial-pacing-escalation-curve';

// Stage name for the timeline / canon-contradiction LLM check (#1581). Ships in
// data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 129 (boot runs
// migrations but NOT setup-data, so the migration is required). Reads the stitched
// manuscript plus the established canon character facts, the reverse-outline scene
// ordering, and the authored per-character arcs to surface internal contradictions
// — a dead character who reappears alive, an age that contradicts the bible, or an
// impossible chronology.
export const TIMELINE_CONTRADICTION_STAGE = 'pipeline-editorial-timeline-contradiction';

// Stage name for the research / fact-accuracy LLM check (#1588). Ships in
// data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 135 (boot runs
// migrations but NOT setup-data, so the migration is required). Reconciles the
// stitched manuscript against the author-supplied real-world fact reference
// (`series.factReference`) — a prose claim that contradicts a documented external
// fact (geography, history, physics/physiology). Opt-in and gated on the
// `series.factCritical` flag so it never fires on pure fantasy.
export const FACT_ACCURACY_STAGE = 'pipeline-editorial-fact-accuracy';

// Stage name for the character-consistency / unearned-personality-shift LLM check
// (#1582). Ships in data.reference/prompts/stages/ + stage-config.json (fresh
// installs via setup-data.js) and migrates to existing installs via migration 130
// (boot runs migrations but NOT setup-data, so the migration is required). Reads
// the stitched manuscript plus the established canon character TRAITS (personality,
// fixed traits, mannerisms, speech), the reverse-outline scene ordering, and the
// authored per-character arcs — and flags a shift the prose never earns: a reserved
// character cracking jokes with no beat, a fear/allergy silently contradicted, or
// POV knowledge that changes mid-scene with no on-page learning. Reconciles against
// the authored arcs so an intentional, earned transition is NOT flagged.
export const CHARACTER_CONSISTENCY_STAGE = 'pipeline-editorial-character-consistency';

// Stage name for the head-hopping / POV-discipline LLM check (#1311). Ships in
// data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 112 (boot runs
// migrations but NOT setup-data, so the migration is required). Distinct from
// pov.justified (#1295, which asks whether each POV character earns an arc); this
// check polices POV *discipline* within a scene — narration that enters another
// character's head or reports what the POV character can't perceive.
export const HEAD_HOPPING_STAGE = 'pipeline-editorial-head-hopping';

// Stage name for the comic page-turn-beats LLM check (#1314). Ships in
// data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 117 (boot runs
// migrations but NOT setup-data, so the migration is required). Reads each issue's
// parsed comic-page layout (`comicPageTurnSummary`) plus the authored reveals /
// cliffhangers (`authoredRevealSummary`) and flags big reveals placed where the
// reader sees them early (a page the reader has already been looking at across the
// spread, rather than the first page after a turn). The deterministic sibling
// (comic.panel-rhythm) needs no stage.
export const COMIC_PAGE_TURN_STAGE = 'pipeline-editorial-comic-page-turn';

// Stage name for the theme-coherence / thematic-throughline LLM check (#1317).
// Ships in data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 115 (boot runs
// migrations but NOT setup-data, so the migration is required). Reads the stitched
// manuscript plus the AUTHORED arc themes (series.arc.themes) and the reverse-outline
// scene map, and reconciles whether each declared theme is set up / complicated /
// paid off — surfacing stated-but-undramatized themes, dropped themes, a strong
// emergent theme not in the arc, and a climax that resolves plot but not theme.
export const THEME_COHERENCE_STAGE = 'pipeline-editorial-theme-coherence';

// Render the authored arc themes (#1317) into a compact text block the
// theme-coherence check passes alongside the manuscript, so the model reconciles
// whether the prose actually sets up / complicates / pays off each DECLARED theme
// (vs. stating it but never dramatizing it, or dropping it after the opening).
// Pure + deterministic so it's unit-testable and its token cost can be counted
// into the per-chunk overhead. Returns '' when no themes are authored (the
// prompt's `{{#declaredThemes}}` section then renders nothing and the check still
// runs to detect a strong emergent theme).
export function declaredThemesSummary(themes) {
  const lines = (Array.isArray(themes) ? themes : [])
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter(Boolean)
    .map((t) => `- ${t}`);
  if (!lines.length) return '';
  return `Declared themes (authored on the story arc):\n${lines.join('\n')}`;
}

// Stage name for the climax / resolution-power LLM check (#1583). Ships in
// data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 131 (boot runs
// migrations but NOT setup-data, so the migration is required). Reads the stitched
// manuscript plus the authored reader-map payoffs (series.arc.readerMap) and the
// declared themes (series.arc.themes) and the reverse-outline scene ordering, and
// judges whether the CLIMAX is the protagonist's hardest, most active choice (vs.
// a passive climax where an ally rescues them or events simply resolve around
// them) AND whether it resolves the story's core problem/theme (vs. a plot climax
// that lands the action but leaves the emotional/thematic core unanswered).
// Complements plot.structure-momentum (which flags a passive protagonist arc-wide;
// this one focuses the lens on the single payoff scene). The climax can only be
// judged once the whole manuscript is in view, so the run gates its verdict on the
// final part (`finalPart`); degrades to a prose-only scan when no reader-map,
// themes, or outline exist.
export const CLIMAX_AGENCY_STAGE = 'pipeline-editorial-climax-agency';

// Stage name for the emotional-beat / reaction-proportionality LLM check (#1584).
// Ships in data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 132 (boot runs
// migrations but NOT setup-data, so the migration is required). Reads the stitched
// manuscript plus the reverse-outline scene map and judges whether each character's
// emotional reactions are PROPORTIONATE to the magnitude of the events that befall
// them: a high-magnitude event (trauma, death, betrayal, a major loss or win) that
// draws no on-page reaction and is never processed afterward (under-reaction), or a
// minor setback that triggers grief/rage out of all proportion (over-reaction).
// Because an unprocessed event in an early issue can stay unaddressed many issues
// later, the run carries high-magnitude events still awaiting a proportionate
// reaction across chunks (`crossChunkSetup`) so a later part can flag the missing
// payoff; degrades to a prose-only scan when no outline exists.
export const REACTION_PROPORTIONALITY_STAGE = 'pipeline-editorial-reaction-proportionality';

// Stage name for the secondary (non-POV) character-arc LLM check (#1585). Ships
// in data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 133 (boot runs
// migrations but NOT setup-data, so the migration is required). The sibling of
// pov.justified (#1295), which covers POV characters only: this check judges the
// RECURRING NON-POV cast — characters who appear in multiple scenes but never
// hold the viewpoint — and flags those who never change (a flat side character
// who is the same at the end as the start) or who regress without purpose. Reads
// the stitched manuscript plus the reverse-outline scene map (to tally which
// non-POV characters recur and weigh their presence) and the canon roster (so a
// genuinely-minor walk-on isn't held to an arc). Because a flat arc is a
// whole-story claim, the run gates its verdict on the final part (`finalPart`)
// and carries each recurring secondary character's established state forward
// across chunks (`crossChunkSetup`); degrades to a prose-only scan when no
// outline exists.
export const SECONDARY_ARC_STAGE = 'pipeline-editorial-secondary-arc';

// Stage name for the unmodeled-proper-nouns LLM check (#1412). Ships in
// data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 116 (boot runs
// migrations but NOT setup-data, so the migration is required). Reads the stitched
// manuscript plus the canon roster (names + aliases) and asks the model to surface
// capitalized proper nouns used as apparent CHARACTER names that are absent from
// canon — the LLM-assisted half of roster economy (#1292) the deterministic
// `roster.economy` scan deliberately leaves alone (it can't tell a person from a
// place/org/brand/honorific).
export const UNMODELED_NAMES_STAGE = 'pipeline-editorial-unmodeled-names';

// Stage name for the eyeline-match continuity LLM check (#1466). Ships in
// data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 117 (boot runs
// migrations but NOT setup-data, so the migration is required). Reads the per-issue
// storyboard shots (`ctx.storyboardScenes`, wired by #1315 — the same source the
// deterministic `visual.shot-continuity` check reads) and asks the model to flag
// eyeline-match breaks WITHIN a scene: two characters in conversation whose gaze
// directions don't reciprocate across the cut, or a described eyeline that
// contradicts the shot's screen direction. The judgment sibling the deterministic
// 180°/shot-type scan deliberately leaves to an LLM (see shotContinuity.js).
export const EYELINE_MATCH_STAGE = 'pipeline-editorial-eyeline-match';

// Stage name for the appearance/prop-continuity LLM check (#1467). Ships in
// data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 118 (boot runs
// migrations but NOT setup-data, so the migration is required). Reads the same
// per-issue storyboard shots (`ctx.storyboardScenes`, wired by #1315) the eyeline
// sibling reads and asks the model to DIFF descriptions of the same entity across
// shots WITHIN a scene: a character's wardrobe/appearance that contradicts an
// earlier shot, a prop that appears/vanishes/transforms with nothing removing it,
// or a setting whose weather/time/layout flips with no transition. The semantic
// sibling the deterministic 180°/shot-type scan can't catch (the shot parser
// matches characters by name but never diffs their free-text descriptions).
export const APPEARANCE_CONTINUITY_STAGE = 'pipeline-editorial-appearance-continuity';

// Stage name for the comic ↔ prose synchronization LLM check (#1589). Ships in
// data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 136 (boot runs
// migrations but NOT setup-data, so the migration is required). For a hybrid
// comic+prose issue it pairs the issue's PROSE (its prose stage) with its
// authoritative COMIC content (description + dialogue + caption + SFX — the same
// fields the `comicScript.pacing` source carries) and asks the model to flag
// SUBSTANTIVE cross-media divergences: a plot beat the prose narrates that no
// panel shows, panel dialogue that contradicts the prose, or a chronology
// disagreement across the two media. Comics legitimately compress and cut, so the
// prompt is tuned to ignore ordinary medium-translation trims.
export const COMIC_PROSE_SYNC_STAGE = 'pipeline-editorial-comic-prose-sync';

// Render the canon roster's names + aliases (#1412) into a compact text block the
// unmodeled-names check passes alongside the manuscript, so the model knows which
// proper nouns are ALREADY modeled (and therefore must NOT be flagged) and only
// surfaces apparent character names absent from this list. Pure + deterministic so
// it's unit-testable and its token cost can be counted into the per-chunk overhead.
// Returns '' when no canon character has a usable name (the prompt's
// `{{#knownCharacters}}` section then renders nothing and EVERY named proper noun in
// the prose is a candidate — exactly right when the bible is empty). Reuses
// `characterNameTokens` so name + aliases render with the same trim/de-dup the
// deterministic matcher uses.
export function canonRosterNamesSummary(canon) {
  const chars = Array.isArray(canon?.characters) ? canon.characters : [];
  const lines = [];
  for (const c of chars) {
    // Require a real name — an alias-only row isn't a named character (mirrors
    // buildRosterAppearances, which skips nameless rows). characterNameTokens then
    // returns the trimmed name first, followed by de-duped aliases.
    if (!c || typeof c.name !== 'string' || !c.name.trim()) continue;
    const [name, ...aliases] = characterNameTokens(c);
    lines.push(aliases.length ? `- ${name} (also: ${aliases.join(', ')})` : `- ${name}`);
  }
  if (!lines.length) return '';
  return `Known characters (already in the story bible — do NOT flag these or their aliases):\n${lines.join('\n')}`;
}

// Render the established WORLD canon (#2175) — the named objects (with their
// significance) and places (with their recurring details) — into a compact text
// block the worldbuilding-doctrine checks pass alongside the manuscript so the
// model can tell a rule/power/artifact the prose ESTABLISHED (and may legitimately
// use) from one that appears out of nowhere. Objects carry the artifacts/powers a
// solution might draw on; places carry the world's physical logic. Prose
// `significance` / `description` / `recurringDetails` are the fields that state
// what a thing DOES and what it costs, so those are what get surfaced. Pure +
// deterministic (unit-testable, token-countable) and type-guarded throughout (the
// canon rides peer sync, so an older/hand-edited row could carry a non-string
// field). Returns '' when no object or place has usable content (the prompt's
// `{{#canonWorld}}` section then renders nothing and the check reasons from the
// prose alone).
export function canonWorldSummary(canon) {
  const objects = Array.isArray(canon?.objects) ? canon.objects : [];
  const places = Array.isArray(canon?.places) ? canon.places : [];
  const trim = (v) => (typeof v === 'string' ? v.trim() : '');
  const objectLines = [];
  for (const o of objects) {
    const name = trim(o?.name);
    if (!name) continue;
    const detail = trim(o?.significance) || trim(o?.description);
    objectLines.push(detail ? `- ${name}: ${detail}` : `- ${name}`);
  }
  const placeLines = [];
  for (const p of places) {
    const name = trim(p?.name) || trim(p?.slugline);
    if (!name) continue;
    const detail = trim(p?.recurringDetails) || trim(p?.description);
    placeLines.push(detail ? `- ${name}: ${detail}` : `- ${name}`);
  }
  if (!objectLines.length && !placeLines.length) return '';
  const blocks = [];
  if (objectLines.length) blocks.push(`Named artifacts / objects (with their significance):\n${objectLines.join('\n')}`);
  if (placeLines.length) blocks.push(`Named places (with their recurring details):\n${placeLines.join('\n')}`);
  // Neutral framing: this is the author's reference for what the world's
  // mechanics ARE, so a check can judge internal consistency. It deliberately
  // does NOT assert the reader has seen these — each consuming prompt sets that
  // interpretation (the unforeshadowed-solution check must still flag a canon
  // rule the PROSE never surfaced; the cost-free-power check reads it for the
  // costs a system is supposed to carry).
  return `World-bible reference (the author's record of the world's artifacts, places, and mechanics — use it to understand what a thing is and does; it is NOT the manuscript and does not prove the reader has seen any of it):\n\n${blocks.join('\n\n')}`;
}

// Render the authored reader-map cliffhangers (#1298) into a compact text block
// the chapter-ending check passes alongside the manuscript so the model
// reconciles its DETECTED endings against the issue-boundary tugs the writer
// already LOGGED — an authored cliffhanger the prose doesn't deliver, or a
// settled ending where the writer planned one. Pure + deterministic so it's
// unit-testable and its token cost can be counted into the per-chunk overhead.
// Returns '' when nothing is authored (the prompt's `{{#authoredCliffhangers}}`
// section then renders nothing). `atIssueBoundary` is the issue the cliffhanger
// caps (the cut falls between it and the next), so it's surfaced as a location hint.
export function authoredCliffhangerSummary(readerMap) {
  const cliffs = Array.isArray(readerMap?.cliffhangers) ? readerMap.cliffhangers : [];
  const lines = cliffs.map((c) => {
    const note = typeof c?.note === 'string' ? c.note.trim() : '';
    if (!note) return '';
    const at = Number.isFinite(c?.atIssueBoundary) ? ` (ending issue ${c.atIssueBoundary})` : '';
    return `- ${note}${at}`;
  }).filter(Boolean);
  if (!lines.length) return '';
  return `Authored cliffhangers (issue-boundary tugs the writer planned):\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Chapter-ending POV switch (#1298) — deterministic over the reverse-outline POV
// map + the authored reader-map cliffhangers. The editorial rule: in a multi-POV
// story, after a chapter ends on a cliffhanger, the NEXT chapter should cut to a
// DIFFERENT POV character (the cut sustains tension across the break). The LLM
// cliffhanger check above judges WHICH endings are cliffhangers; this check uses
// the writer's AUTHORED cliffhangers as the deterministic trigger so it never
// needs the model. No authored cliffhangers ⇒ nothing to reconcile (no-op);
// single-POV series ⇒ no-op (there's no other POV to cut to).
// ---------------------------------------------------------------------------

// Group POV-tagged scenes by issue number, preserving outline (sequence) order
// within each issue and first-seen story order across issues. Scenes without an
// integer issueNumber can't be mapped to a chapter boundary and are dropped.
export function scenesByIssue(scenes) {
  const byIssue = new Map();
  for (const s of scenes) {
    if (!s || typeof s !== 'object') continue;
    const n = Number.isInteger(s.issueNumber) ? s.issueNumber : null;
    if (n == null) continue;
    if (!byIssue.has(n)) byIssue.set(n, []);
    byIssue.get(n).push(s);
  }
  return byIssue;
}

// The POV holder of a scene, trimmed, or '' when untagged.
export const scenePov = (s) => (typeof s?.povCharacter === 'string' ? s.povCharacter.trim() : '');

// The last / first POV-tagged scene of an issue's scene list (sequence-ordered),
// as { name, scene }, or null when no scene in the issue carries a POV.
export function lastPovScene(list) {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const name = scenePov(list[i]);
    if (name) return { name, scene: list[i] };
  }
  return null;
}
export function firstPovScene(list) {
  for (const s of list) {
    const name = scenePov(s);
    if (name) return { name, scene: s };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Character-name dissimilarity (#1291) reads cast names + aliases and respects
// locked entries. The pure similarity primitives live in ./nameSimilarity.js;
// the helpers below turn the canon into the flat name list the check walks.
// ---------------------------------------------------------------------------

// SEVERITIES is ordered high→…→low (index 0 = most severe). Escalate `base` up
// by `steps` ranks, clamped at the top — a strong collision (near-identical
// spelling, dense first-letter cluster) outranks the check's low floor.
export function escalateSeverity(base, steps) {
  const i = SEVERITIES.indexOf(base);
  const idx = i === -1 ? SEVERITIES.length - 1 : i;
  return SEVERITIES[Math.max(0, idx - Math.max(0, steps))];
}

// The flat list of confusable name tokens for a cast: each character's `name`
// plus every alias, tagged with the owning character (id-or-index), whether that
// character is locked, and whether the token is an alias. Two tokens owned by the
// same character never pair (a name vs. its own alias isn't a reader collision).
export function castNameTokens(ctx) {
  const chars = Array.isArray(ctx.canon?.characters) ? ctx.canon.characters : [];
  const tokens = [];
  chars.forEach((c, idx) => {
    if (!c || typeof c !== 'object') return;
    const owner = c.id || `idx-${idx}`;
    const locked = c.locked === true;
    const primary = typeof c.name === 'string' ? c.name.trim() : '';
    if (primary) tokens.push({ token: primary, owner, ownerName: primary, locked, isAlias: false });
    const aliases = Array.isArray(c.aliases) ? c.aliases : [];
    for (const a of aliases) {
      const alias = typeof a === 'string' ? a.trim() : '';
      if (alias) tokens.push({ token: alias, owner, ownerName: primary || alias, locked, isAlias: true });
    }
  });
  return tokens;
}

// A name token's display label — an alias is annotated with its owning character
// so the finding text and the rename suggestion always name the source.
export const tokenLabel = (t) => (t.isAlias ? `${t.token} (alias of ${t.ownerName})` : t.token);

// How to phrase the rename suggestion given which of the two characters are
// locked — always steer the author toward renaming an UNLOCKED one (#1291).
export function renameSuggestion(a, b) {
  if (a.locked && b.locked) {
    return `Both ${a.ownerName} and ${b.ownerName} are locked — unlock one to rename it so readers can tell them apart.`;
  }
  if (a.locked) return `Rename ${b.ownerName} (${a.ownerName} is locked) so it reads less like "${tokenLabel(a)}".`;
  if (b.locked) return `Rename ${a.ownerName} (${b.ownerName} is locked) so it reads less like "${tokenLabel(b)}".`;
  return `Rename one of ${a.ownerName} / ${b.ownerName} so readers can tell them apart at a glance.`;
}

// ---------------------------------------------------------------------------
// Shared scaffolding for the relationship-link checks (#1287). All three walk
// `canon.characters × relationshipLinks`, so the id-bearing character list,
// the id→name lookup, and the link iteration live here once.
// ---------------------------------------------------------------------------

// Id-bearing characters + an id→name lookup (falling back to the id when a
// character is unnamed). The three checks index off this same pair.
export function relationshipCanon(ctx) {
  const chars = (ctx.canon?.characters || []).filter((c) => c && c.id);
  return { chars, nameById: new Map(chars.map((c) => [c.id, c.name || c.id])) };
}

// Yields every relationship link that points somewhere, as { c, link, targetId }.
export function* eachRelationshipLink(chars) {
  for (const c of chars) {
    for (const link of (Array.isArray(c.relationshipLinks) ? c.relationshipLinks : [])) {
      if (link?.targetCharacterId) yield { c, link, targetId: link.targetCharacterId };
    }
  }
}

// ---------------------------------------------------------------------------
// Shared scaffolding for the object-attachment checks (#1288). All three walk
// `canon.objects × attachments`, resolving each attachment's `characterId`
// against the cast, so the id-bearing object/character lists, the id→character
// lookup, and the attachment iteration live here once.
// ---------------------------------------------------------------------------

export function attachmentCanon(ctx) {
  const objects = (ctx.canon?.objects || []).filter((o) => o && o.id);
  const chars = (ctx.canon?.characters || []).filter((c) => c && c.id);
  return {
    objects,
    chars,
    nameById: new Map(chars.map((c) => [c.id, c.name || c.id])),
    charById: new Map(chars.map((c) => [c.id, c])),
  };
}

// Yields every attachment that points at a character, as { o, att }.
function* eachAttachment(objects) {
  for (const o of objects) {
    for (const att of (Array.isArray(o.attachments) ? o.attachments : [])) {
      if (att?.characterId) yield { o, att };
    }
  }
}

// A human-readable summary of every object + who's attached to it, fed to the
// unmotivated-interaction LLM so it knows which objects already carry an
// established stake (and which don't) before judging a prose interaction.
export function describeObjectAttachments(ctx) {
  const { objects, nameById } = attachmentCanon(ctx);
  const lines = [];
  for (const o of objects) {
    const atts = Array.isArray(o.attachments) ? o.attachments : [];
    const sig = (o.significance || '').trim();
    const attText = atts.length
      ? atts.map((a) => {
        const who = nameById.get(a.characterId) || a.characterId;
        const emotion = a.emotion ? ` (${a.emotion})` : '';
        const why = a.significance ? ` — ${a.significance}` : '';
        return `${who}${emotion}${why}`;
      }).join('; ')
      : 'nobody';
    lines.push(`- ${o.name || o.id}${sig ? ` — significance: ${sig}` : ''}\n  attached to: ${attText}`);
  }
  return lines.join('\n') || '(no objects in canon)';
}

// A richer per-object weight summary for the weight-proportionality check
// (#1624). Unlike describeObjectAttachments (which the unmotivated-interaction
// check uses to know who already cares about an object), this surfaces the FULL
// recorded weight an object carries going in — the prose significance plus every
// attachment's emotion, per-bond significance, ORIGIN (the lineage/backstory),
// and ROLE archetype — so the model can weigh that recorded backstory against
// how prominent the object actually is in the manuscript. The origin/role fields
// are exactly the "rich recorded backstory for a barely used object" signal the
// over-weighted verdict depends on, which the leaner attachments summary omits.
export function describeObjectWeight(ctx) {
  const { objects, nameById } = attachmentCanon(ctx);
  const lines = [];
  for (const o of objects) {
    const atts = Array.isArray(o.attachments) ? o.attachments : [];
    const sig = (o.significance || '').trim();
    const head = `- ${o.name || o.id}${sig ? ` — significance: ${sig}` : ''}`;
    if (!atts.length) {
      lines.push(`${head}\n  attachments: none`);
      continue;
    }
    const attLines = atts.map((a) => {
      const who = nameById.get(a.characterId) || a.characterId || 'unknown';
      const emotion = (a.emotion || '').trim();
      const significance = (a.significance || '').trim();
      const origin = (a.origin || '').trim();
      const role = (a.role || '').trim();
      const parts = [
        `  • ${who}${emotion ? ` (${emotion})` : ''}${role ? ` [${role}]` : ''}`,
      ];
      if (significance) parts.push(`    significance: ${significance}`);
      if (origin) parts.push(`    origin: ${origin}`);
      return parts.join('\n');
    });
    lines.push(`${head}\n${attLines.join('\n')}`);
  }
  return lines.join('\n') || '(no objects in canon)';
}

// The attachment rows whose `origin` can be checked against the attached
// character's `background` — both must be present, and the character must
// still exist (a dangling characterId is the UI/sanitizer's concern, not this
// check's). Shared by the backstory-consistency check's `gate` (cheap presence
// test) and its `run` (the actual prompt rows) so they never disagree.
export function attachmentBackstoryRows(ctx) {
  const { objects, charById } = attachmentCanon(ctx);
  const rows = [];
  for (const { o, att } of eachAttachment(objects)) {
    const origin = (att.origin || '').trim();
    if (!origin) continue;
    const char = charById.get(att.characterId);
    if (!char) continue;
    const background = (char.background || '').trim();
    if (!background) continue;
    rows.push({
      object: o.name || o.id,
      character: char.name || char.id,
      emotion: (att.emotion || '').trim(),
      origin,
      background,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Shared LLM-check helpers. Every `kind: 'llm'` check normalizes the model's
// raw findings into the manuscriptReview comment shape, and a manuscript-
// consuming check additionally feeds the whole corpus to the model in
// provider-sized chunks (so a long series isn't truncated on a small/local
// provider) and merges the per-chunk findings. These collapse those repeated
// blocks so the field validation + chunk-merge live once.
// ---------------------------------------------------------------------------

// Fixed per-call prompt overhead (template scaffolding + JSON-shape
// instructions) reserved on top of any check-specific static vars, so the
// chunk budget leaves room for the prompt the manuscript rides inside.
export const EDITORIAL_PROMPT_OVERHEAD_TOKENS = 1_500;

// First-wins dedup key for an editorial finding, used to merge results across
// manuscript chunks. Mirrors completenessPass.findingKey: a finding identical on
// (issue, category, anchor, problem) is kept once even if two chunks surface it.
export const editorialFindingKey = (f) => [
  f.issueNumber ?? '',
  f.category ?? '',
  (f.anchorQuote || '').trim().toLowerCase().slice(0, 120),
  (f.problem || '').trim().toLowerCase().slice(0, 120),
].join('|');

// Cross-chunk continuity digest (#1383). When a manuscript is too long for the
// provider window it is reviewed chunk-by-chunk; a check whose problems span
// chapters (an object set up early and paid off late; tense/POV established in
// chapter 1 judged against chapter 3) can't see that with a per-chunk view.
// These constants bound the rolling digest of prior-chunk findings fed to later
// chunks so it stays small enough to ride in the chunk's spare budget.
export const EDITORIAL_PRIOR_DIGEST_MAX = 40;
// Only the findings BODY is capped — the fixed header and the trailing `---`
// delimiter are always added AFTER the cap (the next manuscript chunk is
// concatenated right after the digest, so the delimiter MUST survive or the
// manuscript bleeds into the "already recorded" list).
export const EDITORIAL_PRIOR_DIGEST_BODY_CHARS = 2_000;
const EDITORIAL_PRIOR_DIGEST_HEADER = '# Editorial findings already recorded for EARLIER parts of this manuscript\n'
  + 'Do not repeat these. Flag only NEW problems in the text below, plus any cross-chapter '
  + 'continuity these earlier findings reveal (e.g. an object set up earlier, or a tense/POV '
  + 'choice established in an earlier chapter).\n\n';
const EDITORIAL_PRIOR_DIGEST_SEPARATOR = '\n\n---\n\n';
// Whole-digest char ceiling = fixed wrapper + capped body. The digest is only
// prepended to a chunk when it fits in that chunk's spare budget (see
// runChunkedManuscriptCheck), so it never grows a chunk past the provider window.
export const EDITORIAL_PRIOR_DIGEST_CHARS =
  EDITORIAL_PRIOR_DIGEST_HEADER.length + EDITORIAL_PRIOR_DIGEST_BODY_CHARS + EDITORIAL_PRIOR_DIGEST_SEPARATOR.length;

// One-block digest of findings already recorded for earlier chunks, prepended
// INSIDE the next chunk's manuscript var so no prompt template changes (mirrors
// completenessPass.priorFindingsDigest). Pure + capped for unit-testing. Returns
// '' when there are no prior findings so the first chunk is untouched.
//
// Scope note: this carries prior FINDINGS, not clean prior setup (same as the
// completeness pass). It removes the duplicate/contradiction blind spot — a
// later chunk won't re-flag something an earlier chunk already flagged — but it
// can't tell a later chunk that an earlier chunk *cleanly* established an object's
// motivation or a tense. Carrying clean cross-chunk context would need a
// per-chunk content summary (extra LLM calls); tracked as a follow-up in #1403.
export function editorialPriorFindingsDigest(findings) {
  if (!Array.isArray(findings) || !findings.length) return '';
  const lines = findings.slice(0, EDITORIAL_PRIOR_DIGEST_MAX).map((f) => {
    const where = Number.isInteger(f.issueNumber) ? `Issue ${f.issueNumber}` : (f.location || 'general');
    return `- [${where}] ${f.category}: ${f.problem}`;
  });
  const more = findings.length > EDITORIAL_PRIOR_DIGEST_MAX
    ? `\n(+${findings.length - EDITORIAL_PRIOR_DIGEST_MAX} more earlier findings)` : '';
  // Cap the body only — the header and the trailing `---` separator are appended
  // afterwards so they always survive (see EDITORIAL_PRIOR_DIGEST_BODY_CHARS).
  const body = `${lines.join('\n')}${more}`.slice(0, EDITORIAL_PRIOR_DIGEST_BODY_CHARS);
  return `${EDITORIAL_PRIOR_DIGEST_HEADER}${body}${EDITORIAL_PRIOR_DIGEST_SEPARATOR}`;
}

// Cross-chunk CLEAN-SETUP digest (#1403). The findings digest above carries prior
// problems forward, but it cannot tell a later chunk that an earlier chunk
// *cleanly* established context (an object's motivation, a tense/POV/rating) —
// clean setup produces no finding, so a payoff in a later chunk can be mis-flagged
// "missing setup". This digest threads a short rolling summary of established
// setup alongside the findings digest, generated by one extra summarization LLM
// call per chunk (see `runManuscriptLlmCheck`'s `crossChunkSetup` path).
//
// (When the reverse-outline (#1349) or continuity-bible (#1305) artifacts land,
// either could supply this cross-chunk context more cheaply than a per-chunk
// summary call — they already condense the manuscript. Until then this is the
// self-contained source.)
//
// Free-form run tag so /runs can filter the setup-summary calls apart from the
// named-stage editorial checks and custom-check calls.
export const EDITORIAL_SETUP_DIGEST_SOURCE = 'pipeline-editorial-setup-digest';
// Body cap for the rolling setup summary (a touch smaller than the findings
// digest — it is condensed prose, not a bounded findings list). Header + trailing
// `---` are appended AFTER the cap so the delimiter always survives truncation
// (the next manuscript chunk concatenates right after, same contract as the
// findings digest).
export const EDITORIAL_SETUP_DIGEST_BODY_CHARS = 1_500;
const EDITORIAL_SETUP_DIGEST_HEADER =
  '# Setup already established in EARLIER parts of this manuscript (clean context — these are NOT problems)\n'
  + 'Use this when judging the text below: do NOT flag a payoff as missing setup, or a tense/POV/rating as a '
  + 'drift, if it was already established here.\n\n';
const EDITORIAL_SETUP_DIGEST_SEPARATOR = '\n\n---\n\n';
// Whole-digest char ceiling = fixed wrapper + capped body. Like the findings
// digest, the setup digest is prepended only when it fits the chunk's spare
// budget, so it never grows a chunk past the provider window.
export const EDITORIAL_SETUP_DIGEST_CHARS =
  EDITORIAL_SETUP_DIGEST_HEADER.length + EDITORIAL_SETUP_DIGEST_BODY_CHARS + EDITORIAL_SETUP_DIGEST_SEPARATOR.length;

// Wrap an accumulated "setup so far" summary in the fixed header + trailing `---`
// so it rides INSIDE the next chunk's manuscript var (no prompt template change,
// mirrors editorialPriorFindingsDigest). Returns '' for an empty/non-string
// summary so the first chunk (no prior setup yet) is untouched.
export function editorialSetupDigest(summary) {
  if (typeof summary !== 'string' || !summary.trim()) return '';
  const body = summary.trim().slice(0, EDITORIAL_SETUP_DIGEST_BODY_CHARS);
  return `${EDITORIAL_SETUP_DIGEST_HEADER}${body}${EDITORIAL_SETUP_DIGEST_SEPARATOR}`;
}

// Build the inline summarization prompt that maintains the rolling "setup so far"
// summary. Pure + deterministic so it's unit-testable and so the caller can pin a
// per-check `focus` (the objects check tracks item motivations; the style check
// tracks tense/POV/rating). Asks for terse merged setup text only — no JSON, no
// commentary — since the result rides verbatim into the next chunk's digest.
export function buildSetupDigestPrompt({ focus, priorSummary, manuscript }) {
  const trackDefault = 'Items/objects introduced and any motivation or significance established for them; '
    + 'the narrative tense, point-of-view person, and content rating in force.';
  return [
    'You are tracking established narrative SETUP across a long manuscript reviewed in parts.',
    'Maintain a SHORT running summary of the setup so far — only the facts a later part needs to judge payoffs and continuity.',
    '',
    '# What to track',
    String(focus || '').trim() || trackDefault,
    '',
    '# Setup recorded so far (from earlier parts)',
    String(priorSummary || '').trim() || '(none yet)',
    '',
    '# New manuscript part',
    String(manuscript || ''),
    '',
    '# How to respond',
    'Return an updated running summary that MERGES the prior setup with any new setup established in this part.',
    'Be terse: short bullet lines, no preamble, no commentary — only the established facts, dropping nothing important from the prior summary.',
    'Respond with the summary text only: no JSON, no section headers, no explanation.',
  ].join('\n');
}

// Shared chunk loop for the manuscript-consuming LLM checks: run `callChunk` on
// each provider-sized chunk, normalize + merge findings first-wins (capped at
// `max` across the whole run). When `crossChunkDigest` is set, each chunk after
// the first is prefixed with a digest of the findings gathered so far so the
// model keeps cross-chapter continuity in view; the digest rides INSIDE the
// chunk text passed to `callChunk`, so the per-check prompt template is
// unchanged. Merges incrementally (vs collect-then-merge) so the digest is O(1)
// to derive from the running map.
//
// The digest YIELDS to manuscript coverage: it is prepended only when it fits in
// the chunk's spare budget (`usableChars - chunk length`, exposed by the runner's
// chunker). So it never displaces manuscript text and never grows a chunk past
// the provider window — a chunk packed up to the budget simply runs without a
// digest rather than dropping its tail. When the chunker doesn't report a budget
// (a fits-in-one-call provider, or a test stub), there is unbounded headroom.
//
// `summarizeChunk` (#1403) opts in the CLEAN-SETUP digest: when provided, after
// each non-final chunk it is called `(priorSummary, chunkText) => nextSummary` to
// roll forward a short "setup so far" summary, and that summary's `editorialSetupDigest`
// is prepended (alongside the findings digest, after it in the budget) to later
// chunks — also yielding to spare room. It is a no-op for a single-chunk run (no
// later chunk consumes a summary), so the common fits-in-one-call provider pays
// nothing.
//
// `reserveSetupDigest` (#1667) GUARANTEES the carried setup digest reaches the
// FINAL chunk for checks that gate a whole-story verdict to it and anchor that
// verdict on the carried snippet (arc.climax-agency #1583, emotion.reaction-
// proportionality #1584). The setup digest normally yields to manuscript coverage,
// so a final chunk packed to within a few hundred chars of the window silently
// drops the digest and the final-only finding is missed. When this opt-in is set
// and the digest doesn't fit the final chunk's spare room, the manuscript TAIL is
// trimmed to reserve the digest's room (the inverse of the usual yield) so the
// verdict keeps its carried context. Scoped to the final chunk and to opt-in checks
// only — every other chunk, and every non-reserving check, keeps full manuscript
// coverage. If the digest alone is larger than the whole window it still yields
// (never prepended past the budget), preserving the no-overflow contract.
async function runChunkedManuscriptCheck(ctx, { chunks, category, max, callChunk, crossChunkDigest = false, summarizeChunk = null, reserveSetupDigest = false, subtypes = null }) {
  const usableChars = Number.isFinite(chunks?.usableChars) ? chunks.usableChars : Infinity;
  const merged = new Map();
  // The presence of `summarizeChunk` (set only when the check opts into the
  // clean-setup digest AND an inline LLM caller is available) is itself the gate —
  // no separate flag, so the null-checks below can't drift from it.
  let setupSummary = '';
  for (let i = 0; i < chunks.length; i++) {
    const manuscript = chunks[i];
    // Stop launching further chunk calls once the run is cancelled — the runner
    // only checks the signal around the whole check, so without this a multi-
    // chunk check keeps paying for LLM calls whose results will be discarded.
    if (ctx.signal?.aborted) break;
    // `isFinal` lets a check distinguish the last part of a chunked manuscript
    // from earlier ones (#1299): a whole-corpus judgment like "this setup is
    // never paid off" can only be made once the final part is in view, so the
    // Chekhov check defers its "planted, never fired" findings to it. A
    // single-chunk run is its own final part, so the common (provider-fits-the-
    // book) case judges against the whole text. Existing checks ignore the arg.
    const isFinal = i === chunks.length - 1;
    let text = manuscript;
    if (crossChunkDigest && merged.size) {
      const digest = editorialPriorFindingsDigest([...merged.values()]);
      // Only prepend when the digest fits the chunk's spare room — never trim the
      // manuscript (would drop review coverage) or overflow the window.
      if (digest && digest.length <= usableChars - text.length) text = `${digest}${manuscript}`;
    }
    if (summarizeChunk && setupSummary) {
      const setup = editorialSetupDigest(setupSummary);
      if (setup && setup.length <= usableChars - text.length) {
        // Fits into whatever spare room remains AFTER the findings digest — manuscript
        // coverage and the findings digest both win over the setup digest if budget is tight.
        text = `${setup}${text}`;
      } else if (setup && reserveSetupDigest && isFinal && setup.length <= usableChars) {
        // #1667: the digest didn't fit, but this check gates its verdict to the final
        // part and anchors it on the carried snippet — so reserve the digest's room and
        // fill the rest with the manuscript HEAD (trimming its tail) rather than drop
        // the carried context. Rebuild from the RAW `manuscript`, NOT the
        // findings-digest-prefixed `text`: slicing `text` could truncate the findings
        // digest mid-block into a malformed prefix, and the findings digest's job
        // (suppressing duplicate re-flags) is already covered by the first-wins merge,
        // so it safely yields here. Gated on `setup.length <= usableChars` so a digest
        // larger than the whole window yields instead of overflowing it — preserving
        // the pre-reserve no-overflow contract on a tiny/high-overhead window.
        text = `${setup}${manuscript.slice(0, usableChars - setup.length)}`;
      }
    }
    const content = await callChunk(text, { isFinal });
    for (const f of mapLlmFindings(content?.findings, {
      severityDefault: ctx.severityDefault,
      category,
      max,
      withIssueNumber: true,
      subtypes,
    })) {
      const k = editorialFindingKey(f);
      if (!merged.has(k)) merged.set(k, f);
    }
    // Roll the setup summary forward for the NEXT chunk — skip after the last chunk
    // (nothing consumes it) and on cancellation (its result would be discarded).
    // Summarize the RAW chunk, never the digest-prefixed text. A summarizer failure
    // must not abort the check — keep the prior summary and continue.
    if (summarizeChunk && i < chunks.length - 1 && !ctx.signal?.aborted) {
      const next = await summarizeChunk(setupSummary, manuscript).catch(() => setupSummary);
      // Cap the STORED summary, not just the rendered digest: a verbose/echoing
      // summarizer response is fed back into the next summarization prompt as the
      // prior summary, so an uncapped string would compound and could overflow the
      // provider context. Trimming here bounds both the next prompt and the digest.
      if (typeof next === 'string' && next.trim()) {
        setupSummary = next.trim().slice(0, EDITORIAL_SETUP_DIGEST_BODY_CHARS);
      }
    }
  }
  return [...merged.values()].slice(0, Math.max(0, max));
}

// Shared body for a manuscript-consuming LLM check. Plans the manuscript into
// provider-sized chunks for `stage` (via the runner-injected
// `ctx.planManuscriptChunks`), runs the model on each chunk, and merges the
// findings first-wins (capped at the check's `maxFindings`). `buildVars(chunk, meta)`
// returns the stage vars — only the manuscript var changes per chunk; `meta.isFinal`
// is true on the last (or only) chunk so a check can gate whole-corpus judgments to
// it (the Chekhov "planted, never fired" pass). Existing checks ignore `meta`. These
// checks are all manuscript-scoped, so findings keep a model-supplied issue
// number (`withIssueNumber: true`).
//
// A check declares its per-chunk non-manuscript overhead in ONE of two ways:
//
//   `context` (preferred) — a `{ varName: string }` map of the TRIMMABLE context
//     blocks the check re-sends on each chunk (the scene map, character arcs, the
//     style-guide expectations, …). The runner counts them as overhead AND, on a
//     small/fallback window where they'd starve the manuscript chunk to '', trims
//     them to guarantee the manuscript a budget floor (#1459). `buildVars` then
//     receives the (possibly trimmed) blocks as its third arg — so the check feeds
//     the SAME context it was budgeted for (sending the untrimmed originals would
//     overflow the window the trim was sized to fit). `EDITORIAL_PROMPT_OVERHEAD_TOKENS`
//     is added automatically as the fixed (non-trimmable) template/contract reserve.
//
//   `overheadTokens` (legacy) — a single fixed token count for a check with no
//     trimmable context (a plain whole-manuscript scan). MUST account for every
//     non-manuscript prompt var, on top of EDITORIAL_PROMPT_OVERHEAD_TOKENS.
//
// `buildVars(chunk, meta, context)` returns the stage vars — only the manuscript
// var changes per chunk; `meta.isFinal` is true on the last (or only) chunk so a
// check can gate whole-corpus judgments to it (the Chekhov "planted, never fired"
// pass), and `context` is the trimmed block map (or `{}` for an `overheadTokens`
// check). Existing checks ignore the extra args. These checks are all
// manuscript-scoped, so findings keep a model-supplied issue number
// (`withIssueNumber: true`).
export async function runManuscriptLlmCheck(ctx, { stage, category, overheadTokens = 0, context = null, buildVars, crossChunkDigest = false, crossChunkSetup = false, setupFocus = '', reserveSetupDigest = false, subtypes = null }) {
  const max = ctx.config?.maxFindings ?? 12;
  // Chunks are planned at the full usable budget; the digest is fitted into each
  // later chunk's spare room inside runChunkedManuscriptCheck (it yields to the
  // manuscript), so no budget is reserved or carved out here. A `context` map is
  // trimmed to keep the manuscript a budget floor; the trimmed blocks come back on
  // `chunks.context` so they're what we feed the model.
  const chunks = context
    ? await ctx.planManuscriptChunks(stage, { context, fixedOverheadTokens: EDITORIAL_PROMPT_OVERHEAD_TOKENS })
    : await ctx.planManuscriptChunks(stage, { overheadTokens });
  // The runner returns the (possibly trimmed) context on `chunks.context`; fall back
  // to the originals if it didn't echo them (a chunker that doesn't implement the
  // context path), and to `{}` for an `overheadTokens` check with no context.
  const fittedContext = chunks?.context || context || {};
  // Clean-setup digest (#1403): roll a short "setup so far" summary forward via an
  // inline summarization call. Only wired when the check opts in AND the runner
  // injected the stage-scoped inline caller — absent it (unit tests of the
  // findings-digest path), the check degrades to findings-only with no extra calls.
  // The call is STAGE-SCOPED (not plain callInlineLLM) so the summary runs on the
  // same provider the stage is pinned to — never leaking manuscript text to the
  // active/cloud provider when the check's stage targets a private/local one.
  const summarizeChunk = crossChunkSetup && typeof ctx.callStageScopedInlineLLM === 'function'
    ? async (priorSummary, manuscript) => {
        const prompt = buildSetupDigestPrompt({ focus: setupFocus, priorSummary, manuscript });
        const { content } = await ctx.callStageScopedInlineLLM(stage, prompt, { source: EDITORIAL_SETUP_DIGEST_SOURCE });
        return typeof content === 'string' ? content : '';
      }
    : null;
  return runChunkedManuscriptCheck(ctx, {
    chunks,
    category,
    max,
    crossChunkDigest,
    summarizeChunk,
    reserveSetupDigest,
    subtypes,
    callChunk: async (manuscript, meta) => {
      const { content } = await ctx.callStagedLLM(stage, buildVars(manuscript, meta, fittedContext), { returnsJson: true, source: stage });
      return content;
    },
  });
}

// Normalize raw LLM findings into partial manuscriptReview comments: validate
// severity against the allow-list (fall back to the check default), force the
// check's `category`, coerce each string field, cap the count, and drop any
// finding with no `problem`. `withIssueNumber` keeps a model-supplied issue
// number (manuscript-scoped checks) vs. forcing null (canon-scoped checks).
// `subtypes` (optional) is a per-check allow-list (#1626): when supplied, the
// model's `subtype` is validated against it and stamped on the finding (off-list
// or absent → null), letting a check sub-classify its findings (e.g. on-the-nose
// → exposition / emotion-tell / relationship-report) without a new field on every
// other check.
export function mapLlmFindings(raw, { severityDefault, category, max, withIssueNumber, subtypes = null }) {
  const list = Array.isArray(raw) ? raw : [];
  const allowSubtype = Array.isArray(subtypes) && subtypes.length > 0;
  return list.slice(0, max).map((f) => ({
    severity: SEVERITIES.includes(f?.severity) ? f.severity : severityDefault,
    category,
    // Optional per-check sub-classification. Only set when the check declares an
    // allow-list AND the model returned a recognized value — null otherwise so a
    // check with no subtypes (and an unrecognized label) carries a clean null.
    subtype: allowSubtype && subtypes.includes(f?.subtype) ? f.subtype : null,
    location: typeof f?.location === 'string' ? f.location : '',
    problem: typeof f?.problem === 'string' ? f.problem : '',
    suggestion: typeof f?.suggestion === 'string' ? f.suggestion : '',
    anchorQuote: typeof f?.anchorQuote === 'string' ? f.anchorQuote : '',
    issueNumber: withIssueNumber && Number.isInteger(f?.issueNumber) ? f.issueNumber : null,
  })).filter((f) => f.problem);
}

// ---------------------------------------------------------------------------
// User-defined (custom) LLM checks (#1346). A custom check has no shipped stage
// template — its prompt body is authored from the UI. The fixed JSON output
// contract is enforced HERE (not by the user), so an author only describes WHAT
// to look for; the response is parsed by the same `mapLlmFindings` the built-in
// stage prompts feed. Kept pure: the model caller (`ctx.callInlineLLM`) and the
// chunk planner (`ctx.planManuscriptChunks`) are injected by the runner.
// ---------------------------------------------------------------------------

// Free-form tag persisted on the run record so /runs can filter custom-check
// calls apart from the named-stage editorial checks.
export const CUSTOM_CHECK_RUN_SOURCE = 'pipeline-editorial-custom';

// Wrap a user's authored instructions in the fixed findings JSON contract. Pure
// and deterministic so it's unit-testable and so `runManuscriptLlmCheckInline`
// can render it once with an empty manuscript to measure per-call overhead.
export function buildCustomCheckPrompt({ instructions, manuscript, maxFindings = CUSTOM_CHECK_MAX_FINDINGS_DEFAULT }) {
  const cap = Number.isInteger(maxFindings) && maxFindings > 0 ? maxFindings : CUSTOM_CHECK_MAX_FINDINGS_DEFAULT;
  return [
    'You are an editorial reviewer analyzing a draft manuscript for one specific issue.',
    '',
    '# What to look for',
    String(instructions || '').trim(),
    '',
    '# Manuscript',
    String(manuscript || ''),
    '',
    '# How to respond',
    `Return ONLY a JSON object of the form {"findings": [...]} with at most ${cap} findings.`,
    'Each finding is an object with these fields:',
    '- "severity": one of "high", "medium", "low"',
    '- "location": a short human-readable pointer to where the problem is (e.g. a chapter or section name)',
    '- "problem": one sentence stating what is wrong (REQUIRED — omit the finding if you cannot name a concrete problem)',
    '- "suggestion": one sentence on how to fix it',
    '- "anchorQuote": a short verbatim quote from the manuscript at the problem location',
    '- "issueNumber": the issue/chapter number the problem is in, or null',
    'If nothing matches, return {"findings": []}. Do not include any prose outside the JSON object.',
  ].join('\n');
}

// Inline-prompt sibling of `runManuscriptLlmCheck` for custom checks: same
// provider-sized chunking + first-wins merge, but the prompt is the authored
// instructions wrapped by `buildCustomCheckPrompt` instead of a named stage.
// `ctx.planManuscriptChunks(null, …)` resolves the active/overridden provider's
// window (a custom check has no stage to pin), and `ctx.callInlineLLM` runs the
// built prompt. Findings keep a model-supplied issue number (manuscript-scoped).
export async function runManuscriptLlmCheckInline(ctx, { category, instructions }) {
  const max = ctx.config?.maxFindings ?? CUSTOM_CHECK_MAX_FINDINGS_DEFAULT;
  // Fixed per-call overhead = the contract wrapper + the instructions (only the
  // manuscript var changes per chunk). Measure it by rendering the prompt with an
  // empty manuscript so the chunk budget accounts for everything riding along.
  const overheadTokens = EDITORIAL_PROMPT_OVERHEAD_TOKENS
    + estimateTokens(buildCustomCheckPrompt({ instructions, manuscript: '', maxFindings: max }));
  const chunks = await ctx.planManuscriptChunks(null, { overheadTokens });
  return runChunkedManuscriptCheck(ctx, {
    chunks,
    category,
    max,
    // Custom checks are localized to the authored instruction — no cross-chunk
    // digest (the built-in continuity/style checks opt in explicitly).
    callChunk: async (manuscript) => {
      const prompt = buildCustomCheckPrompt({ instructions, manuscript, maxFindings: max });
      const { content } = await ctx.callInlineLLM(prompt, { returnsJson: true, source: CUSTOM_CHECK_RUN_SOURCE });
      return content;
    },
  });
}

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

// ---------------------------------------------------------------------------
// Roster economy (#1292) — character-appearance accounting over the stitched
// manuscript. Reads canon names + aliases and counts the DISTINCT issues each
// named character is mentioned in (recurrence), which issue they first appear
// in, and the named cast present in the opening issue. Pure: the per-issue
// `ctx.sections` and `ctx.canon` are injected by the runner.
//
// The match is a deterministic word-bounded name scan. A character whose name
// is a common word (Hope, Grace, Reed) can over-match prose — which biases the
// check toward UNDER-flagging throwaways (safe) at the cost of possibly
// over-counting first-issue crowding. Classifying unmodeled proper nouns as
// characters needs an LLM pass and is tracked as its own check (see the issue).
// ---------------------------------------------------------------------------

// Escape a name so it rides inside a RegExp alternation literally — names carry
// regex-significant punctuation ("D'Argo", "Anne-Marie", "T.A.R.D.I.S.").
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A character's match tokens: its name plus every alias, trimmed + de-duped.
// Empty when the character has no usable name.
function characterNameTokens(c) {
  const tokens = [];
  const push = (v) => { const t = typeof v === 'string' ? v.trim() : ''; if (t) tokens.push(t); };
  push(c?.name);
  for (const a of (Array.isArray(c?.aliases) ? c.aliases : [])) push(a);
  return [...new Set(tokens)];
}

// A case-insensitive, whole-token matcher for a character's tokens (built once
// per character and reused across every section so a long manuscript isn't
// re-compiling a regex per section), or null when there are no tokens.
export function characterMatcher(tokens) {
  if (!tokens.length) return null;
  // Longest-first so a token that's a prefix of another can't shadow it under
  // leftmost-match alternation (cosmetic for .test, but keeps intent clear).
  const alt = tokens.slice().sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  // Lookarounds, not \b: a token that begins or ends with punctuation ("Mr.",
  // "T.A.R.D.I.S.", "J.R.") has no word char at that edge, so a leading/trailing
  // \b would never match it in prose. (?<!\w)…(?!\w) enforces whole-token matching
  // at any edge while still rejecting substrings (Sam ≠ "Samuel").
  return new RegExp(`(?<!\\w)(?:${alt})(?!\\w)`, 'i');
}

// One row per NAMED canon character: { id, name, locked, appearedInIssues,
// firstIssueNumber }. `appearedInIssues` is the distinct issue numbers the
// character is mentioned in, in story order (sections are one-per-issue, ordered
// by arc position). Unnamed canon entries aren't a roster-economy concern.
export function buildRosterAppearances(ctx) {
  const chars = Array.isArray(ctx.canon?.characters) ? ctx.canon.characters : [];
  const sections = Array.isArray(ctx.sections) ? ctx.sections : [];
  const rows = [];
  for (const c of chars) {
    if (!c || typeof c !== 'object') continue;
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (!name) continue;
    const matcher = characterMatcher(characterNameTokens(c));
    if (!matcher) continue;
    const appearedInIssues = [];
    // Capture the ACTUAL matched token (name OR alias) from the first issue the
    // character appears in, so a finding's anchorQuote lands on real prose — an
    // alias-only mention ("Bob" for canonical "Robert") must anchor on "Bob", not
    // the canonical name the editor would never find. `matcher` is non-global, so
    // exec starts at 0 on each section. Falls back to the name for unmatched rows.
    let anchorQuote = '';
    for (const s of sections) {
      const m = matcher.exec(s.content || '');
      if (!m) continue;
      appearedInIssues.push(s.number);
      if (!anchorQuote) anchorQuote = m[0];
    }
    rows.push({
      id: c.id || name,
      name,
      locked: c.locked === true,
      appearedInIssues,
      firstIssueNumber: appearedInIssues.length ? appearedInIssues[0] : null,
      anchorQuote: anchorQuote || name,
    });
  }
  return rows;
}

// Normalized keys of every canon character that actually APPEARS in the prose
// (named at least once across the manuscript sections) — the "appearing cast"
// both the screen-time skew and the silent-major distribution signals score
// against. Pure; reuses buildRosterAppearances' per-section matcher scan.
export function buildAppearingKeys(ctx) {
  return new Set(
    buildRosterAppearances(ctx)
      .filter((r) => r.appearedInIssues.length > 0)
      .map((r) => normalizeName(r.name))
  );
}

// ---------------------------------------------------------------------------
// Cast representation & balance (#1312) — three coarse, computable casting
// signals over the canon + reverse-outline + stitched manuscript:
//   1) Bechdel co-presence — does ANY scene put two+ non-male characters
//      together (the structural precondition for two women talking)? Computed
//      from the reverse-outline's per-scene charactersPresent against
//      pronoun-inferred gender. A coarse signal, not the full Bechdel test
//      (we can't read whether the conversation is about a man deterministically).
//   2) Dialogue share — does one character dominate the spoken lines? Counts
//      attributed dialogue paragraphs per character (attributeDialogueByOwner)
//      and flags a lopsided distribution (top speaker over a configurable share).
//   3) Screen-time balance — when gender is inferable, flag a strongly skewed
//      appearing cast (e.g. a near-all-male roster) as a representation nudge.
//
// All three are advisory (low/medium): representation is an authorial choice and
// these are signals, not correctness errors. Gender is inferred ONLY from the
// canon `pronouns` field — absent/ambiguous pronouns yield 'unknown', and the
// gender-dependent signals stay silent rather than guess (absent ≠ a category).
// ---------------------------------------------------------------------------

// Infer a coarse gender bucket from a character's canon `pronouns` string. Only
// the unambiguous subject/object pronoun sets map; anything else (neopronouns,
// "any", blank, a sentence) is 'unknown' so a gender-dependent signal can opt
// out rather than miscategorize. Returns 'female' | 'male' | 'nonbinary' | 'unknown'.
function inferGender(pronouns) {
  const p = typeof pronouns === 'string' ? pronouns.toLowerCase() : '';
  if (!p) return 'unknown';
  const has = (re) => re.test(p);
  const she = has(/\bshe\b/) || has(/\bher\b/) || has(/\bhers\b/);
  const he = has(/\bhe\b/) || has(/\bhim\b/) || has(/\bhis\b/);
  const they = has(/\bthey\b/) || has(/\bthem\b/) || has(/\btheir\b/);
  // A clean single set wins; a mixed string ("she/they") is ambiguous → unknown,
  // except she+they / he+they which still read as a definite female/male identity
  // with a secondary set. Both she AND he present is genuinely ambiguous.
  if (she && he) return 'unknown';
  if (she) return 'female';
  if (he) return 'male';
  if (they) return 'nonbinary';
  return 'unknown';
}

// Coarse role-tier inference from a canon character's free-text `role` field, for
// the per-character dialogue-distribution signal (#1594). Only unambiguous keyword
// sets map to a tier; anything else (blank, a description, a role that mixes a
// major AND a minor word like "minor antagonist") is 'unknown' so the distribution
// signal opts out rather than guess — the same absent-vs-empty discipline
// inferGender() uses. Deliberately omits genuinely-ambiguous words ("supporting",
// "secondary", "recurring") that sit between lead and walk-on. Returns
// 'major' | 'minor' | 'unknown'. The two keyword sets live at module scope (vs
// inferGender's inline pronoun checks) so the regexes are compiled once, not on
// every per-character call.
const MAJOR_ROLE_RE = /\b(protagonist|deuteragonist|antagonist|villain|hero|heroine|lead|main|primary|central|principal)\b/;
const MINOR_ROLE_RE = /\b(minor|background|cameo|walk-?on|bit[- ]?part|extra|incidental|tertiary)\b/;
function inferRoleTier(role) {
  const r = typeof role === 'string' ? role.toLowerCase() : '';
  if (!r) return 'unknown';
  const major = MAJOR_ROLE_RE.test(r);
  const minor = MINOR_ROLE_RE.test(r);
  if (major && minor) return 'unknown'; // contradictory ("minor antagonist") → opt out
  if (major) return 'major';
  if (minor) return 'minor';
  return 'unknown';
}

// Normalized name → { char, gender, key } for every named canon character, plus
// the per-owner whole-token matcher reused for dialogue attribution. Built once
// per run so the dialogue scan and the co-presence scan share one identity map.
export function buildCastIdentities(ctx) {
  const chars = Array.isArray(ctx.canon?.characters) ? ctx.canon.characters : [];
  const identities = [];
  for (const c of chars) {
    if (!c || typeof c !== 'object') continue;
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (!name) continue;
    const key = normalizeName(name);
    if (!key) continue;
    const matcher = characterMatcher(characterNameTokens(c));
    identities.push({
      key,
      name,
      gender: inferGender(c.pronouns),
      roleTier: inferRoleTier(c.role),
      matcher,
    });
  }
  return identities;
}

// Resolve a scene's charactersPresent names to canon identity keys (so a scene
// that lists "Bob" maps to canonical "Robert"). A present name that matches no
// canon character is dropped — the co-presence signal is canon-relative.
export function sceneCastKeys(scene, identityByKey, identities) {
  const present = Array.isArray(scene?.charactersPresent) ? scene.charactersPresent : [];
  const keys = new Set();
  for (const raw of present) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const direct = identityByKey.get(normalizeName(raw));
    if (direct) { keys.add(direct.key); continue; }
    // Fall back to a token match (the present-name might be an alias surface form).
    const hit = identities.find((id) => id.matcher && id.matcher.test(raw));
    if (hit) keys.add(hit.key);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Scene component balance (#1296) — reads the cached reverse-outline (#1286)
// scene segmentation, where each scene carries a `components` boolean signal
// { narrative, action, dialogue }. The editorial rule: a scene should mix at
// least 2 of the 3; a single-mode scene (a narration wall, talking heads with
// no action, pure action with no interiority or voice) reads flat and is flagged.
//
// A scene with NO component flagged (all three false) is treated as
// "unclassified" (an older outline, or a scene the segmenter didn't tag), not
// "zero components" — it is skipped rather than flagged as a false positive,
// per the absent-vs-empty rule.
// ---------------------------------------------------------------------------

const SCENE_COMPONENT_KEYS = ['narrative', 'action', 'dialogue'];

// The present/missing component lists for a scene's `components` signal.
export function sceneComponentMix(components) {
  const c = components && typeof components === 'object' ? components : {};
  const present = SCENE_COMPONENT_KEYS.filter((k) => c[k] === true);
  const missing = SCENE_COMPONENT_KEYS.filter((k) => c[k] !== true);
  return { present, missing };
}

// A scene's display label for finding text/location — its heading, falling back
// to the summary, then a sequence-based label. Type-guarded because the reverse
// outline rides peer sync (#1348): a hand-edited / older-peer scene could carry a
// non-string heading, and a bare `.trim()` on it would throw and abort the check.
export const sceneLabel = (s) => {
  const heading = typeof s?.heading === 'string' ? s.heading.trim() : '';
  const summary = typeof s?.summary === 'string' ? s.summary.trim() : '';
  const seq = typeof s?.sequence === 'number' ? s.sequence + 1 : '?';
  return heading || summary || `scene ${seq}`;
};

// Render the reverse-outline scenes into a compact text block the scene-grounding
// LLM checks (#1309) pass alongside the manuscript so the model can attribute
// findings to scenes and reason about each scene's recorded setting / characters.
// Pure + deterministic so it's unit-testable and its token cost can be counted
// into the per-chunk overhead. Returns '' when there are no scenes (the prompt's
// `{{#sceneMap}}` section then renders nothing and the check degrades to a plain
// whole-issue manuscript scan). Type-guarded throughout — the reverse outline
// rides peer sync (#1348), so a hand-edited / older-peer scene could carry a
// non-string field that a bare `.trim()` would throw on.
export function sceneGroundingSummary(scenes) {
  const list = Array.isArray(scenes) ? scenes : [];
  const lines = list.map((s) => {
    if (!s || typeof s !== 'object') return '';
    const label = sceneLabel(s);
    const issueNumber = Number.isInteger(s.issueNumber) ? s.issueNumber : null;
    const where = issueNumber != null ? `Issue ${issueNumber}` : 'Scene';
    const setting = typeof s.setting === 'string' ? s.setting.trim() : '';
    const chars = Array.isArray(s.charactersPresent)
      ? s.charactersPresent.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim())
      : [];
    const parts = [`- ${where}: ${label}`];
    parts.push(setting ? `setting: ${setting}` : 'setting: (none recorded)');
    if (chars.length) parts.push(`present: ${chars.join(', ')}`);
    return parts.join(' — ');
  }).filter(Boolean);
  if (!lines.length) return '';
  return `Scenes (from the reverse outline):\n${lines.join('\n')}`;
}

// Render the reverse-outline PLOTLINES (#1286) into a compact text block the
// plot-structure check (#1310) passes alongside the manuscript so the model can
// reconcile dropped subplots against the author's tagged plotlines — a plotline
// that opens early and is never returned to is a dropped subplot. For each
// plotline we count the scenes tagged to it (primary OR secondary) and report the
// span of issues those scenes touch, so the model sees which threads fizzle.
// Pure + deterministic so it's unit-testable and its token cost can be counted
// into the per-chunk overhead. Returns '' when there are no plotlines (the
// prompt's `{{#plotlineMap}}` section then renders nothing and the check degrades
// to reasoning about subplots from the prose alone). Type-guarded throughout —
// the reverse outline rides peer sync (#1348), so a hand-edited / older-peer
// plotline could carry a non-string field a bare `.trim()` would throw on.
export function plotlineCoverageSummary(plotlines, scenes) {
  const lines = Array.isArray(plotlines) ? plotlines : [];
  const sceneList = Array.isArray(scenes) ? scenes : [];
  const rows = lines.map((pl) => {
    if (!pl || typeof pl !== 'object') return '';
    const id = typeof pl.id === 'string' ? pl.id : '';
    if (!id) return '';
    const label = typeof pl.label === 'string' && pl.label.trim() ? pl.label.trim() : id;
    const kind = typeof pl.kind === 'string' && pl.kind.trim() ? pl.kind.trim() : 'other';
    // Scenes tagged to this plotline (primary or secondary), in outline order.
    const tagged = sceneList.filter((s) => s && (s.plotlineId === id || s.secondaryPlotlineId === id));
    const issues = [...new Set(
      tagged
        .map((s) => (Number.isInteger(s.issueNumber) ? s.issueNumber : null))
        .filter((n) => n != null),
    )].sort((a, b) => a - b);
    const span = issues.length
      ? (issues.length === 1 ? `issue ${issues[0]}` : `issues ${issues[0]}–${issues[issues.length - 1]}`)
      : 'no tagged scenes';
    return `- ${label} (${kind}): ${tagged.length} scene${tagged.length === 1 ? '' : 's'}, ${span}`;
  }).filter(Boolean);
  if (!rows.length) return '';
  return `Plotlines (from the reverse outline — reconcile dropped subplots against these):\n${rows.join('\n')}`;
}

// Curated lexicon of conflict / stakes / high-intensity markers (#1618). A
// per-issue tally of these words is a crude-but-deterministic proxy for dramatic
// intensity: the escalation-curve check can't "feel" tension, but it CAN see
// whether the density of conflict language rises, plateaus, or falls across the
// issues. The model treats the tally as a hint (not ground truth) and confirms
// the curve against the prose — so a quiet-but-tense scene the lexicon misses is
// still caught. Word-boundary matched, case-insensitive; kept deliberately small
// and high-signal (physical conflict + danger/stakes) to limit false hits.
const CONFLICT_INTENSITY_MARKERS = Object.freeze([
  // physical conflict / violence
  'attack', 'attacks', 'attacked', 'fight', 'fights', 'fought', 'fighting',
  'strike', 'strikes', 'struck', 'punch', 'punched', 'stab', 'stabbed', 'shoot',
  'shoots', 'shot', 'kill', 'kills', 'killed', 'die', 'dies', 'died', 'death',
  'blood', 'bleeding', 'wound', 'wounded', 'scream', 'screams', 'screamed',
  'shout', 'shouted', 'slam', 'slammed', 'crash', 'crashed',
  // danger / stakes / dread
  'danger', 'dangerous', 'threat', 'threats', 'threaten', 'threatened', 'enemy',
  'enemies', 'weapon', 'weapons', 'gun', 'guns', 'knife', 'fire', 'fired',
  'fires', 'firing', 'explode', 'exploded', 'explosion', 'fear', 'terror',
  'panic', 'desperate', 'betray',
  'betrayed', 'betrayal', 'trap', 'trapped', 'flee', 'fled', 'chase', 'chased',
  'escape', 'war', 'battle', 'dying', 'doom', 'doomed',
]);

// Tally the conflict-marker density per issue across the WHOLE stitched manuscript
// (#1618) so the escalation-curve check sees the complete intensity shape on every
// chunk. Splits on the `# Issue N` headers the manuscript stitcher emits, counts
// markers + words per issue, and reports markers-per-1k-words — normalizing out
// raw length so a long-but-quiet issue doesn't read as more intense than a short
// climactic one. Pure + deterministic so it's unit-testable and its token cost can
// be counted into the per-chunk overhead. Returns '' when there are no issue
// headers (the prompt's `{{#intensityTally}}` section then renders nothing and the
// check judges the curve from the prose + scene map alone). A header that repeats
// across the stitch (a chunk boundary mid-issue) sums into the same issue bucket.
export function conflictIntensityTally(manuscript) {
  const text = typeof manuscript === 'string' ? manuscript : '';
  if (!text.trim()) return '';
  const headerRe = /^#+\s*Issue\s+(\d+)\b[^\n]*$/gim;
  const sections = [];
  let match;
  let prev = null;
  while ((match = headerRe.exec(text)) !== null) {
    if (prev) prev.end = match.index;
    prev = { issue: Number(match[1]), start: headerRe.lastIndex, end: text.length };
    sections.push(prev);
  }
  if (!sections.length) return '';
  const markerRe = new RegExp(`\\b(?:${CONFLICT_INTENSITY_MARKERS.join('|')})\\b`, 'gi');
  // Sum duplicate issue numbers (a repeated header across a stitch) — keep numeric
  // order so the rendered curve reads issue 1 → N for the model.
  const byIssue = new Map();
  for (const sec of sections) {
    const body = text.slice(sec.start, sec.end);
    const words = (body.match(/\b[\w']+\b/g) || []).length;
    const markers = (body.match(markerRe) || []).length;
    const acc = byIssue.get(sec.issue) || { words: 0, markers: 0 };
    byIssue.set(sec.issue, { words: acc.words + words, markers: acc.markers + markers });
  }
  const rows = [...byIssue.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([issue, { words, markers }]) => {
      const density = words > 0 ? (markers / words) * 1000 : 0;
      return `- Issue ${issue}: ${markers} conflict marker${markers === 1 ? '' : 's'} across `
        + `${words} word${words === 1 ? '' : 's'} (${density.toFixed(1)} per 1k)`;
    });
  if (!rows.length) return '';
  return 'Conflict-marker density per issue (deterministic intensity proxy — a rising '
    + 'number suggests escalation, a flat or falling one a plateau / de-escalation; '
    + 'treat as a hint and confirm against the prose):\n' + rows.join('\n');
}

// Human-readable POV-person labels for the head-hopping check's prompt (#1311).
// Inlined (not imported from styleGuide.js) to keep this registry pure — mirrors
// the labels in server/lib/styleGuide.js so generation and the check describe a
// POV person identically. An omniscient style guide no-ops via the check's gate,
// so it's intentionally absent here.
export const POV_PERSON_LABELS = Object.freeze({
  first: 'first person',
  'third-limited': 'third-person limited',
  second: 'second person',
});

// Render the reverse-outline scenes into a compact POV-focused block the
// head-hopping check (#1311) passes alongside the manuscript so the model knows
// WHOSE head each limited-POV scene is anchored to — and which other characters
// are on-stage (candidate heads a head-hop would slip into). EVERY scene is
// rendered: a scene with no recorded POV character is marked "POV: (not recorded
// — infer from the prose)" rather than dropped, so a PARTIALLY-tagged outline
// doesn't silently omit scenes and let the model assume the list is exhaustive of
// POV-bearing scenes (the model still confirms each anchor against the prose).
// Pure + deterministic so it's unit-testable and its token cost can be counted
// into the per-chunk overhead. Returns '' only when there are NO scenes at all
// (the prompt's `{{#povMap}}` section then renders nothing and the check degrades
// to a plain whole-issue scan). Type-guarded throughout — the reverse outline
// rides peer sync (#1348), so a hand-edited / older-peer scene could carry a
// non-string field that a bare `.trim()` would throw on.
export function scenePovSummary(scenes) {
  const list = Array.isArray(scenes) ? scenes : [];
  const lines = list.map((s) => {
    if (!s || typeof s !== 'object') return '';
    const label = sceneLabel(s);
    const issueNumber = Number.isInteger(s.issueNumber) ? s.issueNumber : null;
    const where = issueNumber != null ? `Issue ${issueNumber}` : 'Scene';
    const pov = scenePov(s);
    // Other on-stage characters are the candidate heads a head-hop slips into —
    // exclude the POV holder themselves (by normalized name) so the list names
    // only "other" heads. When the scene has no recorded POV holder there's no
    // one to exclude, so every present character is a candidate.
    const povKey = pov ? normalizeName(pov) : '';
    const others = Array.isArray(s.charactersPresent)
      ? s.charactersPresent
        .filter((n) => typeof n === 'string' && n.trim() && normalizeName(n) !== povKey)
        .map((n) => n.trim())
      : [];
    const povText = pov ? `POV: ${pov}` : 'POV: (not recorded — infer from the prose)';
    const parts = [`- ${where}: ${label} — ${povText}`];
    if (others.length) parts.push(`others present: ${others.join(', ')}`);
    return parts.join(' — ');
  }).filter(Boolean);
  if (!lines.length) return '';
  return `POV per scene (from the reverse outline):\n${lines.join('\n')}`;
}

// Render the RECURRING NON-POV cast (#1585) into a compact text block the
// secondary-arc check passes alongside the manuscript, so the model focuses on
// the side characters that actually carry weight (present across multiple scenes)
// rather than every walk-on. A "secondary" character is one who appears in
// `charactersPresent` but NEVER holds `povCharacter` in ANY scene — a character
// who ever takes the viewpoint is a POV character (covered by pov.justified). For
// each such character we count the scenes they appear in and the span of issues
// those scenes touch, keeping only those at or above `minScenes` (the recurrence
// threshold). Pure + deterministic so it's unit-testable and its token cost can
// be counted into the per-chunk overhead. Returns '' when no non-POV character
// recurs enough (the prompt's `{{#secondaryCast}}` section then renders nothing
// and the check degrades to identifying recurring side characters from the prose
// alone). Type-guarded throughout — the reverse outline rides peer sync (#1348),
// so a hand-edited / older-peer scene could carry a non-string field a bare
// `.trim()` would throw on.
export function secondaryCharacterPresenceSummary(scenes, { minScenes = 2 } = {}) {
  const list = Array.isArray(scenes) ? scenes : [];
  const threshold = Number.isInteger(minScenes) && minScenes > 0 ? minScenes : 2;

  // Every character who EVER holds the viewpoint, by normalized name — these are
  // POV characters and are excluded from the secondary cast even in scenes where
  // they happen to be present-but-not-narrating.
  const povHolders = new Set();
  for (const s of list) {
    const pov = scenePov(s);
    if (pov) povHolders.add(normalizeName(pov));
  }

  // Non-POV character → { name, sceneCount, issues } keyed by normalized name so
  // casing / spacing variants collapse. Preserves first-appearance order (scenes
  // arrive sequence-ordered) for stable output.
  const cast = new Map();
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const issueNumber = Number.isInteger(s.issueNumber) ? s.issueNumber : null;
    const present = Array.isArray(s.charactersPresent)
      ? s.charactersPresent.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim())
      : [];
    // De-dup names within a single scene so a name listed twice counts once.
    const seenThisScene = new Set();
    for (const name of present) {
      const key = normalizeName(name);
      if (!key || povHolders.has(key) || seenThisScene.has(key)) continue;
      seenThisScene.add(key);
      let entry = cast.get(key);
      if (!entry) { entry = { name, sceneCount: 0, issues: new Set() }; cast.set(key, entry); }
      entry.sceneCount += 1;
      if (issueNumber != null) entry.issues.add(issueNumber);
    }
  }

  const rows = [];
  for (const entry of cast.values()) {
    if (entry.sceneCount < threshold) continue;
    const issues = [...entry.issues].sort((a, b) => a - b);
    const span = issues.length
      ? (issues.length === 1 ? `issue ${issues[0]}` : `issues ${issues[0]}–${issues[issues.length - 1]}`)
      : 'no tagged issues';
    rows.push(`- ${entry.name}: present in ${entry.sceneCount} scene${entry.sceneCount === 1 ? '' : 's'} (${span})`);
  }
  if (!rows.length) return '';
  return `Recurring non-POV characters (appear in ${threshold}+ scenes but never hold POV — judge whether each shows meaningful change):\n${rows.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Registry entries.
// ---------------------------------------------------------------------------

// Split a UI text field holding a phrase list (comma- or newline-separated) into
// trimmed, non-empty phrases — used by prose.cliches' allow/extra config fields.
export function splitPhraseList(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.split(/[,\n]/).map((p) => p.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Copy-edit prose-tic checks (#1306). The deterministic word-level scanners live
// in proseTics.js / repetition.js; these helpers turn raw occurrences into the
// density-scaled findings the registry emits. Density matters: one "just" is
// fine, forty is a tic — so each check measures per-1000-word frequency against
// a configurable threshold and only flags when the rate (not the raw count) is
// high. Findings anchor on the FIRST offending occurrence in each section.
// ---------------------------------------------------------------------------

// Word count of a section's prose (for per-1000-word density). Cheap word
// tokenization — apostrophes kept inside words so contractions count once.
export function countWords(text) {
  return (String(text || '').match(/[A-Za-z][A-Za-z']*/g) || []).length;
}

// Map a section to its issue label/number once (used by every prose-tic check).
export function sectionIssue(s) {
  const number = Number.isInteger(s?.number) ? s.number : null;
  return { number, location: number != null ? `Issue ${number}` : 'Manuscript' };
}

// Shared driver for the per-1000-word density checks (filter words, crutch
// words, passive voice). For each section it runs the supplied `scan`, computes
// the per-1000-word rate, and emits one finding per section whose rate is at or
// above the configured `densityPer1000` — anchored to the first occurrence.
// `opts` declares the section scan, a noun for messages, and problem/suggestion
// builders. `scan(text, cfg)` returns `[{ index, anchor }, …]` occurrences.
export function runDensityCheck(ctx, opts) {
  const cfg = ctx.config || {};
  const max = cfg.maxFindings ?? 20;
  const density = cfg.densityPer1000 ?? 0;
  const sections = Array.isArray(ctx.sections) ? ctx.sections : [];
  const findings = [];
  for (const s of sections) {
    if (findings.length >= max) break;
    const text = s?.content || '';
    const words = countWords(text);
    if (words === 0) continue;
    const hits = opts.scan(text, cfg);
    if (!hits.length) continue;
    const rate = Math.round((hits.length / words) * 1000 * 10) / 10;
    if (rate < density) continue;
    const { number, location } = sectionIssue(s);
    findings.push({
      severity: ctx.severityDefault,
      category: 'style',
      location,
      problem: opts.problem(hits.length, rate, hits[0].anchor),
      suggestion: opts.suggestion,
      anchorQuote: hits[0].anchor,
      issueNumber: number,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Comic lettering density / balloon load (#1313) — deterministic over each
// issue's parsed comic script. The pure word/balloon accounting + threshold
// evaluation lives in ./letteringDensity.js (shared with the client comic-script
// stage's inline warnings); the helpers below turn its violations into
// manuscriptReview findings and pre-flight whether any issue even has a script
// (the check's gate). Scope is 'issue' — findings carry the issue number so the
// editor groups them per issue / per page.
// ---------------------------------------------------------------------------

// The AUTHORITATIVE comic pages for an issue (parser-shaped `[{ panels: [...] }]`).
// A POPULATED per-page split (`stages.comicPages.pages[]`) WINS over the generated
// markdown (`stages.comicScript.output`): once a script is split into pages, edits
// in the Comic tab persist to `comicPages.pages[].rawText/panels` and never flow
// back to `comicScript.output`, so reading the raw script would analyze stale text
// (flag balloons the user already cut, miss ones they added). The client
// comic-script stage reads the same `comicPages.pages[].panels`, so both surfaces
// judge the same edited content.
//
// We key on `pages.length`, not `Array.isArray(pages)`, on purpose: the issue
// sanitizer (`sanitizeVisualStage`) ALWAYS materializes `comicPages.pages` as `[]`,
// so an EMPTY array can't distinguish "never split" from "split then all pages
// deleted" — they are byte-identical on disk. Falling back to the still-present
// generated script when the split is empty means an UNSPLIT or IMPORTED script
// (the common pre-render case, where lettering feedback matters most) is still
// checked; the script remains the issue's authored comic text even if a prior
// split was emptied.
export function comicIssuePages(issue) {
  const pages = issue?.stages?.comicPages?.pages;
  if (Array.isArray(pages) && pages.length) {
    return pages.filter((p) => p && typeof p === 'object');
  }
  const output = typeof issue?.stages?.comicScript?.output === 'string' ? issue.stages.comicScript.output : '';
  return output.trim() ? parseComicScript(output).pages : [];
}

// Issues with analyzable comic content, as { number, pages }, sorted by issue
// number for a stable scan order. Shared by the lettering check's `run` AND the
// staleness runner's fingerprint (which projects the lettering-relevant fields off
// this), so the fingerprinted content is exactly what the check analyzes.
export function comicLetteringIssues(issues) {
  return (Array.isArray(issues) ? issues : [])
    .map((i) => ({
      number: Number.isInteger(i?.number) ? i.number : null,
      pages: comicIssuePages(i),
    }))
    .filter((i) => i.pages.length)
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
}

// Cheap presence test for the check's gate — true when any issue has an edited
// comic-pages split OR a non-empty generated script — without paying the parse
// that `comicLetteringIssues` does.
export function hasComicContent(issues) {
  return (Array.isArray(issues) ? issues : []).some((i) => {
    const pages = i?.stages?.comicPages?.pages;
    if (Array.isArray(pages) && pages.length) return true;
    return (typeof i?.stages?.comicScript?.output === 'string' ? i.stages.comicScript.output : '').trim();
  });
}

// One human-readable { problem, suggestion } per violation kind. Kept here (not
// in the pure helper) because the wording is PortOS-facing copy, while the helper
// stays a reusable counting primitive.
function comicLetteringText(v) {
  const who = v.speaker ? ` (${v.speaker})` : '';
  switch (v.kind) {
    case 'balloon-words':
      return {
        problem: `A balloon${who} runs ${v.count} words — over the ~${v.threshold}-word balloon limit. A wall of text crammed into one balloon is the #1 reader gripe in comics.`,
        suggestion: 'Split the balloon in two, move some of it to a caption, or trim the line.',
      };
    case 'caption-words':
      return {
        problem: `A caption box runs ${v.count} words — over the ~${v.threshold}-word limit. A dense narration box buries the art the same way an over-stuffed balloon does.`,
        suggestion: 'Tighten the caption, split it across panels, or cut it down.',
      };
    case 'panel-words':
      return {
        problem: `This panel carries ${v.count} words of lettering — over the ~${v.threshold}-word panel limit, crowding the art.`,
        suggestion: 'Spread the lettering across more panels, or cut copy so the art can breathe.',
      };
    case 'panel-balloons':
      return {
        problem: `This panel has ${v.count} balloons — more than the ~${v.threshold} a single panel reads cleanly with.`,
        suggestion: 'Break the exchange across more panels, or merge balloons from the same speaker.',
      };
    case 'page-words':
    default:
      return {
        problem: `This page carries ${v.count} words of lettering — over the ~${v.threshold}-word page ceiling; the text load would overwhelm the art.`,
        suggestion: 'Move some beats to adjacent pages, or trim copy so the page is not text-heavy.',
      };
  }
}

// Map a lettering violation to a manuscriptReview finding for issue `number`.
// `panelNumber` is absent for page-level findings, so the location degrades to
// "Issue N · Page P" cleanly. Severity rides the violation's overflow-scaled
// value (#1313).
export function comicLetteringFinding(v, number) {
  const { problem, suggestion } = comicLetteringText(v);
  const where = v.panelNumber != null
    ? `Page ${v.pageNumber} · Panel ${v.panelNumber}`
    : `Page ${v.pageNumber}`;
  return {
    severity: v.severity,
    category: 'lettering',
    location: number != null ? `Issue ${number} · ${where}` : where,
    problem,
    suggestion,
    anchorQuote: typeof v.anchorQuote === 'string' ? v.anchorQuote : '',
    issueNumber: number,
  };
}

// Map a balloon-attribution violation to a manuscriptReview finding for issue
// `number`. The wording is PortOS-facing copy (kept here, not in the pure
// helper). Severity rides the violation's risk-scaled value.
export function balloonAttributionFinding(v, number) {
  const where = `Page ${v.pageNumber} · Panel ${v.panelNumber}`;
  const more = v.panelCount > 1 ? ` (and ${v.panelCount - 1} more panel${v.panelCount - 1 === 1 ? '' : 's'} on this page)` : '';
  const target = Array.isArray(v.visibleOthers) && v.visibleOthers.length
    ? ` Another character (${v.visibleOthers.slice(0, 3).join(', ')}) IS shown on the page, so the balloon will likely be tailed to the wrong character.`
    : ' No one is clearly shown speaking it, so the balloon reads as orphaned.';
  return {
    severity: v.severity,
    category: 'continuity',
    location: number != null ? `Issue ${number} · ${where}` : where,
    problem: `${v.speaker} speaks here${more} but is not shown anywhere on the page and the line carries no off-panel/broadcast cue.${target}`,
    suggestion: `Either show ${v.speaker} in a panel on this page, or mark the line as spoken from elsewhere — e.g. ${v.speaker} (OFF-PANEL), (V.O.), (RADIO), or (SPEAKERS)/(PA) for a broadcast — so it renders as a disembodied balloon instead of being attributed to a visible character.`,
    anchorQuote: typeof v.anchorQuote === 'string' ? v.anchorQuote : '',
    issueNumber: number,
  };
}

// ---------------------------------------------------------------------------
// Comic ↔ prose synchronization helpers (#1589). The cross-media check pairs each
// hybrid issue's PROSE (a manuscript section) with its authoritative COMIC content
// and feeds the pair to the model. Pure + deterministic so they're unit-testable
// in isolation (the LLM caller is injected via ctx.callStagedLLM).
// ---------------------------------------------------------------------------

// Per-issue prose ceiling fed to the comic↔prose check (#1589) — so a long
// chapter can't blow a small/local provider's window. Unlike the manuscript-
// corpus checks (which chunk the whole series), this check makes ONE call per
// hybrid issue with that issue's prose + comic, so the bound is per-issue. The
// comic content is the smaller, authoritative anchor; the prose is sliced to this
// ceiling and the prompt warns the model the prose may be truncated. ~24k chars
// ≈ 6k tokens, which fits alongside the comic block on every supported provider.
export const PROSE_SYNC_PROSE_CHAR_CAP = 24_000;

// Extract an issue's PROSE-stage text. Inlines arcPlanner's `stageTextOf` (output
// then input) to keep the registry import-pure (no service import). Reads the
// `prose` stage SPECIFICALLY — NOT the default manuscript precedence (comicScript ▸
// teleplay ▸ prose), which for a hybrid comic+prose issue would return the comic
// script, not the prose (the bug this check exists to avoid). Returns '' when the
// issue has no prose-stage text.
function proseStageText(issue) {
  const stage = issue?.stages?.prose;
  const output = typeof stage?.output === 'string' ? stage.output.trim() : '';
  if (output) return output;
  return typeof stage?.input === 'string' ? stage.input.trim() : '';
}

// Per-issue PROSE-stage content, as `{ number, prose }`, sorted by issue number.
// The single source of truth for "the prose half" of the comic↔prose-sync check —
// read by BOTH the check's `run` AND the runner's `prose` staleness resolver
// (mirrors `comicLetteringIssues` for the comic half), so the fingerprinted text is
// exactly what the check compares. Only issues with prose-stage text contribute.
export function proseStageIssues(issues) {
  return (Array.isArray(issues) ? issues : [])
    .map((i) => ({ number: Number.isInteger(i?.number) ? i.number : null, prose: proseStageText(i) }))
    .filter((i) => i.prose)
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
}

// Render an issue's parsed comic pages into a compact, model-readable block —
// page/panel headers plus each panel's visual DESCRIPTION (what the panel SHOWS),
// DIALOGUE (`speaker: line`), CAPTION, and SFX — so the model can compare what the
// comic shows and says against the prose. Mirrors the field set in
// `projectComicPacingContent` (the `comicScript.pacing` source this check
// fingerprints), so the rendered content matches what staleness tracks. Returns ''
// when no panel carries any content.
export function renderComicForProseSync(pages) {
  const lines = [];
  (Array.isArray(pages) ? pages : []).forEach((p, pageIdx) => {
    const panels = Array.isArray(p?.panels) ? p.panels : [];
    panels.forEach((panel, panelIdx) => {
      const block = [];
      const desc = typeof panel?.description === 'string' ? panel.description.trim() : '';
      if (desc) block.push(`  Shows: ${desc}`);
      for (const d of (Array.isArray(panel?.dialogue) ? panel.dialogue : [])) {
        // The comic-script parser keys the speaker as `character` ({ character, line }),
        // the same field balloonAttribution/letteringDensity read — NOT `speaker`.
        // Tolerate a `speaker` alias for robustness, but `character` is the real shape.
        const rawSpeaker = typeof d?.character === 'string' ? d.character : (typeof d?.speaker === 'string' ? d.speaker : '');
        const speaker = rawSpeaker.trim();
        const line = typeof d?.line === 'string' ? d.line.trim() : '';
        if (line) block.push(`  ${speaker ? `${speaker}: ` : ''}${line}`);
      }
      const caption = typeof panel?.caption === 'string' ? panel.caption.trim() : '';
      if (caption) block.push(`  Caption: ${caption}`);
      const sfx = typeof panel?.sfx === 'string' ? panel.sfx.trim() : '';
      if (sfx) block.push(`  SFX: ${sfx}`);
      // Skip an entirely empty panel — no content to cross-check against prose.
      if (block.length) {
        lines.push(`Page ${pageIdx + 1} · Panel ${panelIdx + 1}`, ...block);
      }
    });
  });
  return lines.join('\n');
}

// The issues that have BOTH drafted PROSE-stage text AND comic content — the
// comparable set for the comic↔prose sync check. Returns `[{ number, prose, comic }]`
// sorted by issue number (`comicLetteringIssues` already sorts), prose sliced to
// PROSE_SYNC_PROSE_CHAR_CAP. An issue with comic but no prose (or prose but no
// comic) has nothing to cross-check and is skipped. Pure: reads ctx.issues only —
// both halves come off the already-loaded issue records (the prose STAGE, not the
// comicScript-precedence manuscript section).
export function proseSyncPairs(ctx) {
  const proseByIssue = new Map();
  for (const { number, prose } of proseStageIssues(ctx?.issues)) {
    if (Number.isInteger(number)) proseByIssue.set(number, prose);
  }
  const pairs = [];
  for (const { number, pages } of comicLetteringIssues(ctx?.issues)) {
    if (!Number.isInteger(number)) continue;
    const prose = proseByIssue.get(number);
    if (!prose) continue;
    const comic = renderComicForProseSync(pages);
    if (!comic.trim()) continue;
    pairs.push({ number, prose: prose.slice(0, PROSE_SYNC_PROSE_CHAR_CAP), comic });
  }
  return pairs;
}
