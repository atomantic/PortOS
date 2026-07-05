/**
 * arcPlanner/arcCore.js — the arc overview / reader-map / refine / verify /
 * resolve / commit cluster.
 *
 * These passes are mutually recursive (overview ↔ resolve ↔ commit, verify ↔
 * volume-verify) and can't be cleanly separated, so they share one module.
 * Built on the leaf helpers in ./context.js.
 */

import { runStagedLLM } from '../../../lib/stageRunner.js';
import { ServerError } from '../../../lib/errorHandler.js';
import { stripAnsi } from '../../../lib/ansiStrip.js';
import { ARC_LOCKABLE_FIELDS, getSeries, updateSeries } from '../series.js';
import { listIssues, recomputeIssueNumbersForSeries, updateIssue, updateStageWithLatest } from '../issues.js';
import { emitRecordUpdated, withReexportSuppressed } from '../../sharing/recordEvents.js';
import { getSeason } from '../seasons.js';
import { READER_MAP_BEAT_KINDS, buildSeason, cleanThemes, renderArcShapeGuidance, renderArcShapePositionSummary, sanitizeArc, sanitizeReaderMap, sanitizeSeason, sanitizeSeasonList } from '../../../lib/storyArc.js';
import { runPromptRefineRaw, trimChanges } from '../refineHelpers.js';
import { ERR_VALIDATION, SHAPE_GUIDANCE_NONE, appendTickingClock, buildArcBaseContext, buildArcOverviewContext, buildNeighborVolumes, buildReaderMapContext, buildResolveContext, buildVerifyContext, compareIssuesByPosition, makeErr, matchIssueForEpisodeEdit, renderVolumeIssue, resolveWorldContext, seasonIdByNumberOf, shapeEpisodeResolutions, shapeFindings, shapeSeasonOutlines, shapeVerifyIssues } from './context.js';

export async function generateArcOverview(seriesId, options = {}) {
  const series = await getSeries(seriesId);
  if (series.locked?.arc === true) {
    throw makeErr(
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
    throw makeErr('Reader map is locked — unlock it before regenerating', ERR_VALIDATION);
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
    throw makeErr('LLM returned an empty reader map — try regenerating', ERR_VALIDATION);
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
  // nothing usable (mirrors the CLAUDE.md absent-vs-empty rule).
  const safeReaderMap = readerMap || arc.readerMap || null;
  if (!safeReaderMap) {
    throw makeErr('LLM returned an empty reader map and there is none to preserve', ERR_VALIDATION);
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
    throw makeErr('Arc is locked — unlock it on the Arc Canvas before refining', ERR_VALIDATION);
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
    throw makeErr('LLM returned an empty arc and there is none to preserve', ERR_VALIDATION);
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
  const ctx = await buildVerifyContext(series, options.preloadedWorld);
  const { content, runId, providerId, model } = await runStagedLLM(
    'pipeline-arc-verify',
    ctx,
    {
      providerOverride: options.providerOverride,
      providerDefault: options.providerDefault,
      modelOverride: options.modelOverride,
      modelDefault: options.modelDefault,
      returnsJson: true,
      source: 'pipeline-arc-verify',
    },
  );
  const issues = shapeVerifyIssues(content?.issues);
  return { issues, raw: content, runId, providerId, model };
}

export async function buildVolumeVerifyContext(series, season, preloadedWorld) {
  const [allIssues, base] = await Promise.all([
    listIssues({ seriesId: series.id }),
    buildArcBaseContext(series, preloadedWorld),
  ]);
  const volumeIssues = allIssues
    .filter((iss) => iss.seasonId === season.id)
    .sort(compareIssuesByPosition)
    .map(renderVolumeIssue);
  // Volume-specific curve placement layered on top of base's arc-wide
  // shapeGuidance so the verifier can flag "this volume inverts the expected
  // fortune at its position."
  const totalSeasons = (series.seasons || []).length || 1;
  const volumeShapePosition = renderArcShapePositionSummary(series.arc?.shape, season.number, totalSeasons)
    || '(no story shape selected — do not flag shape adherence for this volume)';
  return {
    ...base,
    volume: {
      number: season.number ?? '',
      title: season.title || '',
      logline: season.logline || '',
      synopsis: season.synopsis || '',
      endingHook: season.endingHook || '',
      episodeCountTarget: season.episodeCountTarget ?? '',
      themesCsv: Array.isArray(season.themes) ? season.themes.join(', ') : '',
    },
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
  const ctx = await buildVolumeVerifyContext(series, season, options.preloadedWorld);
  const { content, runId, providerId, model } = await runStagedLLM(
    'pipeline-volume-verify',
    ctx,
    {
      providerOverride: options.providerOverride,
      providerDefault: options.providerDefault,
      modelOverride: options.modelOverride,
      modelDefault: options.modelDefault,
      returnsJson: true,
      source: 'pipeline-volume-verify',
    },
  );
  const issues = shapeVerifyIssues(content?.issues);
  return { issues, raw: content, runId, providerId, model, seasonId };
}

// Per-episode (issue) records are NOT touched — those are user-owned scripts
// and shouldn't get clobbered by a structural fix. If a finding's only
// actionable resolution would require deleting issues, the LLM is told to
// flag that in the response's `notes` field rather than executing it.
// `options.findings` empty / omitted = re-run verify first and resolve
// everything it returns.
export async function resolveVerifyIssues(seriesId, options = {}) {
  const series = await getSeries(seriesId);
  if (!series.arc) {
    throw new ServerError(
      'Series has no arc to resolve — run /arc/generate first',
      { status: 400, code: 'PIPELINE_NO_ARC' },
    );
  }
  // Resolve rewrites arc + seasons in place, so the lock gates this too.
  // Verify (read-only) stays enabled — the user can act on findings manually.
  if (series.locked?.arc === true) {
    throw new ServerError(
      'Arc is locked — unlock it before rewriting the arc',
      { status: 400, code: ERR_VALIDATION },
    );
  }

  // Load the world once and thread it through verify + resolve so the
  // refresh-then-resolve path doesn't hit the filesystem twice for the same
  // world.
  const world = await resolveWorldContext(series);

  let findings = shapeFindings(options.findings);
  if (!findings.length) {
    const fresh = await verifyArc(seriesId, { ...options, preloadedWorld: world });
    findings = fresh.issues || [];
    if (!findings.length) {
      return { series, applied: false, notes: 'No findings to resolve', findings: [] };
    }
  }

  const ctx = await buildResolveContext(series, findings, world);
  const { content, runId, providerId, model } = await runStagedLLM(
    'pipeline-arc-resolve',
    ctx,
    {
      providerOverride: options.providerOverride,
      providerDefault: options.providerDefault,
      modelOverride: options.modelOverride,
      modelDefault: options.modelDefault,
      returnsJson: true,
      source: 'pipeline-arc-resolve',
    },
  );

  const arc = sanitizeArc({
    logline: content?.arc?.logline || series.arc.logline || '',
    summary: content?.arc?.summary || series.arc.summary || '',
    themes: content?.arc?.themes ?? series.arc.themes,
    protagonistArc: content?.arc?.protagonistArc ?? series.arc.protagonistArc ?? '',
    shape: content?.arc?.shape ?? series.arc.shape ?? null,
    // The resolve prompt doesn't author the reader map — preserve any existing
    // one so auto-resolve never silently wipes a reader map the user already
    // built on the next step. Mirrors `generateArcOverview` above.
    readerMap: series.arc?.readerMap ?? null,
    // Same for the ticking clock — auto-resolve must not wipe the countdown.
    tickingClock: series.arc?.tickingClock ?? null,
    // The resolve prompt doesn't author the foreshadowing ledger — take it if
    // present, else preserve any existing one so auto-resolve never wipes it.
    foreshadowing: content?.arc?.foreshadowing ?? series.arc?.foreshadowing ?? null,
    status: 'draft',
  });

  // Round-trip the LLM's seasons through `buildSeason` if they include a
  // brand-new entry (no `id`), otherwise preserve the existing `id` so child
  // issues still join their season cleanly. The sanitizer enforces the
  // canonical shape regardless.
  const existingById = new Map((series.seasons || []).map((s) => [s.id, s]));
  const proposedSeasons = Array.isArray(content?.seasons) ? content.seasons : [];
  // Track each entry's provenance (existing id vs freshly minted) so we can
  // remap orphaned child issues after sanitization.
  const seasonEntries = proposedSeasons.map((raw) => {
    const existing = raw?.id ? existingById.get(raw.id) : null;
    if (existing) {
      return {
        season: sanitizeSeason({
          ...existing,
          title: typeof raw.title === 'string' ? raw.title : existing.title,
          number: Number.isFinite(raw.number) ? raw.number : existing.number,
          logline: typeof raw.logline === 'string' ? raw.logline : existing.logline,
          synopsis: typeof raw.synopsis === 'string' ? raw.synopsis : existing.synopsis,
          endingHook: typeof raw.endingHook === 'string' ? raw.endingHook : existing.endingHook,
          episodeCountTarget: Number.isFinite(raw.episodeCountTarget)
            ? raw.episodeCountTarget
            : existing.episodeCountTarget,
          themes: Array.isArray(raw.themes) ? raw.themes : existing.themes,
        }),
        sourceId: existing.id,
      };
    }
    return {
      season: buildSeason({
        number: raw?.number,
        title: raw?.title,
        logline: raw?.logline,
        synopsis: raw?.synopsis,
        endingHook: raw?.endingHook,
        episodeCountTarget: raw?.episodeCountTarget,
      }),
      sourceId: null,
    };
  }).filter((entry) => entry?.season);

  const seasons = sanitizeSeasonList(seasonEntries.map((e) => e.season));

  const { series: updated } = await commitSeasonsWithRemap(series, { arc, seasons });

  // Apply any episode-level synopsis corrections the resolver returned. This is
  // the heal capability that lets episode-scoped findings converge: when a
  // contradiction originates inside one episode's planning synopsis (e.g. it
  // stages an event a later volume reserves as its own "first"), the only fix is
  // to rewrite that episode — the volume/arc layer can't make it go away. Done
  // here (after the arc+season commit) against the freshest issue set.
  const episodesResolved = await applyEpisodeResolutions(
    seriesId,
    updated,
    shapeEpisodeResolutions(content?.episodes),
  );

  const notes = typeof content?.notes === 'string' ? content.notes.trim().slice(0, 2000) : '';
  return {
    series: updated,
    applied: true,
    notes,
    findings,
    episodesResolved,
    runId,
    providerId,
    model,
  };
}

/**
 * Apply the auto-resolve pass's episode-synopsis corrections to the canonical
 * issue records. Each correction targets one issue by its series-global episode
 * number (with `seasonNumber` as a disambiguating cross-check). Writes the new
 * synopsis to the issue's `idea.input` seed. If that issue already has expanded
 * beats (`idea.output`) — only possible on a resume where beats ran in a prior
 * pass — they are cleared and the stage reset to `empty` so the beat-sheet step
 * regenerates them from the corrected synopsis instead of leaving stale beats
 * that still encode the contradiction.
 *
 * A locked `idea` stage is left untouched (the user froze it) and reported as
 * skipped. Returns `[{ issueId, number, seasonNumber, clearedBeats, skipped }]`
 * for the conductor to surface; never throws — a bad match is dropped, not fatal.
 */
export async function applyEpisodeResolutions(seriesId, series, episodes) {
  if (!Array.isArray(episodes) || episodes.length === 0) return [];
  const issues = await listIssues({ seriesId });
  const seasonIdByNumber = seasonIdByNumberOf(series);
  const applied = [];
  for (const edit of episodes) {
    // Season match required when the named season resolves, else series-global
    // number; fail-safe to no-match on a numbering-scheme mismatch (see
    // matchIssueForEpisodeEdit). A bad match is logged below, never fatal.
    const issue = matchIssueForEpisodeEdit(issues, seasonIdByNumber, edit);
    if (!issue) {
      // A correction we can't land is a silent path to non-convergence — log it
      // so a number-scheme mismatch (per-season vs series-global) is diagnosable.
      console.log(`⚠️ arc-resolve: no issue matched episode correction (season ${edit.seasonNumber}, episode ${edit.episodeNumber})`);
      applied.push({ seasonNumber: edit.seasonNumber, episodeNumber: edit.episodeNumber, skipped: 'no-match' });
      continue;
    }
    if (issue.stages?.idea?.locked === true) {
      applied.push({ issueId: issue.id, number: issue.number, seasonNumber: edit.seasonNumber, skipped: 'locked' });
      continue;
    }
    const hadBeats = !!(issue.stages?.idea?.output && issue.stages.idea.output.trim());
    await updateStageWithLatest(issue.id, 'idea', (current) => (
      hadBeats
        ? { input: edit.synopsis, output: '', status: 'empty', errorMessage: '' }
        : { input: edit.synopsis }
    )).catch((err) => {
      console.log(`⚠️ arc-resolve: episode ${edit.episodeNumber} synopsis edit failed: ${err.message}`);
    });
    applied.push({ issueId: issue.id, number: issue.number, seasonNumber: edit.seasonNumber, clearedBeats: hadBeats });
  }
  if (applied.length) {
    const fixed = applied.filter((a) => !a.skipped).length;
    console.log(`📝 arc-resolve: corrected ${fixed} episode synopsis(es) for series ${seriesId.slice(0, 12)}`);
  }
  return applied;
}

// Preserve per-field arc locks. When `currentSeries.locked.arcFields[k]` is
// true, the incoming arc's value for `k` is replaced with the existing one so
// auto-resolve / regenerate flows can rewrite unlocked fields without
// clobbering user-frozen ones. `null` next-arc (no incoming arc) is passed
// through unchanged — the persist layer's sanitizer drops it.
export function mergeArcWithLocks(currentArc, nextArc, lockedFields) {
  if (!nextArc || !lockedFields || typeof lockedFields !== 'object') return nextArc;
  if (!currentArc) return nextArc;
  const merged = { ...nextArc };
  for (const field of ARC_LOCKABLE_FIELDS) {
    if (lockedFields[field] === true) merged[field] = currentArc[field];
  }
  return merged;
}

// Preserve per-season locks. For every locked season in `currentSeasons`:
//   - if the LLM proposed an entry with the same id, replace it with the
//     existing locked record field-for-field (LLM's title/logline/etc. are
//     discarded);
//   - if the LLM dropped it entirely, re-insert it so it survives the resolve.
// Unlocked seasons (and brand-new entries the LLM minted) pass through. The
// caller still funnels the result through `sanitizeSeasonList`, which re-sorts
// by `number` ascending and dedups by id.
//
// Mirrors `mergeArcWithLocks`'s contract: locks are an *enforcement* gate, not
// a workflow signal — the arc-level `series.locked.arc` check up the stack
// remains the all-or-nothing block; this lets users freeze individual seasons
// while still letting auto-resolve rewrite the rest of the arc.
export function mergeSeasonsWithLocks(currentSeasons, nextSeasons) {
  if (!Array.isArray(nextSeasons)) return nextSeasons;
  if (!Array.isArray(currentSeasons)) return nextSeasons;
  const lockedById = new Map();
  for (const s of currentSeasons) {
    if (s?.locked === true && s.id) lockedById.set(s.id, s);
  }
  if (lockedById.size === 0) return nextSeasons;
  const seen = new Set();
  const merged = [];
  for (const next of nextSeasons) {
    const locked = next?.id ? lockedById.get(next.id) : null;
    if (locked) {
      merged.push(locked);
      seen.add(locked.id);
    } else {
      merged.push(next);
    }
  }
  for (const [id, locked] of lockedById) {
    if (!seen.has(id)) merged.push(locked);
  }
  return merged;
}

/**
 * Persist a new `arc` + `seasons[]` onto a series, migrating any child issues
 * whose `seasonId` referenced a season that the new shape dropped or renamed.
 * Shared by `resolveVerifyIssues` (auto-resolve) and `/arc/generate` — both
 * paths can rewrite season ids, and without this migration the orphans land
 * behind keys the Arc Canvas never iterates back.
 *
 * Match priority (via `buildSeasonRemap`): normalized title → unique number →
 * positional 1:1 fallback. Unmatched orphans get `seasonId: null` so they fall
 * into the visible "Un-grouped" bucket instead of vanishing.
 *
 * Per-field arc locks (`series.locked.arcFields`) are honored: locked fields
 * are restored from `currentSeries.arc` before the persist, so an auto-resolve
 * that proposes a new logline can preserve the user-frozen themes verbatim.
 *
 * `currentSeries` identifies the target series. The helper refreshes the
 * latest snapshot before writing so locks toggled while an LLM run is in
 * flight are honored at commit time.
 */
export async function commitSeasonsWithRemap(currentSeries, { arc, seasons }) {
  const seriesId = currentSeries.id;
  const latestSeries = await getSeries(seriesId);
  if (latestSeries.locked?.arc === true) {
    throw new ServerError(
      'Arc is locked — unlock it before rewriting the arc',
      { status: 400, code: ERR_VALIDATION },
    );
  }
  const mergedArc = mergeArcWithLocks(latestSeries.arc, arc, latestSeries.locked?.arcFields);
  // Per-season locks: restore any locked existing seasons over LLM-proposed
  // rewrites, and re-insert any locked seasons the LLM dropped. Re-sanitize
  // so the locked records merge with the new shape (sort by number, dedup).
  const mergedSeasons = sanitizeSeasonList(
    mergeSeasonsWithLocks(latestSeries.seasons, seasons),
  );
  const newIds = new Set(mergedSeasons.map((s) => s.id));
  const droppedOldSeasons = (latestSeries.seasons || []).filter((s) => !newIds.has(s.id));
  const oldIds = new Set((latestSeries.seasons || []).map((s) => s.id));
  const newlyMintedSeasons = mergedSeasons.filter((s) => !oldIds.has(s.id));
  const remap = buildSeasonRemap(droppedOldSeasons, newlyMintedSeasons);
  const droppedIdSet = new Set(droppedOldSeasons.map((s) => s.id));
  const reassignList = droppedIdSet.size
    ? (await listIssues({ seriesId })).filter((iss) => droppedIdSet.has(iss.seasonId))
    : [];

  // Mirrors `deleteSeason`'s bulk-reassign idiom — `skipRenumber` per call +
  // one `recomputeIssueNumbers` after, wrapped in `withReexportSuppressed` so
  // we don't fan out N socket events + N debounced re-exports of the same
  // series.
  //
  // Persist the new seasons FIRST so that a crash between writes leaves
  // issues attached to ids that still exist in `series.seasons[]`. If we
  // wrote issues first and crashed before `updateSeries`, every reassigned
  // issue would point at a `seasonId` that's not in the persisted series —
  // the exact orphan state this helper was written to prevent.
  let updated;
  await withReexportSuppressed('series', seriesId, async () => {
    updated = await updateSeries(seriesId, { arc: mergedArc, seasons: mergedSeasons });
    for (const iss of reassignList) {
      const target = remap.get(iss.seasonId) ?? null;
      await updateIssue(iss.id, { seasonId: target }, { skipRenumber: true });
    }
    if (reassignList.length) await recomputeIssueNumbersForSeries(seriesId);
  });
  if (reassignList.length) emitRecordUpdated('series', seriesId);
  return { series: updated, reassignedIssueCount: reassignList.length };
}

// Build a Map<oldSeasonId, newSeasonId|null> from the set of removed seasons
// and the freshly-minted ones in the same resolve. Matching priority:
//   1. normalized title equality (LLM was told to preserve titles when it can)
//   2. `number` equality (only when the target number is unique among new ones)
//   3. positional fallback — only fires when exactly ONE unmatched on each
//      side. With a single pair the mapping is forced and unambiguous; with
//      2+ unmatched the LLM may have reshuffled/renamed everything and
//      positional guessing silently invents wrong mappings (the bug that
//      motivated this guard). Skipped runs log a warning and let those
//      orphans fall through to the ungrouped bucket below.
// Anything that can't be matched maps to null so the issue lands in the
// ungrouped bucket instead of staying stranded behind a defunct id.
export function buildSeasonRemap(droppedOldSeasons, newlyMintedSeasons) {
  const remap = new Map();
  const claimed = new Set();
  const norm = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

  // Pass 1: normalized title
  for (const old of droppedOldSeasons) {
    const oldTitle = norm(old.title);
    if (!oldTitle) continue;
    const hit = newlyMintedSeasons.find(
      (n) => norm(n.title) === oldTitle && !claimed.has(n.id),
    );
    if (hit) {
      claimed.add(hit.id);
      remap.set(old.id, hit.id);
    }
  }

  // Pass 2: unique `number` match
  for (const old of droppedOldSeasons) {
    if (remap.has(old.id)) continue;
    if (!Number.isFinite(old.number)) continue;
    const matches = newlyMintedSeasons.filter(
      (n) => n.number === old.number && !claimed.has(n.id),
    );
    if (matches.length === 1) {
      claimed.add(matches[0].id);
      remap.set(old.id, matches[0].id);
    }
  }

  // Pass 3: positional fallback — only when the unmatched sets are exactly
  // 1↔1, where the pairing is forced.
  const oldRemaining = droppedOldSeasons.filter((s) => !remap.has(s.id));
  const newRemaining = newlyMintedSeasons.filter((n) => !claimed.has(n.id));
  if (oldRemaining.length === 1 && newRemaining.length === 1) {
    // Sanitize titles before logging — LLM-generated text can carry newlines,
    // C0/C1 control chars, or ANSI escapes that would break the project's
    // single-line logging convention or corrupt terminal output; fall back to
    // the stable id when the title is empty after sanitization.
    const safeLabel = (s) => {
      const raw = typeof s.title === 'string' ? s.title : '';
      // stripAnsi removes full ESC + CSI sequences (so "[31m" payload tails
      // don't leak through). Note: per PLAN.md
      // [ansistrip-osc-alternative-unreachable], OSC sequence bodies do leak
      // through stripAnsi today — extremely unlikely in LLM-generated season
      // titles, but called out here so a future fix to ANSI_PATTERN naturally
      // tightens this path. The trailing control-char sweep catches any bare
      // C0/C1 bytes the regex doesn't match.
      const t = stripAnsi(raw)
        .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
      return t || s.id;
    };
    console.warn(
      `⚠️ buildSeasonRemap Pass 3 fired: forced 1↔1 pairing "${safeLabel(oldRemaining[0])}" → "${safeLabel(newRemaining[0])}"`,
    );
    remap.set(oldRemaining[0].id, newRemaining[0].id);
    claimed.add(newRemaining[0].id);
  } else if (
    oldRemaining.length === newRemaining.length
    && oldRemaining.length > 1
  ) {
    // Suppression warn ONLY for the cases where the previous behavior would
    // have fired the positional fallback (equal counts ≥ 2). Unequal counts
    // were never positional-fallback candidates, so they don't deserve a
    // "skipped" message.
    console.warn(
      `⚠️ buildSeasonRemap skipped positional fallback (${oldRemaining.length} old × ${newRemaining.length} new unmatched) — orphan issues route to ungrouped`,
    );
  }

  // Anything still unmapped → null (ungrouped bucket).
  for (const old of droppedOldSeasons) {
    if (!remap.has(old.id)) remap.set(old.id, null);
  }
  return remap;
}
