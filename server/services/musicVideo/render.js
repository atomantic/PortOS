import { maintenance } from '../../lib/maintenanceAdmission.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { assertMusicVideoMediaSelections } from '../../lib/musicVideoMediaPolicy.js';
import { assertProductionApproval, clipLocks, nameShots, productionReviewBasis } from './productionReview.js';
import { musicVideoGradeFilter } from '../../lib/musicVideoGrade.js';
/**
 * Music Video — render pipeline (#1760, Phase 2).
 *
 * Assembles a project's per-scene i2v clips (each a `videoHistoryId` entry the
 * scene-video hook filed) into a single MP4 laid under the project's source
 * track as the **master audio bed** — the music video's defining shape: one
 * music track under all clips, the per-clip generated audio dropped. Mirrors
 * videoTimeline's SSE render runner (job map, ffmpeg `-progress` parsing, the
 * shared sseUtils broadcast), but its ffmpeg graph concats video-only and maps
 * one external audio input as the sole output audio, ended on `-shortest` so the
 * render runs only as long as the shorter of (video, track).
 *
 * Beat-snap: when the project carries a cached beat analysis, each cut is
 * trimmed back to the nearest beat (never extended — a clip can't grow), so
 * cuts land on the music. With no analysis the clips render at their natural
 * length. A scene the director has explicitly arranged on the beat-quantized
 * timeline (#1854 — `startSec`/`endSec`/`beatAligned` saved via drag-snap in
 * the client) skips this live re-derivation entirely: its saved boundaries
 * are honored exactly, so the render matches what was shown on the timeline
 * rather than whatever the current beat grid would produce.
 */

import { spawn } from '../../lib/childProcess.js';
import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { BT709_CONTAINER_ARGS, H264_ENCODE_ARGS, findFfmpeg, safeUnder, generateThumbnail, probeVideoDuration, probeVideoGeometry } from '../../lib/ffmpeg.js';
import { filterGraphViaFile } from '../../lib/ffmpegFilterGraph.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { cancelMusicVideoRenderJob, isMusicVideoRenderCanceled } from './renderCancellation.js';
import { attachFfmpegRenderGuard } from '../../lib/ffmpegRenderGuard.js';
import { loadHistory, mutateVideoHistory } from '../videoGen/local.js';
import { getTrack } from '../tracks/index.js';
import { getProject, listProjects, updateProject, mutateProjectRecord } from './projects.js';
import { requireProject } from './requireProject.js';
import { applyProjectPatch } from './projectsLogic.js';
import { COVERAGE_TOLERANCE_SEC, MUSIC_VIDEO_FRAME_FITS, STILL_PAN_TRAVEL, STILL_PUSH_ZOOM, clipLoops, clipNeedsMoreFootage, clipPlaybackWindow, clipReversed, isSelfDrawnLayer, sceneHasAuthoredSpan, sceneVisualLayer } from '../../lib/musicVideoLayers.js';
import { musicVideoAspect, musicVideoRenderCanvas } from '../../lib/musicVideoAspect.js';
import { encodeCodeComposition, prepareCodeRender, writeCodeProofSheet } from './codeRender.js';
import { documentRenderInitScripts, encodeDocumentComposition, prepareDocumentRender, sweepDocumentScratch } from './documentRender.js';
import { sweepCompositionScratch } from './compositionRender.js';
import { applyFilmLookFinish, filmLookFinishNeeded } from './filmLookFinish.js';
import { appendStatsOutro, sweepStatsOutroScratch } from './statsOutro.js';
import { endingSeconds } from '../../lib/musicVideoEnding.js';
import { coldOpenPlan, coldOpenScenes, withSongScenesOnly } from '../../lib/musicVideoColdOpen.js';
import { selectedPerformanceInstruction } from '../../lib/musicVideoShotTiming.js';
import { captureMusicVideoEvidence, musicVideoTakeChanges } from '../../lib/musicVideoDependencies.js';
import { assertCurrentPerformanceTakes, withDraftPerformanceFallbacks } from './performanceShot.js';
import { ensureInstanceId } from '../instanceIdentity.js';
import { AUDIO_NORM, buildAudioBedMix } from '../videoTimeline/audioBedMix.js';
import { musicVideoEvents } from './events.js';
import { projectSoundBed } from './soundBed.js';
import { intercutClips } from './intercut.js';
import { applyFrameHold, projectFrameHold } from './frameHold.js';
import { rendersIntercut, usesLoudTierEverywhere } from '../../lib/musicVideoProductionMedium.js';
import { cutEffectCuts, plannedTransitions, sceneCutEffect } from '../../lib/musicVideoCutEffects.js';
import { imageEffectGlitchFrames, mergeGlitchFrames, musicVideoTransitionFilter, sceneTransitions, shotGlitchFrames, transitionGlitchFrames } from '../../lib/musicVideoTransitions.js';
import { stillMoveForCamera } from '../../lib/cameraMovements.js';
import { isEndFrameImageEffect, musicVideoImageEffectFilter, photoSequenceArrivals, sceneImageEffect, scenePhotoSequence } from '../../lib/musicVideoImageEffects.js';
import { trackedRenderMap } from '../renderActivity.js';

// Per-project render mutex (keyed by projectId so two projects can render in
// parallel; same-project re-entry returns 409 with the live jobId for re-attach).
const jobs = new Map();
const projectRenders = trackedRenderMap('music-video-final', { noun: 'music video render', link: (key) => `/music-video/${encodeURIComponent(key)}` });
// Reserved synchronously the instant a render is accepted, BEFORE the async
// prep (ffmpeg/audio/clip resolution) — so a double-click or second client
// can't pass the 409 check during that await window and spawn a duplicate.
const PENDING = Symbol('mv-render-pending');

// Append a finalized render to the shared video-history file. The per-project
// mutex above deliberately lets two DIFFERENT projects render (and finalize) in
// parallel, and this renderer bypasses the mediaJobQueue GPU lane that serializes
// the normal video-gen pipeline — so its append MUST share the ONE per-file
// serialization tail (`mutateVideoHistory` in videoGen/history.js) with every
// other writer of data/video-history.json (the video-gen finalizer, full-video
// downloads, stitch/upscale, timeline saves). A private second tail here would
// re-open the race against those other writers and drop an entry, leaving a
// "View rendered music video" deep link pointing at a 404. mutateVideoHistory
// keeps the lane alive if one append throws.
const appendToVideoHistory = (meta) =>
  mutateVideoHistory((history) => { history.unshift(meta); return history; });

// #9010: an in-flight render mark (`status: 'rendering'` on a project, or on
// one of its draft excerpts) names the instance running it in `renderingOn`.
// Project records federate between a user's machines, so a booting machine
// must only treat ITS OWN marks as crashed jobs — a peer's mark describes a
// render that may still be running there. A legacy mark with no stamp predates
// the field and is recovered as before.
export const isLocalRenderMark = (renderingOn, instanceId) => !renderingOn || renderingOn === instanceId;

// Every terminal project write clears the in-flight mark's stamp and the
// partial-output pointer alongside the status.
// A settled render carries no error unless `extra` names one: a finished render
// never keeps the message of an earlier attempt.
const settledRender = (status, extra = {}) => ({ status, renderError: null, ...extra, renderingOn: null, renderPartialFilename: null, renderResume: null });

// Tell listeners (the autonomous run waiting on its final render) that a render
// job reached a terminal state. Emitted after the project record's terminal
// write, with the outcome read off the job the caller already settled.
const emitRenderSettled = (projectId, job) => musicVideoEvents.emit('render', {
  projectId, jobId: job.id,
  status: job.status === 'complete' ? 'completed' : job.status === 'canceled' ? 'canceled' : 'failed',
  error: job.lastError || null,
});

export const attachRenderSseClient = (jobId, res) => attachSse(jobs, jobId, res);

const round3 = (n) => Math.round(n * 1000) / 1000;
// #8977: a performance take is placed by the immutable shot instruction it was
// generated with — its footage starts `edit.inSec` into the clip (the audio
// window was padded to the provider minimum) and ends at `edit.outSec`. It
// never loops: repeating a sung take would desync the mouth from the song.
const performanceEdit = (scene) => selectedPerformanceInstruction(scene)?.edit ?? null;
// A shot's switched-on cut effect for its clip (else the one its storyboard row plans), or nothing.
const cutEffectOf = (scene, planned) => {
  const effect = sceneCutEffect(scene, planned.get(scene.sceneId));
  return effect?.enabled ? { cutEffect: effect } : {};
};

const COVERAGE_RESOLUTIONS = Object.freeze(['hold', 'trim', 'continue', 'replace', 'loop']);

/**
 * Pure: the snapped clips whose authored span needs more footage than their
 * non-looping source clip provides (one set to hold its last frame is covered). Returns
 * `[{ sceneId, spanSec, clipSec, shortBySec }]` (empty when every shot is covered).
 */
function findCoverageShortfalls(clips, { toleranceSec = COVERAGE_TOLERANCE_SEC } = {}) {
  const out = [];
  for (const clip of Array.isArray(clips) ? clips : []) {
    if (clip.layer) continue;
    const spanSec = clip.outSec - clip.inSec;
    const clipSec = clip.sourceSec ?? clip.duration;
    if (clipNeedsMoreFootage({ loop: clip.loop, holdLastFrame: clip.holdLastFrame, spanSec, clipSec }, toleranceSec)) {
      const round = (n) => Math.round(n * 100) / 100;
      out.push({ sceneId: clip.sceneId, spanSec: round(spanSec), clipSec: round(clipSec), shortBySec: round(spanSec - clipSec) });
    }
  }
  return out;
}

function releaseProjectRender(projectId) {
  if (projectRenders.delete(projectId)) musicVideoEvents.emit('render-cleanup-idle', { projectId });
}

// Preparation also owns the slot before a public job ID exists.
export const isProjectRenderActive = (projectId) => projectRenders.has(projectId);

/**
 * The project's live final-render job on THIS instance, or null — a render
 * still preparing (no job id yet) or running on another machine reports null.
 * Read-only: lets a reloaded page re-attach to the render's progress stream
 * without POSTing /render, which would START one when none is live (#9940).
 */
export function getActiveRenderJobId(projectId) {
  const existing = projectRenders.get(projectId);
  return existing && existing !== PENDING && jobs.has(existing) ? existing : null;
}

export function getRenderJobStatus(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  return { status: job.status, error: job.lastError };
}

export function cancelRender(jobId) {
  return cancelMusicVideoRenderJob(jobs.get(jobId), { label: 'music-video render' });
}

// Resolve the project's source audio to a verified path under data/music/.
// Mirrors the route's resolveAudioPath (track or uploaded file, safe basename).
export async function resolveMasterAudioPath(project) {
  let filename = null;
  if (project.trackId) {
    const track = await getTrack(project.trackId);
    if (!track) throw new ServerError('Linked track not found', { status: 404, code: 'NOT_FOUND' });
    filename = track.audioFilename;
  } else if (project.uploadedAudioFilename) {
    filename = project.uploadedAudioFilename;
  }
  if (!filename) {
    throw new ServerError('Project has no audio — set a track or upload audio first', { status: 400, code: 'NO_AUDIO' });
  }
  const safe = safeUnder(PATHS.music, filename);
  if (!safe || !existsSync(safe)) {
    throw new ServerError('Project audio file is missing', { status: 404, code: 'AUDIO_MISSING' });
  }
  return safe;
}

// #8988: resolve the project's explicitly chosen sound-design bed (a
// music-library track) to a verified path under data/music/, or null when the
// song is the sole audio master (the default).
export async function resolveSoundBedPath(project) {
  const bed = projectSoundBed(project);
  // A (synced) record naming the song itself as its bed mixes nothing.
  if (!bed || bed.trackId === project.trackId) return null;
  const track = await getTrack(bed.trackId);
  const safe = track?.audioFilename ? safeUnder(PATHS.music, track.audioFilename) : null;
  if (!safe || !existsSync(safe)) {
    throw new ServerError('The sound-design bed track is missing — choose another bed or clear it', { status: 404, code: 'SOUND_BED_MISSING' });
  }
  return { path: safe, volume: bed.volume };
}

// A still/card section has no source clip to measure, so its authored span IS
// its length. Null when the scene is not timed.
const authoredSpan = (scene) => (sceneHasAuthoredSpan(scene) ? round3(scene.endSec - scene.startSec) : null);

// A composed render's non-footage section — a still, a card or a code shot —
// or the problem that keeps it out of the render: `untimed` (no authored span
// to take a length from) or `missing-still` (the selected reference frame is gone).
function sectionClip(scene, layer, planned, { layered }) {
  const spanSec = authoredSpan(scene);
  if (spanSec == null) return { problem: 'untimed' };
  const section = { sceneId: scene.sceneId, layer, inSec: 0, outSec: spanSec, duration: spanSec, sourceSec: spanSec, ...sceneTransitions(scene), ...cutEffectOf(scene, planned) };
  // A composed render has no code to run: a code shot (#10297) is a black
  // ground the typography layer draws over, cut exactly like a blank card.
  if (layer === 'code') return { clip: { ...section, layer: 'card', cardText: '', cardColor: '#000000' } };
  if (layer === 'card') {
    // A blank card falls back to the shot's own line, so a silence card is not left black.
    const cardText = [scene.cardText, scene.lyricText].find((t) => typeof t === 'string' && t.trim())?.trim() || '';
    return { clip: { ...section, cardText, cardColor: /^#[0-9a-f]{6}$/i.test(scene.cardColor || '') ? scene.cardColor : '#000000' } };
  }
  return stillClip(scene, section, { layered });
}

function stillClip(scene, section, { layered }) {
  const sequence = layered && scenePhotoSequence(scene);
  const photoPaths = sequence ? sequence.imageIds.map(id => safeUnder(PATHS.images, id)) : null;
  if (sequence && (!photoPaths.length || photoPaths.some(path => !path || !existsSync(path)))) {
    throw new ServerError('A selected sequence photo is missing. Pick the missing photos before rendering.', {
      status: 404, code: 'MISSING_SEQUENCE_PHOTOS', context: { sceneId: scene.sceneId,
        imageIds: sequence.imageIds.filter((id, i) => !photoPaths[i] || !existsSync(photoPaths[i])) },
    });
  }
  const imagePath = photoPaths?.[0] || (scene.referenceImageId ? safeUnder(PATHS.images, scene.referenceImageId) : null);
  if (!imagePath || !existsSync(imagePath)) return { problem: 'missing-still' };
  // The shot's Move plays as set; a planned camera move (#10589) only seeds it when the shot is made.
  // An image effect (a camera flash that develops, musicVideoImageEffects.js) plays over the still.
  // An end-frame effect also reads the shot's end frame; without it on disk the still plays alone.
  const effect = sceneImageEffect(scene, { layered });
  const endImagePath = effect && isEndFrameImageEffect(effect.effect) ? safeUnder(PATHS.images, scene.endImageId) : null;
  const playable = effect && (!isEndFrameImageEffect(effect.effect) || (endImagePath && existsSync(endImagePath)));
  return { clip: { ...section, imagePath, move: scene.stillMove || stillMoveForCamera(scene.camera) || 'hold',
    ...(sequence ? { photoPaths, photoSequence: scene.photoSequence, photoStartSec: scene.startSec, photoEndSec: scene.endSec } : {}),
    ...(playable ? { effect, ...(endImagePath ? { endImagePath } : {}) } : {}) } };
}

// A footage shot's verified clip: the history entry's own frame count and
// dimensions, or the file's when a hosted render (Grok/fal/reactor) recorded
// none (#8977). Null when the clip file is missing or unreadable, or has no
// usable length or dimensions — a dimensionless entry would make
// buildMusicVideoFfmpegArgs emit `scale=undefined:undefined` (opaque ffmpeg
// failure), so it is reported as a missing clip like the duration guard.
async function footageGeometry(entry) {
  const videoPath = entry && entry.filename ? safeUnder(PATHS.videos, entry.filename) : null;
  if (!entry || !videoPath || !existsSync(videoPath)) return null;
  const measured = entry.numFrames && entry.fps && entry.width && entry.height
    ? entry
    : { ...entry, ...(await probeVideoGeometry(videoPath)) };
  const duration = measured.numFrames && measured.fps ? measured.numFrames / measured.fps : null;
  if (!duration || duration <= 0) return null;
  if (!measured.width || measured.width <= 0 || !measured.height || measured.height <= 0) return null;
  return { videoPath, width: measured.width, height: measured.height, fps: measured.fps || 24, duration };
}

// A footage shot's render clip, or `missing-clip` when its selected take cannot be read.
async function footageClip(scene, entry, planned) {
  const geometry = await footageGeometry(entry);
  if (!geometry) return { problem: 'missing-clip' };
  const edit = performanceEdit(scene);
  const { rate, leadSec, inSec, outSec, sourceSec } = clipPlaybackWindow(scene, edit, geometry.duration);
  return { clip: {
    sceneId: scene.sceneId,
    videoPath: geometry.videoPath,
    width: geometry.width,
    height: geometry.height,
    fps: geometry.fps,
    duration: outSec - inSec,
    // The playable source length survives the beat snap (which rewrites
    // `duration` to the rendered span) so coverage can be judged against it.
    sourceSec,
    // A reversed clip is read once, backwards, and holds its last frame rather than looping.
    loop: clipLoops(scene, edit),
    ...(clipReversed(scene) ? { reverse: true } : {}),
    // The director chose to hold the last frame over a shot longer than its clip.
    ...(scene.holdLastFrame === true ? { holdLastFrame: true } : {}),
    ...(rate !== 1 ? { rate } : {}),
    ...(leadSec > 0 ? { leadSec } : {}),
    inSec,
    outSec,
    ...footageFrameFit(scene),
    // VHS glitches on its cuts (musicVideoTransitions.js) ride over the edit without moving it.
    ...sceneTransitions(scene),
    // So does a beat toggle on its cut out (musicVideoCutEffects.js).
    ...cutEffectOf(scene, planned),
  } };
}

// Resolve every scene that has a generated i2v clip (`videoHistoryId`) to a
// verified on-disk path + dims, in scene order. Scenes without a clip yet are
// skipped (not an error — they're just not rendered). A scene whose clip id
// references a missing history entry/file IS an error (404, listed).
//
// `layered` (a composed render, #8985) also resolves still and card sections
// in scene order. Neither needs footage: a still needs its selected reference
// frame (404 MISSING_STILLS when it is gone), and both need an authored span
// (422 UNTIMED_SECTIONS), since there is no clip to take a length from.
export async function resolveSceneClips(project, { layered = false, stillForMissingClip = false } = {}) {
  // A draft shows a footage shot that has no clip yet as its still (layered renders only).
  const standIn = (s) => stillForMissingClip && layered && !s.videoHistoryId && s.referenceImageId && sceneVisualLayer(s, { layered }) === 'footage';
  const scenes = (Array.isArray(project.scenes) ? project.scenes : [])
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .filter((s) => s && (s.videoHistoryId || sceneVisualLayer(s, { layered }) !== 'footage' || standIn(s)));
  if (scenes.length === 0) {
    throw new ServerError('No scene videos to render — generate at least one scene clip first', {
      status: 400, code: 'NO_SCENE_CLIPS',
    });
  }
  const planned = plannedTransitions(project.productionReview?.draft?.storyboard);
  const history = scenes.some((s) => sceneVisualLayer(s, { layered }) === 'footage') ? await loadHistory() : [];
  const historyMap = new Map((Array.isArray(history) ? history : []).map((h) => [h.id, h]));
  const problems = { 'missing-clip': [], 'missing-still': [], untimed: [] };
  const clips = [];
  for (const scene of scenes) {
    const layer = standIn(scene) ? 'still' : sceneVisualLayer(scene, { layered });
    const { clip, problem } = layer === 'footage'
      ? await footageClip(scene, historyMap.get(scene.videoHistoryId), planned)
      : sectionClip(scene, layer, planned, { layered });
    if (clip) clips.push(clip);
    else problems[problem].push(scene);
  }
  const missingShots = problems['missing-clip'];
  if (missingShots.length > 0) {
    const one = missingShots.length === 1;
    throw new ServerError(`${nameShots(project, missingShots.map((s) => s.sceneId))}: the selected clip file ${one ? 'is' : 'are'} missing or unreadable. Pick another take or render a new one`, {
      status: 404, code: 'MISSING_CLIPS', context: { missingClipIds: missingShots.map((s) => s.videoHistoryId) },
    });
  }
  if (problems['missing-still'].length > 0) {
    const sceneIds = problems['missing-still'].map((s) => s.sceneId);
    throw new ServerError(`${nameShots(project, sceneIds)}: no still frame to show. Generate or pick one first`, {
      status: 404, code: 'MISSING_STILLS', context: { sceneIds },
    });
  }
  if (problems.untimed.length > 0) {
    const sceneIds = problems.untimed.map((s) => s.sceneId);
    throw new ServerError(`${nameShots(project, sceneIds)}: give ${sceneIds.length === 1 ? 'this still or card' : 'these stills or cards'} a start and end time`, {
      status: 422, code: 'UNTIMED_SECTIONS', context: { sceneIds },
    });
  }
  return clips;
}

// Pure: trim each clip's out-point so its cumulative cut lands on the nearest
// analyzed beat, when one is within `toleranceSec` and the trim keeps the clip
// at least `minClipSec` long. This derived, non-authored snap only SHORTENS a
// source clip. A director-authored beatAligned span is handled separately
// below and may exceed the native clip: a looping scene fills it by repeating
// the clip, a non-looping one is caught by findCoverageShortfalls (#8964).
// Returns a NEW clips array with adjusted `outSec`/`duration`.
// With no beats (no analysis) and no persisted scene arrangement, clips are
// returned unchanged.
//
// `scenes` (optional) is the project's scene list — when a clip's matching
// scene has planner section provenance or `beatAligned: true` and valid
// `startSec`/`endSec` (persisted by
// the BeatTimeline drag-snap arranger, #1854), that scene's saved duration is
// honored EXACTLY instead of being re-derived from the live beat grid: the
// director already snapped and saved it, so the render shouldn't silently
// recompute a different cut from whatever the grid says today. The ffmpeg
// builder loops finite source clips, so a saved music-video span may exceed a
// clip's native duration; it is still floored to `minClipSec`. The running
// cursor advances by the honored duration so any later, non-aligned clips keep
// snapping against the correct cumulative position.
export function beatSnapClips(clips, beats, { toleranceSec = 0.12, minClipSec = 0.4, scenes = null } = {}) {
  const grid = Array.isArray(beats) ? beats.filter((b) => typeof b === 'number' && b >= 0).sort((a, b) => a - b) : [];
  const scenesById = Array.isArray(scenes) ? new Map(scenes.map((s) => [s.sceneId, s])) : null;
  if (grid.length === 0 && !scenesById) return clips.map((c) => ({ ...c }));
  let running = 0;
  return clips.map((clip) => {
    // A still/card section (#8985) is exactly its authored span.
    if (clip.layer) {
      running += clip.duration;
      return { ...clip };
    }
    const scene = scenesById?.get(clip.sceneId);
    // A planned shot keeps its bounded span even when a sparse grid cannot
    // supply an on-beat cut. Beat alignment describes the cut, not ownership
    // of its timing. Section provenance is cleared when the audio changes.
    const planned = Number.isInteger(scene?.sectionIndex) && scene.sectionIndex >= 0;
    // A measured word-gap repair owns its edit boundary independently of beats.
    if ((scene?.beatAligned || planned || selectedPerformanceInstruction(scene)?.repair) && sceneHasAuthoredSpan(scene)) {
      // Keep the resolved playback in-point, including performance edits and
      // hand-set clip offsets; only the authored output span changes here.
      // A looping input may repeat to fill a span longer than its source.
      // Insufficient coverage for a non-looping shot is refused before render
      // (#8964), using the preserved playable duration in sourceSec.
      const inSec = clip.inSec || 0;
      const spanSec = Math.max(minClipSec, scene.endSec - scene.startSec);
      running += spanSec;
      return { ...clip, inSec, outSec: inSec + spanSec, duration: spanSec };
    }
    if (grid.length === 0) {
      running += clip.duration;
      return { ...clip };
    }
    const naturalEnd = running + clip.duration;
    // Nearest beat at or before the natural end (snap trims, never extends).
    let best = null;
    for (const beat of grid) {
      if (beat > naturalEnd) break;
      best = beat;
    }
    const inSec = clip.inSec || 0;
    let outSec = clip.outSec;
    if (best != null
      && (naturalEnd - best) <= toleranceSec
      && (best - running) >= minClipSec) {
      outSec = inSec + (best - running); // trim relative to the clip's in-point
      running = best;
    } else {
      running = naturalEnd;
    }
    return { ...clip, inSec, outSec, duration: outSec - inSec };
  });
}

// How a clip whose shape is not the video's fills the frame: zoomed
// to fill (the default), or kept whole with its side gaps covered by the shot's
// still, a VHS-style blur of the clip, or black. The still edge needs the
// still on disk; without it the gaps fall back to black.
function footageFrameFit(scene) {
  const fit = MUSIC_VIDEO_FRAME_FITS.includes(scene.frameFit) ? scene.frameFit : 'fill';
  if (fit !== 'still') return { frameFit: fit };
  const stillPath = scene.referenceImageId ? safeUnder(PATHS.images, scene.referenceImageId) : null;
  return stillPath && existsSync(stillPath) ? { frameFit: 'still', stillPath } : { frameFit: 'black' };
}

// The frame for a composed render with no footage to take dimensions from.
const DEFAULT_CANVAS = Object.freeze({ width: 1280, height: 720, fps: 24 });
const evenPx = (n) => Math.max(2, Math.round(n / 2) * 2);

// One overlay per photo arrival is the exact stacking order; past this many in
// one rendered section the graph is refused rather than thinned.
const PHOTO_STACK_RENDER_LIMIT = 240;

// #14277: a stacked photo sequence. Every arrival visible in this section is
// overlaid in sequence order onto a black ground at the still's cover size, then
// the shot's Move plays over the composed picture as it does over one still.
// A laid-out photo is fitted whole, scaled, faded and turned about its centre;
// a photo without a layout is cover-cropped like an ordinary still.
function stackedPhotoChain(c, inputRefs, sequence, { coverW, coverH, fps, frames, after }) {
  const id = inputRefs.clip;
  const inputs = [id, ...(inputRefs.photos || [])];
  const offset = Math.round((c.photoAtSec ?? c.effectAtSec ?? 0) * fps);
  // A preroll (incoming cut effect) starts before the shot; its frames clamp to the
  // shot's first frame, so the first photo shows there as it does in a plain sequence.
  const arrivals = photoSequenceArrivals(sequence, Math.max(0, offset), Math.max(1, offset + frames));
  if (arrivals.length > PHOTO_STACK_RENDER_LIMIT) {
    throw new ServerError(`This photo sequence overlaps ${arrivals.length} photo arrivals in one shot; the render supports ${PHOTO_STACK_RENDER_LIMIT}. Shorten the overlap, lengthen the interval or split the shot.`, {
      status: 422, code: 'PHOTO_STACK_TOO_DEEP', context: { sceneId: c.sceneId, arrivals: arrivals.length, limit: PHOTO_STACK_RENDER_LIMIT },
    });
  }
  const frame = `max(0,t*${fps}+${offset}+0.000001)`;
  const copies = new Map();
  for (const arrival of arrivals) copies.set(arrival.index, (copies.get(arrival.index) || 0) + 1);
  const parts = [...copies].map(([index, count]) => {
    const layout = sequence.layouts[index];
    const labels = Array.from({ length: count }, (_, n) => `[stk${id}p${index}_${n}]`).join('');
    if (!layout) return `[${inputs[index]}:v]fps=${fps},scale=${coverW}:${coverH}:force_original_aspect_ratio=increase,crop=${coverW}:${coverH},setsar=1,split=${count}${labels}`;
    const angle = Number((layout.rotation * Math.PI / 180).toFixed(6));
    return `[${inputs[index]}:v]fps=${fps},scale=${Math.max(2, Math.round(coverW * layout.scale))}:${Math.max(2, Math.round(coverH * layout.scale))}:force_original_aspect_ratio=decrease,setsar=1,format=rgba`
      + (layout.opacity < 1 ? `,colorchannelmixer=aa=${layout.opacity}` : '')
      + (angle ? `,rotate=${angle}:c=none:ow=rotw(${angle}):oh=roth(${angle})` : '')
      + `,split=${count}${labels}`;
  });
  parts.push(`color=c=black:s=${coverW}x${coverH}:r=${fps},setsar=1[stk${id}_0]`);
  const used = new Map();
  arrivals.forEach((arrival, k) => {
    const n = used.get(arrival.index) || 0;
    used.set(arrival.index, n + 1);
    const layout = sequence.layouts[arrival.index];
    const at = layout ? `x='(W-w)/2+${Number((layout.x * coverW).toFixed(3))}':y='(H-h)/2+${Number((layout.y * coverH).toFixed(3))}'` : 'x=0:y=0';
    const end = Number.isFinite(arrival.end) ? `*lt(${frame},${arrival.end})` : '';
    parts.push(`[stk${id}_${k}][stk${id}p${arrival.index}_${n}]overlay=${at}:enable='gte(${frame},${arrival.start})${end}'[stk${id}_${k + 1}]`);
  });
  return `${parts.join(';')};[stk${id}_${arrivals.length}]${after}`;
}

// One section's video chain (without its output label). A footage clip is
// fitted, letterboxed and trimmed; a still (#8985) is cover-cropped and moved
// deterministically (every frame is a pure function of its frame number); a
// card is a solid colour the typography layer writes its text over. On the
// frame grid every section is cut to an exact frame count. `inputRefs` names
// the allocated ffmpeg inputs: clip (null for a card), optional end or still.
function sectionChain(c, inputRefs, { canonW, canonH, fps, frames, frameGrid, beats = [] }) {
  // On the frame grid a footage in-point (a performance edit, an intercut
  // piece #9290) is a start frame; stills and cards always start at 0.
  const startFrame = !c.layer && c.inSec > 0 ? Math.round(c.inSec * fps) : 0;
  const trim = frameGrid
    ? (startFrame > 0 ? `trim=start_frame=${startFrame}:end_frame=${startFrame + frames}` : `trim=end_frame=${frames}`)
    : `trim=start=${c.inSec}:end=${c.outSec}`;
  if (c.layer === 'card') {
    return `color=c=0x${c.cardColor.slice(1)}:s=${canonW}x${canonH}:r=${fps},setsar=1,format=yuv420p,${trim},setpts=PTS-STARTPTS`;
  }
  if (c.layer === 'still') {
    const scale = c.move === 'push' ? 2 : c.move === 'pan' ? 1 + STILL_PAN_TRAVEL : 1;
    const coverW = evenPx(canonW * scale);
    const coverH = evenPx(canonH * scale);
    const move = c.move === 'push'
      // Rendered from a 2x cover so the slow zoom does not step pixel by pixel.
      ? `zoompan=z='1+${STILL_PUSH_ZOOM}*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${canonW}x${canonH}:fps=${fps},setsar=1,`
      : c.move === 'pan' ? `crop=${canonW}:${canonH}:x='(iw-ow)*n/${Math.max(1, frames - 1)}':y='(ih-oh)/2',` : '';
    // An end frame (an end-frame image effect) is fitted and moved exactly like the still.
    const fitted = (id) => `[${id}:v]fps=${fps},scale=${coverW}:${coverH}:force_original_aspect_ratio=increase,crop=${coverW}:${coverH},setsar=1,`
      + `${move}format=yuv420p,${trim},setpts=PTS-STARTPTS`;
    const id = inputRefs.clip;
    const end = inputRefs.end != null ? `${fitted(inputRefs.end)}[fxend${id}];` : '';
    const sequence = c.photoSequence
      ? scenePhotoSequence({ visualLayer: 'still', photoSequence: c.photoSequence, startSec: c.photoStartSec, endSec: c.photoEndSec }, { fps, beats })
      : null;
    let picture = sequence?.stacked
      ? stackedPhotoChain(c, inputRefs, sequence, { coverW, coverH, fps, frames, after: `${move}format=yuv420p,${trim},setpts=PTS-STARTPTS` })
      : fitted(id);
    if (inputRefs.photos?.length && !sequence?.stacked) {
      const frame = `max(0,t*${fps}+${Math.round((c.photoAtSec ?? c.effectAtSec ?? 0) * fps)}+0.000001)`;
      const step = sequence.switchFrames ? (sequence.switchFrames.map(f => `gte(${frame},${f})`).join('+') || '0') : `floor(${frame}/${sequence.intervalFrames})`;
      inputRefs.photos.forEach((photo, i) => {
        picture += `[seq${id}_${i}];${fitted(photo)}[photo${id}_${i}];[seq${id}_${i}][photo${id}_${i}]overlay=shortest=1:enable='eq(mod(${step},${sequence.imageIds.length}),${i + 1})'`;
      });
    }
    return end + picture
      + musicVideoImageEffectFilter(c.effect, { width: canonW, height: canonH, fps, key: id, atSec: c.effectAtSec || 0, end: end ? `fxend${id}` : null });
  }
  // A non-looping shot a hair longer than its source holds the last frame for
  // the remainder instead of ending early and drifting every later cut. On the
  // frame grid it also pads the rounding frame, so it always fills its count.
  const holdSec = c.loop === false ? (c.outSec - c.inSec) - (c.sourceSec ?? c.duration) : 0;
  const padSec = c.loop === false && frameGrid ? Math.max(0, holdSec) + 2 / fps : holdSec;
  const hold = padSec > 0 ? `tpad=stop_mode=clone:stop_duration=${round3(padSec)},` : '';
  // A hand-set speed retimes the clip and a negative offset holds its first frame, both before the trim.
  const speed = c.rate && c.rate !== 1 ? `setpts=(PTS-STARTPTS)/${Number(c.rate.toFixed(6))},` : '';
  const lead = c.leadSec > 0 ? `tpad=start_mode=clone:start_duration=${round3(c.leadSec)},` : '';
  // A reversed clip plays from its last frame, before any speed, offset or trim.
  const reverse = c.reverse ? 'reverse,setpts=PTS-STARTPTS,' : '';
  const timed = `${reverse}${speed}${lead}fps=${fps},${hold}${trim},setpts=PTS-STARTPTS`;
  const cover = `scale=${canonW}:${canonH}:force_original_aspect_ratio=increase,crop=${canonW}:${canonH},setsar=1`;
  const fit = `scale=${canonW}:${canonH}:force_original_aspect_ratio=decrease,setsar=1`;
  const centered = `overlay=(W-w)/2:(H-h)/2:shortest=1`;
  const id = inputRefs.clip;
  if (c.frameFit === 'fill') return `[${id}:v]${cover},${timed}`;
  // The shot's still, cover-fitted like a still section, fills the gaps beside the whole clip.
  if (c.frameFit === 'still' && inputRefs.still != null) {
    return `[${inputRefs.still}:v]fps=${fps},${cover}[edge${id}];[${id}:v]${fit},${timed}[clip${id}];[edge${id}][clip${id}]${centered}`;
  }
  // The clip itself, zoomed, blurred, faded and noisy with scanlines, like a worn tape behind it.
  if (c.frameFit === 'vhs') {
    return `[${id}:v]${fit},${timed},split[clip${id}][tape${id}];`
      + `[tape${id}]${cover},boxblur=lr=min(h\\,w)/20:lp=2:cr=min(ch\\,cw)/20:cp=2,eq=saturation=0.55:brightness=-0.12,noise=alls=24:allf=t+u,`
      + `drawgrid=w=iw:h=3:t=1:c=black@0.35[edge${id}];[edge${id}][clip${id}]${centered}`;
  }
  return `[${id}:v]${fit},pad=${canonW}:${canonH}:(ow-iw)/2:(oh-ih)/2,${timed}`;
}

// One plan section of a composed render as its own silent, video-only encode
// (shotSegments.js): the section's chain on the full film's timeline (cut
// effects borrowing the next shot, fades either side, its grade and glitches on
// absolute song frames, the typography windows over it), so the encoded frames
// are the ones the whole-film render draws there. `segment` is `{ index,
// maxFrames?, tagFilter? }`; `overlays` here are this window's captures, each
// with its absolute song `startSec`.
function buildSegmentArgs(segment, { plan, prerolls, addInput, sectionFilters, glitches, overlays, outputPath, grade, canonW, canonH, fps, sectionFrame, inputs, nextInput }) {
  const index = segment.index;
  if (!Number.isInteger(index) || !plan[index]) throw new Error(`buildMusicVideoFfmpegArgs: no section ${index}`);
  const { c, frames, startSec, endSec } = plan[index];
  const startFrame = sectionFrame(startSec);
  const own = addInput(c);
  const preroll = prerolls.find((p) => p.index === index);
  if (preroll) preroll.input = addInput(preroll.clip);
  const overlayBase = nextInput();
  for (const overlay of overlays) inputs.push('-itsoffset', String(round3(overlay.startSec - startSec)), '-i', overlay.path);
  const filters = sectionFilters(index, own, preroll, 'v0');
  const gradeFilter = musicVideoGradeFilter(grade, [{ sceneId: c.sceneId, startSec, endSec }], { fps, offsetSec: startSec });
  const local = glitches.filter((g) => g.frame >= startFrame && g.frame < startFrame + frames).map((g) => ({ ...g, frame: g.frame - startFrame }));
  const glitchFilter = musicVideoTransitionFilter(local, { width: canonW, height: canonH });
  const finishing = [gradeFilter, glitchFilter].filter(Boolean).join(',');
  let label = 'v0';
  if (finishing) { filters.push(`[v0]${finishing}[graded]`); label = 'graded'; }
  overlays.forEach((_, k) => {
    filters.push(`[${label}][${overlayBase + k}:v]overlay=eof_action=pass:format=auto[ov${k}]`);
    label = `ov${k}`;
  });
  // Every segment is tagged the way the composition encoder tags its own, so
  // shot segments, film-look passes and the outro join by stream copy.
  filters.push(`[${label}]format=yuv420p${segment.tagFilter ? `,${segment.tagFilter}` : ''}[outv]`);
  const outFrames = Number.isInteger(segment.maxFrames) ? Math.max(0, Math.min(frames, segment.maxFrames)) : frames;
  const args = [
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[outv]',
    '-frames:v', String(outFrames),
    '-r', String(fps),
    ...H264_ENCODE_ARGS,
    ...BT709_CONTAINER_ARGS,
    '-an',
    '-movflags', '+faststart',
    '-y',
    outputPath,
  ];
  // `shotId` is the shot whose span this section plays in: an intercut partner
  // piece or a hook card belongs to the shot it cuts into.
  return { args, sceneId: c.sceneId, shotId: c.intercutOf || c.cardOf || c.sceneId, layer: c.layer || 'footage', frames: outFrames, startFrame, startSec, endSec: (startFrame + outFrames) / fps, canonW, canonH, fps, sections: plan.length };
}

// Pure: build the ffmpeg args for the master-bed render. Concats the clips
// video-only (each scaled/padded to the canonical dims + fps and trimmed to its
// snapped out-point) and maps ONE external audio input as the sole output audio.
// `-shortest` ends the output at the shorter of (concatenated video, track).
// `overlays` (a composed render, #8984) are transparent typography clips, each
// offset to its song time and laid over the cut footage — the footage passes
// through untouched outside them, and the master audio is never re-cut.
//
// `frameGrid` (a composed render, #8985 — implied by any still/card section)
// cuts every section to a whole number of frames derived from its cumulative
// song-time boundary, so the edit never drifts more than half a frame from the
// authored timeline however many sections it has. Returns `sections`, each
// section's `[startSec, endSec)` on the output timebase.
//
// `excerpt` (#8986 — a draft excerpt render) windows the SAME full-song plan
// down to `[startSec, endSec)` with one extra filter stage after the cut/overlay
// chain is built: `trim`/`atrim` the finished `[outv]`/audio down to the window
// and re-zero their timestamps, so a footage cut and every overlay keep the
// exact absolute song-time alignment they'd have in a full render — only the
// output's first/last frame move. `sections` reports only the spans that
// overlap the window, clipped to it and re-based to the excerpt's own timeline
// (0 = `startSec`) so a contact sheet built from the excerpt file can sample
// cut boundaries directly. `totalDuration` becomes the excerpt's own length.
export function buildMusicVideoFfmpegArgs(clips, audioPath, outputPath, { audioDurationSec = null, overlays = [], frameGrid: gridOption = false, excerpt = null, soundBed = null, grade = null, aspect = null, beats = [], segment = null, canvas = null } = {}) {
  if (!Array.isArray(clips) || clips.length === 0) throw new Error('buildMusicVideoFfmpegArgs: empty clips');
  const frameGrid = gridOption || clips.some((c) => c.layer);
  // Stills and cards have no dimensions of their own: the first footage clip
  // sets the frame, or a default one when the render has no footage at all.
  // The project's aspect (when given) wins over a lead clip of another shape.
  // `canvas` ({ width, height, fps }) pins the frame outright: the cold open
  // is cut on the song's frame so the two join.
  const lead = clips.find((c) => !c.layer) || DEFAULT_CANVAS;
  const { width: canonW, height: canonH } = canvas || (aspect ? musicVideoRenderCanvas(aspect, lead) : lead);
  const fps = canvas?.fps || lead.fps || 24;

  let cursorSec = 0;
  let cursorFrame = 0;
  const plan = [];
  for (const c of clips) {
    const startSec = cursorSec;
    cursorSec += c.outSec - c.inSec;
    const endFrame = Math.round(cursorSec * fps);
    const frames = endFrame - cursorFrame;
    const section = frameGrid
      ? { c, frames, startSec: cursorFrame / fps, endSec: endFrame / fps }
      : { c, frames, startSec, endSec: cursorSec };
    cursorFrame = endFrame;
    // A section shorter than half a frame has no frame of its own on the grid.
    if (!frameGrid || frames > 0) plan.push(section);
  }
  if (plan.length === 0) throw new Error('buildMusicVideoFfmpegArgs: no section spans a frame');

  const inputs = [];
  const sectionInputs = [];
  // A generated scene clip is a reusable shot source, while the director's
  // timeline owns how long that shot appears in the music video. A LOOPING
  // clip input repeats so a 6–10s Grok/local result can fill a longer verse or
  // chorus span; the per-input trim below still makes every loop finite. A
  // non-looping clip (#8964, `loop: false`) is read once — the render preflight
  // guarantees its span fits, within COVERAGE_TOLERANCE_SEC. A still loops its
  // single image; a card needs no input (its colour is a filter source).
  let nextInput = 0;
  const addInput = (c) => {
    if (c.layer === 'card') return { clip: null };
    const clipInput = nextInput++;
    if (c.layer === 'still') {
      inputs.push('-loop', '1', '-framerate', String(fps), '-i', c.imagePath);
      const photos = (c.photoPaths || []).slice(1).map(path => {
        inputs.push('-loop', '1', '-framerate', String(fps), '-i', path);
        return nextInput++;
      });
      if (c.endImagePath) {
        inputs.push('-loop', '1', '-framerate', String(fps), '-i', c.endImagePath);
        return { clip: clipInput, end: nextInput++, photos };
      }
      return { clip: clipInput, photos };
    } else {
      if (c.loop !== false) inputs.push('-stream_loop', '-1');
      inputs.push('-i', c.videoPath);
    }
    // A still edge reads the shot's still as one more looping input.
    if (!c.layer && c.frameFit === 'still' && c.stillPath) {
      inputs.push('-loop', '1', '-framerate', String(fps), '-i', c.stillPath);
      return { clip: clipInput, still: nextInput++ };
    }
    return { clip: clipInput };
  };
  // A beat toggle or dissolve (musicVideoCutEffects.js) shows the next shot's clip over
  // the end of a shot: flipping to it on the beats, or fading it in. That clip runs on the
  // song's clock, read from an input of its own, so its own section starts exactly where
  // it would without the effect. A fade through black darkens the sections either side.
  const sectionFrame = (sec) => Math.round(sec * fps);
  const cutEffects = cutEffectCuts(plan.map(({ c, startSec, endSec }) => ({
    sceneId: c.sceneId, startFrame: sectionFrame(startSec), endFrame: sectionFrame(endSec),
    partner: !!c.intercutOf, cutEffect: c.cutEffect,
  })), { fps, beats });
  const fades = cutEffects.filter((t) => t.style === 'fade-black');
  const prerolls = cutEffects.filter((t) => t.incoming).map((t) => {
    const { c } = plan[t.index + 1];
    // The footage just before the incoming shot's in-point, on the output timebase
    // its speed and offset already set. With less footage than the window before
    // the in-point it plays on from the clip's first frame instead: the flips
    // always show moving footage, never a held frame.
    const windowSec = t.windowFrames / fps;
    const { leadSec = 0, ...shot } = c;
    const inSec = Math.max(0, c.inSec - windowSec);
    const clip = c.layer ? { ...c, outSec: c.inSec + windowSec, ...(c.photoSequence ? { photoAtSec: (c.effectAtSec || 0) - windowSec } : {}) } : {
      ...shot,
      inSec,
      outSec: inSec + windowSec,
      sourceSec: (c.sourceSec ?? c.duration) - leadSec + (c.inSec - inSec),
    };
    return { ...t, clip };
  });
  const fadeChain = (i, frames) => [
    ...fades.filter((f) => f.index === i - 1 && f.inFrames > 0).map((f) => `,fade=t=in:s=0:n=${f.inFrames}`),
    ...fades.filter((f) => f.index === i).map((f) => `,fade=t=out:s=${Math.max(0, frames - f.outFrames)}:n=${f.outFrames}`),
  ].join('');
  // One section's chain, ending on `out`; an incoming cut effect lays the next shot's preroll over its end.
  const sectionFilters = (i, input, preroll, out) => {
    const { c, frames, startSec } = plan[i];
    const head = `${sectionChain(c, input, { canonW, canonH, fps, frames, frameGrid, beats })}${fadeChain(i, frames)}`;
    if (!preroll) return [`${head}[${out}]`];
    const start = sectionFrame(startSec);
    const pad = Math.max(0, frames - preroll.windowFrames);
    const shown = preroll.incoming.map(([a, b]) => `between(n,${a - start},${b - start - 1})`).join('+');
    // A dissolve fades the incoming clip in across its window, fully in on the cut.
    const fadeIn = preroll.style === 'dissolve' ? `format=yuva420p,fade=t=in:s=0:n=${preroll.windowFrames + 1}:alpha=1,` : '';
    return [
      `${head}[vraw${i}]`,
      `${sectionChain(preroll.clip, preroll.input, { canonW, canonH, fps, frames: preroll.windowFrames, frameGrid, beats })}[pre${i}]`,
      `[pre${i}]${fadeIn}tpad=start=${pad}:color=black,setpts=N/(${fps}*TB)[prepad${i}]`,
      `[vraw${i}][prepad${i}]overlay=eof_action=pass:enable='${shown}'[${out}]`,
    ];
  };
  // Cut transitions repaint a few frames around their cuts, under the typography, and add no time.
  const pieces = plan.map(({ c, startSec, endSec }) => ({
    sceneId: c.sceneId, startFrame: Math.round(startSec * fps), endFrame: Math.round(endSec * fps),
    partner: !!c.intercutOf, transitionIn: c.transitionIn, transitionOut: c.transitionOut, effect: c.effect, effectAtSec: c.effectAtSec,
    shotGlitches: c.shotGlitches,
  }));
  // A still's glitch to its end frame paints with the same frames.
  // So do the glitches a shot sets at moments inside it.
  const glitches = mergeGlitchFrames(transitionGlitchFrames(pieces), imageEffectGlitchFrames(pieces, fps), shotGlitchFrames(pieces, fps));

  if (segment) {
    return buildSegmentArgs(segment, { plan, prerolls, addInput, sectionFilters, glitches, overlays, outputPath, grade, canonW, canonH, fps, sectionFrame, inputs, nextInput: () => nextInput });
  }

  for (const { c } of plan) sectionInputs.push(addInput(c));
  for (const preroll of prerolls) preroll.input = addInput(preroll.clip);
  const audioIdx = nextInput; // master audio follows the section inputs
  inputs.push('-i', audioPath);
  for (const overlay of overlays) inputs.push('-itsoffset', String(overlay.startSec), '-i', overlay.path);

  const filters = plan.flatMap((_, i) => sectionFilters(i, sectionInputs[i], prerolls.find((p) => p.index === i), `v${i}`));
  const gradeFilter = musicVideoGradeFilter(grade, plan.map(({ c, startSec, endSec }) => ({ sceneId: c.sceneId, startSec, endSec })), { fps });
  const glitchFilter = musicVideoTransitionFilter(glitches, { width: canonW, height: canonH });
  const cutLabel = overlays.length > 0 ? 'cut0' : 'outv';
  const finishing = [gradeFilter, glitchFilter].filter(Boolean).join(',');
  filters.push(`${plan.map((_, i) => `[v${i}]`).join('')}concat=n=${plan.length}:v=1:a=0[${finishing ? 'ungraded' : cutLabel}]`);
  if (finishing) filters.push(`[ungraded]${finishing}[${cutLabel}]`);
  overlays.forEach((_, k) => {
    const out = k === overlays.length - 1 ? 'outv' : `cut${k + 1}`;
    filters.push(`[cut${k}][${audioIdx + 1 + k}:v]overlay=eof_action=pass:format=auto[${out}]`);
  });

  const videoTotal = plan[plan.length - 1].endSec;
  const fullDuration = audioDurationSec != null ? Math.min(videoTotal, audioDurationSec) : videoTotal;

  let videoMap = '[outv]';
  // The song is the sole audio master unless a sound-design bed was explicitly
  // chosen (#8988) — then the bed is mixed UNDER it through the shared bed
  // chain, trimmed to the song so it can never extend or replace the master.
  let audioSrc = `[${audioIdx}:a]`;
  let audioMap = `${audioIdx}:a`;
  if (soundBed?.path) {
    filters.push(`[${audioIdx}:a]${AUDIO_NORM}[master]`);
    const bed = buildAudioBedMix({
      beds: [{ assetPath: soundBed.path, offsetSec: 0, durationSec: fullDuration, volume: soundBed.volume }],
      firstInputIdx: audioIdx + 1 + overlays.length,
      mainLabel: '[master]',
      outLabel: '[mixa]',
      limitPeak: true,
    });
    inputs.push(...bed.inputs);
    filters.push(...bed.filters);
    audioSrc = '[mixa]';
    audioMap = '[mixa]';
  }
  let totalDuration = fullDuration;
  let sections = plan.map(({ c, startSec, endSec }) => ({ sceneId: c.sceneId, layer: c.layer || 'footage', startSec, endSec }));

  if (excerpt) {
    const excerptStart = Math.max(0, Math.min(excerpt.startSec, fullDuration));
    const excerptEnd = Math.max(excerptStart, Math.min(excerpt.endSec, fullDuration));
    filters.push(`[outv]trim=start=${excerptStart}:end=${excerptEnd},setpts=PTS-STARTPTS[outvx]`);
    filters.push(`${audioSrc}atrim=start=${excerptStart}:end=${excerptEnd},asetpts=PTS-STARTPTS[outax]`);
    videoMap = '[outvx]';
    audioMap = '[outax]';
    totalDuration = excerptEnd - excerptStart;
    sections = sections
      .filter((s) => s.startSec < excerptEnd && s.endSec > excerptStart)
      .map((s) => ({ ...s, startSec: Math.max(0, s.startSec - excerptStart), endSec: Math.min(totalDuration, s.endSec - excerptStart) }));
  }

  const args = [
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', videoMap,
    '-map', audioMap,
    // Pin the output rate to the project's: left to its default, ffmpeg 7.0
    // can fall back to 25 fps and re-time the graph's frames (#11476).
    '-r', String(fps),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    '-progress', 'pipe:2',
    '-y',
    outputPath,
  ];
  return { args, totalDuration, canonW, canonH, fps, sections };
}

// Pure: every cut and typography-cue boundary that falls inside
// `[startSec, endSec)`, re-based to the excerpt's own timeline (0 = `startSec`)
// and deduplicated — the sample times for the excerpt's contact sheet (#8986).
// `sections`/`cues` are given in ABSOLUTE song time (as `buildMusicVideoFfmpegArgs`
// returns them pre-excerpt, or as `renderableCues`/`sectionCardCues` compute
// them). Always includes both ends of the window so the sheet covers the first
// and last frame even when no cut/cue lands exactly on them.
//
// No encoded video has a frame timestamped at its own total duration (the last
// frame's presentation time is always `duration - 1/fps` or earlier), so any
// boundary that lands exactly at the excerpt's end (its own `span`, including
// one shifted there from a cut/cue at or past `endSec`) is guarded back to
// `span - 1/fps` — the last frame a real capture can land on — rather than
// asking `encodeFileContactSheetAtTimes` for an instant that doesn't exist.
export function excerptBoundaryTimes(sections, cues, startSec, endSec, { fps = 24 } = {}) {
  const span = endSec - startSec;
  const lastFrame = fps > 0 ? Math.max(0, round3(span - 1 / fps)) : span;
  const times = new Set([0, lastFrame]);
  const add = (t) => {
    if (typeof t !== 'number' || !Number.isFinite(t)) return;
    if (t < startSec - 1e-9 || t > endSec + 1e-9) return;
    const rel = Math.min(span, Math.max(0, t - startSec));
    times.add(rel >= span - 1e-9 ? lastFrame : round3(rel));
  };
  for (const s of Array.isArray(sections) ? sections : []) { add(s.startSec); add(s.endSec); }
  for (const c of Array.isArray(cues) ? cues : []) { add(c.startSec); add(c.endSec); }
  return Array.from(times).sort((a, b) => a - b);
}

// Shared prep for both the full render and the draft excerpt render (#8986):
// resolve the master audio, refuse a stale performance take, resolve + snap
// every scene's clip, and refuse a render whose shots don't cover their
// authored span. Both callers build on the exact same resolved clip list, so
// an excerpt frame matches what a full render would produce at that song time.
//
// Legacy approval compatibility: a clip locked before shot locking was removed
// (read-only `clipApprovals`) stays exempt, so older projects still render.
// Any other stale clip blocks, naming its shots (numbered in song order) and the fix.
export function assertCurrentClipDependencies(project) {
  const locks = clipLocks(project);
  const stale = (project.scenes || []).filter((scene) => scene.videoHistoryId && scene.visualLayer !== 'still' && !isSelfDrawnLayer(scene.visualLayer))
    .filter((scene) => locks?.[scene.sceneId] !== 'locked')
    .filter((scene) => musicVideoTakeChanges(project, scene, (scene.takes || []).find((take) => take.kind === 'video' && take.assetId === scene.videoHistoryId)).length);
  if (!stale.length) return;
  const shots = nameShots(project, stale.map((scene) => scene.sceneId));
  throw new ServerError(`${shots}: the clip was made from frames that have since changed. Render a new one`,
    { status: 422, code: 'STALE_CLIP_DEPENDENCIES', context: { sceneIds: stale.map((scene) => scene.sceneId) } });
}

// `decode: false` plans for a read-only caller without host control: the
// performance-take review skips its ffmpeg decode of the song master.
export async function planMusicVideoRender(project, { draft = false, decode = true } = {}) {
  assertMusicVideoMediaSelections(project);
  assertCurrentClipDependencies(project);
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new ServerError('ffmpeg not found on PATH', { status: 500, code: 'FFMPEG_MISSING' });

  const audioPath = await resolveMasterAudioPath(project);
  // #8977/#9266: refuse a performance take whose scene was re-timed or whose
  // sung window changed in the current master. A draft shows a cutaway instead.
  if (draft) project = await withDraftPerformanceFallbacks(project, audioPath, { decode });
  await assertCurrentPerformanceTakes(project, audioPath, { decode });
  // #8985: a composed render cuts still and card sections into the same
  // timebase as the footage; plain concat renders footage only, as before.
  const composed = project.composition?.mode === 'composed';
  // The cold open (shots marked before the song) is cut on its own clock; the
  // song's pipeline below never sees those shots.
  const song = withSongScenesOnly(project);
  const coldOpen = await resolveColdOpenClips(project, { layered: composed, stillForMissingClip: draft });
  const rawClips = await resolveSceneClips(song, { layered: composed, stillForMissingClip: draft });
  const audioDurationSec = await probeVideoDuration(audioPath).catch(() => null);
  const gridDecision = project.audioAnalysis?.gridDecision;
  // #14240: an untrustworthy automatic grid must not move cuts either.
  const beats = gridDecision === 'ignore' ? [] : project.audioAnalysis?.beats;
  const snapped = beatSnapClips(rawClips, beats, { scenes: song.scenes });
  // #8964: a new (non-looping) shot must never silently repeat footage to
  // fill its span. Refuse the render and name the shots that need a trim,
  // a continuation, a replacement clip, an explicit loop, or a held last frame.
  assertClipCoverage(project, [...(coldOpen?.clips || []), ...snapped]);
  // #9290: an intercut project re-cuts the covered shots on the song's energy
  // and sung words, reusing cutaway footage — no extra generation.
  const clips = rendersIntercut(project)
    ? intercutClips(snapped, {
      scenes: song.scenes,
      sections: project.audioAnalysis?.sections,
      beats,
      gridDecision,
      bpm: project.audioAnalysis?.bpm,
      words: (project.lyricCues || []).flatMap((cue) => (Array.isArray(cue?.words) ? cue.words : [])),
      lyricCues: project.lyricCues,
      graphicCards: composed,
      accentColor: project.composition?.style?.accentColor,
      loudTierEverywhere: usesLoudTierEverywhere(project),
    })
    : snapped;
  const soundBed = await resolveSoundBedPath(project);
  return { ffmpeg, audioPath, composed, clips, coldOpen, audioDurationSec, soundBed, aspect: musicVideoAspect(project) };
}

function assertClipCoverage(project, clips) {
  const shortfalls = findCoverageShortfalls(clips);
  if (shortfalls.length > 0) {
    throw new ServerError(
      `${nameShots(project, shortfalls.map((entry) => ({ sceneId: entry.sceneId, note: `${entry.shortBySec}s short` })))}: longer than ${shortfalls.length === 1 ? 'its' : 'their'} clip. Hold the last frame, trim, continue, replace, or loop ${shortfalls.length === 1 ? 'it' : 'them'} before rendering`,
      { status: 422, code: 'INSUFFICIENT_CLIP_COVERAGE', context: { shortfalls, resolutions: COVERAGE_RESOLUTIONS } },
    );
  }
}

/**
 * The cold open's clips in play order, each exactly its cold-open length
 * (`preMusic.durationSec`), or null when no shot is marked before the song or
 * none of them has anything to show yet. Never beat-snapped: there is no song
 * under it.
 */
export async function resolveColdOpenClips(project, { layered = false, stillForMissingClip = false } = {}) {
  const plan = coldOpenPlan(project);
  if (!plan.length) return null;
  // Each shot is laid on a span of its own length so the shared resolver and
  // span honoring treat it like any authored shot.
  const scenes = plan.map(({ scene, preMusic }, order) => ({ ...scene, order, startSec: 0, endSec: preMusic.durationSec, beatAligned: true }));
  const shadow = { ...project, scenes };
  const resolved = await resolveSceneClips(shadow, { layered, stillForMissingClip }).catch((err) => {
    if (err?.code === 'NO_SCENE_CLIPS') return [];
    throw err;
  });
  if (!resolved.length) return null;
  return { clips: beatSnapClips(resolved, [], { scenes }) };
}

// Code-rendered mode (#9076) and the composition-document mode seek a
// composition instead of concatenating footage. They share this module's job
// map so the existing SSE and cancel routes apply. Code mode never asks a
// footage model for pixels; a document draws the scenes' selected takes.
const SEEKED_RENDERERS = Object.freeze({
  eidoverse: {
    label: 'Eidoverse Video', modelId: 'music-video-eidoverse',
    prepare: async (project) => (await import('./eidoverseRender.js')).prepareEidoverseRender(project),
    encode: async (input) => (await import('./eidoverseRender.js')).encodeEidoverseComposition(input),
  },
  code: {
    label: 'code',
    modelId: 'music-video-code',
    // Draws the film look in its page, so the outro page draws it too.
    filmLookInPage: true,
    prepare: async (project) => prepareCodeRender(project),
    encode: async ({ plan, project, projectId, jobId, audioPath, outputPath, signal, onProgress }) => {
      await encodeCodeComposition({
        ...plan, audioPath, outputPath, directory: `compositions/music-video/${projectId}/${jobId}`, signal, onProgress,
        initScripts: documentRenderInitScripts(project),
      });
      return { width: plan.width, height: plan.height, fps: plan.fps, durationSec: plan.durationSec, boundaryTimes: plan.sectionTimes };
    },
  },
  document: {
    label: 'composition document',
    modelId: 'music-video-document',
    filmLookInPage: true,
    soundBed: true,
    // A document draws the scenes' selected takes, so it runs the same
    // performance-take gate as a footage render (#9266).
    performanceTakes: true,
    prepare: (project) => prepareDocumentRender(project),
    encode: ({ plan, project, jobId, audioPath, soundBed, outputPath, signal, onProgress }) => encodeDocumentComposition({
      project, plan, jobId, audioPath, soundBed, outputPath, signal, onProgress,
    }),
  },
});

/** The seeked renderer for a project's render mode, or null for footage modes. */
export const seekedRendererFor = (project) => SEEKED_RENDERERS[project?.composition?.mode] || null;

async function renderSeekedMode(projectId, project, handOff, renderer, options = {}) {
  const plan = await renderer.prepare(project);
  // Resolve the master before any rendering mark. A missing track throws here
  // and the caller releases the pending slot without leaving a job running.
  const audioPath = await resolveMasterAudioPath(project);
  if (renderer.performanceTakes) {
    assertCurrentClipDependencies(project);
    await assertCurrentPerformanceTakes(project, audioPath);
  }
  const soundBed = renderer.soundBed ? await resolveSoundBedPath(project) : null;
  await ensureDir(PATHS.videos);
  await ensureDir(PATHS.videoThumbnails);
  const renderingOn = await ensureInstanceId();
  await assertCurrentRenderApproval(projectId, project, options);
  const jobId = randomUUID();
  const filename = `music-video-${projectId.slice(0, 8)}-${Date.now()}.mp4`;
  const outputPath = join(PATHS.videos, filename);
  const sheetName = filename.replace(/\.mp4$/, '-proof.png');
  const job = {
    id: jobId, projectId, status: 'running', clients: [], process: null,
    totalDuration: plan.durationSec, overlayAbort: new AbortController(),
  };
  jobs.set(jobId, job);
  projectRenders.set(projectId, jobId);
  handOff();
  const priorStatus = project.status && project.status !== 'rendering' ? project.status : 'ready';
  await updateProject(projectId, { status: 'rendering', renderingOn, renderPartialFilename: filename, renderError: null }).catch((err) => {
    maintenance.markCurrentUnsettled();
    console.error(`❌ Music-video ${renderer.label} render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→rendering write failed: ${err.message}`);
  });
  console.log(`🎬 Rendering ${renderer.label} music video [${jobId.slice(0, 8)}]: project=${projectId.slice(0, 8)} frames=${Math.round(plan.durationSec * plan.fps)} footage=off`);
  const { signal } = job.overlayAbort;
  const writeSettled = (patch) => updateProject(projectId, settledRender(patch.status, { renderError: patch.status === 'failed' ? job.lastError?.slice(0, 2000) || 'Render failed' : null, ...patch.extra })).catch((err) => {
    maintenance.markCurrentUnsettled();
    console.error(`❌ Music-video ${renderer.label} render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→${patch.status} write failed: ${err.message}`);
  });
  // `written`: the success path already committed the row inside its backup lease.
  const finish = async (patch, { written = false } = {}) => {
    releaseProjectRender(projectId);
    if (!written) await writeSettled(patch);
    emitRenderSettled(projectId, job);
    if (options.productionRunId) musicVideoEvents.emit('document-render', { projectId, runId: options.productionRunId, attemptId: options.productionRenderAttemptId, jobId, status: patch.status === 'complete' ? 'completed' : 'failed', error: job.lastError || null });
    closeJobAfterDelay(jobs, jobId);
    options.maintenancePermit?.finish();
  };
  Promise.resolve().then(async () => {
    await assertCurrentRenderApproval(projectId, project, options);
    if (signal.aborted) throw Object.assign(new Error('Render cancelled'), { code: 'CANCELED' });
    const encoded = await renderer.encode({
      plan, project, projectId, jobId, audioPath, soundBed, outputPath, signal,
      onProgress: (fraction) => broadcastSse(job, { type: 'progress', progress: fraction }),
    });
    // The ending (cutting room floor, credits; when on) joins after the song.
    const outroSec = await appendStatsOutro({ project, path: outputPath, jobId, signal, withFilmLook: !!renderer.filmLookInPage });
    return outroSec > 0 ? { ...encoded, durationSec: encoded.durationSec + outroSec } : encoded;
  }).then(async (encoded) => {
    job.overlayAbort = null;
    job.status = 'complete';
    let proof = null;
    try {
      await writeCodeProofSheet(outputPath, join(PATHS.videoThumbnails, sheetName), encoded.boundaryTimes, {
        width: encoded.width, height: encoded.height, fps: encoded.fps,
      });
      proof = sheetName;
    } catch (err) {
      console.warn(`⚠️ Music-video ${renderer.label} proof sheet failed [${jobId.slice(0, 8)}]: ${err.message}`);
    }
    const atSec = typeof project.composition?.posterSec === 'number' ? project.composition.posterSec : (encoded.boundaryTimes[0] || 0);
    const completed = { status: 'complete', extra: { renderHistoryId: jobId, renderDependencies: captureMusicVideoEvidence(project) } };
    // The encoder wrote the MP4 in place; the poster, the history entry naming
    // it and the project row naming that entry publish under one lease (#9982).
    const thumb = await withBackupAssetPublication(async () => {
      const poster = await generateThumbnail(outputPath, jobId, { atSec });
      await appendToVideoHistory({
        id: jobId,
        prompt: `Music Video: ${project.name}`,
        modelId: renderer.modelId,
        seed: 0,
        width: encoded.width,
        height: encoded.height,
        numFrames: Math.round(encoded.durationSec * encoded.fps),
        fps: encoded.fps,
        filename,
        thumbnail: poster,
        createdAt: new Date().toISOString(),
        musicVideoProjectId: projectId,
      });
      await writeSettled(completed);
      return poster;
    });
    await retireOldFinals(projectId, jobId);
    await finish(completed, { written: true });
    console.log(`✅ ${renderer.label[0].toUpperCase()}${renderer.label.slice(1)} music video rendered [${jobId.slice(0, 8)}]: ${filename}`);
    broadcastSse(job, { type: 'complete', result: { id: jobId, filename, thumbnail: thumb, path: `/data/videos/${filename}`, proof: proof ? `/data/video-thumbnails/${proof}` : null } });
  }).catch(async (err) => {
    const canceled = signal.aborted || err?.code === 'CANCELED';
    job.status = canceled ? 'canceled' : 'error';
    const reason = canceled ? 'Render cancelled' : `${renderer.label[0].toUpperCase()}${renderer.label.slice(1)} render failed: ${err.message}`;
    job.lastError = reason;
    const log = canceled ? console.log : console.error;
    log(`${canceled ? '🛑' : '❌'} Music-video ${renderer.label} render ${canceled ? 'cancelled' : 'failed'} [${jobId.slice(0, 8)}]: ${reason}`);
    await unlink(outputPath).catch(() => {});
    broadcastSse(job, { type: canceled ? 'canceled' : 'error', error: reason });
    await finish({ status: canceled ? priorStatus : 'failed' });
  });
  return { jobId };
}

// A composed footage render (shotSegments.js): each shot section, its film
// look and the outro come from the segment cache, rendering only what is
// missing, then join by stream copy with the song laid under them once.
async function renderFromShotSegments(projectId, project, handOff, options) {
  const { planShotSegments, renderMissingSegments, stitchSegments, pruneSegments } = await import('./shotSegments.js');
  const startedAtMs = Date.now();
  const plan = await planShotSegments(project);
  await ensureDir(PATHS.videos);
  await ensureDir(PATHS.videoThumbnails);
  const renderingOn = await ensureInstanceId();
  await assertCurrentRenderApproval(projectId, project, options);
  const jobId = randomUUID();
  const filename = `music-video-${projectId.slice(0, 8)}-${Date.now()}.mp4`;
  const outputPath = join(PATHS.videos, filename);
  const job = { id: jobId, projectId, status: 'running', clients: [], process: null, totalDuration: plan.songSec, overlayAbort: new AbortController() };
  jobs.set(jobId, job);
  projectRenders.set(projectId, jobId);
  handOff();
  const priorStatus = project.status && project.status !== 'rendering' ? project.status : 'ready';
  const writeProject = (patch, status) => updateProject(projectId, patch).catch((err) => {
    maintenance.markCurrentUnsettled();
    console.error(`❌ Music-video render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→${status} write failed: ${err.message}`);
  });
  // The mark boot recovery reads to start this render again after a restart:
  // the shots it finished are cached, so the rerun picks up where it stopped.
  const renderResume = options.resumable ? { attempt: options.resumeAttempt || 0 } : null;
  await writeProject({ status: 'rendering', renderingOn, renderPartialFilename: filename, renderError: null, renderResume }, 'rendering');
  const all = [...plan.segments, ...(plan.outro ? [plan.outro] : [])];
  const cached = all.filter((segment) => existsSync(segment.path)).length;
  console.log(`🎬 Rendering music video [${jobId.slice(0, 8)}]: project=${projectId.slice(0, 8)} segments=${all.length} cached=${cached} duration=${plan.songSec.toFixed(2)}s`);
  const { signal } = job.overlayAbort;
  const finish = (status) => {
    releaseProjectRender(projectId);
    emitRenderSettled(projectId, job);
    closeJobAfterDelay(jobs, jobId);
    options.maintenancePermit?.finish();
    return status;
  };
  Promise.resolve().then(async () => {
    // Shots take 95% of the bar; joining and laying the song under them the rest.
    await renderMissingSegments(plan, { signal, onProgress: (fraction) => broadcastSse(job, { type: 'progress', progress: 0.95 * fraction }) });
    await assertCurrentRenderApproval(projectId, project, options);
    const { durationSec, leadSec } = await stitchSegments(plan, outputPath, { signal });
    // The stepped medium (#14244) holds the stitched cut; shot looks are already in it.
    const hold = projectFrameHold(project);
    if (hold) await applyFrameHold({ path: outputPath, sections: plan.sections, leadSec, signal, ffmpeg: plan.ffmpeg, ...hold });
    broadcastSse(job, { type: 'progress', progress: 1 });
    return durationSec;
  }).then(async (durationSec) => {
    job.overlayAbort = null;
    job.status = 'complete';
    const section = (project.audioAnalysis?.sections || [])
      .filter((entry) => Number.isFinite(entry.energy) && entry.startSec >= 0 && entry.endSec > entry.startSec && entry.startSec < plan.songSec)
      .sort((a, b) => b.energy - a.energy || a.startSec - b.startSec)[0];
    const posterSec = project.composition?.posterSec;
    const songAtSec = typeof posterSec === 'number' && posterSec < plan.songSec ? posterSec
      : section ? (section.startSec + Math.min(section.endSec, plan.songSec)) / 2 : undefined;
    // Song time sits after the cold open in the file.
    const atSec = songAtSec != null ? songAtSec + (plan.coldOpen?.durationSec || 0) : undefined;
    const thumb = await withBackupAssetPublication(async () => {
      const poster = await generateThumbnail(outputPath, jobId, { atSec });
      await appendToVideoHistory({
        id: jobId, prompt: `Music Video: ${project.name}`, modelId: 'music-video', seed: 0,
        width: plan.width, height: plan.height, numFrames: Math.round(durationSec * plan.fps), fps: plan.fps,
        filename, thumbnail: poster, createdAt: new Date().toISOString(), musicVideoProjectId: projectId,
      });
      await writeProject(settledRender('complete', { renderHistoryId: jobId, renderDependencies: captureMusicVideoEvidence(project)}), 'complete');
      return poster;
    });
    await retireOldFinals(projectId, jobId);
    // Older takes of each shot are dropped once the new cut is published.
    const pruned = await pruneSegments(plan, { startedAtMs, current: true }).catch(err => { console.warn(`⚠️ Music-video segment cleanup failed: ${err.message}`); return 0; });
    finish('complete');
    console.log(`✅ Music video rendered [${jobId.slice(0, 8)}]: ${filename} (${all.length - cached} of ${all.length} segments rendered${pruned ? `, ${pruned} old dropped` : ''})`);
    broadcastSse(job, { type: 'complete', result: { id: jobId, filename, thumbnail: thumb, path: `/data/videos/${filename}` } });
  }).catch(async (err) => {
    const canceled = signal.aborted || err?.code === 'CANCELED';
    job.status = canceled ? 'canceled' : 'error';
    const reason = canceled ? 'Render cancelled' : err.message;
    job.lastError = reason;
    const log = canceled ? console.log : console.error;
    log(`${canceled ? '🛑' : '❌'} Music-video render ${canceled ? 'cancelled' : 'failed'} [${jobId.slice(0, 8)}]: ${reason}`);
    await unlink(outputPath).catch(() => {});
    broadcastSse(job, { type: canceled ? 'canceled' : 'error', error: reason });
    const status = canceled ? priorStatus : 'failed';
    await writeProject(settledRender(status, { renderError: canceled ? null : reason.slice(0, 2000) }), status);
    finish(status);
  });
  return { jobId };
}

async function assertCurrentRenderApproval(projectId, preparedProject, options) {
  const current = await getProject(projectId);
  // The final render needs the approved storyboard; the animated proof is optional.
  assertProductionApproval(current, 'storyboard');
  if (productionReviewBasis(current).proof !== productionReviewBasis(preparedProject).proof) {
    throw new ServerError('The reviewed film changed during render preparation.', { status: 409, code: 'MUSIC_VIDEO_REVIEW_STALE' });
  }
  await options.verifyCurrent?.(current);
}

export async function renderMusicVideo(projectId, options = {}) {
  const permit = maintenance.admit('music-video', projectId, { continuation: true, parentKinds: ['media'] });
  try { return await permit.run(() => renderAdmittedMusicVideo(projectId, options, permit)); }
  catch (err) { permit.finish(); throw err; }
}

async function renderAdmittedMusicVideo(projectId, options, permit) {
  const project = await requireProject(projectId);
  assertProductionApproval(project, 'storyboard');
  if (typeof options?.codeDirectory === 'string' && options.codeDirectory) {
    throw new ServerError('Import and select the composition document before rendering.', { status: 409, code: 'MUSIC_VIDEO_UNREVIEWED_DIRECTORY' });
  }
  const { assertRenderCleanupIdle } = await import('./renderCleanupActivity.js');
  assertRenderCleanupIdle(projectId);
  const existingJob = projectRenders.get(projectId);
  if (existingJob && (existingJob === PENDING || jobs.has(existingJob))) {
    throw new ServerError('Render already in progress for this project', {
      status: 409, code: 'RENDER_IN_PROGRESS', context: { jobId: existingJob === PENDING ? null : existingJob },
    });
  }
  // Reserve the slot SYNCHRONOUSLY (no await between the check above and here)
  // so a concurrent same-project start can't slip through during prep. Released
  // in the `finally` below if prep throws or we never reach the spawn handoff.
  projectRenders.set(projectId, PENDING);

  let handedOff = false;
  try {
    const seeked = seekedRendererFor(project);
    if (seeked && coldOpenScenes(project).length) {
      throw new ServerError(`${nameShots(project, coldOpenScenes(project).map((scene) => scene.sceneId))}: a cold open before the song plays in a footage render. Switch the render style to composed or footage, or move ${coldOpenScenes(project).length === 1 ? 'the shot' : 'the shots'} back onto the song`,
        { status: 422, code: 'PRE_MUSIC_NEEDS_FOOTAGE' });
    }
    if (seeked) {
      return await renderSeekedMode(projectId, project, () => { handedOff = true; }, seeked, { ...options, maintenancePermit: permit });
    }
    // A composed cut renders shot by shot into the segment cache and stitches.
    if (project.composition?.mode === 'composed') {
      return await renderFromShotSegments(projectId, project, () => { handedOff = true; }, { ...options, maintenancePermit: permit });
    }
    const { ffmpeg, audioPath, composed, clips, coldOpen, audioDurationSec, soundBed, aspect } = await planMusicVideoRender(project);
    await ensureDir(PATHS.videos);
    await ensureDir(PATHS.videoThumbnails);

    // Resolved before the job hand-off so a failure here releases the slot.
    const renderingOn = await ensureInstanceId();
    const jobId = randomUUID();
    const filename = `music-video-${projectId.slice(0, 8)}-${Date.now()}.mp4`;
    const outputPath = join(PATHS.videos, filename);
    const { args, totalDuration, canonW, canonH, fps, sections } = buildMusicVideoFfmpegArgs(clips, audioPath, outputPath, { audioDurationSec, frameGrid: composed, soundBed, grade: composed ? project.composition?.grade : null, beats: project.audioAnalysis?.beats, aspect });

    await assertCurrentRenderApproval(projectId, project, options);
    // A long filter graph goes to ffmpeg in this file, removed once ffmpeg exits.
    const graphPath = join(tmpdir(), `portos-music-video-${jobId}.filtergraph`);
    const plainEncode = await filterGraphViaFile(ffmpeg, args, graphPath);
    const job = { id: jobId, projectId, status: 'running', clients: [], process: null, totalDuration };
    jobs.set(jobId, job);
    projectRenders.set(projectId, jobId);
    handedOff = true; // the job lifecycle now owns the projectRenders entry

    // Capture the pre-render status so a cancel restores it rather than blindly
    // downgrading a previously-'complete' project to 'ready'. Fall back to 'ready'
    // if it was somehow already 'rendering'.
    const priorStatus = project.status && project.status !== 'rendering' ? project.status : 'ready';
    // Mark the project rendering so the board reflects an in-flight render even
    // on a client that didn't initiate it (federates via emitRecordUpdated).
    // #9010: stamp this instance on the mark so a peer's boot recovery leaves
    // it alone, and record the output file so OUR boot recovery can delete the
    // partial a restart mid-encode leaves behind.
    await updateProject(projectId, { status: 'rendering', renderingOn, renderPartialFilename: filename, renderError: null }).catch((err) => {
      maintenance.markCurrentUnsettled();
      console.error(`❌ Music-video render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→rendering write failed: ${err.message}`);
    });

    console.log(`🎬 Rendering music video [${jobId.slice(0, 8)}]: project=${projectId.slice(0, 8)} clips=${clips.length} duration=${totalDuration.toFixed(2)}s`);

    // Terminal failure or cancel across the encode and film look pass. A
    // cancel is a user action (stdout); a failure is an error (#7945).
    const settleFailure = async (canceled, reason) => {
      job.status = canceled ? 'canceled' : 'error';
      job.lastError = reason;
      const log = canceled ? console.log : console.error;
      log(`${canceled ? '🛑' : '❌'} Music-video render ${canceled ? 'cancelled' : 'failed'} [${jobId.slice(0, 8)}]: ${reason}`);
      await unlink(outputPath).catch(() => {});
      broadcastSse(job, { type: canceled ? 'canceled' : 'error', error: reason });
      releaseProjectRender(projectId);
      // A cancel restores the pre-render status (so a cancelled re-render of a
      // 'complete' project stays 'complete'); a real failure marks it 'failed'.
      const targetStatus = canceled ? priorStatus : 'failed';
      await updateProject(projectId, settledRender(targetStatus, { renderError: canceled ? null : reason.slice(0, 2000) })).catch((updateErr) => {
        maintenance.markCurrentUnsettled();
        console.error(`❌ Music-video render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→${targetStatus} write failed: ${updateErr.message}`);
      });
      emitRenderSettled(projectId, job);
      closeJobAfterDelay(jobs, jobId);
      permit.finish();
    };

    // A footage render with a film look re-encodes its finished cut through the
    // look after ffmpeg (filmLookFinish.js); the pass takes the second half of
    // whatever the encode's share of the bar is.
    const finishing = filmLookFinishNeeded(project);
    // Seconds the ending (cutting room floor, credits) adds after the song (0 when both are off).
    const outroSec = endingSeconds(project);
    // Seconds the cold open adds before the song, once it is cut in front.
    let leadSec = 0;
    const startEncode = (encode) => {
      const encodeTop = finishing ? 0.5 : 1;
      const encodeProgress = (fraction) => encodeTop * fraction;
      const dropGraphFile = () => (encode.file ? unlink(encode.file).catch(() => {}) : null);
      const proc = spawn(ffmpeg, encode.args, safeChildProcessOptions({ stdio: ['ignore', 'ignore', 'pipe'] }));
      job.process = proc;

      let stderrBuf = '';
      proc.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString();
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop();
        for (const raw of lines) {
          const line = raw.trim();
          const eq = line.indexOf('=');
          if (eq <= 0) continue;
          const key = line.slice(0, eq);
          const val = line.slice(eq + 1);
          if (key === 'out_time_us') {
            const us = parseInt(val, 10);
            if (Number.isFinite(us) && totalDuration > 0) {
              broadcastSse(job, { type: 'progress', progress: encodeProgress(Math.min(1, (us / 1_000_000) / totalDuration)) });
            }
          } else if (key === 'progress' && val === 'end') {
            broadcastSse(job, { type: 'progress', progress: encodeTop });
          }
        }
      });

      // Spawn-state tracking + exactly-once terminal guard + pre-vs-post-spawn
      // dispatch live in the shared helper; only the finalize bodies below are
      // service-specific (music-video mutates the project's render status).
      attachFfmpegRenderGuard(proc, {
        label: `Music-video render [${jobId.slice(0, 8)}]`,
        onProcessError: (err) => {
          // Post-spawn error (e.g. a failed kill during cancel). The ffmpeg is
          // still live — do NOT release the project mutex or null job.process
          // here, or a replacement render could spawn and overlap it. Record
          // the reason; the pending 'close' runs the sole terminal finalization.
          job.lastError = `ffmpeg process error: ${err.message}`;
          console.log(`⚠️ Music-video render post-spawn error [${jobId.slice(0, 8)}]: ${err.message}`);
        },
        onSpawnError: async (err) => {
          // Pre-spawn failure: the child never started, so 'close' won't follow.
          await dropGraphFile();
          job.process = null;
          job.status = 'error';
          const reason = `Failed to spawn ffmpeg: ${err.message}`;
          job.lastError = reason;
          console.error(`❌ Music-video render spawn error [${jobId.slice(0, 8)}]: ${reason}`);
          broadcastSse(job, { type: 'error', error: reason });
          releaseProjectRender(projectId);
          await updateProject(projectId, settledRender('failed', { renderError: reason.slice(0, 2000) })).catch((updateErr) => {
            maintenance.markCurrentUnsettled();
            console.error(`❌ Music-video render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→failed write failed: ${updateErr.message}`);
          });
          emitRenderSettled(projectId, job);
          closeJobAfterDelay(jobs, jobId);
          permit.finish();
        },
        onClose: async (code, signal) => {
          job.process = null;
          await dropGraphFile();
          if (code !== 0) {
            const canceled = isMusicVideoRenderCanceled(job, signal);
            await settleFailure(canceled, canceled ? 'Render cancelled' : signal ? `Killed by signal ${signal}` : `ffmpeg exit ${code}`);
            return;
          }
          // The cold open (shots before the song) goes in front, before the
          // film look so the look grades it with the rest of the film.
          if (coldOpen) {
            job.overlayAbort = new AbortController();
            const { signal: coldSignal } = job.overlayAbort;
            try {
              const { prependColdOpen } = await import('./coldOpen.js');
              leadSec = await prependColdOpen({ project, coldOpen, path: outputPath, ffmpeg, jobId, signal: coldSignal });
            } catch (err) {
              await settleFailure(coldSignal.aborted, coldSignal.aborted ? 'Render cancelled' : `Cold open failed: ${err.message}`);
              return;
            }
            job.overlayAbort = null;
          }
          // The cutting room floor outro (when on) joins after the song, before
          // the film look so the look grades it with the rest of the film.
          if (outroSec > 0) {
            job.overlayAbort = new AbortController();
            const { signal: outroSignal } = job.overlayAbort;
            try {
              await appendStatsOutro({ project, path: outputPath, jobId, signal: outroSignal });
            } catch (err) {
              await settleFailure(outroSignal.aborted, outroSignal.aborted ? 'Render cancelled' : `Outro scene failed: ${err.message}`);
              return;
            }
            job.overlayAbort = null;
          }
          // The stepped medium (#14244) holds every other frame of the cut,
          // before the film look so the grain and weave still move each frame.
          const hold = projectFrameHold(project);
          if (hold) {
            job.overlayAbort = new AbortController();
            const { signal: holdSignal } = job.overlayAbort;
            try {
              await applyFrameHold({ path: outputPath, sections, leadSec, signal: holdSignal, ffmpeg, ...hold });
            } catch (err) {
              await settleFailure(holdSignal.aborted, holdSignal.aborted ? 'Render cancelled' : `Frame hold failed: ${err.message}`);
              return;
            }
            job.overlayAbort = null;
          }
          // The cut is encoded; a film look re-encodes it in place through the
          // look before it is published. A cancel here aborts the pass.
          if (finishing) {
            job.overlayAbort = new AbortController();
            const { signal: finishSignal } = job.overlayAbort;
            try {
              await applyFilmLookFinish({ project, path: outputPath, jobId, signal: finishSignal,
                onProgress: (fraction) => broadcastSse(job, { type: 'progress', progress: encodeTop + (1 - encodeTop) * fraction }) });
            } catch (err) {
              await settleFailure(finishSignal.aborted, finishSignal.aborted ? 'Render cancelled' : `Film look pass failed: ${err.message}`);
              return;
            }
            job.overlayAbort = null;
          }
          // Success finalization runs in an event callback (no request to bubble
          // to) — a throw in thumbnailing/history I/O would otherwise leave the
          // project stuck 'rendering' and projectRenders un-cleared (every later
          // render 409s). Wrap it so any failure still emits a terminal frame and
          // releases the slot.
          try {
            job.status = 'complete';
            const section = (project.audioAnalysis?.sections || [])
              .filter(section => Number.isFinite(section.energy) && section.startSec >= 0 && section.endSec > section.startSec && section.startSec < totalDuration)
              .sort((a, b) => b.energy - a.energy || a.startSec - b.startSec)[0];
            // An explicitly chosen poster frame (#8984) wins over the loudest-section guess.
            const posterSec = project.composition?.posterSec;
            const songAtSec = typeof posterSec === 'number' && posterSec < totalDuration ? posterSec
              : section ? (section.startSec + Math.min(section.endSec, totalDuration)) / 2 : undefined;
            // Song time sits after the cold open in the file.
            const atSec = songAtSec != null ? songAtSec + leadSec : undefined;
            // ffmpeg wrote the MP4 in place; the poster, the history entry naming
            // it and the project row naming that entry publish under one lease (#9982).
            const thumb = await withBackupAssetPublication(async () => {
              const poster = await generateThumbnail(outputPath, jobId, { atSec });
              await appendToVideoHistory({
                id: jobId,
                prompt: `Music Video: ${project.name}`,
                modelId: 'music-video',
                seed: 0,
                width: canonW,
                height: canonH,
                numFrames: Math.round((leadSec + totalDuration + outroSec) * (fps || 24)),
                fps: fps || 24,
                filename,
                thumbnail: poster,
                createdAt: new Date().toISOString(),
                musicVideoProjectId: projectId,
              });
              await updateProject(projectId, settledRender('complete', { renderHistoryId: jobId, renderDependencies: captureMusicVideoEvidence(project) })).catch((updateErr) => {
                maintenance.markCurrentUnsettled();
                console.error(`❌ Music-video render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→complete write failed: ${updateErr.message}`);
              });
              return poster;
            });
            await retireOldFinals(projectId, jobId);
            emitRenderSettled(projectId, job);
            console.log(`✅ Music video rendered [${jobId.slice(0, 8)}]: ${filename}`);
            broadcastSse(job, { type: 'complete', result: { id: jobId, filename, thumbnail: thumb, path: `/data/videos/${filename}` } });
          } catch (err) {
            permit.markUnsettled();
            job.status = 'error';
            job.lastError = `Finalize failed: ${err.message}`;
            console.error(`❌ Music-video render finalize failed [${jobId.slice(0, 8)}]: ${err.message}`);
            broadcastSse(job, { type: 'error', error: 'Render finalize failed' });
            await updateProject(projectId, settledRender('failed', { renderError: job.lastError.slice(0, 2000) })).catch((updateErr) => {
              maintenance.markCurrentUnsettled();
              console.error(`❌ Music-video render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→failed write failed: ${updateErr.message}`);
            });
            emitRenderSettled(projectId, job);
          } finally {
            releaseProjectRender(projectId);
            closeJobAfterDelay(jobs, jobId);
            permit.finish();
          }
        },
      });
    };

    startEncode(plainEncode);
    return { jobId };
  } finally {
    // Prep threw (or we never handed off to the job lifecycle) — release the
    // reserved slot so a stale PENDING can't 409 every future render.
    if (!handedOff) { releaseProjectRender(projectId); permit.finish(); }
  }
}

// Boot recovery: a render job cannot survive a restart, so a persisted
// 'rendering' status with no live job is stale. Demote it to 'complete' when a
// finished render is already recorded, otherwise to 'ready', then delete the
// partial output the interrupted encode was writing (#9010). A mark another
// instance stamped is left alone — that render may still be running on the
// peer this record synced from. A list failure propagates to the bootstrap
// caller's logBootstrapFailure rather than reporting zero recovered.
export async function recoverStuckMusicVideoRenders() {
  // No overlay capture survives a restart either; drop any scratch it left.
  await sweepCompositionScratch().catch((err) => {
    console.warn(`⚠️ Music Video recovery: could not remove stale overlay scratch: ${err.message}`);
  });
  // Nor a composition-document render's staged copy (document + scene media).
  await sweepDocumentScratch().catch((err) => {
    console.warn(`⚠️ Music Video recovery: could not remove stale composition-document scratch: ${err.message}`);
  });
  // Nor the outro scene's staged page.
  await sweepStatsOutroScratch().catch((err) => {
    console.warn(`⚠️ Music Video recovery: could not remove stale outro scratch: ${err.message}`);
  });
  // Nor a shot segment an interrupted render was writing (finished ones stay cached).
  await import('./shotSegments.js').then(({ sweepPartialSegments }) => sweepPartialSegments()).catch((err) => {
    console.warn(`⚠️ Music Video recovery: could not remove partial shot segments: ${err.message}`);
  });
  const instanceId = await ensureInstanceId();
  const stuck = (await listProjects()).filter((p) => p?.status === 'rendering'
    && !projectRenders.has(p.id) && isLocalRenderMark(p.renderingOn, instanceId));
  // Filenames the video history references, loaded on first need: a render
  // whose history append landed but whose 'complete' write failed still names
  // its (finished) file — that file is the gallery's, not a partial.
  let finished = null;
  let recovered = 0;
  const resumes = [];
  for (const project of stuck) {
    // Re-checked against the FRESHEST record under the write lock: a peer sync
    // landing between the list and this write may have handed the mark to
    // another instance (or finished it), and that render is not ours to demote.
    const outcome = await mutateProjectRecord(project.id, (current) => {
      const stillStuck = current?.status === 'rendering' && !projectRenders.has(current.id)
        && isLocalRenderMark(current.renderingOn, instanceId);
      if (!stillStuck) return { project: current, demoted: false };
      const targetStatus = current.renderHistoryId ? 'complete' : 'ready';
      return { project: applyProjectPatch(current, settledRender(targetStatus)), demoted: true, partial: current.renderPartialFilename, resume: current.renderResume };
    }).catch((err) => {
      console.error(`❌ Music Video recovery: project ${project.id.slice(0, 8)} demotion write failed: ${err.message}`);
      return null;
    });
    if (!outcome?.demoted) continue;
    recovered++;
    if (outcome.resume && (Number(outcome.resume.attempt) || 0) < MAX_RENDER_RESUMES) resumes.push({ projectId: project.id, attempt: (Number(outcome.resume.attempt) || 0) + 1 });
    // Only once the record no longer points at it. The filename came off a
    // (possibly peer-synced) record, so it is only resolved inside videos/.
    const { partial } = outcome;
    if (typeof partial !== 'string' || !partial) continue;
    // An unreadable history keeps every file — a stray partial beats deleting a finished render.
    finished ??= await loadHistory().then((history) => new Set(history.map((entry) => entry?.filename)), (err) => {
      console.warn(`⚠️ Music Video recovery: video history unreadable, keeping partial render output: ${err.message}`);
      return false;
    });
    const partialPath = !finished || finished.has(partial) ? null : safeUnder(PATHS.videos, partial);
    if (partialPath) await unlink(partialPath).catch(() => {});
  }
  if (stuck.length > 0) console.log(`🎬 Music Video boot recovery: demoted ${recovered}/${stuck.length} stuck render(s)`);
  if (resumes.length > 0) scheduleRenderResumes(resumes);
}

// A shot-by-shot final render the user started is started again after a
// restart: every shot it finished is cached, so the rerun only renders the
// shots left and stitches. Bounded, so a render that itself takes the server
// down is not restarted forever.
const MAX_RENDER_RESUMES = 2;
const RENDER_RESUME_DELAY_MS = 15_000;

function scheduleRenderResumes(resumes) {
  // After boot settles (maintenance admission, the media lane): the render
  // admits like any other.
  setTimeout(async () => {
    for (const { projectId, attempt } of resumes) {
      try {
        const { jobId } = await renderMusicVideo(projectId, { resumable: true, resumeAttempt: attempt });
        console.log(`🎬 Music Video boot recovery: resumed the final render of ${projectId.slice(0, 8)} [${jobId.slice(0, 8)}] from its cached shots`);
      } catch (err) {
        // Someone started it again in the meantime: that render resumes from the same cache.
        if (err?.code === 'RENDER_IN_PROGRESS') {
          console.log(`🎬 Music Video boot recovery: the final render of ${projectId.slice(0, 8)} was already started again`);
          continue;
        }
        console.error(`❌ Music Video boot recovery: could not resume the final render of ${projectId.slice(0, 8)}: ${err.message}`);
        await updateProject(projectId, { renderError: `Interrupted by a server restart and could not restart: ${err.message}`.slice(0, 2000) }).catch(() => {});
      }
    }
  }, RENDER_RESUME_DELAY_MS).unref?.();
}

async function retireOldFinals(projectId, replacementId) {
  await import('./renderCleanup.js').then(({ cleanupSupersededFinals }) => cleanupSupersededFinals(projectId, { replacementId }))
    .catch(err => console.warn(`⚠️ Music-video superseded render cleanup failed: ${err.message}`));
}
