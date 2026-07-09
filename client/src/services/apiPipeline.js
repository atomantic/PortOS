import { request } from './apiCore.js';
import { buildFormData } from './apiImageVideo.js';

// Stage IDs mirror server/services/pipeline/issues.js — keep these in sync.
// `nouns` is a UI-only pseudo-stage: it has no server stage record + no LLM
// template, and its actions wrap existing endpoints (extract scenes + the
// generic image gen API). It appears in PIPELINE_TAB_STAGES so it gets a tab
// between Prose and Comic Pages, but it's NOT in server TEXT_STAGE_IDS — so
// auto-run text chain skips it and POST /stages/nouns/generate would 400.
export const PIPELINE_TEXT_STAGES = Object.freeze(['idea', 'prose', 'comicScript', 'teleplay']);
export const PIPELINE_VISUAL_STAGES = Object.freeze(['comicPages', 'storyboards', 'episodeVideo']);
export const PIPELINE_AUDIO_STAGES = Object.freeze(['audio']);
export const PIPELINE_UI_STAGES = Object.freeze(['nouns']);
export const PIPELINE_STAGES = Object.freeze([
  ...PIPELINE_TEXT_STAGES, ...PIPELINE_VISUAL_STAGES, ...PIPELINE_AUDIO_STAGES, ...PIPELINE_UI_STAGES,
]);

// Stages that appear as their own tab, in display order. `comicPages` is
// folded into the Comic Script tab (one merged page-by-page editor) — the
// data still flows through the comicPages routes, the tab is just hidden.
// `nouns` is inserted between Prose and Comic Pages so the workflow reads
// Idea → Prose → Nouns → Comic → Teleplay → Storyboards → Episode Video.
export const PIPELINE_TAB_STAGES = Object.freeze([
  'idea', 'prose', 'nouns', 'comicScript', 'teleplay', 'storyboards', 'episodeVideo', 'audio',
]);

export const PIPELINE_STAGE_LABELS = Object.freeze({
  idea: 'Idea',
  prose: 'Prose',
  nouns: 'Nouns',
  // `comicScript` stage now owns the merged Comic Pages editor — the
  // standalone Comic Pages tab is hidden via PIPELINE_TAB_STAGES below.
  comicScript: 'Comic',
  teleplay: 'Teleplay',
  comicPages: 'Comic',
  storyboards: 'Storyboards',
  episodeVideo: 'Video',
  audio: 'Audio',
});

// The stage that conventionally feeds each text-stage target — mirrors the
// server's DEFAULT_FORWARD_SOURCE (server/services/pipeline/textStages.js).
// The text-stage source picker pre-checks these so the common forward flow
// needs no clicks, while still letting any populated stage be a backport source.
export const PIPELINE_DEFAULT_FORWARD_SOURCE = Object.freeze({
  prose: ['idea'],
  comicScript: ['prose'],
  teleplay: ['prose'],
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
// `options` lets a caller suppress request()'s auto-toast with `{ silent: true }`
// (e.g. an optional join that should fail quietly) — see CLAUDE.md.
export const listPipelineSeries = (options = {}) => request('/pipeline/series', options);
export const getPipelineSeries = (id, options = {}) => request(`/pipeline/series/${encodeURIComponent(id)}`, options);
export const createPipelineSeries = (data) => request('/pipeline/series', {
  method: 'POST',
  body: JSON.stringify(data),
});
export const updatePipelineSeries = (id, patch, requestOptions = {}) => request(`/pipeline/series/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
  ...requestOptions,
});

export const setPipelineArcFieldLock = (id, field, locked, requestOptions = {}) =>
  request(`/pipeline/series/${encodeURIComponent(id)}/arc-fields/${encodeURIComponent(field)}/lock`, {
    method: 'PATCH',
    body: JSON.stringify({ locked }),
    ...requestOptions,
  });
export const deletePipelineSeries = (id) => request(`/pipeline/series/${encodeURIComponent(id)}`, {
  method: 'DELETE',
});

// `requestOptions` flows to apiCore.request — pass `{ silent: true }` when the
// caller owns its own error UX (fire-and-forget on post-create).
export const generateSeriesTitleLogo = (id, opts = {}, requestOptions = {}) =>
  request(`/pipeline/series/${encodeURIComponent(id)}/generate-title-logo`, {
    method: 'POST',
    body: JSON.stringify(opts),
    ...requestOptions,
  });

// Multi-concept series ideation (#2180): invent SEVERAL distinct candidate
// concepts (name / logline / premise / shape + craft facets) from a universe
// under an anti-generic banlist. Returns `{ candidates: [...], banlist,
// rationale }` WITHOUT persisting — the New Series form presents the candidates
// for user pick; the chosen one pre-fills the form. `opts` may carry
// `{ count, providerId, model }`.
export const generateSeriesConcepts = (universeId, opts = {}, requestOptions = {}) =>
  request('/pipeline/series/generate-concept', {
    method: 'POST',
    body: JSON.stringify({ universeId, ...opts }),
    ...requestOptions,
  });

// Voice discovery (#2179): write the same scene beat in several distinct
// registers so the author picks the series voice by ear. Returns
// `{ candidates: [{ register, label, passage, note }] }` WITHOUT persisting —
// the picked passage is committed via the ordinary series PATCH
// (styleGuide.voiceExemplars).
export const discoverSeriesVoice = (id, opts = {}, requestOptions = {}) =>
  request(`/pipeline/series/${encodeURIComponent(id)}/discover-voice`, {
    method: 'POST',
    body: JSON.stringify(opts),
    ...requestOptions,
  });

// Mirror server caps in `server/services/pipeline/series.js` — bump both sides.
export const SERIES_TITLE_LOGO_MAX = 2000;
export const SERIES_AUTHOR_MAX = 120;

// ---- Issues ----
export const listPipelineIssues = (seriesId, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/issues`, options);

export const createPipelineIssue = (seriesId, data) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/issues`, {
    method: 'POST',
    body: JSON.stringify(data),
  });

export const getPipelineIssue = (id) => request(`/pipeline/issues/${encodeURIComponent(id)}`);

export const updatePipelineIssue = (id, patch, requestOptions = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    ...requestOptions,
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

// Restore a prior `runHistory` snapshot as the active text-stage state. The
// server snapshots the just-replaced version into runHistory automatically,
// so restoring is reversible by clicking another snapshot. `options` accepts
// `{ silent: true }` so callers that wrap the call in `useAsyncAction` (which
// toasts on throw) don't double-toast when the request fails.
export const restorePipelineStageVersion = (issueId, stageId, runId, options = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/${encodeURIComponent(stageId)}/restore`, {
    method: 'POST',
    body: JSON.stringify({ runId }),
    ...options,
  });

// Auto-fill the storyboards stage's scenes[] from the issue's prose or
// teleplay text stage. `from` defaults server-side to 'teleplay'. Pass
// `force: true` to replace existing hand-curated scenes.
export const extractPipelineStoryboardScenes = (issueId, { from, providerOverride, modelOverride, force } = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/storyboards/extract-scenes`, {
    method: 'POST',
    body: JSON.stringify({ from, providerOverride, modelOverride, force }),
  });

// Auto-fill the comicPages stage's pages[] by deterministically parsing the
// issue's stages.comicScript.output (Marvel/DC-format markdown). Pass
// `force: true` to replace existing hand-curated pages.
export const extractPipelineComicPages = (issueId, { force } = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/comicPages/extract-pages`, {
    method: 'POST',
    body: JSON.stringify({ force }),
  });

// Run canon extraction (characters/places/objects) against an issue's prose,
// comicScript, or teleplay stage output and merge the result into the series'
// linked universe. Auto-extract fires after prose; this lets the writer re-run
// it (e.g. after a provider failure) with a chosen provider/model, or pull in
// minor entities introduced only in script-stage panel directions / dialogue
// cues. `providerOverride`/`model` override the series' configured LLM for this
// run so the user can keep trying models until extraction succeeds. Returns
// { universe, issue, canonExtraction, failures, extracted: { characters, places,
// objects }, sourceStage, truncated } — `canonExtraction` is the persisted
// outcome marker; `failures` lists kinds that threw; `truncated` is true when
// the corpus exceeded the server's 200K-char extract cap and was clamped.
export const extractPipelineCanonFromScript = (issueId, stageId, { providerOverride, model } = {}, options = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/${encodeURIComponent(stageId)}/extract-canon`, {
    method: 'POST',
    body: JSON.stringify({ providerOverride, model }),
    ...options,
  });

// Strictly-prose-grounded description backfill. `targets` is `[{ id, kind }]`
// (kind = 'character' | 'place' | 'object') — the nouns lacking a description.
// Returns `{ universe, issue, descGaps, report }`; `report.none` lists nouns the
// prose can't describe (the manuscript-quality red flag), `report.filled` the
// count written. Unlike extract, this never invents — a blank stays blank.
export const describePipelineCanonFromProse = (issueId, stageId, { providerOverride, model, targets } = {}, options = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/${encodeURIComponent(stageId)}/describe-canon`, {
    method: 'POST',
    body: JSON.stringify({ providerOverride, model, targets }),
    ...options,
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

// AI prompt-refine + image-to-image re-render for a small correction to an
// already-rendered comic page (issue #1534). `opts.instruction` is the user's
// free-text change; the server adjusts the page's stored render prompt and
// re-renders i2i from the page's existing image, persisting the new jobId +
// adjusted prompt on the matching variant slot. Pass `target` ('proof'|'final')
// to force a variant; absent → server refines the final render when present,
// else the proof. Returns { jobId, mode, prompt, pageIndex, variant, changes,
// runId, providerId, issue, stage }.
export const refinePipelineComicPageRender = (issueId, pageIndex, opts = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/comicPages/pages/${encodeURIComponent(pageIndex)}/refine-render`, {
    method: 'POST',
    body: JSON.stringify(opts),
  });

// Render the issue's front cover. Pass `coverScript` to render a not-yet-
// saved concept (the route persists it back to stages.comicPages.cover so
// the next reload reflects what was rendered). Server folds in series
// name, issue number, issue title, and style notes — caller only owns the
// cover-concept text. Returns { jobId, mode, prompt, cover, issue, stage }.
export const generatePipelineComicCover = (issueId, opts = {}, options = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/comicPages/cover/render`, {
    method: 'POST',
    body: JSON.stringify(opts),
    ...options,
  });

// Render the issue's back cover. Same flow as the front cover wrapper above
// but body field is `backCoverScript` and the persisted slot is
// stages.comicPages.backCover. Server enforces an illustration-only prompt
// (no masthead, no text). Returns { jobId, mode, prompt, backCover, issue, stage }.
export const generatePipelineComicBackCover = (issueId, opts = {}, options = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/comicPages/back-cover/render`, {
    method: 'POST',
    body: JSON.stringify(opts),
    ...options,
  });

// Ask the LLM to propose front + back cover concepts for one comic issue.
// `opts.target` ('cover' | 'backCover' | 'both', default 'both') gates which
// slot(s) get seeded when `commit: true` — the UI button on each card sends
// its own target so the user can regenerate one card's concept without
// touching the other. Seeds only blank scripts; never clobbers a user edit.
// Returns { coverConcept, backCoverConcept, target, seeded, … }; the
// `issue` and `stage` fields are only populated when `commit: true` (the
// preview-only path returns them as null).
export const generatePipelineComicCoverConcepts = (issueId, opts = {}, options = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/cover-concepts/generate`, {
    method: 'POST',
    body: JSON.stringify(opts),
    ...options,
  });

// Volume (season) cover render. Persists in-flight slot on
// series.seasons[].cover via the season write tail.
// Returns { jobId, mode, prompt, coverScript, season, series, variant, fromProof }.
export const generatePipelineVolumeCover = (seriesId, seasonId, opts = {}, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/seasons/${encodeURIComponent(seasonId)}/cover/render`, {
    method: 'POST',
    body: JSON.stringify(opts),
    ...options,
  });

// Volume back-cover render — same shape, lands on season.backCover.
export const generatePipelineVolumeBackCover = (seriesId, seasonId, opts = {}, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/seasons/${encodeURIComponent(seasonId)}/back-cover/render`, {
    method: 'POST',
    body: JSON.stringify(opts),
    ...options,
  });

// Ask the LLM to propose front + back cover concepts for the volume.
// Pass { commit: true } to also seed `season.cover.script` /
// `season.backCover.script` when those slots are currently blank (the
// server never clobbers a user edit). Returns the proposed text plus the
// updated season + series records.
export const generatePipelineVolumeCoverConcepts = (seriesId, seasonId, opts = {}, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/seasons/${encodeURIComponent(seasonId)}/cover-concepts/generate`, {
    method: 'POST',
    body: JSON.stringify(opts),
    ...options,
  });

// Build the trade-paperback PDF download URL for one volume. Used as an
// <a href> so the browser streams the response straight to disk.
export const pipelineVolumePdfUrl = (seriesId, seasonId, { size } = {}) => {
  const qs = size ? `?size=${encodeURIComponent(size)}` : '';
  return `/api/pipeline/series/${encodeURIComponent(seriesId)}/seasons/${encodeURIComponent(seasonId)}/volume.pdf${qs}`;
};

// Prose-series export download URLs (#2181). Used as <a href> so the browser
// streams each artifact straight to disk (no in-app blob handling). All three
// read the persisted per-series export settings server-side.
export const proseExportManuscriptUrl = (seriesId) =>
  `/api/pipeline/series/${encodeURIComponent(seriesId)}/export/manuscript.md`;
export const proseExportEpubUrl = (seriesId) =>
  `/api/pipeline/series/${encodeURIComponent(seriesId)}/export/book.epub`;
export const proseExportPdfUrl = (seriesId) =>
  `/api/pipeline/series/${encodeURIComponent(seriesId)}/export/interior.pdf`;

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

// Render the start-frame image for a single shot inside a storyboard scene.
// Server persists the resulting jobId on
// stages.storyboards.scenes[sceneIndex].shots[shotIndex].startFrameJobId.
export const generatePipelineShotStartFrame = (issueId, sceneIndex, shotIndex, opts = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/storyboards/scenes/${encodeURIComponent(sceneIndex)}/shots/${encodeURIComponent(shotIndex)}/render`, {
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

// Non-destructive N-candidate variant of the panel refine: returns
// `count` alternative image-gen prompts WITHOUT mutating the panel
// description (issue #904). Resolves to { candidates, requested, pageIndex,
// panelIndex } where each candidate is { prompt, changes, runId, ... }.
export const generatePipelineComicPanelImagePrompts = (issueId, pageIndex, panelIndex, opts = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/comicPages/pages/${encodeURIComponent(pageIndex)}/panels/${encodeURIComponent(panelIndex)}/image-prompts`, {
    method: 'POST',
    body: JSON.stringify(opts),
  });

// Non-destructive N-candidate variant for a storyboard scene (issue #904).
// Resolves to { candidates, requested, sceneIndex }.
export const generatePipelineSceneImagePrompts = (issueId, sceneIndex, opts = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/storyboards/scenes/${encodeURIComponent(sceneIndex)}/image-prompts`, {
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

// Deep verify pass for a single volume / season. Complements verifyPipelineArc:
// the arc pass is cross-volume + synopsis-depth; this pass is volume-scoped
// and goes to beat depth for issues whose stages.idea.output is populated.
// Returns { issues, runId, providerId, model, seasonId }. Empty issues[] = clean.
export const verifyPipelineVolume = (seriesId, seasonId, { providerOverride, modelOverride } = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/seasons/${encodeURIComponent(seasonId)}/verify`, {
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

// Back-derive arc + bible + a single-volume restructure from the series' EXISTING
// issue manuscripts. Read-only preview the UI shows for review/edit. Returns
// { arc, volume, bible, issues, derivedSeasons, runId, providerId, model }.
export const derivePipelineArcFromManuscript = (seriesId, { providerOverride, modelOverride } = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/arc/derive-from-manuscript`, {
    method: 'POST',
    body: JSON.stringify({ providerOverride, modelOverride }),
  });

// Apply the (edited) derive preview — writes bible, collapses to one volume,
// reassigns issues, seeds per-issue synopses. No LLM re-run. Pass the confirmed
// { arc, bible, volume, issues } proposal. Returns { series, volumeId, issueCount }.
export const commitPipelineArcFromManuscript = (seriesId, proposal = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/arc/derive-from-manuscript/commit`, {
    method: 'POST',
    body: JSON.stringify(proposal),
  });

// Manuscript-completeness ("finish the draft") editor pass — reads the actual
// drafted script and returns categorized { severity, category, location,
// problem, suggestion } findings. Advisory; no auto-resolve. Empty = complete.
// `mode`: 'merge' (default) leaves prior comments as-is and appends new
// findings; 'fresh' also auto-dismisses open comments this pass no longer finds
// (accepted/dismissed untouched, dismissed still suppress resurfacing).
export const analyzePipelineManuscriptCompleteness = (seriesId, { providerOverride, modelOverride, mode } = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/manuscript/completeness`, {
    method: 'POST',
    body: JSON.stringify({ providerOverride, modelOverride, mode }),
  });

// Streamed completeness review backing the "generate edits for every finding"
// option: this pass always returns a concrete `replace` per finding so each
// seeded comment lands with its `fix` pre-attached. Returns { runId,
// alreadyRunning, sseUrl } — subscribe via pipelineManuscriptCompletenessSseUrl
// to stream per-chunk progress, then re-fetch the review on `complete`.
export const startPipelineManuscriptCompleteness = (seriesId, { providerOverride, modelOverride, mode } = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/manuscript/completeness/stream`, {
    method: 'POST',
    body: JSON.stringify({ providerOverride, modelOverride, mode }),
  });

export const cancelPipelineManuscriptCompleteness = (seriesId) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/manuscript/completeness/cancel`, {
    method: 'POST',
  });

// { active: boolean } — lets a (re)mounting editor re-attach to an in-flight run.
export const getPipelineManuscriptCompletenessStatus = (seriesId, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/manuscript/completeness/status`, options);

export const pipelineManuscriptCompletenessSseUrl = (seriesId) =>
  `/api/pipeline/series/${encodeURIComponent(seriesId)}/manuscript/completeness/progress`;

// ---- Manuscript editor ----
// Full series manuscript in one format. `type` (comicScript|teleplay|prose)
// selects the format; omit to get the series' primary/source format. Returns
// { sections, viewType, primaryStageId, pinnedPrimary, availableTypes }.
export const getPipelineManuscript = (seriesId, type) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/manuscript${type ? `?type=${encodeURIComponent(type)}` : ''}`);

// The persisted "finish the draft" comment set ({ schemaVersion, comments }).
export const getPipelineManuscriptReview = (seriesId) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/manuscript/review`);

// Resolve a finding by its comment id alone (series-agnostic deep-link, #1608).
// Finder semantics: resolves `{ seriesId, comment }` when a series owns the id,
// or `null` when it doesn't (the route 404s) or the lookup fails — the deep-link
// page renders the same "not found" fallback either way, so it owns the error UI
// and we stay silent.
export const locatePipelineFinding = (commentId) =>
  request(`/pipeline/findings/${encodeURIComponent(commentId)}/locate`, { silent: true })
    .catch(() => null);

// Patch one comment: { status } flip and/or { fix } attach/clear. Returns { comment }.
export const patchPipelineManuscriptComment = (seriesId, commentId, patch, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/manuscript/review/comments/${encodeURIComponent(commentId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    ...options,
  });

// Generate one or more anchored fix edits for a comment (does not apply them).
export const generatePipelineManuscriptFix = (seriesId, commentId, { providerOverride, modelOverride } = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/manuscript/review/comments/${encodeURIComponent(commentId)}/fix`, {
    method: 'POST',
    body: JSON.stringify({ providerOverride, modelOverride }),
  });

// Apply one or more optionally edited fixes into stage output + mark accepted.
// Returns { comment, section, sections }.
export const acceptPipelineManuscriptFix = (seriesId, commentId, { find, replace, edits }, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/manuscript/review/comments/${encodeURIComponent(commentId)}/accept`, {
    method: 'POST',
    body: JSON.stringify({ find, replace, edits }),
    ...options,
  });

// Undo a previously-accepted fix — restores the captured pre-edit manuscript
// text and re-opens the finding. No body (the snapshot lives on the comment).
// Returns { comment, section, sections } like accept, so callers reapply through
// the same path.
export const undoPipelineManuscriptFix = (seriesId, commentId, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/manuscript/review/comments/${encodeURIComponent(commentId)}/undo`, {
    method: 'POST',
    ...options,
  });

// Versioned free-text save of one manuscript section. Snapshots the prior text
// into history (revert via restorePipelineStageVersion). Returns { section }
// where section.versions is the updated [{ runId, createdAt }] list.
export const savePipelineManuscriptSection = (seriesId, issueId, { stageId, output }, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/manuscript/sections/${encodeURIComponent(issueId)}`, {
    method: 'PUT',
    body: JSON.stringify({ stageId, output }),
    ...options,
  });

// AI reformat of manuscript text — repairs paste artifacts (wrapping, drop-caps,
// orphaned quotes) WITHOUT changing words. Compute-only: returns the cleaned
// `{ text, changed, runId }` and does NOT persist — the caller sends its live
// content and owns the save (so unsaved edits aren't clobbered). A 400 means the
// model altered the wording (integrity guard) and the text is unchanged.
export const reformatPipelineManuscriptText = (seriesId, { stageId, content, providerOverride, modelOverride } = {}, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/manuscript/reformat`, {
    method: 'POST',
    body: JSON.stringify({ stageId, content, providerOverride, modelOverride }),
    ...options,
  });

// ---- Adversarial cuts (#2168) ----
// Preview cuts — dry-run that returns before/after diffs without applying.
// Returns { preview: [{ issueNumber, before, after, applied, refused, refusedDetails }], totalApplied, totalRefused }.
export const previewPipelineManuscriptCuts = (seriesId, { commentIds, allowTypes, safeTypesOnly } = {}, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/manuscript/cuts/preview`, {
    method: 'POST',
    body: JSON.stringify({ commentIds, allowTypes, safeTypesOnly }),
    ...options,
  });

// Apply cuts — writes through the serialized stage-write path with snapshots.
// Returns { applied, refused, sections, refusedDetails, acceptedCount }.
export const applyPipelineManuscriptCuts = (seriesId, { commentIds, allowTypes, safeTypesOnly } = {}, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/manuscript/cuts/apply`, {
    method: 'POST',
    body: JSON.stringify({ commentIds, allowTypes, safeTypesOnly }),
    ...options,
  });

// ---- Volume beat-sheet bulk generator ----
// Sequential idea-stage run across every issue in a volume. `mode` is
// 'skip-existing' (default) or 'regenerate-all'. Returns
// { runId, alreadyRunning, sseUrl } — subscribe via pipelineVolumeBeatsSseUrl
// to stream per-issue progress.
export const startPipelineVolumeBeats = (seriesId, seasonId, { mode, providerOverride, modelOverride } = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/seasons/${encodeURIComponent(seasonId)}/generate-beats`, {
    method: 'POST',
    body: JSON.stringify({ mode, providerOverride, modelOverride }),
  });

export const cancelPipelineVolumeBeats = (seriesId, seasonId) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/seasons/${encodeURIComponent(seasonId)}/generate-beats/cancel`, {
    method: 'POST',
  });

export const pipelineVolumeBeatsSseUrl = (seriesId, seasonId) =>
  `/api/pipeline/series/${encodeURIComponent(seriesId)}/seasons/${encodeURIComponent(seasonId)}/generate-beats/progress`;

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

// ---- Editorial roadmap / reader-emotion analysis ----
// Aggregate roadmap: { coverage, roadmap[], characters[], protagonist, supportingArcs, ... }
export const getSeriesEditorial = (seriesId, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/editorial`, options);

// Full per-issue snapshot: { sections[], characters[], rollup, stale, ... } or { status: 'none' }
export const getIssueEditorial = (issueId, options = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/editorial`, options);

// Analyze ONE issue (synchronous; returns the finished snapshot)
export const analyzeIssueEditorial = (issueId, opts = {}, options = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/editorial/analyze`, {
    method: 'POST',
    body: JSON.stringify(opts),
    ...options,
  });

// Analyze the whole series (batch). { runId, alreadyRunning, sseUrl } — subscribe
// via pipelineEditorialSseUrl to stream per-issue progress.
export const analyzeSeriesEditorial = (seriesId, opts = {}, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/editorial/analyze`, {
    method: 'POST',
    body: JSON.stringify(opts),
    ...options,
  });

export const cancelSeriesEditorial = (seriesId) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/editorial/analyze/cancel`, {
    method: 'POST',
  });

// { active: boolean } — lets a (re)mounting view re-attach to an in-flight batch.
export const getSeriesEditorialStatus = (seriesId, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/editorial/analyze/status`, options);

export const pipelineEditorialSseUrl = (seriesId) =>
  `/api/pipeline/series/${encodeURIComponent(seriesId)}/editorial/analyze/progress`;

// ---- Calibrated issue quality judge (#2167 — qualityScore = judge − slop) ----
// One issue's stored judge score: { status, overall, dimensions, slopPenalty,
// qualityScore, strongestSentences, weakestSentences, topRevisions, stale, ... }
// or { status: 'none' }.
export const getIssueJudge = (issueId, options = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/judge`, options);

// Judge ONE issue (synchronous; returns the finished snapshot). opts:
// { stageId?, providerId?, model?, force? }.
export const judgeIssue = (issueId, opts = {}, options = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/judge`, {
    method: 'POST',
    body: JSON.stringify(opts),
    ...options,
  });

// Series quality roadmap: { coverage, scores[], weakest[], ... } — scores carry
// per-issue qualityScore; `weakest` is the ascending-quality revision priority.
export const getSeriesJudge = (seriesId, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/judge`, options);

// ---- Reader panel (#2170 — four-persona panel + disagreement mining) ----
// Stored panel: { status, personas[], disagreements:{consensus,attention,polarizing,totalPersonas}, seededFindings, stale } or { status: 'none' }.
export const getReaderPanel = (seriesId, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/editorial/panel`, options);

// Convene the panel (batch). { runId, alreadyRunning, sseUrl } — subscribe via
// readerPanelSseUrl to stream per-persona progress.
export const runReaderPanel = (seriesId, opts = {}, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/editorial/panel/run`, {
    method: 'POST',
    body: JSON.stringify(opts),
    ...options,
  });

export const cancelReaderPanel = (seriesId) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/editorial/panel/run/cancel`, {
    method: 'POST',
  });

// ---- Head-to-head comparative Elo ranking (#2169, CWQE Phase 5) ----
// Stored ranking: { status:'complete', ranking:[{ rank, issueId, number, label,
// rating, wins, losses }], weakest[], matches[], entrants, rounds, stale } or
// { status:'none' } / { status:'insufficient' }.
export const getComparativeRank = (seriesId, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/editorial/rank`, options);

// Run the pairwise Elo tournament (synchronous; returns the finished ranking).
// opts: { providerId?, model?, rounds? }.
export const runComparativeRank = (seriesId, opts = {}, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/editorial/rank`, {
    method: 'POST',
    body: JSON.stringify(opts),
    ...options,
  });

// { active: boolean } — lets a (re)mounting view re-attach to an in-flight run.
export const getReaderPanelStatus = (seriesId, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/editorial/panel/run/status`, options);

export const readerPanelSseUrl = (seriesId) =>
  `/api/pipeline/series/${encodeURIComponent(seriesId)}/editorial/panel/run/progress`;

// ---- Perspective rewrite (#1290 — rewrite a passage in another POV + analyze) ----
// Stored alternate-POV rewrites + cast (for the picker) + per-rewrite stale flags:
// { issueId, seriesId, cast[], hasContent, rewrites[] }
export const getPipelinePerspectiveRewrites = (issueId, options = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/pov-rewrites`, options);

// Generate one alternate-POV rewrite + analysis (synchronous; returns { status, rewrite }).
export const createPipelinePerspectiveRewrite = (issueId, opts = {}, options = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/pov-rewrites`, {
    method: 'POST',
    body: JSON.stringify(opts),
    ...options,
  });

// Remove one stored rewrite artifact ({ removed }).
export const deletePipelinePerspectiveRewrite = (issueId, rewriteId, options = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/pov-rewrites/${encodeURIComponent(rewriteId)}`, {
    method: 'DELETE',
    ...options,
  });

// ---- Editorial checks (#1284 registry-driven review) ----
// The full check catalog merged with persisted enable/config state:
// { checks: [{ id, label, description, scope, kind, category, severityDefault,
//             enabled, config, configFields }] }. The catalog is GLOBAL (settings-
// backed); only the run + findings are series-scoped.
export const getEditorialChecks = (options = {}) =>
  request('/pipeline/editorial/checks', options);

// Enable/disable a check or update its config. `patch` is { enabled?, config? };
// `config` is validated against the check's own schema server-side. Returns the
// updated resolved-state row. Pass { silent: true } when you own the error UI.
export const patchEditorialCheck = (checkId, patch, options = {}) =>
  request(`/pipeline/editorial/checks/${encodeURIComponent(checkId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    ...options,
  });

// User-defined checks (#1346): author an LLM check (name + prompt + scope) with
// no code change. Create/update return the new check's resolved catalog row (the
// same shape getEditorialChecks rows carry, with `isCustom: true` + `prompt`).
export const createEditorialCustomCheck = (def, options = {}) =>
  request('/pipeline/editorial/custom-checks', {
    method: 'POST',
    body: JSON.stringify(def),
    ...options,
  });

export const updateEditorialCustomCheck = (checkId, patch, options = {}) =>
  request(`/pipeline/editorial/custom-checks/${encodeURIComponent(checkId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    ...options,
  });

export const deleteEditorialCustomCheck = (checkId, options = {}) =>
  request(`/pipeline/editorial/custom-checks/${encodeURIComponent(checkId)}`, {
    method: 'DELETE',
    ...options,
  });

// Dry-run a DRAFT custom check (#1607) against a series WITHOUT saving it: runs
// the unsaved definition transiently and returns { findings, skipped, invalid }
// (sample findings only — never seeded into the review). `def` carries the same
// authored fields as create, plus an optional maxFindings cap. Pass
// { silent: true } when the caller owns its own error UI.
export const previewEditorialCustomCheck = (seriesId, def, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/editorial/custom-checks/preview`, {
    method: 'POST',
    body: JSON.stringify(def),
    ...options,
  });

// Start a series-wide checks run (or a named subset). { runId, alreadyRunning,
// sseUrl } — subscribe via editorialChecksRunSseUrl, then re-fetch the manuscript
// review on `complete` (the runner seeds findings into the review store).
export const startEditorialChecksRun = (seriesId, opts = {}, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/editorial/checks/run`, {
    method: 'POST',
    body: JSON.stringify(opts),
    ...options,
  });

// { active: boolean } — lets a (re)mounting view re-attach to an in-flight run.
export const getEditorialChecksRunStatus = (seriesId, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/editorial/checks/run/status`, options);

export const cancelEditorialChecksRun = (seriesId, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/editorial/checks/run/cancel`, {
    method: 'POST',
    ...options,
  });

export const editorialChecksRunSseUrl = (seriesId) =>
  `/api/pipeline/series/${encodeURIComponent(seriesId)}/editorial/checks/run/progress`;

// ---- Editorial health score + revision trend (#1316) ----
// The transparent severity-weighted health score (per series + per issue), the
// readiness signal, and the revision trend + per-category regressions:
// { seriesId, score, ready, open, openBySeverity, openByCategory, gate, weights,
//   perIssue: [...], trend: { points, regressions, latest, previous, delta } }.
export const getEditorialHealth = (seriesId, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/editorial/health`, options);

// Set the editorial-health readiness gate ('noOpenHigh' | 'noOpenHighOrMedium' |
// 'none') the autopilot loop + UI read as "manuscript clean". Returns the
// persisted { readinessGate }.
export const setEditorialReadinessGate = (readinessGate, options = {}) =>
  request('/pipeline/editorial/readiness-gate', {
    method: 'PATCH',
    body: JSON.stringify({ readinessGate }),
    ...options,
  });

// ---- Reverse Outline (scene segmentation + plotline tagging) ----
// The stored outline: { plotlines, scenes, stale, status }. `status:'none'`
// when never generated, `'no-content'` shell while nothing is drafted yet.
export const getReverseOutline = (seriesId, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/reverse-outline`, options);

// Kick off a (re)generation. { runId, alreadyRunning, sseUrl } — subscribe via
// pipelineReverseOutlineSseUrl to stream progress, then re-fetch on `complete`.
export const generateReverseOutline = (seriesId, opts = {}, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/reverse-outline/generate`, {
    method: 'POST',
    body: JSON.stringify(opts),
    ...options,
  });

export const cancelReverseOutline = (seriesId) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/reverse-outline/generate/cancel`, {
    method: 'POST',
  });

// { active: boolean } — lets a (re)mounting view re-attach to an in-flight run.
export const getReverseOutlineStatus = (seriesId, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/reverse-outline/generate/status`, options);

export const pipelineReverseOutlineSseUrl = (seriesId) =>
  `/api/pipeline/series/${encodeURIComponent(seriesId)}/reverse-outline/generate/progress`;

// ---- Voice fingerprint matrix (#2194) ----
// The full issues×metrics fingerprint vector + deterministic drift result:
// { seriesId, config, wells, columns, gatedOff, issueCount, threshold, matrix,
//   series, outliers }. Read-only, no LLM cost — drives the dedicated matrix view.
export const getVoiceFingerprint = (seriesId, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/voice-fingerprint`, options);

// ---- Continuity Bible (established-facts ledger) ----
// The stored ledger: { facts, stale, status }. `status:'none'` when never
// generated, `'no-content'` shell while there's no canon and nothing drafted.
export const getContinuityBible = (seriesId, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/continuity-bible`, options);

// Kick off a (re)generation. { runId, alreadyRunning, sseUrl } — subscribe via
// pipelineContinuityBibleSseUrl to stream progress, then re-fetch on `complete`.
export const generateContinuityBible = (seriesId, opts = {}, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/continuity-bible/generate`, {
    method: 'POST',
    body: JSON.stringify(opts),
    ...options,
  });

export const cancelContinuityBible = (seriesId) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/continuity-bible/generate/cancel`, {
    method: 'POST',
  });

// { active: boolean } — lets a (re)mounting view re-attach to an in-flight run.
export const getContinuityBibleStatus = (seriesId, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/continuity-bible/generate/status`, options);

export const pipelineContinuityBibleSseUrl = (seriesId) =>
  `/api/pipeline/series/${encodeURIComponent(seriesId)}/continuity-bible/generate/progress`;

// ---- Series Autopilot (full autonomous mode) ----
// Drives a series from its current state to story-ready (+ draft visuals) by
// composing every pipeline pass. SSE-backed; gated on the cos autonomy domain
// (off → 409, dry-run → plan only, execute → full run).
export const startPipelineAutopilot = (seriesId, opts = {}, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/autopilot/start`, {
    method: 'POST',
    body: JSON.stringify(opts),
    ...options,
  });

export const cancelPipelineAutopilot = (seriesId) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/autopilot/cancel`, {
    method: 'POST',
  });

// { autopilot: { status, runId, currentStep, residualFindings, ... } | null, active }
export const getPipelineAutopilotStatus = (seriesId, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/autopilot/status`, options);

export const pipelineAutopilotSseUrl = (seriesId) =>
  `/api/pipeline/series/${encodeURIComponent(seriesId)}/autopilot/progress`;

// ---- Canon descriptive-integrity (production readiness) ----
// Read-only: which canon nouns appear where they'd be drawn but lack a
// description (blocking visual production).
export const getPipelineIssueCanonReadiness = (issueId, options = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/canon-readiness`, options);

export const getPipelineSeriesCanonReadiness = (seriesId, options = {}) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/canon-readiness`, options);

// ---- Audio stage ----
// Flat list of every voice the active engines expose, namespaced as
// `engine:voiceName` (e.g. `kokoro:af_bella`, `piper:lessac-medium`). The
// character voice picker + per-line override picker pull from this single
// list so a new engine surfaces in every consumer with one server-side edit.
// Silent — VoicePicker owns its own inline error UI.
export const listPipelineTtsVoices = () => request('/pipeline/tts/voices', { silent: true });

// Audition a voice — returns the rendered WAV as an ArrayBuffer so callers
// can feed it to `playWav` from voiceClient. Optional `text` overrides the
// server-side default preview line. Silent — VoicePicker owns its own
// inline error toast.
export const previewPipelineTtsVoice = (voiceId, text) =>
  request('/pipeline/tts/preview', {
    method: 'POST',
    body: JSON.stringify(text ? { voiceId, text } : { voiceId }),
    responseType: 'arraybuffer',
    silent: true,
  });

// Narrate manuscript prose for read-aloud proofing (#1304). Splits the text
// into sentence segments, synthesizes each via the local TTS engines, and
// returns `{ segments: [{ index, text, start, end, filename, durationMs,
// readability }], voiceId, engine }` so the manuscript editor can play a
// karaoke-style read-along. Non-destructive. `options` lets the caller opt into
// silent mode when it owns its own error UI.
export const narratePipelineProse = (text, voiceId, options = {}) =>
  request('/pipeline/tts/narrate', {
    method: 'POST',
    body: JSON.stringify(voiceId ? { text, voiceId } : { text }),
    ...options,
  });

// Walks storyboards.scenes[].dialogue and populates stages.audio.lines[].
// Pass { force: true } to replace existing lines wholesale (server defaults
// to a 409 when lines[] is already populated so a stray click can't wipe
// manual edits).
export const extractPipelineAudioLines = (issueId, { force } = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/audio/extract-lines`, {
    method: 'POST',
    body: JSON.stringify({ force }),
  });

// Render one VO line. Voice resolution priority (server-side): explicit
// voiceId body param > line.voiceIdOverride > character.voiceId > system
// default. Returns { issue, stage, lineIdx, filename, engine, voiceId }.
export const renderPipelineAudioLine = (issueId, lineIdx, { voiceId } = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/audio/lines/${encodeURIComponent(lineIdx)}/render`, {
    method: 'POST',
    body: JSON.stringify({ voiceId }),
  });

// Per-line edit (text or voice override). Narrow patch shape — the server
// merges against the freshest persisted record inside the per-issue write
// queue so two simultaneous blurs against different lines can't clobber.
export const patchPipelineAudioLine = (issueId, lineIdx, patch) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/audio/lines/${encodeURIComponent(lineIdx)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });

// ---- Music library (Phase 4c) ----
export const listPipelineMusicLibrary = () =>
  request('/pipeline/audio/music-library');

// request() now detects FormData bodies and lets the browser set the multipart
// boundary automatically — no need to bypass it. Accept `options` so callers
// with their own error UI can pass `{ silent: true }`.
export const uploadPipelineMusicTrack = (issueId, file, { label } = {}, options = {}) =>
  request(
    `/pipeline/issues/${encodeURIComponent(issueId)}/stages/audio/music/upload`,
    { method: 'POST', body: buildFormData({ track: file, label }), ...options },
  );

export const attachPipelineMusicTrack = (issueId, { trackFilename, label } = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/audio/music/attach`, {
    method: 'POST',
    body: JSON.stringify({ trackFilename, label }),
  });

export const detachPipelineMusicTrack = (issueId) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/audio/music`, {
    method: 'DELETE',
  });

// Library deletes do NOT auto-purge issue references — by design, so the
// user sees the broken playback and re-picks rather than the library
// silently rewriting issue state.
export const deletePipelineMusicTrack = (filename) =>
  request(`/pipeline/audio/music-library/${encodeURIComponent(filename)}`, {
    method: 'DELETE',
  });

// ---- Local-OSS music generation (Phase 4c.2) ----

// Available local music backends + whether each opt-in runtime is installed.
// Returns { engines: [{ id, name, models, defaultModelId, defaultDurationSec,
// minDurationSec, maxDurationSec, ready }], defaultEngine, ... } — the default
// engine's fields are also flattened to the top level for back-compat. A
// per-engine `ready=false` → show that engine's install hint, not the prompt.
export const listPipelineMusicGenerators = (options = {}) =>
  request('/pipeline/audio/music/generators', options);

// Generate a background-music track with a local backend (`engine`: 'musicgen'
// | 'audioldm2') and attach it to the issue (source: 'gen'). Long-running
// (~tens of seconds); callers own a busy state. Returns
// { issue, stage, music, durationSec, modelId, engine }.
export const generatePipelineMusic = (issueId, { prompt, engine, durationSec, modelId } = {}, options = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/audio/music/generate`, {
    method: 'POST',
    body: JSON.stringify({ prompt, engine, durationSec, modelId }),
    ...options,
  });

// ---- Whole-episode audio cues (issue #863) ----

// Derive the per-arc cue list from the episode's own beats + storyboard scene
// order and flip audioMode to 'generated'. Already-rendered cue audio is
// carried forward by label. Pass { force: true } to replace an existing
// cues[] (server 409s otherwise). Returns
// { issue, stage, cues, cueCount, runId, providerId, model }.
export const generatePipelineAudioCues = (issueId, { engine, providerOverride, modelOverride, force } = {}, options = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/audio/cues/generate`, {
    method: 'POST',
    body: JSON.stringify({ engine, providerOverride, modelOverride, force }),
    ...options,
  });

// Render one cue's music via the generator-agnostic generateMusic contract,
// stamping trackFilename + durationSec back into that cue. Long-running;
// callers own a busy state. Returns
// { issue, stage, cueIdx, cue, trackFilename, durationSec, engine, modelId }.
export const renderPipelineAudioCue = (issueId, cueIdx, { engine, durationSec, modelId } = {}, options = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/audio/cues/${encodeURIComponent(cueIdx)}/render`, {
    method: 'POST',
    body: JSON.stringify({ engine, durationSec, modelId }),
    ...options,
  });
