// Generates, refines and verifies series arcs, reader maps and volumes.

import { runStagedLLM } from '../../stageRunner.js';
import { ServerError } from '../../../lib/errorHandler.js';
import { getSeries } from '../series.js';
import { listIssues } from '../issues.js';
import { getSeason } from '../seasons.js';
import {
  READER_MAP_BEAT_KINDS,
  cleanThemes,
  renderArcShapeGuidance,
  renderArcShapePositionSummary,
  sanitizeArc,
  sanitizeReaderMap,
} from '../../../lib/storyArc.js';
import { runPromptRefineRaw, trimChanges } from '../refineHelpers.js';
import {
  ERR_VALIDATION,
  SHAPE_GUIDANCE_NONE,
  appendTickingClock,
  buildArcBaseContext,
  buildArcOverviewContext,
  buildNeighborVolumes,
  buildReaderMapContext,
  buildVerifyContext,
  compareIssuesByPosition,
  renderVolumeFields,
  renderVolumeIssue,
  shapeSeasonOutlines,
  shapeVerifyIssues,
} from './context.js';
import { codedError } from '../../../lib/codedError.js';

export async function generateArcOverview(seriesId, options = {}) {
  const series = await getSeries(seriesId);
  if (series.locked?.arc === true) {
    throw codedError(
      'Arc is locked — unlock it on the Arc Canvas before regenerating',
      ERR_VALIDATION,
    );
  }
  const ctx = await buildArcOverviewContext(series);
  const { content, runId, providerId, model } = await runStagedLLM(
    'pipeline-arc-overview',
    ctx,
    {
      providerOverride: options.providerOverride,
      providerDefault: options.providerDefault,
      modelOverride: options.modelOverride,
      modelDefault: options.modelDefault,
      effortDefault: options.effortDefault,
      onRunCreated: options.onRunCreated,
      onRunSettled: options.onRunSettled,
      returnsJson: true,
      source: 'pipeline-arc-overview',
    },
  );
  // Build the canonical arc + seasons shape from the LLM payload. We send
  // both back to the caller so the route can persist in one updateSeries
  // call (or hand the user a preview before committing).
  // `shape` is the user's Vonnegut pick — the overview prompt doesn't ask
  // the LLM for it, so without this fallback a regenerate would wipe the
  // pick. Mirrors `resolveVerifyIssues` further down.
  const arc = sanitizeArc({
    logline: content?.logline || '',
    summary: content?.summary || '',
    themes: content?.themes,
    protagonistArc: content?.protagonistArc || '',
    shape: content?.shape ?? series.arc?.shape ?? null,
    // The arc-overview prompt doesn't author the reader map — preserve any
    // existing one (like `shape`) so regenerating the arc never silently wipes
    // a reader map the user already built on the next step.
    seriesDesign: series.arc?.seriesDesign,
    readerMap: series.arc?.readerMap ?? null,
    // Same for the ticking clock — the overview prompt doesn't author it, so
    // preserve any existing countdown across a regenerate.
    tickingClock: series.arc?.tickingClock ?? null,
    // The arc-overview prompt DOES author the foreshadowing ledger (#2172) —
    // take the LLM's if present, else preserve any existing one so a regenerate
    // that omits it doesn't silently wipe the seeds.
    foreshadowing: content?.foreshadowing ?? series.arc?.foreshadowing ?? null,
    status: 'draft',
  });
  const seasons = shapeSeasonOutlines(content?.seasonOutlines);
  return {
    arc,
    seasons,
    raw: content,
    runId,
    providerId,
    model,
  };
}

// The reader map is authored AFTER the plot arc is approved, so a frozen arc
// (`locked.arc`, which protects the core arc fields from the arc-overview
// regenerator) must NOT block reader-map work — only the reader-map field lock
// (`locked.arcFields.readerMap`) does. The locked arc is read as INPUT here.
export function assertReaderMapUnlocked(series) {
  if (series.locked?.arcFields?.readerMap === true) {
    throw codedError('Reader map is locked — unlock it before regenerating', ERR_VALIDATION);
  }
}

/**
 * Generate the reader map (audience experience roadmap) from the series arc.
 * Extraction-only like generateArcOverview — returns the sanitized readerMap;
 * the caller persists it by merging into `series.arc` (preserving the other
 * arc fields) via updateSeries.
 */
export async function generateReaderMap(seriesId, options = {}) {
  const series = await getSeries(seriesId);
  assertReaderMapUnlocked(series);
  const ctx = await buildReaderMapContext(series);
  const { content, runId, providerId, model } = await runStagedLLM(
    'story-builder-reader-map',
    ctx,
    {
      providerOverride: options.providerOverride,
      providerDefault: options.providerDefault,
      modelOverride: options.modelOverride,
      modelDefault: options.modelDefault,
      effortDefault: options.effortDefault,
      onRunCreated: options.onRunCreated,
      onRunSettled: options.onRunSettled,
      returnsJson: true,
      source: 'story-builder-reader-map',
    },
  );
  const readerMap = sanitizeReaderMap({
    hooks: content?.hooks,
    payoffs: content?.payoffs,
    beats: content?.beats,
    cliffhangers: content?.cliffhangers,
    status: 'draft',
  });
  // A null sanitize means the LLM returned nothing usable — surface an error
  // rather than letting the caller persist `readerMap: null` over an existing
  // map (silent data loss).
  if (!readerMap) {
    throw codedError('LLM returned an empty reader map — try regenerating', ERR_VALIDATION);
  }
  return { readerMap, raw: content, runId, providerId, model };
}

/**
 * Refine an existing reader map against free-text feedback (the same AI-
 * feedback affordance as image-prompt refine). Returns the regenerated
 * readerMap plus `changes` (a short bullet list) and `rationale`.
 */
export async function refineReaderMap(seriesId, feedback, options = {}) {
  const series = await getSeries(seriesId);
  assertReaderMapUnlocked(series);
  const arc = series.arc || {};
  const { content, rationale, runId, providerId, model } = await runPromptRefineRaw({
    templateName: 'story-builder-reader-map-refine',
    variables: {
      currentReaderMapJson: arc.readerMap ? JSON.stringify(arc.readerMap, null, 2) : '{}',
      feedback: typeof feedback === 'string' ? feedback.trim().slice(0, 4000) : '',
      arcSummary: arc.summary || '',
      protagonistArc: arc.protagonistArc || '',
      shapeGuidance: appendTickingClock(renderArcShapeGuidance(arc.shape) || SHAPE_GUIDANCE_NONE, arc),
      beatKindsCsv: READER_MAP_BEAT_KINDS.join(', '),
    },
    options,
    source: 'story-builder-reader-map-refine',
    logTag: `Story Builder reader-map refine series=${seriesId.slice(0, 8)}`,
  });
  const readerMap = sanitizeReaderMap({ ...content, status: 'draft' });
  // Refine is meant to PRESERVE — never let an empty LLM payload null out the
  // existing map. Fall back to the current reader map when the refine produced
  // nothing usable (mirrors the AGENTS.md absent-vs-empty rule).
  const safeReaderMap = readerMap || arc.readerMap || null;
  if (!safeReaderMap) {
    throw codedError('LLM returned an empty reader map and there is none to preserve', ERR_VALIDATION);
  }
  // When the refine produced nothing usable and we fell back to the existing
  // map, the LLM's `changes`/`rationale` describe an attempt that was DISCARDED
  // — surfacing them would tell the user we applied edits we threw away. Only
  // report changes/rationale when the refined map is the one we're returning.
  const usedRefinedMap = readerMap != null;
  return {
    readerMap: safeReaderMap,
    changes: usedRefinedMap ? trimChanges(content.changes) : [],
    rationale: usedRefinedMap ? rationale : '',
    runId,
    providerId,
    model,
  };
}

/**
 * Refine an existing plot arc's NARRATIVE fields (logline / summary /
 * protagonist arc / themes) against free-text feedback — the AI-feedback
 * affordance the arc step lacked (it only had full regenerate). Deliberately
 * does NOT re-plan seasons or change the Vonnegut shape: the refine prompt
 * authors only the narrative fields, and `shape`/`readerMap` are carried over
 * from the current arc. Returns the merged arc plus `changes` + `rationale`.
 *
 * Honors the absent-vs-intentionally-empty rule: a field the LLM omits or
 * returns empty falls back to the current value (refine PRESERVES; it must
 * never null out an arc the user already has). The same `locked.arc` guard the
 * arc-overview regenerator uses applies.
 */
export async function refineArc(seriesId, feedback, options = {}) {
  const series = await getSeries(seriesId);
  if (series.locked?.arc === true) {
    throw codedError('Arc is locked — unlock it on the Arc Canvas before refining', ERR_VALIDATION);
  }
  const arc = series.arc || {};
  const { content, rationale, runId, providerId, model } = await runPromptRefineRaw({
    templateName: 'story-builder-arc-refine',
    variables: {
      currentLogline: arc.logline || '',
      currentSummary: arc.summary || '',
      currentProtagonistArc: arc.protagonistArc || '',
      currentThemesCsv: Array.isArray(arc.themes) ? arc.themes.join(', ') : '',
      shapeGuidance: appendTickingClock(renderArcShapeGuidance(arc.shape) || SHAPE_GUIDANCE_NONE, arc),
      series: { name: series.name, premise: series.premise },
      feedback: typeof feedback === 'string' ? feedback.trim().slice(0, 4000) : '',
    },
    options,
    source: 'story-builder-arc-refine',
    logTag: `Story Builder arc refine series=${seriesId.slice(0, 8)}`,
  });
  // Merge the refined narrative fields over the current arc, preserving any the
  // LLM omitted (absent) or returned empty (a refine should never blank a field
  // the user already had). `shape`, `readerMap`, and status pass through from
  // the current arc — this pass is narrative-only. sanitizeArc trims/cleans the
  // fields (incl. themes) on the way in, so pass raw values and only choose
  // between the refined value and the current one here.
  const refinedStr = (next, current) => {
    const trimmed = typeof next === 'string' ? next.trim() : '';
    return trimmed || current || '';
  };
  // Clean the candidate themes BEFORE deciding to keep them: an LLM array of
  // only blanks/nulls (`['  ']`, `[null]`) is non-empty but sanitizes to [],
  // which would wipe the existing themes. Fall back to current when the cleaned
  // candidate is empty (preserve, per the absent-vs-empty rule).
  const cleanedCandidateThemes = cleanThemes(content.themes);
  const refinedThemes = cleanedCandidateThemes.length > 0
    ? cleanedCandidateThemes
    : (arc.themes || []);
  const refinedArc = sanitizeArc({
    logline: refinedStr(content.logline, arc.logline),
    summary: refinedStr(content.summary, arc.summary),
    protagonistArc: refinedStr(content.protagonistArc, arc.protagonistArc),
    themes: refinedThemes,
    shape: arc.shape ?? null,
    seriesDesign: arc.seriesDesign,
    readerMap: arc.readerMap ?? null,
    // The arc-refine prompt edits the narrative fields only — preserve the
    // ticking clock (like readerMap/shape) so a refine never wipes it.
    tickingClock: arc.tickingClock ?? null,
    // Same for the foreshadowing ledger — a narrative refine must not wipe it.
    foreshadowing: arc.foreshadowing ?? null,
    status: 'draft',
  });
  // sanitizeArc returns null only when every identifying field is empty — which,
  // because every field above falls back to the current arc, means the current
  // arc was ALSO empty and the LLM added nothing. Nothing to preserve, so error.
  if (!refinedArc) {
    throw codedError('LLM returned an empty arc and there is none to preserve', ERR_VALIDATION);
  }
  return { arc: refinedArc, changes: trimChanges(content.changes), rationale, runId, providerId, model };
}

export async function verifyArc(seriesId, options = {}) {
  const series = await getSeries(seriesId);
  if (!series.arc) {
    throw new ServerError(
      'Series has no arc to verify — run /arc/generate first',
      { status: 400, code: 'PIPELINE_NO_ARC' },
    );
  }
  const ctx = await buildVerifyContext(series, options.preloadedWorld, { spineOnly: options.spineOnly === true });
  const { content, runId, providerId, model } = await runStagedLLM(
    'pipeline-arc-verify',
    ctx,
    {
      providerOverride: options.providerOverride,
      providerDefault: options.providerDefault,
      modelOverride: options.modelOverride,
      modelDefault: options.modelDefault,
      effortDefault: options.effortDefault,
      onRunCreated: options.onRunCreated,
      onRunSettled: options.onRunSettled,
      returnsJson: true,
      source: 'pipeline-arc-verify',
    },
  );
  const issues = shapeVerifyIssues(content?.issues);
  return { issues, raw: content, runId, providerId, model };
}

export async function buildVolumeVerifyContext(series, season, preloadedWorld, { synopsisOnly = false } = {}) {
  const [allIssues, base] = await Promise.all([
    listIssues({ seriesId: series.id }),
    buildArcBaseContext(series, preloadedWorld),
  ]);
  const volumeIssues = allIssues
    .filter((iss) => iss.seasonId === season.id)
    .sort(compareIssuesByPosition)
    .map((issue) => renderVolumeIssue(issue, { synopsisOnly }));
  // Volume-specific curve placement layered on top of base's arc-wide
  // shapeGuidance so the verifier can flag "this volume inverts the expected
  // fortune at its position."
  const totalSeasons = (series.seasons || []).length || 1;
  const volumeShapePosition = renderArcShapePositionSummary(series.arc?.shape, season.number, totalSeasons)
    || '(no story shape selected — do not flag shape adherence for this volume)';
  return {
    ...base,
    volume: renderVolumeFields(season),
    volumeShapePosition,
    neighborsJson: JSON.stringify(buildNeighborVolumes(series.seasons, season.id), null, 2),
    volumeIssuesJson: JSON.stringify(volumeIssues, null, 2),
  };
}

// Verify a single volume / season — the deeper, narrower counterpart to
// verifyArc. The cross-volume pass operates at synopsis depth across the
// whole arc; this pass operates at beat depth (when beats exist) across one
// volume. Issues without beats are checked at synopsis depth — the prompt
// is explicitly aware of which depth each issue is at, so a partially-
// expanded volume can still be validated mid-workflow.
export async function verifyVolume(seriesId, seasonId, options = {}) {
  const series = await getSeries(seriesId);
  if (!series.arc) {
    throw new ServerError(
      'Series has no arc — run /arc/generate first before verifying a volume',
      { status: 400, code: 'PIPELINE_NO_ARC' },
    );
  }
  const season = await getSeason(seriesId, seasonId);
  const ctx = await buildVolumeVerifyContext(series, season, options.preloadedWorld, {
    synopsisOnly: options.synopsisOnly === true,
  });
  const { content, runId, providerId, model } = await runStagedLLM(
    'pipeline-volume-verify',
    ctx,
    {
      providerOverride: options.providerOverride,
      providerDefault: options.providerDefault,
      modelOverride: options.modelOverride,
      modelDefault: options.modelDefault,
      effortDefault: options.effortDefault,
      onRunCreated: options.onRunCreated,
      onRunSettled: options.onRunSettled,
      returnsJson: true,
      source: 'pipeline-volume-verify',
    },
  );
  const issues = shapeVerifyIssues(content?.issues);
  return { issues, raw: content, runId, providerId, model, seasonId };
}
