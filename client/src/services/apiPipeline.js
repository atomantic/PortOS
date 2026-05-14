import { request } from './apiCore.js';

// Stage IDs mirror server/services/pipeline/issues.js — keep these in sync.
// `nouns` is a UI-only pseudo-stage: it has no server stage record + no LLM
// template, and its actions wrap existing endpoints (extract-bible + the
// generic image gen API). It appears in PIPELINE_TAB_STAGES so it gets a tab
// between Prose and Comic Pages, but it's NOT in server TEXT_STAGE_IDS — so
// auto-run text chain skips it and POST /stages/nouns/generate would 400.
export const PIPELINE_TEXT_STAGES = Object.freeze(['idea', 'prose', 'comicScript', 'tvScript']);
export const PIPELINE_VISUAL_STAGES = Object.freeze(['comicPages', 'storyboards', 'episodeVideo']);
export const PIPELINE_UI_STAGES = Object.freeze(['nouns']);
export const PIPELINE_STAGES = Object.freeze([...PIPELINE_TEXT_STAGES, ...PIPELINE_VISUAL_STAGES, ...PIPELINE_UI_STAGES]);

// Stages that appear as their own tab, in display order. `comicPages` is
// folded into the Comic Script tab (one merged page-by-page editor) — the
// data still flows through the comicPages routes, the tab is just hidden.
// `nouns` is inserted between Prose and Comic Pages so the workflow reads
// Idea → Prose → Nouns → Comic → TV Script → Storyboards → Episode Video.
export const PIPELINE_TAB_STAGES = Object.freeze([
  'idea', 'prose', 'nouns', 'comicScript', 'tvScript', 'storyboards', 'episodeVideo',
]);

export const PIPELINE_STAGE_LABELS = Object.freeze({
  idea: 'Idea',
  prose: 'Prose',
  nouns: 'Nouns',
  // `comicScript` stage now owns the merged Comic Pages editor — the
  // standalone Comic Pages tab is hidden via PIPELINE_TAB_STAGES below.
  comicScript: 'Comic',
  tvScript: 'TV Script',
  comicPages: 'Comic',
  storyboards: 'Storyboards',
  episodeVideo: 'Video',
});

export const PIPELINE_TARGET_FORMATS = Object.freeze(['comic', 'tv', 'comic+tv']);

export const PIPELINE_STAGE_STATUS_LABEL = Object.freeze({
  empty: 'Not started',
  generating: 'Generating…',
  ready: 'Ready',
  edited: 'Edited',
  'needs-review': 'Needs review',
  error: 'Error',
});

export const PIPELINE_STAGE_STATUS_COLOR = Object.freeze({
  empty: 'text-gray-500',
  generating: 'text-port-accent',
  ready: 'text-port-success',
  edited: 'text-port-warning',
  'needs-review': 'text-port-warning',
  error: 'text-port-error',
});

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

// Rewrite one character's physicalDescription so they render distinct from
// every peer. Returns { series, entry, rationale, changes }.
export const refinePipelineCharacter = (seriesId, entryId, { providerId, model } = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/characters/${encodeURIComponent(entryId)}/refine`, {
    method: 'POST',
    body: JSON.stringify({ providerId, model }),
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

// Render the issue's front cover. Pass `coverScript` to render a not-yet-
// saved concept (the route persists it back to stages.comicPages.cover so
// the next reload reflects what was rendered). Server folds in series
// name, issue number, issue title, and style notes — caller only owns the
// cover-concept text. Returns { jobId, mode, prompt, cover, issue, stage }.
export const generatePipelineComicCover = (issueId, opts = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/comicPages/cover/render`, {
    method: 'POST',
    body: JSON.stringify(opts),
  });

// Patch one comic page's raw markdown — the server re-parses panels from the
// edited rawText so subsequent renders still get a structured prompt.
// Returns { issue, stage, page }.
export const updatePipelineComicPage = (issueId, pageIndex, { rawText } = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/comicPages/pages/${encodeURIComponent(pageIndex)}`, {
    method: 'PATCH',
    body: JSON.stringify({ rawText }),
  });

// Render a single storyboard scene as a video clip (one t2v call against
// the scene's existing description + style). Independent of the
// episode-video stitch — use this when you want to preview a scene before
// committing the whole episode render.
// Server persists the resulting jobId on stages.storyboards.scenes[index]
// .sceneVideoJobId. Returns { jobId, prompt, sceneIndex, issue, stage }.
export const generatePipelineSceneVideo = (issueId, sceneIndex, opts = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/storyboards/scenes/${encodeURIComponent(sceneIndex)}/video`, {
    method: 'POST',
    body: JSON.stringify(opts),
  });

// LLM-driven refinement of a single comic panel's description into a
// richer image-gen prompt. Uses the pipeline-comic-panel-image-prompt
// stage with neighboring-panel continuity context. Server persists the
// refined description on the panel and returns { panel, page, issue,
// stage, runId, changes, providerId }.
export const refinePipelineComicPanelPrompt = (issueId, pageIndex, panelIndex, opts = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/comicPages/pages/${encodeURIComponent(pageIndex)}/panels/${encodeURIComponent(panelIndex)}/refine-prompt`, {
    method: 'POST',
    body: JSON.stringify(opts),
  });

// LLM-driven refinement of a single storyboard scene's description into a
// richer image-gen prompt. Mirror of refinePipelineComicPanelPrompt.
export const refinePipelineSceneImagePrompt = (issueId, sceneIndex, opts = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/storyboards/scenes/${encodeURIComponent(sceneIndex)}/refine-prompt`, {
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

// Auto-resolve verification findings — server runs an LLM pass that rewrites
// the arc + volume/season outlines to address every finding, then persists.
// Pass `findings: [...]` to resolve only that subset; omit to re-verify and
// resolve everything. Returns { series, applied, notes, findings, runId, ... }.
export const resolvePipelineArcIssues = (seriesId, { findings, providerOverride, modelOverride } = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/arc/resolve-issues`, {
    method: 'POST',
    body: JSON.stringify({ findings, providerOverride, modelOverride }),
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
