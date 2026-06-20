/**
 * arcPlanner/episodeSeedPass.js — season → episode seeding + commit-to-issues
 * and the per-episode canon extraction. Built on ./context.js.
 */

import { runStagedLLM } from '../../../lib/stageRunner.js';
import { getSeries } from '../series.js';
import { createIssue, listIssues } from '../issues.js';
import { renderArcShapeGuidance, renderArcShapePositionSummary } from '../../../lib/storyArc.js';
import { composeStyleNotes } from '../../../lib/styleGuide.js';
import { extractCanonFromProse } from '../../universeCanon.js';
import { resolveSeriesLlmOverride } from '../../../lib/seriesLlmOverride.js';
import { getSeriesCanon } from '../seriesCanon.js';
import { ARC_ROLES, ERR_VALIDATION, SEASON_LENGTH_PRESETS, SHAPE_GUIDANCE_NONE, appendTickingClock, lengthProfileForArcRole, makeErr, renderPriorSeason, resolveWorldContext } from './context.js';

/**
 * Build the context for one season's episode breakdown. `priorSeasonsContext`
 * gives the LLM granular per-episode continuity — without it the verifier and
 * planner only see season-level synopses and can't catch beat-level contradictions.
 */
export async function buildSeasonEpisodesContext(series, season, priorSeasons, priorIssues = [], preloadedWorld) {
  const arc = series.arc || {};
  const themesCsv = Array.isArray(arc.themes) ? arc.themes.join(', ') : '';
  const priorSeasonsContext = priorSeasons.length === 0
    ? '(this is the first season — no prior context)'
    : priorSeasons.map((s) => renderPriorSeason(s, priorIssues)).join('\n\n');
  const [world, canon] = await Promise.all([
    resolveWorldContext(series, preloadedWorld),
    getSeriesCanon(series),
  ]);
  const totalSeasons = (series.seasons || []).length || 1;
  const arcGuidance = appendTickingClock(renderArcShapeGuidance(arc.shape) || SHAPE_GUIDANCE_NONE, arc);
  const shapePosition = renderArcShapePositionSummary(arc.shape, season.number, totalSeasons)
    || '(no story shape selected — pace episode beats by arcRole only)';
  return {
    series: {
      name: series.name,
      logline: series.logline,
      premise: series.premise,
      // Fold the structured style guide into styleNotes so episode-beat
      // generation honors house style (see composeStyleNotes) — same as the
      // arc-overview and per-issue text contexts.
      styleNotes: composeStyleNotes(series),
    },
    ...world,
    arc: {
      logline: arc.logline || '',
      protagonistArc: arc.protagonistArc || '',
      themesCsv,
      shape: arc.shape || '',
    },
    shapeGuidance: arcGuidance,
    shapePosition,
    priorSeasonsContext,
    season: {
      number: season.number,
      title: season.title,
      logline: season.logline,
      synopsis: season.synopsis,
      endingHook: season.endingHook,
      episodeCountTarget: season.episodeCountTarget,
    },
    existingCharactersJson: JSON.stringify(canon.characters, null, 2),
    existingPlacesJson: JSON.stringify(canon.places, null, 2),
    existingObjectsJson: JSON.stringify(canon.objects, null, 2),
  };
}

/**
 * Shape `episodes[]` from the LLM into the canonical issue-like preview
 * shape. We do NOT persist here — the route layer creates the issues via
 * `createIssue` so a preview/confirm flow can land in Phase 4.
 *
 * Drops entries with no title, clamps `number` >= 1, and validates `arcRole`
 * against the controlled vocab the prompt promised. An invalid `arcRole`
 * collapses to `null` rather than the entry being rejected — the rest of the
 * episode metadata is still useful.
 */
export function shapeEpisodes(rawEpisodes) {
  if (!Array.isArray(rawEpisodes)) return [];
  const out = [];
  let nextNumber = 1;
  for (const raw of rawEpisodes) {
    const title = typeof raw?.title === 'string' ? raw.title.trim().slice(0, 300) : '';
    if (!title) continue;
    const number = Number.isFinite(raw?.number) && raw.number > 0
      ? Math.floor(raw.number)
      : nextNumber;
    nextNumber = number + 1;
    const arcRole = ARC_ROLES.has(raw?.arcRole) ? raw.arcRole : null;
    // Episode-level length sizing — fed straight into the issue's
    // lengthProfile when the route creates issues from this preview. Only the
    // concrete presets are accepted here (no 'custom' sentinel — the LLM is
    // never asked to invent custom page/minute targets, and a 'custom' value
    // without companion numbers silently degrades to 'standard' downstream).
    // The fallback is derived from arcRole so a finale episode still sizes
    // like a finale when the LLM omits the field.
    const lengthProfile = SEASON_LENGTH_PRESETS.has(raw?.lengthProfile)
      ? raw.lengthProfile
      : lengthProfileForArcRole(arcRole);
    const primaryCharacters = Array.isArray(raw?.primaryCharacters)
      ? raw.primaryCharacters.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim().slice(0, 200)).slice(0, 12)
      : [];
    out.push({
      number,
      title,
      logline: typeof raw?.logline === 'string' ? raw.logline.trim().slice(0, 500) : '',
      synopsis: typeof raw?.synopsis === 'string' ? raw.synopsis.trim().slice(0, 4000) : '',
      primaryCharacters,
      arcRole,
      lengthProfile,
    });
  }
  return out;
}

export async function generateSeasonEpisodes(seriesId, seasonId, options = {}) {
  const series = await getSeries(seriesId);
  const seasons = series.seasons || [];
  const season = seasons.find((s) => s.id === seasonId);
  if (!season) {
    throw makeErr(`Season not found on series: ${seasonId}`, ERR_VALIDATION);
  }
  // Per-season lock — same semantics as the arc-level lock above, scoped to
  // this volume. Generating episodes seeds new issue records under the
  // season; a locked season's shape is frozen, so refuse before the LLM call.
  // Verify (read-only) stays available so the user can still inspect findings.
  if (season.locked === true) {
    throw makeErr(
      `Season "${season.title || season.number}" is locked — unlock it before generating episodes`,
      ERR_VALIDATION,
    );
  }
  // A season with no synopsis + no logline gives the LLM nothing to riff
  // against — fail loud so the user sees the misconfiguration instead of
  // getting back 8 episodes of "a thing happens then another thing".
  if (!season.synopsis?.trim() && !season.logline?.trim()) {
    throw makeErr(
      `Season "${season.title || season.number}" has no synopsis or logline — fill at least one before generating episodes`,
      ERR_VALIDATION,
    );
  }
  // Prior-seasons context for continuity. Strict number-ordering rather than
  // id-ordering because seasons[] is already sorted by number in the
  // sanitizer; this matches what the user is editing on screen.
  const priorSeasons = seasons.filter((s) => (s.number || 0) < (season.number || 0));

  let priorIssues = [];
  if (priorSeasons.length > 0) {
    const priorIds = new Set(priorSeasons.map((s) => s.id));
    const all = await listIssues({ seriesId });
    priorIssues = all.filter((iss) => iss.seasonId && priorIds.has(iss.seasonId));
  }

  const ctx = await buildSeasonEpisodesContext(series, season, priorSeasons, priorIssues);
  const { content, runId, providerId, model } = await runStagedLLM(
    'pipeline-season-episodes',
    ctx,
    {
      providerOverride: options.providerOverride,
      modelOverride: options.modelOverride,
      returnsJson: true,
      source: 'pipeline-season-episodes',
    },
  );
  const episodes = shapeEpisodes(content?.episodes);
  return {
    season,
    episodes,
    raw: content,
    runId,
    providerId,
    model,
  };
}

/**
 * Persist a season's generated episodes as issue records — one issue per
 * episode, with the season pointer + arcPosition + arcRole + length profile
 * forwarded so the downstream auto-run-text chain has a seed to expand
 * against. Shared by the pipeline season-episodes route and the Story
 * Builder's "generate issues from arc" action so both mint byte-identical
 * issue shapes. The episode's logline + synopsis land in `stages.idea.input`.
 */
export async function commitEpisodesToIssues(seriesId, seasonId, episodes = [], { preloadedSeries = null } = {}) {
  // Fetch the series once for the whole batch (unless the caller already holds
  // it) and thread it into each createIssue's renumber pass. The series record
  // doesn't change as issues are appended, so an N-episode season otherwise
  // pays N redundant getSeries reads of an unchanging record.
  const series = preloadedSeries || await getSeries(seriesId).catch(() => null);
  const created = [];
  for (const ep of episodes) {
    const issue = await createIssue({
      seriesId,
      title: ep.title,
      // Issue `number` is derived from (volume order, arcPosition) by
      // `createIssue`'s renumber pass — a new episode falls into its volume's
      // slot and later volumes' numbers shift to make room.
      seasonId,
      arcPosition: ep.number,
      // `arcRole` carries the LLM's pilot / complication / midpoint / etc.
      // classification forward so the idea-expansion prompt can size beats to
      // the role (a finale needs a different cadence than a complication).
      arcRole: ep.arcRole,
      // Episode-level length sizing from the season-episodes LLM pass.
      // Defaults to 'standard' inside the issue sanitizer when missing.
      lengthProfile: ep.lengthProfile,
      stages: {
        idea: {
          status: ep.synopsis ? 'edited' : 'empty',
          input: [ep.logline, ep.synopsis].filter(Boolean).join('\n\n'),
        },
      },
    }, { preloadedSeries: series });
    created.push(issue);
  }
  return created;
}

/**
 * Collapse `extractCanonFromProse` result counts into { characters, places, objects }.
 * Mirrors the `countExtractedCanon` helper in the pipeline route.
 */
export function countExtractedCanon(results) {
  return {
    characters: results.characters?.extracted?.length || 0,
    places: results.places?.extracted?.length || 0,
    objects: results.objects?.extracted?.length || 0,
  };
}

/**
 * Post-commit canon extraction for season-episode generation. Called after
 * commitEpisodesToIssues succeeds to run continuity extraction on the newly
 * committed episode corpus. Non-fatal: episode creation already succeeded, so
 * extraction failure must not invalidate the user's accepted breakdown.
 *
 * Orphan series (no universeId) and empty episode corpora skip extraction and
 * return `null`. On success returns
 * `{ characters, places, objects, universe }` (the `bibleExtracted` shape the
 * route sends down to the client).
 *
 * @param {object} opts
 * @param {object}         opts.series          - full series record (preloaded by caller)
 * @param {object[]}       opts.episodes        - committed episode list from generateSeasonEpisodes
 * @param {string|undefined} opts.providerOverride - explicit provider override from client body
 * @param {string|undefined} opts.modelOverride  - explicit model override from client body
 * @returns {Promise<{characters,places,objects,universe}|null>}
 */
export async function extractEpisodeCanon({ series, episodes, providerOverride, modelOverride }) {
  const corpus = episodes
    .map((ep) => `## E${ep.number} — ${ep.title}\n\n${ep.logline || ''}\n\n${ep.synopsis || ''}`.trim())
    .filter(Boolean)
    .join('\n\n');
  if (!corpus.trim() || !series?.universeId) return null;

  // Fall back to the series' configured LLM when the client doesn't pass an
  // explicit override — matches the extract-canon and extract-scenes routes so
  // continuity extraction honors the provider/model picked in the series header
  // instead of the global active provider. A model id is provider-specific, so
  // only inherit the series model when the effective provider is still the series
  // provider; an override that switches providers without naming a model leaves it
  // blank so the new provider's default resolves.
  const { provider, model } = resolveSeriesLlmOverride(series, {
    overrideProvider: providerOverride,
    overrideModel: modelOverride,
  });

  // Stamp new inserts as series-extracted (autoLock + sourceSeriesId) so
  // continuity-derived canon survives later AI refines and stays attributable
  // to this series. Matches the pre-B.4 series-side extract semantics.
  const extractRes = await extractCanonFromProse(series.universeId, {
    corpus,
    providerOverride: provider,
    modelOverride: model,
    parallel: true,
    autoLock: true,
    sourceSeriesId: series.id,
  }).catch((err) => {
    console.warn(`⚠️ Continuity extraction failed for series ${series.id}: ${err.message}`);
    return null;
  });
  if (!extractRes) return null;

  return {
    ...countExtractedCanon(extractRes.results),
    universe: extractRes.universe,
  };
}
