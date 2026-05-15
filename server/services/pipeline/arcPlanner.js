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
import { getSeries, updateSeries } from './series.js';
import { listIssues } from './issues.js';
import { sanitizeArc, sanitizeSeasonList, sanitizeSeason, buildSeason } from '../../lib/storyArc.js';
import { recommendStructure, describeStructure } from '../../lib/seasonStructure.js';
import { LENGTH_PROFILE_NAMES, DEFAULT_LENGTH_PROFILE } from '../../lib/issueLength.js';
import { getUniverse } from '../universeBuilder.js';
import { getSeriesCanon } from './seriesCanon.js';
import { renderCategoriesForPrompt, renderCompositesForPrompt } from '../../lib/universePromptRenderers.js';

export const ERR_VALIDATION = 'PIPELINE_ARC_VALIDATION';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

const VERIFY_SEVERITIES = new Set(['high', 'medium', 'low']);
const ARC_ROLES = new Set(['pilot', 'complication', 'midpoint', 'b-plot', 'all-is-lost', 'finale']);
// Season-episode generation must produce concrete preset profiles only — the
// 'custom' sentinel needs companion pageTarget/minutesTarget values the LLM is
// not asked to invent, so a 'custom' here would silently render as 'standard'
// at prompt time. Limit to the canonical preset names.
const SEASON_LENGTH_PRESETS = new Set(LENGTH_PROFILE_NAMES.filter((n) => n !== 'custom'));
// Finale-role episodes should size like a finale even when the LLM omits
// (or misspells) lengthProfile. Other arcRoles fall back to the default
// profile so a missing/misspelled length doesn't cascade into the wrong
// size for the whole arc.
const lengthProfileForArcRole = (arcRole) => (arcRole === 'finale' ? 'finale' : DEFAULT_LENGTH_PROFILE);

// Each prior season renders as its header (logline + synopsis) plus the
// committed per-episode beats from `stages.idea.input` — that field was
// seeded with the LLM's `logline + synopsis` at episode-generate time.
function renderPriorSeason(s, priorIssues) {
  const header = `### Season ${s.number} — ${s.title}\n\n${s.logline}\n\n${s.synopsis || '(no synopsis)'}`;
  const seasonEpisodes = priorIssues
    .filter((iss) => iss.seasonId === s.id)
    .sort((a, b) => (a.arcPosition ?? 9999) - (b.arcPosition ?? 9999));
  if (seasonEpisodes.length === 0) return header;
  const lines = seasonEpisodes.map((iss) => {
    const idea = (iss.stages?.idea?.input || '').trim();
    const ord = iss.arcPosition || '?';
    return idea ? `- E${ord} — ${iss.title}: ${idea}` : `- E${ord} — ${iss.title}`;
  }).join('\n');
  return `${header}\n\nEpisode beats:\n${lines}`;
}

// The world is the canonical source for factions, characters, environments,
// etc. — without this, the arc planner would only see the series' own
// characters/settings/objects which are usually empty pre-prose.
async function loadWorldContext(universeId) {
  if (!universeId) return null;
  const world = await getUniverse(universeId).catch(() => null);
  if (!world) return null;

  const embrace = Array.isArray(world.influences?.embrace) ? world.influences.embrace : [];
  const avoid = Array.isArray(world.influences?.avoid) ? world.influences.avoid : [];

  return {
    worldName: world.name || '',
    worldStarter: world.starterPrompt || '',
    worldLogline: world.logline || '',
    worldPremise: world.premise || '',
    worldStyleNotes: world.styleNotes || '',
    worldInfluencesEmbrace: embrace.length ? embrace.join(', ') : '(none)',
    worldInfluencesAvoid: avoid.length ? avoid.join(', ') : '(none)',
    worldCategoriesText: renderCategoriesForPrompt(world.categories) || '(none)',
    worldCompositesText: renderCompositesForPrompt(world.compositeSheets) || '(none)',
  };
}

// Fallback when series has no linked world — prompt partials still expect
// these variables to be defined.
const EMPTY_WORLD_CONTEXT = {
  worldName: '(no linked world)',
  worldStarter: '',
  worldLogline: '',
  worldPremise: '',
  worldStyleNotes: '',
  worldInfluencesEmbrace: '(none)',
  worldInfluencesAvoid: '(none)',
  worldCategoriesText: '(none — series has no linked Universe Builder world)',
  worldCompositesText: '(none)',
};

// Resolve world context, accepting an optional preloaded value so callers
// that chain (verify → resolve) don't reload the same world twice.
async function resolveWorldContext(series, preloaded) {
  if (preloaded) return preloaded;
  return (await loadWorldContext(series.universeId)) || EMPTY_WORLD_CONTEXT;
}

// The `recommendedStructure` field encodes comic-as-TV norms (6–10 per
// season, single season ≤ 12, 3-season arc around 18–30) so the LLM stops
// defaulting to 3 seasons regardless of total count.
async function buildArcOverviewContext(series, preloadedWorld) {
  const structure = recommendStructure(series.issueCountTarget);
  const world = await resolveWorldContext(series, preloadedWorld);
  const canon = await getSeriesCanon(series);
  return {
    series: {
      name: series.name,
      logline: series.logline,
      premise: series.premise,
      styleNotes: series.styleNotes,
      issueCountTarget: series.issueCountTarget,
    },
    ...world,
    recommendedStructure: structure
      ? describeStructure(structure)
      : '(no target episode count set — propose 1–3 volumes based on premise weight)',
    recommendedSeasonCount: structure ? structure.seasons : '',
    recommendedPerSeasonJson: structure ? JSON.stringify(structure.perSeason) : '[]',
    existingCharactersJson: JSON.stringify(canon.characters, null, 2),
    existingSettingsJson: JSON.stringify(canon.settings, null, 2),
    existingObjectsJson: JSON.stringify(canon.objects, null, 2),
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
  const ctx = await buildArcOverviewContext(series);
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
 * gives the LLM granular per-episode continuity — without it the verifier and
 * planner only see season-level synopses and can't catch beat-level contradictions.
 */
async function buildSeasonEpisodesContext(series, season, priorSeasons, priorIssues = [], preloadedWorld) {
  const arc = series.arc || {};
  const themesCsv = Array.isArray(arc.themes) ? arc.themes.join(', ') : '';
  const priorSeasonsContext = priorSeasons.length === 0
    ? '(this is the first season — no prior context)'
    : priorSeasons.map((s) => renderPriorSeason(s, priorIssues)).join('\n\n');
  const world = await resolveWorldContext(series, preloadedWorld);
  const canon = await getSeriesCanon(series);
  return {
    series: {
      name: series.name,
      logline: series.logline,
      premise: series.premise,
      styleNotes: series.styleNotes,
    },
    ...world,
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
    existingCharactersJson: JSON.stringify(canon.characters, null, 2),
    existingSettingsJson: JSON.stringify(canon.settings, null, 2),
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
 * Build the verify-pass context — a JSON-encoded tree of seasons + their
 * child issues so the LLM has a single structural blob to scan. Issues are
 * looked up via `listIssues` so the verify pass sees the *current* set, not
 * a stale snapshot.
 */
async function buildVerifyContext(series, preloadedWorld) {
  const seasons = sanitizeSeasonList(series.seasons || []);
  const issues = await listIssues({ seriesId: series.id });
  // Group issues by seasonId so the tree's leaf order matches the seasons'
  // arcPosition order. Ungrouped issues land in a `null` bucket so the LLM
  // sees them too.
  const issuesBySeason = new Map();
  for (const iss of issues) {
    const key = iss.seasonId || null;
    if (!issuesBySeason.has(key)) issuesBySeason.set(key, []);
    // `synopsis` key (not `beats`) so it matches the prompt's existing
    // language; sourced from idea.input which carries the LLM's logline+synopsis.
    const synopsis = (iss.stages?.idea?.input || '').trim();
    issuesBySeason.get(key).push({
      number: iss.number,
      title: iss.title,
      status: iss.status,
      arcPosition: iss.arcPosition,
      synopsis: synopsis || null,
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
  const world = await resolveWorldContext(series, preloadedWorld);
  const canon = await getSeriesCanon(series);
  return {
    series: {
      name: series.name,
      logline: series.logline,
      premise: series.premise,
    },
    ...world,
    arc: {
      logline: arc.logline || '',
      summary: arc.summary || '',
      protagonistArc: arc.protagonistArc || '',
      themesCsv: Array.isArray(arc.themes) ? arc.themes.join(', ') : '',
    },
    seasonsTreeJson: JSON.stringify(tree, null, 2),
    existingCharactersJson: JSON.stringify(canon.characters, null, 2),
    existingSettingsJson: JSON.stringify(canon.settings, null, 2),
    existingObjectsJson: JSON.stringify(canon.objects, null, 2),
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
  const ctx = await buildVerifyContext(series, options.preloadedWorld);
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

async function buildResolveContext(series, findings, preloadedWorld) {
  const ctx = await buildVerifyContext(series, preloadedWorld);
  const structure = recommendStructure(series.issueCountTarget);
  return {
    ...ctx,
    findingsJson: JSON.stringify(findings, null, 2),
    recommendedStructure: structure
      ? describeStructure(structure)
      : '(no target episode count set)',
    recommendedSeasonCount: structure ? structure.seasons : '',
    recommendedPerSeasonJson: structure ? JSON.stringify(structure.perSeason) : '[]',
  };
}

const RESOLVE_FINDING_MAX = 50;

function shapeFindings(rawFindings) {
  if (!Array.isArray(rawFindings)) return [];
  const out = [];
  for (const f of rawFindings) {
    const problem = typeof f?.problem === 'string' ? f.problem.trim() : '';
    if (!problem) continue;
    out.push({
      severity: VERIFY_SEVERITIES.has(f?.severity) ? f.severity : 'medium',
      location: typeof f?.location === 'string' ? f.location.trim().slice(0, 200) : '',
      problem: problem.slice(0, 2000),
      suggestion: typeof f?.suggestion === 'string' ? f.suggestion.trim().slice(0, 2000) : '',
    });
    if (out.length >= RESOLVE_FINDING_MAX) break;
  }
  return out;
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
      modelOverride: options.modelOverride,
      returnsJson: true,
      source: 'pipeline-arc-resolve',
    },
  );

  const arc = sanitizeArc({
    logline: content?.arc?.logline || series.arc.logline || '',
    summary: content?.arc?.summary || series.arc.summary || '',
    themes: content?.arc?.themes ?? series.arc.themes,
    protagonistArc: content?.arc?.protagonistArc ?? series.arc.protagonistArc ?? '',
    status: 'draft',
  });

  // Round-trip the LLM's seasons through `buildSeason` if they include a
  // brand-new entry (no `id`), otherwise preserve the existing `id` so child
  // issues still join their season cleanly. The sanitizer enforces the
  // canonical shape regardless.
  const existingById = new Map((series.seasons || []).map((s) => [s.id, s]));
  const proposedSeasons = Array.isArray(content?.seasons) ? content.seasons : [];
  const merged = proposedSeasons.map((raw) => {
    const existing = raw?.id ? existingById.get(raw.id) : null;
    if (existing) {
      return sanitizeSeason({
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
      });
    }
    return buildSeason({
      number: raw?.number,
      title: raw?.title,
      logline: raw?.logline,
      synopsis: raw?.synopsis,
      endingHook: raw?.endingHook,
      episodeCountTarget: raw?.episodeCountTarget,
    });
  }).filter(Boolean);

  const seasons = sanitizeSeasonList(merged);
  const updated = await updateSeries(seriesId, { arc, seasons });

  const notes = typeof content?.notes === 'string' ? content.notes.trim().slice(0, 2000) : '';
  return {
    series: updated,
    applied: true,
    notes,
    findings,
    runId,
    providerId,
    model,
  };
}

// Export internals for tests.
export const __testing = {
  buildArcOverviewContext,
  buildSeasonEpisodesContext,
  buildVerifyContext,
  buildResolveContext,
  shapeSeasonOutlines,
  shapeEpisodes,
  shapeVerifyIssues,
  shapeFindings,
};
