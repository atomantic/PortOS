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

// Run canon extraction (characters/places/objects) against an issue's
// comicScript or teleplay stage output and merge the result into the series'
// linked universe. Auto-extract only fires after prose; this lets the writer
// pull in minor entities introduced only in script-stage panel directions or
// dialogue cues. Returns { universe, extracted: { characters, places, objects },
// sourceStage, truncated } — `truncated` is true when the script exceeded
// the server's 200K-char extract cap and was clamped before being sent to the LLM.
export const extractPipelineCanonFromScript = (issueId, stageId, { providerOverride } = {}, options = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/${encodeURIComponent(stageId)}/extract-canon`, {
    method: 'POST',
    body: JSON.stringify({ providerOverride }),
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
