/**
 * Macro-structure stage names + their prompt summaries: plot structure, worldbuilding doctrine, pacing, timeline,
 * fact accuracy, head-hopping, theme, climax agency, roster and comic/prose sync,
 * plus the canon roster/world/theme/cliffhanger summary renderers they feed.
 *
 * Each stage ships in data.reference/prompts/stages/ + stage-config.json and reaches existing
 * installs through a seed migration (boot runs migrations but NOT setup-data).
 */

import { characterNameTokens } from './rosterCast.js';

// Plot-structure & momentum check: passive protagonist, deus ex machina, idiot plot, flat stakes, sagging middle, dropped subplots.
export const PLOT_STRUCTURE_STAGE = 'pipeline-editorial-plot-structure';

// Worldbuilding-doctrine check pair; both reconcile prose against `canonWorldSummary` plus continuity-bible world-rule facts so an established rule is not flagged.
//   - unforeshadowed-solution: a problem solved by a rule/power the reader was never shown.
//   - cost-free-power: an ability used at a decisive moment with no cost on the page.
export const WORLD_UNFORESHADOWED_SOLUTION_STAGE = 'pipeline-editorial-world-unforeshadowed-solution';
export const WORLD_COST_FREE_POWER_STAGE = 'pipeline-editorial-world-cost-free-power';

// Series-wide pacing check: flat intensity curve, front-loaded climax, or plateauing/de-escalating stakes, scored from a per-issue conflict-marker density tally.
export const PACING_ESCALATION_STAGE = 'pipeline-editorial-pacing-escalation-curve';

// Timeline / canon-contradiction check: a dead character reappearing, an age contradicting the bible, impossible chronology.
export const TIMELINE_CONTRADICTION_STAGE = 'pipeline-editorial-timeline-contradiction';

// Fact-accuracy check against `series.factReference`; opt-in, gated on `series.factCritical` so it never fires on pure fantasy.
export const FACT_ACCURACY_STAGE = 'pipeline-editorial-fact-accuracy';

// Unearned personality-shift check against canon traits and authored arcs, so an intentional, earned transition is not flagged.
export const CHARACTER_CONSISTENCY_STAGE = 'pipeline-editorial-character-consistency';

// POV-discipline check within a scene (distinct from pov.justified, which asks whether each POV character earns an arc).
export const HEAD_HOPPING_STAGE = 'pipeline-editorial-head-hopping';

// Comic page-turn check: big reveals the reader sees early rather than on the first page after a turn. The deterministic sibling (comic.panel-rhythm) needs no stage.
export const COMIC_PAGE_TURN_STAGE = 'pipeline-editorial-comic-page-turn';

// Theme-coherence check: each declared arc theme set up / complicated / paid off, plus strong emergent themes not in the arc.
export const THEME_COHERENCE_STAGE = 'pipeline-editorial-theme-coherence';

// Render the authored arc themes for the theme-coherence prompt. Pure; returns '' when none are
// authored (the `{{#declaredThemes}}` section renders nothing and the check still looks for an emergent theme).
export function declaredThemesSummary(themes) {
  const lines = (Array.isArray(themes) ? themes : [])
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter(Boolean)
    .map((t) => `- ${t}`);
  if (!lines.length) return '';
  return `Declared themes (authored on the story arc):\n${lines.join('\n')}`;
}

// Climax check: is it the protagonist's hardest active choice and does it resolve the core problem/theme. Gates its verdict on the final part (`finalPart`); degrades to a prose-only scan without reader-map, themes or outline.
export const CLIMAX_AGENCY_STAGE = 'pipeline-editorial-climax-agency';

// Emotional-reaction proportionality check. Carries events still awaiting a reaction across chunks (`crossChunkSetup`); degrades to a prose-only scan without an outline.
export const REACTION_PROPORTIONALITY_STAGE = 'pipeline-editorial-reaction-proportionality';

// Recurring non-POV character-arc check (sibling of pov.justified, which covers POV characters). A flat arc is a whole-story claim, so it gates on `finalPart` and carries state via `crossChunkSetup`.
export const SECONDARY_ARC_STAGE = 'pipeline-editorial-secondary-arc';

// Unmodeled-proper-nouns check: capitalized names absent from canon. The LLM half of roster economy; the deterministic `roster.economy` scan cannot tell a person from a place/org/brand.
export const UNMODELED_NAMES_STAGE = 'pipeline-editorial-unmodeled-names';

// Eyeline-match continuity check over per-issue storyboard shots (`ctx.storyboardScenes`); the judgment sibling of the deterministic `visual.shot-continuity` scan (see shotContinuity.js).
export const EYELINE_MATCH_STAGE = 'pipeline-editorial-eyeline-match';

// Appearance/prop continuity check: diffs free-text descriptions of the same entity across shots within a scene, which the deterministic shot parser never does.
export const APPEARANCE_CONTINUITY_STAGE = 'pipeline-editorial-appearance-continuity';

// Comic <-> prose sync check for hybrid issues; flags substantive divergences only, since comics legitimately compress and cut.
export const COMIC_PROSE_SYNC_STAGE = 'pipeline-editorial-comic-prose-sync';

// Render the canon roster's names + aliases so the unmodeled-names check does NOT flag modeled
// names. Pure; returns '' when no canon character has a usable name (every named proper noun is
// then a candidate, right for an empty bible). `characterNameTokens` gives the matcher's trim/de-dup.
export function canonRosterNamesSummary(canon) {
  const chars = Array.isArray(canon?.characters) ? canon.characters : [];
  const lines = [];
  for (const c of chars) {
    // An alias-only row isn't a named character (mirrors buildRosterAppearances).
    if (!c || typeof c.name !== 'string' || !c.name.trim()) continue;
    const [name, ...aliases] = characterNameTokens(c);
    lines.push(aliases.length ? `- ${name} (also: ${aliases.join(', ')})` : `- ${name}`);
  }
  if (!lines.length) return '';
  return `Known characters (already in the story bible — do NOT flag these or their aliases):\n${lines.join('\n')}`;
}

// Render the established WORLD canon (objects with significance, places with recurring details)
// so the worldbuilding checks can tell an established rule/power from one that appears out of
// nowhere. Pure and type-guarded throughout (canon rides peer sync, so a row may carry a
// non-string field). Returns '' when nothing is usable (`{{#canonWorld}}` renders nothing).
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
  // Neutral framing: it deliberately does NOT assert the reader has seen these; the
  // unforeshadowed-solution check must still flag a canon rule the PROSE never surfaced.
  return `World-bible reference (the author's record of the world's artifacts, places, and mechanics — use it to understand what a thing is and does; it is NOT the manuscript and does not prove the reader has seen any of it):\n\n${blocks.join('\n\n')}`;
}

// Render the authored reader-map cliffhangers so the chapter-ending check can reconcile detected
// endings against the writer's logged ones. Pure; returns '' when none are authored.
// `atIssueBoundary` is the issue the cliffhanger caps, surfaced as a location hint.
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
