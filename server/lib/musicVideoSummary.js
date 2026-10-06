/**
 * Music Video project summary projection (#10169).
 *
 * `GET /api/music-video?summary=1` returns one bounded record per project — just
 * what the project index card and the header picker render — so the index never
 * ships every project's scenes, excerpts, revisions, runs and reviews. The stage
 * / spend / preview rules mirror `client/src/lib/musicVideoStages.js` and
 * `musicVideoPreview.js`, which still derive them for a full record.
 */
import { isLayeredComposition, sceneRenderReady } from './musicVideoLayers.js';
import { latestMusicVideoReviewDraft } from './musicVideoReviewDraft.js';
import { finishedOutsideCovers } from './musicVideoFinishedOutside.js';

// The six steps (Song, Look, Storyboard, Make, Final render, Publish); Make (`produce`) absorbed Compose.
const STAGE_IDS = ['setup', 'cast-sets', 'board', 'produce', 'review', 'publish'];
const RESUMABLE_RUN_STATUSES = new Set(['running', 'stopped', 'limit-reached', 'blocked', 'needs-replan']);
const FOOTAGE_OPTIONAL_MODES = new Set(['code', 'document', 'eidoverse']);

const nonEmptyString = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const imageSrc = (assetId) => (/^(https?:|data:|blob:)/i.test(assetId) || assetId.startsWith('/') ? assetId : `/data/images/${assetId}`);
const imageFallback = (assetId) => (assetId.includes('.') ? null : `/data/images/${assetId}.png`);

const currentRun = (project) => {
  const runs = Array.isArray(project.productionRuns) ? project.productionRuns : [];
  return runs.find((r) => RESUMABLE_RUN_STATUSES.has(r.status)) || runs[runs.length - 1] || null;
};

function projectSpend(project, run) {
  const runs = Array.isArray(project.productionRuns) ? project.productionRuns : [];
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const autopilot = runs.reduce((sum, r) => sum + num(r?.usage?.spentUsd), 0);
  let manual = 0;
  let autoReview = 0;
  for (const scene of Array.isArray(project.scenes) ? project.scenes : []) {
    for (const take of Array.isArray(scene?.takes) ? scene.takes : []) {
      if (take?.spendKind === 'autoReview') autoReview += num(take.costUsd);
      else if (take?.spendKind === 'manual') manual += num(take.costUsd);
    }
  }
  const spentUsd = autopilot + manual + autoReview;
  const capUsd = run?.limits?.spendCapUsd ?? project.automation?.budgetUsd ?? null;
  return { spentUsd, capUsd, autopilot, manual, autoReview, total: spentUsd };
}

function composeDone(project, mode) {
  const composition = project.composition || {};
  if (mode === 'composed') return (composition.textCues || []).length > 0;
  if (mode === 'document') return Boolean(composition.document);
  if (mode === 'eidoverse') return Boolean(composition.eidoverseScene?.inlineScript);
  if (mode === 'code') return Boolean(composition.codeVideo?.generatedAt || (composition.codeVideo?.sections || []).length > 0);
  return true;
}

// Song is done once its lyrics are in and their timing verified, or the song
// is an explicit instrumental — mirrors the client's lyricSetupState.
function lyricsReady(project, readiness) {
  const draft = project.productionReview?.draft || {};
  const instrumental = draft.lyricsMode === 'instrumental';
  const lines = (project.lyricCues || []).filter((cue) => nonEmptyString(cue?.text)).length;
  const alignment = readiness?.alignment?.status || (instrumental ? 'instrumental' : draft.timingStatus === 'verified' ? 'verified' : 'provisional');
  const verified = alignment === 'verified' || alignment === 'instrumental';
  return Boolean(readiness?.storyboard?.approved) || ((instrumental || lines > 0) && verified);
}

// The first step not yet done; a live production run pins Make.
function currentStage(project, readiness, run) {
  if (run && RESUMABLE_RUN_STATUSES.has(run.status)) return 'produce';
  const scenes = project.scenes || [];
  const mode = project.composition?.mode || 'concat';
  const layered = isLayeredComposition(project);
  const planned = Boolean(readiness?.storyboard?.approved);
  const proofApproved = Boolean(readiness?.proof?.approved);
  const footageReady = FOOTAGE_OPTIONAL_MODES.has(mode) || scenes.every((scene) => sceneRenderReady(scene, { layered }));
  const done = {
    setup: Boolean(project.trackId || project.uploadedAudioFilename) && Boolean(project.audioAnalysis) && lyricsReady(project, readiness),
    'cast-sets': Boolean(readiness?.art?.approved),
    board: planned,
    // Make needs footage, the composition over it and the proof that closes both (#10140) — mirrors the client's deriveStages.
    produce: planned && footageReady && composeDone(project, mode) && proofApproved,
    // A render made before later scene edits no longer counts as the final video — mirrors the client's isFinalRenderStale.
    review: Boolean(project.renderHistoryId) && project.renderDependencyState?.status !== 'stale',
    publish: Object.keys(project.publishKit?.posts || {}).length > 0,
  };
  // Finished outside PortOS — mirrors the client's deriveStages.
  return STAGE_IDS.find((id) => !done[id] && !finishedOutsideCovers(project, id)) || 'publish';
}

function projectPreview(project) {
  const finalId = nonEmptyString(project.renderHistoryId);
  const video = (jobId, label, src = `/data/videos/${jobId}.mp4`) => ({
    kind: 'video', jobId, src, poster: jobId ? `/data/video-thumbnails/${jobId}.jpg` : null, label,
  });
  if (finalId) return { ...video(finalId, project.renderDependencyState?.status === 'stale' ? 'Previous final' : 'Final video'), source: 'final',
    ...(project.renderDependencyState?.status === 'stale' ? { stale: true } : {}) };

  const draft = latestMusicVideoReviewDraft(project);
  if (draft) return draft;

  const excerpts = Array.isArray(project.excerpts) ? project.excerpts : [];
  const excerpt = [...excerpts].reverse().find((e) => e.status === 'complete' && (e.filename || e.jobId));
  if (excerpt) {
    const jobId = nonEmptyString(excerpt.jobId);
    const filename = nonEmptyString(excerpt.filename);
    return video(jobId, excerpt.label || 'Latest excerpt', filename ? `/data/videos/${filename}` : (jobId ? `/data/videos/${jobId}.mp4` : null));
  }

  const scenes = Array.isArray(project.scenes) ? project.scenes : [];
  for (let i = scenes.length - 1; i >= 0; i -= 1) {
    const jobId = nonEmptyString(scenes[i]?.videoHistoryId);
    if (jobId) return video(jobId, `Scene ${i + 1} clip`);
  }
  for (let i = scenes.length - 1; i >= 0; i -= 1) {
    const frameId = nonEmptyString(scenes[i]?.referenceImageId);
    if (frameId) return { kind: 'image', src: imageSrc(frameId), fallbackSrc: imageFallback(frameId), label: `Scene ${i + 1} frame` };
  }
  const reference = project.visualSpec?.references?.[0];
  const refId = nonEmptyString(reference?.imageId);
  if (refId) return { kind: 'image', src: imageSrc(refId), fallbackSrc: imageFallback(refId), label: reference.label || 'Style reference' };
  return { kind: 'none', label: 'No render yet' };
}

function shotSummary(project) {
  const draft = project.productionReview?.draft;
  const document = project.composition?.mode === 'document' && draft?.storyboardSource === 'document';
  const count = (document ? draft.storyboard : project.scenes)?.length || 0;
  return `${count} ${document ? 'document shot' : 'scene'}${count === 1 ? '' : 's'}`;
}

/** Newest created first, then newest updated — the order the index and picker show. */
export function compareMusicVideoProjectsNewestFirst(a, b) {
  const created = (Date.parse(b?.createdAt || b?.updatedAt) || 0) - (Date.parse(a?.createdAt || a?.updatedAt) || 0);
  return created || (Date.parse(b?.updatedAt) || 0) - (Date.parse(a?.updatedAt) || 0);
}

/**
 * Bounded projection of one project. `readiness` is the server's
 * `productionReadiness(project)` (approvals decide the stage, and only the
 * server computes them). Nested objects keep the shape of the full record so
 * the project card reads a summary and a full project the same way.
 */
export function summarizeMusicVideoProject(project, readiness) {
  const run = currentRun(project);
  const scenes = Array.isArray(project.scenes) ? project.scenes : [];
  const preview = projectPreview(project);
  const video = project.videoSettings || {};
  const concept = project.concept || {};
  return {
    id: project.id,
    name: project.name,
    version: project.version || 1,
    rootProjectId: project.rootProjectId || project.id,
    versionRoot: project.rootProjectId || project.id,
    parentProjectId: project.parentProjectId || null,
    mode: project.mode || 'director',
    status: project.status || 'draft',
    stage: currentStage(project, readiness, run),
    runStatus: project.autonomousRun?.status || run?.status || null,
    runInterrupted: Boolean(project.autonomousRun?.interrupted || project.castAndSets?.interrupted || run?.interrupted),
    runAwaiting: project.autonomousRun?.status === 'awaiting-approval',
    // 'schedule' when the Autonomous run task started it — the Schedule card names the project it is parked on (#10156).
    runOrigin: project.autonomousRun?.brief?.origin?.kind || null,
    poster: preview.poster || (preview.kind === 'image' ? preview.src : null),
    preview,
    spend: projectSpend(project, run),
    shotSummary: shotSummary(project),
    sceneCount: scenes.length,
    clipCount: scenes.filter((s) => s.videoHistoryId).length,
    frameCount: scenes.filter((s) => s.referenceImageId).length,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    trackId: project.trackId || null,
    uploadedAudioFilename: project.uploadedAudioFilename || null,
    audioAnalysis: project.audioAnalysis?.bpm ? { bpm: project.audioAnalysis.bpm } : null,
    videoSettings: {
      backend: video.backend, modelId: video.modelId, generationMode: video.generationMode, audioReactiveLora: video.audioReactiveLora,
    },
    vocalStemFilename: project.vocalStemFilename || null,
    midiTranscription: Boolean(project.midiTranscription),
    composition: { mode: project.composition?.mode },
    concept: { style: concept.style || concept.prompt || null, universeId: concept.universeId || null },
    visualSpec: { palette: Array.isArray(project.visualSpec?.palette) ? project.visualSpec.palette.slice(0, 5) : [] },
  };
}
