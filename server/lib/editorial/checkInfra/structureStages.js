/**
 * Macro-structure stage names + their prompt summaries (#2842 split of
 * checkInfra.js): plot structure, worldbuilding doctrine, pacing, timeline,
 * fact accuracy, head-hopping, theme, climax agency, roster and comic/prose sync,
 * plus the canon roster/world/theme/cliffhanger summary renderers they feed.
 */

import { characterNameTokens } from './rosterCast.js';

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
