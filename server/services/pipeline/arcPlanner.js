/**
 * Pipeline — Series Arc Planning Service
 *
 * Phase 3 of the Story Arc Planning initiative. Owns the three LLM-driven
 * planning passes that populate `series.arc` and `series.seasons[]`:
 *
 *   generateArcOverview(seriesId)         → seeds series.arc + series.seasons[]
 *   generateSeasonEpisodes(seriesId, seasonId, { force? })
 *                                          → seeds issues under a season
 *   verifyArc(seriesId)                   → cross-season continuity pass
 *
 * Each function returns `{ result, runId, providerId, model }` so the caller
 * can react to a successful run (persisted via `updateSeries` / `createSeason`
 * / `createIssue` chains as appropriate) and surface the runId in /runs.
 *
 * Extraction-only; mirrors how `bibleExtractor.js` and `sceneExtractor.js`
 * are split — the caller decides whether to persist. The two-step shape
 * keeps the LLM call replayable and lets the UI preview the plan before
 * committing it (Phase 4's confirm-before-seeding pattern).
 */

import { runStagedLLM } from '../../lib/stageRunner.js';
import { ServerError } from '../../lib/errorHandler.js';
import { getSeries } from './series.js';
import { listIssues } from './issues.js';
import { sanitizeArc, sanitizeSeasonList, sanitizeSeason, buildSeason } from '../../lib/storyArc.js';

export const ERR_VALIDATION = 'PIPELINE_ARC_VALIDATION';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

const VERIFY_SEVERITIES = new Set(['high', 'medium', 'low']);
const ARC_ROLES = new Set(['pilot', 'complication', 'midpoint', 'b-plot', 'all-is-lost', 'finale']);

/**
 * Pull only the fields the arc-overview prompt cares about from the series
 * bible, so a verbose series record doesn't blow the prompt budget.
 */
function buildArcOverviewContext(series) {
  return {
    series: {
      name: series.name,
      logline: series.logline,
      premise: series.premise,
      styleNotes: series.styleNotes,
      targetFormat: series.targetFormat,
      issueCountTarget: series.issueCountTarget,
    },
    existingCharactersJson: JSON.stringify(series.characters || [], null, 2),
    existingSettingsJson: JSON.stringify(series.settings || [], null, 2),
    existingObjectsJson: JSON.stringify(series.objects || [], null, 2),
  };
}

/**
 * Coerce the LLM's `seasonOutlines[]` into a list of canonical Season records.
 * Reuses `buildSeason` so the new seasons get fresh sea-uuid ids + timestamps
 * + run through the sanitizer. Defensive — drops malformed entries silently
 * so a partial response doesn't crash the route layer.
 */
function shapeSeasonOutlines(rawOutlines) {
  if (!Array.isArray(rawOutlines)) return [];
  const out = [];
  for (const raw of rawOutlines) {
    const season = buildSeason({
      number: raw?.number,
      title: raw?.title,
      logline: raw?.logline,
      endingHook: raw?.endingHook,
      episodeCountTarget: raw?.episodeCountTarget,
    });
    if (season) out.push(season);
  }
  return out;
}

export async function generateArcOverview(seriesId, options = {}) {
  const series = await getSeries(seriesId);
  const ctx = buildArcOverviewContext(series);
  const { content, runId, providerId, model } = await runStagedLLM(
    'pipeline-arc-overview',
    ctx,
    {
      providerOverride: options.providerOverride,
      modelOverride: options.modelOverride,
      returnsJson: true,
      source: 'pipeline-arc-overview',
    },
  );
  // Build the canonical arc + seasons shape from the LLM payload. We send
  // both back to the caller so the route can persist in one updateSeries
  // call (or hand the user a preview before committing).
  const arc = sanitizeArc({
    logline: content?.logline || '',
    summary: content?.summary || '',
    themes: content?.themes,
    protagonistArc: content?.protagonistArc || '',
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

/**
 * Build the context for one season's episode breakdown. `priorSeasonsContext`
 * is a textual summary of the seasons BEFORE this one (synopsis + logline),
 * so the LLM has continuity to work against without re-reading every season.
 */
function buildSeasonEpisodesContext(series, season, priorSeasons) {
  const arc = series.arc || {};
  const themesCsv = Array.isArray(arc.themes) ? arc.themes.join(', ') : '';
  const priorSeasonsContext = priorSeasons.length === 0
    ? '(this is the first season — no prior context)'
    : priorSeasons
      .map((s) => `### Season ${s.number} — ${s.title}\n\n${s.logline}\n\n${s.synopsis || '(no synopsis)'}`)
      .join('\n\n');
  return {
    series: {
      name: series.name,
      logline: series.logline,
      premise: series.premise,
      styleNotes: series.styleNotes,
    },
    arc: {
      logline: arc.logline || '',
      protagonistArc: arc.protagonistArc || '',
      themesCsv,
    },
    priorSeasonsContext,
    season: {
      number: season.number,
      title: season.title,
      logline: season.logline,
      synopsis: season.synopsis,
      endingHook: season.endingHook,
      episodeCountTarget: season.episodeCountTarget,
    },
    existingCharactersJson: JSON.stringify(series.characters || [], null, 2),
    existingSettingsJson: JSON.stringify(series.settings || [], null, 2),
    existingObjectsJson: JSON.stringify(series.objects || [], null, 2),
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
function shapeEpisodes(rawEpisodes) {
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

  const ctx = buildSeasonEpisodesContext(series, season, priorSeasons);
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
 * Build the verify-pass context — a JSON-encoded tree of seasons + their
 * child issues so the LLM has a single structural blob to scan. Issues are
 * looked up via `listIssues` so the verify pass sees the *current* set, not
 * a stale snapshot.
 */
async function buildVerifyContext(series) {
  const seasons = sanitizeSeasonList(series.seasons || []);
  const issues = await listIssues({ seriesId: series.id });
  // Group issues by seasonId so the tree's leaf order matches the seasons'
  // arcPosition order. Ungrouped issues land in a `null` bucket so the LLM
  // sees them too.
  const issuesBySeason = new Map();
  for (const iss of issues) {
    const key = iss.seasonId || null;
    if (!issuesBySeason.has(key)) issuesBySeason.set(key, []);
    issuesBySeason.get(key).push({
      number: iss.number,
      title: iss.title,
      status: iss.status,
      arcPosition: iss.arcPosition,
    });
  }
  for (const list of issuesBySeason.values()) {
    list.sort((a, b) => (a.arcPosition ?? 9999) - (b.arcPosition ?? 9999) || (a.number || 0) - (b.number || 0));
  }
  const tree = seasons.map((s) => ({
    number: s.number,
    title: s.title,
    logline: s.logline,
    synopsis: s.synopsis,
    endingHook: s.endingHook,
    episodeCountTarget: s.episodeCountTarget,
    themes: s.themes,
    status: s.status,
    episodes: issuesBySeason.get(s.id) || [],
  }));
  const ungrouped = issuesBySeason.get(null) || [];
  if (ungrouped.length) {
    tree.push({
      number: null,
      title: '(ungrouped issues)',
      episodes: ungrouped,
    });
  }
  const arc = series.arc || {};
  return {
    series: {
      name: series.name,
      logline: series.logline,
      premise: series.premise,
      targetFormat: series.targetFormat,
    },
    arc: {
      logline: arc.logline || '',
      summary: arc.summary || '',
      protagonistArc: arc.protagonistArc || '',
      themesCsv: Array.isArray(arc.themes) ? arc.themes.join(', ') : '',
    },
    seasonsTreeJson: JSON.stringify(tree, null, 2),
    existingCharactersJson: JSON.stringify(series.characters || [], null, 2),
    existingSettingsJson: JSON.stringify(series.settings || [], null, 2),
    existingObjectsJson: JSON.stringify(series.objects || [], null, 2),
  };
}

/**
 * Shape verify-pass issues. Drops malformed entries (no problem, invalid
 * severity) so a partial LLM response doesn't trash the route response.
 */
function shapeVerifyIssues(rawIssues) {
  if (!Array.isArray(rawIssues)) return [];
  const out = [];
  for (const raw of rawIssues) {
    const problem = typeof raw?.problem === 'string' ? raw.problem.trim() : '';
    if (!problem) continue;
    const severity = VERIFY_SEVERITIES.has(raw?.severity) ? raw.severity : 'medium';
    out.push({
      severity,
      location: typeof raw?.location === 'string' ? raw.location.trim().slice(0, 200) : '',
      problem: problem.slice(0, 2000),
      suggestion: typeof raw?.suggestion === 'string' ? raw.suggestion.trim().slice(0, 2000) : '',
    });
  }
  return out;
}

export async function verifyArc(seriesId, options = {}) {
  const series = await getSeries(seriesId);
  if (!series.arc) {
    throw new ServerError(
      'Series has no arc to verify — run /arc/generate first',
      { status: 400, code: 'PIPELINE_NO_ARC' },
    );
  }
  const ctx = await buildVerifyContext(series);
  const { content, runId, providerId, model } = await runStagedLLM(
    'pipeline-arc-verify',
    ctx,
    {
      providerOverride: options.providerOverride,
      modelOverride: options.modelOverride,
      returnsJson: true,
      source: 'pipeline-arc-verify',
    },
  );
  const issues = shapeVerifyIssues(content?.issues);
  return { issues, raw: content, runId, providerId, model };
}

// Export internals for tests.
export const __testing = {
  buildArcOverviewContext,
  buildSeasonEpisodesContext,
  buildVerifyContext,
  shapeSeasonOutlines,
  shapeEpisodes,
  shapeVerifyIssues,
};
