import { request } from './apiCore.js';

// Stage IDs mirror server/services/pipeline/issues.js — keep these in sync.
export const PIPELINE_TEXT_STAGES = Object.freeze(['idea', 'prose', 'comicScript', 'tvScript']);
export const PIPELINE_VISUAL_STAGES = Object.freeze(['comicPages', 'storyboards', 'episodeVideo']);
export const PIPELINE_STAGES = Object.freeze([...PIPELINE_TEXT_STAGES, ...PIPELINE_VISUAL_STAGES]);

export const PIPELINE_STAGE_LABELS = Object.freeze({
  idea: 'Idea',
  prose: 'Prose',
  comicScript: 'Comic Script',
  tvScript: 'TV Script',
  comicPages: 'Comic Pages',
  storyboards: 'Storyboards',
  episodeVideo: 'Episode Video',
});

export const PIPELINE_TARGET_FORMATS = Object.freeze(['comic', 'tv', 'comic+tv']);

// ---- Series ----
export const listPipelineSeries = () => request('/pipeline/series');
export const getPipelineSeries = (id) => request(`/pipeline/series/${encodeURIComponent(id)}`);
export const createPipelineSeries = (data) => request('/pipeline/series', {
  method: 'POST',
  body: JSON.stringify(data),
});
export const updatePipelineSeries = (id, patch) => request(`/pipeline/series/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
});
export const deletePipelineSeries = (id) => request(`/pipeline/series/${encodeURIComponent(id)}`, {
  method: 'DELETE',
});

// Extract bibles (characters / settings / objects) from an issue's prose
// stage and merge them into the series. `kinds` defaults server-side to all
// three. Pass `parallel: true` to fan out the kinds concurrently — ~3×
// wall-clock speedup on HTTP-API providers (OpenAI / Anthropic / LM Studio
// HTTP). Safe to leave off for CLI-only providers (codex / claude-code /
// gemini-cli) which serialize at the provider session anyway.
// Returns { series, results } where results is keyed by field name.
export const extractPipelineBibles = (seriesId, { issueId, corpus, kinds, providerOverride, parallel } = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/extract-bible`, {
    method: 'POST',
    body: JSON.stringify({ issueId, corpus, kinds, providerOverride, parallel }),
  });

// ---- Issues ----
export const listPipelineIssues = (seriesId) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/issues`);

export const createPipelineIssue = (seriesId, data) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/issues`, {
    method: 'POST',
    body: JSON.stringify(data),
  });

export const getPipelineIssue = (id) => request(`/pipeline/issues/${encodeURIComponent(id)}`);

export const updatePipelineIssue = (id, patch) =>
  request(`/pipeline/issues/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });

export const deletePipelineIssue = (id) =>
  request(`/pipeline/issues/${encodeURIComponent(id)}`, { method: 'DELETE' });

// ---- Stage operations ----
export const generatePipelineStage = (issueId, stageId, opts = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/${encodeURIComponent(stageId)}/generate`, {
    method: 'POST',
    body: JSON.stringify(opts),
  });

export const generatePipelineVisualImage = (issueId, stageId, opts) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/${encodeURIComponent(stageId)}/visual`, {
    method: 'POST',
    body: JSON.stringify(opts),
  });

// Auto-fill the storyboards stage's scenes[] from the issue's prose or
// tvScript text stage. `from` defaults server-side to 'tvScript'. Pass
// `force: true` to replace existing hand-curated scenes.
export const extractPipelineStoryboardScenes = (issueId, { from, providerOverride, force } = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/storyboards/extract-scenes`, {
    method: 'POST',
    body: JSON.stringify({ from, providerOverride, force }),
  });

// Auto-fill the comicPages stage's pages[] by deterministically parsing the
// issue's stages.comicScript.output (Marvel/DC-format markdown). Pass
// `force: true` to replace existing hand-curated pages.
export const extractPipelineComicPages = (issueId, { force } = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/comicPages/extract-pages`, {
    method: 'POST',
    body: JSON.stringify({ force }),
  });

// Render a full comic page (multi-panel layout in one image) — the default
// for cloud image models (Codex / Google), draft-quality for local models.
// Server persists the returned jobId on stages.comicPages.pages[pageIndex].
// Returns { jobId, mode, prompt, pageIndex, issue, stage }.
export const generatePipelineComicPage = (issueId, pageIndex, opts = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/comicPages/pages/${encodeURIComponent(pageIndex)}/render`, {
    method: 'POST',
    body: JSON.stringify(opts),
  });

// ---- Seasons (Phase 2 of Story Arc Planning) ----
export const listPipelineSeasons = (seriesId) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/seasons`);

export const createPipelineSeason = (seriesId, data) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/seasons`, {
    method: 'POST',
    body: JSON.stringify(data),
  });

export const updatePipelineSeason = (seriesId, seasonId, patch) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/seasons/${encodeURIComponent(seasonId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });

// Body: { reassignTo: <seasonId> | null }. Omitting reassignTo un-groups
// every child issue.
export const deletePipelineSeason = (seriesId, seasonId, { reassignTo } = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/seasons/${encodeURIComponent(seasonId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ reassignTo: reassignTo ?? null }),
  });

// ---- Arc planning (Phase 3) ----
// Returns { arc, seasons, runId, providerId, model, committed, series }.
// commit:true persists arc + seasons to the series in one shot.
export const generatePipelineArcOverview = (seriesId, { providerOverride, modelOverride, commit } = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/arc/generate`, {
    method: 'POST',
    body: JSON.stringify({ providerOverride, modelOverride, commit }),
  });

// Returns { season, episodes, runId, providerId, model, committed, createdIssues }.
// commit:true creates one issue per episode with seasonId + arcPosition set.
export const generatePipelineSeasonEpisodes = (seriesId, seasonId, { providerOverride, modelOverride, commit } = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/seasons/${encodeURIComponent(seasonId)}/episodes/generate`, {
    method: 'POST',
    body: JSON.stringify({ providerOverride, modelOverride, commit }),
  });

// Returns { issues, runId, providerId, model }. Empty issues[] = clean.
export const verifyPipelineArc = (seriesId, { providerOverride, modelOverride } = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/arc/verify`, {
    method: 'POST',
    body: JSON.stringify({ providerOverride, modelOverride }),
  });

// ---- Auto-run text chain ----
export const startPipelineAutoRunText = (issueId, opts = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/auto-run-text`, {
    method: 'POST',
    body: JSON.stringify(opts),
  });

export const cancelPipelineAutoRunText = (issueId) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/auto-run-text/cancel`, {
    method: 'POST',
  });

export const pipelineAutoRunSseUrl = (issueId) =>
  `/api/pipeline/issues/${encodeURIComponent(issueId)}/auto-run-text/progress`;
