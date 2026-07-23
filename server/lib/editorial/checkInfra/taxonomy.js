/**
 * Editorial check taxonomy (#2842 split of checkInfra.js) — the declarative
 * vocabulary every check entry is validated against: scopes, kinds, severities,
 * the staleness `sources` allow-list, and the UI field types.
 */

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

