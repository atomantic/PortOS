/**
 * Series Autopilot — deterministic step resolution (#2842 split of
 * seriesAutopilot.js). Pure: given the series, its issues and the run state,
 * decides the single next step. No I/O, so it is exhaustively unit-testable.
 */

import { parseComicScript } from '../../../lib/comicScriptParser.js';
import { isStageReady } from '../issues.js';
import { compareIssuesByPosition } from '../arcPlanner.js';
import { wantsTeaser, wantsVisual } from './config.js';
import { VISUAL_DRAFT_ENABLED } from './convergence.js';

// ---------------------------------------------------------------------------
// Pure next-step resolver — the heart of the conductor (no I/O; unit-tested).
// ---------------------------------------------------------------------------

const setHas = (s, v) => (s instanceof Set ? s.has(v) : Array.isArray(s) ? s.includes(v) : false);

export const byNumber = (a, b) => (a?.number ?? 9999) - (b?.number ?? 9999);

// The script stages a series must have drafted to be "story-ready", derived
// from its targetFormat. prose is the intermediate source the scripts adapt
// from — we gate on the final scripts so a script-first import (prose empty,
// script authored) is already considered ready and never regenerated.
export function requiredScriptStages(series, options = {}) {
  const fmt = series?.targetFormat || 'comic+tv';
  // Per-run format restriction: a multi-format (comic+tv) series can be driven
  // to just one format's scripts in a single autopilot run — e.g. "produce the
  // comic draft only, skip the 24 teleplays." `options.targetFormats` is a
  // subset of ['comic','tv']; absent/empty means "all formats the series wants".
  const restrict = Array.isArray(options?.targetFormats) && options.targetFormats.length
    ? options.targetFormats
    : null;
  const wantComic = fmt.includes('comic') && (!restrict || restrict.includes('comic'));
  const wantTv = fmt.includes('tv') && (!restrict || restrict.includes('tv'));
  const stages = [];
  if (wantComic) stages.push('comicScript');
  if (wantTv) stages.push('teleplay');
  // Never strand the run with zero required script stages (which would mark every
  // issue text-ready with no script authored). If the restriction excludes
  // everything this series supports, ignore it and fall back to the series' own
  // formats.
  if (stages.length === 0) return requiredScriptStages(series);
  return stages;
}

export function isComicTarget(series) {
  return (series?.targetFormat || 'comic+tv').includes('comic');
}

// Does THIS run want the comic format? `isComicTarget` alone keys off the
// series' declared format, but a per-run `options.targetFormats` restriction can
// scope a comic+tv series to TV only — in which case the comic-only steps
// (scriptVerify, visual draft) must NOT run, or a TV-only pass would enter
// comic-script verification with no comicScript and pause on an unparseable
// script. Mirrors the restriction logic in requiredScriptStages: an empty/absent
// restriction (or one that excludes everything the series supports) means "all
// formats the series wants", so this stays true for the default whole-series run.
export function wantsComic(series, options = {}) {
  if (!isComicTarget(series)) return false;
  const restrict = Array.isArray(options?.targetFormats) && options.targetFormats.length
    ? options.targetFormats
    : null;
  if (!restrict) return true;
  // If the restriction excludes every format the series supports, requiredScriptStages
  // ignores it (never strand the run) — match that here so the gates agree.
  const wantComic = restrict.includes('comic');
  const wantTv = restrict.includes('tv') && (series?.targetFormat || '').includes('tv');
  if (!wantComic && !wantTv) return true; // restriction is a no-op → whole series
  return wantComic;
}


export function orderedIssues(issues) {
  return [...(Array.isArray(issues) ? issues : [])].sort(compareIssuesByPosition);
}

export function textReady(issue, series, options = {}) {
  return requiredScriptStages(series, options).every((stageId) => isStageReady(issue.stages?.[stageId]));
}

// An issue "has beats" once its idea stage carries expanded beat text
// (idea.output) — the unit the whole-manuscript beat-continuity pass (#1510)
// reads. isStageReady(idea) is exactly that: status ready/edited AND non-empty
// output.
export function issueHasBeats(issue) {
  return isStageReady(issue?.stages?.idea);
}

// Structural script gate (pure): does the comic script parse into >=1 page with
// >=1 panel? Cheap, no LLM — this is the Phase-1 "verify the scripts work".
export function scriptStructurallyReady(issue) {
  const output = issue.stages?.comicScript?.output || '';
  if (!output.trim()) return false;
  const { pages } = parseComicScript(output);
  if (!Array.isArray(pages) || pages.length === 0) return false;
  return pages.some((p) => Array.isArray(p.panels) && p.panels.length > 0);
}

// A render slot counts as "enqueued" once it carries a jobId or a stamped
// filename (proof or final). Draft rendering only kicks off proof renders, but
// we accept either so a re-run never re-renders a slot the user already
// finalized manually.
// Include the legacy pre-proof/final fields (`imageJobId`/`filename`) the
// sanitizer still preserves on upgraded projects — otherwise an
// already-rendered legacy slot reads as un-enqueued and gets re-rendered.
export const slotEnqueued = (slot) => !!(
  slot && (slot.proofImage?.jobId || slot.proofImage?.filename
    || slot.finalImage?.jobId || slot.finalImage?.filename
    || slot.imageJobId || slot.filename)
);
export const pageEnqueued = (page) => !!(
  page && (page.proofImage?.jobId || page.proofImage?.filename
    || page.finalImage?.jobId || page.finalImage?.filename
    || page.imageJobId || page.filename)
);

/**
 * Has an issue's comic art been drafted? True once pages exist, the front cover
 * is enqueued, any authored back cover is enqueued, and every page that HAS
 * panels is enqueued. Pages with no panels can't be rendered, so they don't
 * block readiness.
 */
export function visualReady(issue) {
  const cp = issue.stages?.comicPages;
  const pages = Array.isArray(cp?.pages) ? cp.pages : [];
  if (pages.length === 0) return false;
  if (!slotEnqueued(cp?.cover)) return false;
  if (!slotEnqueued(cp?.backCover)) return false; // always drafted (renderer has a fallback)
  return pages.every((p) => (Array.isArray(p.panels) && p.panels.length > 0 ? pageEnqueued(p) : true));
}

/**
 * Return the first unmet step for a series given its canonical records and the
 * in-run accumulator (`runState`). Pure — caller supplies fresh state.
 *
 * runState fields consulted (all optional): arcVerified, editorialReviewed,
 * reverseOutlineRefreshed (booleans); beatsAttempted, textAttempted, scriptChecked (Set|array of ids).
 * The *attempted* sets stop a perpetually-failing step (an issue whose LLM run
 * keeps erroring) from looping forever — the conductor records an attempt even
 * on failure, so the resolver moves past it within one run.
 */
export function resolveNextStep(series, issues, runState = {}, options = {}) {
  const seasons = Array.isArray(series?.seasons) ? [...series.seasons].sort(byNumber) : [];
  const ordered = orderedIssues(issues);

  // STEP 1 — arc. Also (re)generate when there are no seasons at all: an
  // arc-only series (arc text present, seasons: []) has nothing for the
  // episode/issue steps to expand, and would otherwise sail through verify/
  // review of an empty issue list and be marked done with no volumes. The
  // attempted-guard stops a re-loop if arc generation yields no seasons (the
  // dispatch pauses in that case).
  const noArc = !series?.arc?.logline && !series?.arc?.summary;
  if (!runState.arcAttempted && (noArc || seasons.length === 0)) {
    return { kind: 'generateArc', reason: seasons.length === 0 && !noArc ? 'series has no volumes' : 'series has no arc' };
  }

  // STEP 2 — a season with zero issues (in season order). Skip volumes already
  // attempted this run so an empty episode generation can't re-loop (the
  // dispatch pauses when it produces no issues).
  for (const season of seasons) {
    if (setHas(runState.episodesAttempted, season.id)) continue;
    const inSeason = ordered.filter((i) => i.seasonId === season.id);
    if (inSeason.length === 0) {
      return { kind: 'generateEpisodes', seasonId: season.id, reason: `volume ${season.number ?? '?'} has no issues` };
    }
  }

  // STEP 3 — arc verification (once per run; bounded loop happens in dispatch).
  if (!runState.arcVerified) {
    return { kind: 'verifyArc', reason: 'arc not yet verified this run' };
  }

  // STEP 3.5 — foundation-quality gate (#2176). After the arc/volumes exist and
  // arc structure is verified, judge the whole foundation (world / characters /
  // arc) BEFORE the expensive beat/text stages and iterate on the weakest
  // dimension until it clears the threshold. Once per run (bounded loop happens
  // in dispatch). Gated on `foundationGate` being enabled AND a non-zero round
  // budget — a disabled/0-round gate is treated as already satisfied so the
  // resolver falls straight through to beats (the dispatch never runs).
  if (!runState.foundationGated
    && options.foundationGate !== false
    && options.maxFoundationRounds !== 0) {
    return { kind: 'foundationGate', reason: 'foundation not yet judged this run' };
  }

  // STEP 4a — per-volume beat sheets (skip volumes already attempted this run).
  for (const season of seasons) {
    if (setHas(runState.beatsAttempted, season.id)) continue;
    const inSeason = ordered.filter((i) => i.seasonId === season.id);
    if (inSeason.some((i) => !isStageReady(i.stages?.idea))) {
      return { kind: 'beatSheet', seasonId: season.id, reason: `beats missing in volume ${season.number ?? '?'}` };
    }
  }

  // STEP 4a.5 — whole-manuscript beat continuity (#1510). Once every volume's
  // beats exist (the 4a loop above is exhausted), run ONE cross-issue beat-level
  // pass BEFORE the expensive text/script generation — catching dropped
  // cliffhangers, finale drift, unlanded through-lines, and duplicated "firsts"
  // at the cheap beat altitude instead of after 24 full scripts exist. Only
  // meaningful when at least one issue actually carries beats; a synopsis-only
  // run has nothing beat-level to check (and would just duplicate arc verify),
  // so it's skipped without ever marking the gate.
  if (!runState.beatContinuityChecked && ordered.some(issueHasBeats)) {
    return { kind: 'beatContinuity', reason: 'whole-manuscript beat continuity not yet checked this run' };
  }

  // STEP 4b — per-issue text stages (prose + required scripts).
  for (const issue of ordered) {
    if (setHas(runState.textAttempted, issue.id)) continue;
    if (!textReady(issue, series, options)) {
      return { kind: 'textStages', issueId: issue.id, reason: 'prose / scripts not ready' };
    }
  }

  // STEP 4c — structural script gate (comic targets only). Gate on wantsComic,
  // not bare isComicTarget, so a TV-only run of a comic+tv series doesn't enter
  // comic-script verification with no comicScript (which would pause on an
  // unparseable script).
  if (wantsComic(series, options)) {
    for (const issue of ordered) {
      if (setHas(runState.scriptChecked, issue.id)) continue;
      return { kind: 'scriptVerify', issueId: issue.id, reason: 'comic script not yet structurally verified' };
    }
  }

  // STEP 5 — series-level editorial review via the manuscript editor (once).
  if (!runState.editorialReviewed) {
    return { kind: 'editorialReview', reason: 'editorial review not yet run this run' };
  }

  // STEP 5.1 — refresh the reverse-outline scene segmentation (#1349). Runs AFTER
  // the editorial completeness pass (STEP 5, which may edit the manuscript) and
  // BEFORE the registry checks (5.2) so the scene-consuming checks read fresh
  // scenes. The handler self-gates: a no-op (no budget) when no enabled check
  // reads the outline or the stored outline is already fresh.
  if (!runState.reverseOutlineRefreshed) {
    return { kind: 'reverseOutline', reason: 'reverse-outline segmentation not yet refreshed this run' };
  }

  // STEP 5.2 — registry-driven editorial checks (#1284). Runs the enabled
  // editorial checks once per run and seeds their findings into the same
  // manuscript-review comment set. A no-op when no checks are enabled.
  if (!runState.editorialChecksReviewed) {
    return { kind: 'editorialChecks', reason: 'editorial checks not yet run this run' };
  }

  // STEP 5.3 — editorial health convergence gate (#1316). After BOTH editorial
  // passes have seeded their findings, read the aggregate "ready" signal (no open
  // findings above the configured readiness gate). The completeness loop only
  // gates on its OWN high findings; the registry checks (5.2) can surface fresh
  // blockers after it converged, so this final gate reconciles the whole review
  // before visuals. Pauses with the residual blockers when not clean.
  if (!runState.editorialHealthReady) {
    return { kind: 'editorialHealthGate', reason: 'editorial health not yet confirmed clean this run' };
  }

  // STEP 5.4 — iterate-to-quality revision loop (CWQE Phase 7, #2171). Opt-in.
  // Runs AFTER the editorial health gate is clean (so the manuscript is
  // structurally sound) and BEFORE canon/visuals — each cycle judges every
  // drafted issue, revises the weakest through adversarial cuts under a
  // keep/revert score gate, and stops on plateau / hedged-convergence / maxCycles.
  // Pure-function-of-state like every other step: cycle counters + convergence
  // live in runState (revisionCyclesRun / revisionConverged), so a resume picks up
  // mid-loop with no stored cursor. `revisionConverged` is set by the dispatch
  // once a stop condition fires; until then we route back here while cycles remain.
  if (options.revisionEnabled
    && !runState.revisionConverged
    && (runState.revisionCyclesRun || 0) < (options.revisionMaxCycles ?? 1)) {
    return { kind: 'revisionCycle', reason: `iterate-to-quality revision cycle ${(runState.revisionCyclesRun || 0) + 1}` };
  }

  // STEP 5.5 — canon descriptive integrity. Before ANY visual production, every
  // canon noun that appears where it'd be drawn must be described (an artist
  // can't render a name). Runs once per run; the gate blocks (pauses) on
  // undescribed drawn nouns. Only relevant when visuals will be produced.
  if (VISUAL_DRAFT_ENABLED && wantsVisual(options) && wantsComic(series, options) && !runState.canonVerified) {
    return { kind: 'canonVerify', reason: 'canon descriptive integrity not yet verified this run' };
  }

  // STEP 6 — draft visuals (cover + back + all interior pages).
  if (VISUAL_DRAFT_ENABLED && wantsVisual(options) && wantsComic(series, options)) {
    for (const issue of ordered) {
      if (setHas(runState.visualDrafted, issue.id)) continue;
      if (visualReady(issue)) continue;
      return { kind: 'visualDraft', issueId: issue.id, reason: 'comic pages not yet drafted' };
    }
  }

  // STEP 7 — teaser video deliverable (CDO Phase 3, #2185, opt-in, default off).
  // After every issue is text-ready + drafted, OPTIONALLY mint + start a Creative
  // Director video project seeded from each issue. Gated on wantsTeaser (which
  // itself requires visuals). Attempted-once per issue this run so a started (or
  // failed) teaser can't re-loop the resolver back here.
  if (VISUAL_DRAFT_ENABLED && wantsTeaser(options) && wantsComic(series, options)) {
    for (const issue of ordered) {
      if (setHas(runState.teaserProduced, issue.id)) continue;
      return { kind: 'produceTeaser', issueId: issue.id, reason: 'teaser video not yet produced' };
    }
  }

  return { kind: 'done' };
}
