import { maintenance } from '../../lib/maintenanceAdmission.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { assertMusicVideoMediaSelections } from '../../lib/musicVideo/musicVideoMediaPolicy.js';
import { assertProductionApproval, nameShots, productionReviewBasis } from './productionReview.js';
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
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { findFfmpeg, hasAudioStream, safeUnder, generateThumbnail, probeVideoDuration, probeVideoGeometry } from '../../lib/ffmpeg.js';
import { filterGraphViaFile } from '../../lib/ffmpegFilterGraph.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { cancelMusicVideoRenderJob, isMusicVideoRenderCanceled } from './renderCancellation.js';
import { attachFfmpegRenderGuard } from '../../lib/ffmpegRenderGuard.js';
import { loadHistory, mutateVideoHistory } from '../videoGen/history.js';
import { getTrack } from '../tracks/index.js';
import { getProject, listProjects, updateProject, mutateProjectRecord } from './projects.js';
import { requireProject } from './requireProject.js';
import { applyProjectPatch } from './projectsLogic.js';
import { isLocalRenderMark, settledRender, settleMusicVideoRender } from './renderSettlement.js';
import { COVERAGE_TOLERANCE_SEC, MUSIC_VIDEO_FRAME_FITS, clipLoops, clipNeedsMoreFootage, clipPlaybackWindow, clipReversed, sceneHasAuthoredSpan, sceneUsesAuthoredTiming, sceneVisualLayer, wordTimedScenes } from '../../lib/musicVideo/musicVideoLayers.js';
import { assertSongAudioCurrent, audioRevisionOf } from '../../lib/musicVideo/musicVideoSongAudio.js';
import { musicVideoAspect } from '../../lib/musicVideo/musicVideoAspect.js';
import { encodeCodeComposition, prepareCodeRender, writeCodeProofSheet } from './codeRender.js';
import { documentRenderInitScripts, encodeDocumentComposition, prepareDocumentRender, sweepDocumentScratch } from './documentRender.js';
import { sweepCompositionScratch } from './compositionRender.js';
import { applyFilmLookFinish, filmLookFinishNeeded } from './filmLookFinish.js';
import { appendStatsOutro, sweepStatsOutroScratch } from './statsOutro.js';
import { endingSeconds } from '../../lib/musicVideo/musicVideoEnding.js';
import { coldOpenPlan, coldOpenScenes, withSongScenesOnly } from '../../lib/musicVideo/musicVideoColdOpen.js';
import { selectedPerformanceInstruction } from '../../lib/musicVideo/musicVideoShotTiming.js';
import { resolveSourceTake, scenePlayableClipId } from '../../lib/musicVideo/musicVideoSourceTake.js';
import { captureMusicVideoEvidence, } from '../../lib/musicVideo/musicVideoDependencies.js';
import { assertCurrentPerformanceTakes, withDraftPerformanceFallbacks } from './performanceShot.js';
import { ensureInstanceId } from '../instanceIdentity.js';
import { songClipSound } from '../../lib/musicVideo/musicVideoClipSound.js';
import { musicVideoEvents } from './events.js';
import { projectSoundBed } from './soundBed.js';
import { audioLayerBeds } from './audioLayers.js';
import { intercutClips } from './intercut.js';
import { applyFrameHold, projectFrameHold } from './frameHold.js';
import { rendersIntercut, usesLoudTierEverywhere } from '../../lib/musicVideo/musicVideoProductionMedium.js';
import { plannedTransitions, sceneCutEffect } from '../../lib/musicVideo/musicVideoCutEffects.js';
import { applyCameraCutDefaults, sceneTransitions } from '../../lib/musicVideo/musicVideoTransitions.js';
import { MUSIC_VIDEO_CAMERA_FRAME_ASPECTS, musicVideoOverscan, shotCamera } from '../../lib/musicVideo/musicVideoFilmLook.js';
import { stillMoveForCamera } from '../../lib/cameraMovements.js';
import { isEndFrameImageEffect, sceneImageEffect, scenePhotoSequence } from '../../lib/musicVideo/musicVideoImageEffects.js';
import { trackedRenderMap } from '../renderActivity.js';
import { buildMusicVideoFfmpegArgs, osdDateText } from './renderFfmpegArgs.js';
import { normalizeBlenderRecord } from '../../lib/musicVideo/musicVideoBlender.js';

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

export { buildMusicVideoFfmpegArgs, isLocalRenderMark };

// The terminal project write of a final render job, decided on the freshest
// row inside the project mutation (renderSettlement.js). When the song changed
// during the render, the job's status is not applied; a file it already wrote
// stays in the history marked abandoned, since the project never names it, and
// the superseded-finals cleanup that follows keeps the project's finals.
// Resolves to whether the status was applied, so a success path can tell its
// listeners the render was abandoned (#15158).
async function settleRenderProject(projectId, job, status, extra) {
  const instanceId = await ensureInstanceId();
  const { settled } = await mutateProjectRecord(projectId, (current) => settleMusicVideoRender(current, { jobRevision: job.audioRevision, status, extra, instanceId }));
  if (settled) return true;
  console.log(`⏭️ Music-video render [${job.id.slice(0, 8)}] project ${projectId.slice(0, 8)}: the song changed during the render, status→${status} not applied`);
  if (status === 'complete') {
    await mutateVideoHistory((history) => history.map((entry) => (entry.id === job.id ? { ...entry, abandonedReason: 'audio-changed' } : entry)));
  }
  return false;
}

// A change of the song cancels this instance's render of the old one. A
// render another instance owns is left to that instance (#15154).
musicVideoEvents.on('audio-changed', ({ projectId, project }) => {
  const jobId = getActiveRenderJobId(projectId);
  const job = jobId ? jobs.get(jobId) : null;
  if (!job || job.audioRevision === audioRevisionOf(project)) return;
  ensureInstanceId().then((instanceId) => {
    if (isLocalRenderMark(project.renderingOn, instanceId) && cancelRender(jobId)) {
      console.log(`🛑 Music-video render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)}: the song changed, canceling the render`);
    }
  }).catch((err) => console.error(`❌ Music-video render [${jobId.slice(0, 8)}] cancel after a song change failed: ${err.message}`));
});

// Tell listeners (the autonomous run waiting on its final render) that a render
// job reached a terminal state. Emitted after the project record's terminal
// write, with the outcome read off the job the caller already settled. A job
// that finished while the song changed under it stays `completed` (its file
// exists) but carries `abandoned: true`: the project never names that render,
// so a listener must not treat it as delivered (#15158). Only a success path
// passes `settled`; `undefined` (no write, or one that threw) is not abandoned.
const emitRenderSettled = (projectId, job, settled) => musicVideoEvents.emit('render', {
  projectId, jobId: job.id,
  status: job.status === 'complete' ? 'completed' : job.status === 'canceled' ? 'canceled' : 'failed',
  error: job.lastError || null,
  ...(settled === false ? { abandoned: true } : {}),
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
// music-library track) to a verified path under data/music/, and the audio
// layers placed on the editor timeline (audioLayers.js) to bed-chain entries
// on song time. Null when the song is the sole audio master (the default).
// The answer is `{ path, volume, layers }`: `path` is null when only layers
// are set. Every caller hands it to buildSongAudioMix (clipSoundMix.js),
// which cuts each layer at the song's end.
export async function resolveSoundBedPath(project) {
  const bed = projectSoundBed(project);
  let path = null;
  // A (synced) record naming the song itself as its bed mixes nothing.
  if (bed && bed.trackId !== project.trackId) {
    const track = await getTrack(bed.trackId);
    path = track?.audioFilename ? safeUnder(PATHS.music, track.audioFilename) : null;
    if (!path || !existsSync(path)) {
      throw new ServerError('The sound-design bed track is missing — choose another bed or clear it', { status: 404, code: 'SOUND_BED_MISSING' });
    }
  }
  const layers = await audioLayerBeds(project, {
    resolvePath: (filename) => {
      const safe = safeUnder(PATHS.music, filename);
      if (!safe || !existsSync(safe)) {
        throw new ServerError('An audio layer\'s file is missing — remove that layer or upload it again', { status: 404, code: 'AUDIO_LAYER_MISSING' });
      }
      return safe;
    },
    durationOf: (_layer, assetPath) => probeVideoDuration(assetPath).catch(() => null),
  });
  if (!path && !layers.length) return null;
  return { path, volume: path ? bed.volume : null, layers };
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
async function footageClip(scene, entry, planned, editOverride = undefined) {
  const geometry = await footageGeometry(entry);
  if (!geometry) return { problem: 'missing-clip' };
  const edit = editOverride !== undefined ? editOverride : performanceEdit(scene);
  const { rate, leadSec, inSec, outSec, sourceSec } = clipPlaybackWindow(scene, edit, geometry.duration);
  const clipSound = songClipSound(scene);
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
    // The shot plays its own sound over the song, when its clip has any.
    ...(clipSound && await hasAudioStream(geometry.videoPath) ? { clipSound } : {}),
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
export async function resolveSceneClips(project, { layered = false, stillForMissingClip = false, sceneId = null } = {}) {
  // A draft shows a footage shot that has no clip yet as its still (layered renders only).
  const allScenes = Array.isArray(project.scenes) ? project.scenes : [];
  const playableId = (s) => scenePlayableClipId(s, allScenes);
  const standIn = (s) => {
    if (!stillForMissingClip || !layered || playableId(s)) return false;
    const resolved = resolveSourceTake(s, allScenes);
    return Boolean(resolved?.referenceImageId || s.referenceImageId) && sceneVisualLayer(s, { layered }) === 'footage';
  };
  const scenes = allScenes
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .filter((s) => s && (!sceneId || s.sceneId === sceneId) && (playableId(s) || sceneVisualLayer(s, { layered }) !== 'footage' || standIn(s)));
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
    const resolved = resolveSourceTake(scene, allScenes);
    const played = resolved
      ? { ...scene, videoHistoryId: resolved.videoHistoryId, referenceImageId: resolved.referenceImageId || scene.referenceImageId || null }
      : scene;
    const layer = standIn(scene) ? 'still' : sceneVisualLayer(scene, { layered });
    const shot = applyCameraCutDefaults(played, project.cameras);
    const { clip, problem } = layer === 'footage'
      ? await footageClip(shot, historyMap.get(played.videoHistoryId), planned, resolved ? { inSec: resolved.inSec, outSec: resolved.outSec } : undefined)
      : sectionClip(shot, layer, planned, { layered });
    if (clip) clips.push(withCameraPicture(clip, played, project));
    else problems[problem].push(scene);
  }
  const missingShots = problems['missing-clip'];
  if (missingShots.length > 0) {
    const one = missingShots.length === 1;
    throw new ServerError(`${nameShots(project, missingShots.map((s) => s.sceneId))}: the selected clip file ${one ? 'is' : 'are'} missing or unreadable. Pick another take or render a new one`, {
      status: 404, code: 'MISSING_CLIPS', context: { missingClipIds: missingShots.map((s) => playableId(s) || s.videoHistoryId) },
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
// scene has a pacing cut, planner section provenance or `beatAligned: true` and valid
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
    // A measured word-gap repair owns its edit boundary independently of beats.
    if ((sceneUsesAuthoredTiming(scene) || selectedPerformanceInstruction(scene)?.repair) && sceneHasAuthoredSpan(scene)) {
      // Keep the resolved playback in-point, including performance edits and
      // hand-set clip offsets; only the authored output span changes here.
      // A looping input may repeat to fill a span longer than its source.
      // Insufficient coverage for a non-looping shot is refused before render
      // (#8964), using the preserved playable duration in sourceSec.
      const inSec = clip.inSec || 0;
      // A cut on a sung word may be shorter than the floor; it plays exactly its span (#14820).
      const spanSec = scene.wordCut ? scene.endSec - scene.startSec : Math.max(minClipSec, scene.endSec - scene.startSec);
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

/** Camera frame, overscan and OSD on a footage or still clip. Cards stay full frame, and an unset camera leaves the chain unchanged. */
function withCameraPicture(clip, scene, project) {
  if (!clip || clip.layer === 'card') return clip;
  const camera = shotCamera(project, scene);
  const aspect = MUSIC_VIDEO_CAMERA_FRAME_ASPECTS.includes(camera?.frame?.aspect) ? camera.frame.aspect : null;
  const overscan = musicVideoOverscan(project);
  const date = osdDateText(camera?.osd?.date);
  const record = camera?.osd?.record === true;
  const osd = record || date ? { ...(record ? { record: true } : {}), ...(date ? { date } : {}) } : null;
  if (!aspect && !overscan && !osd) return clip;
  return {
    ...clip,
    ...(aspect ? { cameraFrame: { aspect, matte: typeof camera.frame.matte === 'string' ? camera.frame.matte : '#000000' } } : {}),
    ...(overscan ? { overscan } : {}),
    ...(osd ? { osd } : {}),
  };
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
// A selected clip is never checked against the shot's current frames: the user may
// override or pick any clip and it renders as chosen.

// `decode: false` plans for a read-only caller without host control: the
// performance-take review skips its ffmpeg decode of the song master.
export async function planMusicVideoRender(project, { draft = false, decode = true } = {}) {
  assertMusicVideoMediaSelections(project);
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new ServerError('ffmpeg not found on PATH', { status: 500, code: 'FFMPEG_MISSING' });

  const audioPath = await resolveMasterAudioPath(project);
  assertSongAudioCurrent(project, basename(audioPath));
  // #8977/#9266: refuse a performance take whose scene was re-timed or whose
  // sung window changed in the current master. A draft shows a cutaway instead.
  if (draft) project = await withDraftPerformanceFallbacks(project, audioPath, { decode });
  await assertCurrentPerformanceTakes(project, audioPath, { decode });
  // #8985: a composed render cuts still and card sections into the same
  // timebase as the footage; plain concat renders footage only, as before.
  const composed = project.composition?.mode === 'composed';
  // The cold open (shots marked before the song) is cut on its own clock; the
  // song's pipeline below never sees those shots.
  const songOnly = withSongScenesOnly(project);
  const song = { ...songOnly, scenes: wordTimedScenes(songOnly) };
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
  // A Blender film: the final shot videos joined with the song. It is an ffmpeg
  // join like a footage cut, so the project's film look is a finishing pass.
  blender: {
    label: 'Blender film', modelId: 'music-video-blender', filmLookFinish: true,
    prepare: async (project) => (await import('./blender/finalRender.js')).prepareBlenderFinal(project),
    encode: async (input) => (await import('./blender/finalRender.js')).encodeBlenderFinal(input),
    recordFinal: async (input) => (await import('./blender/finalRender.js')).recordBlenderFinal(input),
  },
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
  assertSongAudioCurrent(project, basename(audioPath));
  if (renderer.performanceTakes) {
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
    totalDuration: plan.durationSec, overlayAbort: new AbortController(), audioRevision: audioRevisionOf(project),
  };
  jobs.set(jobId, job);
  projectRenders.set(projectId, jobId);
  handOff();
  const priorStatus = project.status && project.status !== 'rendering' ? project.status : 'ready';
  await updateProject(projectId, { status: 'rendering', renderingOn, renderAudioRevision: job.audioRevision, renderPartialFilename: filename, renderError: null }).catch((err) => {
    maintenance.markCurrentUnsettled();
    console.error(`❌ Music-video ${renderer.label} render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→rendering write failed: ${err.message}`);
  });
  console.log(`🎬 Rendering ${renderer.label} music video [${jobId.slice(0, 8)}]: project=${projectId.slice(0, 8)} frames=${Math.round(plan.durationSec * plan.fps)} footage=off`);
  const { signal } = job.overlayAbort;
  const writeSettled = (patch) => settleRenderProject(projectId, job, patch.status, { renderError: patch.status === 'failed' ? job.lastError?.slice(0, 2000) || 'Render failed' : null, ...patch.extra }).catch((err) => {
    maintenance.markCurrentUnsettled();
    console.error(`❌ Music-video ${renderer.label} render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→${patch.status} write failed: ${err.message}`);
  });
  // `written`: the success path already committed the row inside its backup lease.
  // `settled`: the success path's own write outcome (see settleRenderProject).
  const finish = async (patch, { written = false, settled } = {}) => {
    releaseProjectRender(projectId);
    if (!written) settled = await writeSettled(patch);
    emitRenderSettled(projectId, job, settled);
    if (options.productionRunId) musicVideoEvents.emit('document-render', { projectId, runId: options.productionRunId, attemptId: options.productionRenderAttemptId, jobId, status: patch.status === 'complete' ? 'completed' : 'failed', error: job.lastError || null, ...(settled === false ? { abandoned: true } : {}) });
    closeJobAfterDelay(jobs, jobId);
    options.maintenancePermit?.finish();
  };
  // A renderer that cannot draw the film look in its page gets the footage renders' finishing
  // pass (filmLookFinish.js), which takes the second half of the progress bar.
  const finishing = Boolean(renderer.filmLookFinish) && filmLookFinishNeeded(project, { shotLooks: true });
  const encodeTop = finishing ? 0.5 : 1;
  Promise.resolve().then(async () => {
    await assertCurrentRenderApproval(projectId, project, options);
    if (signal.aborted) throw Object.assign(new Error('Render cancelled'), { code: 'CANCELED' });
    const encoded = await renderer.encode({
      plan, project, projectId, jobId, audioPath, soundBed, outputPath, signal, lookPass: finishing,
      onProgress: (fraction) => broadcastSse(job, { type: 'progress', progress: encodeTop * fraction }),
    });
    // The ending (cutting room floor, credits; when on) joins after the song.
    const outroSec = await appendStatsOutro({ project, path: outputPath, jobId, signal, withFilmLook: !!renderer.filmLookInPage });
    // After the ending, so the look grades it with the rest of the film. `lookPassInputs` is
    // what the encode left for the pass to draw over the look (a Blender film's steady title card).
    if (finishing) {
      await applyFilmLookFinish({ project, shotLooks: true, path: outputPath, jobId, signal, ...encoded.lookPassInputs,
        onProgress: (fraction) => broadcastSse(job, { type: 'progress', progress: encodeTop + (1 - encodeTop) * fraction }) });
    }
    return outroSec > 0 ? { ...encoded, durationSec: encoded.durationSec + outroSec } : encoded;
  }).then(async (encoded) => {
    job.overlayAbort = null;
    job.status = 'complete';
    let proof = null;
    let settled;
    try {
      await writeCodeProofSheet(outputPath, join(PATHS.videoThumbnails, sheetName), encoded.boundaryTimes, {
        width: encoded.width, height: encoded.height, fps: encoded.fps,
      });
      proof = sheetName;
    } catch (err) {
      console.warn(`⚠️ Music-video ${renderer.label} proof sheet failed [${jobId.slice(0, 8)}]: ${err.message}`);
    }
    const atSec = typeof project.composition?.posterSec === 'number'
      ? project.composition.posterSec + (encoded.leadSec || 0)
      : (encoded.boundaryTimes[0] || 0);
    const completed = { status: 'complete', extra: { renderHistoryId: jobId, renderDependencies: captureMusicVideoEvidence(project, { clipFrames: false }) } };
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
      settled = await writeSettled(completed);
      return poster;
    });
    await retireOldFinals(projectId, jobId);
    // What a renderer keeps about the final it made, once it is the project's final. The video
    // is delivered either way, so a failure here is reported and never fails the render.
    if (settled) {
      await Promise.resolve().then(() => renderer.recordFinal?.({ projectId, jobId, encoded }))
        .catch((err) => console.error(`❌ Music-video ${renderer.label} final record failed [${jobId.slice(0, 8)}]: ${err.message}`));
    }
    await finish(completed, { written: true, settled });
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
  const job = { id: jobId, projectId, status: 'running', clients: [], process: null, totalDuration: plan.songSec, overlayAbort: new AbortController(), audioRevision: audioRevisionOf(project) };
  jobs.set(jobId, job);
  projectRenders.set(projectId, jobId);
  handOff();
  const priorStatus = project.status && project.status !== 'rendering' ? project.status : 'ready';
  const logWriteFailure = (status) => (err) => {
    maintenance.markCurrentUnsettled();
    console.error(`❌ Music-video render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→${status} write failed: ${err.message}`);
  };
  const writeSettled = (status, extra) => settleRenderProject(projectId, job, status, extra).catch(logWriteFailure(status));
  // The mark boot recovery reads to start this render again after a restart:
  // the shots it finished are cached, so the rerun picks up where it stopped.
  const renderResume = options.resumable ? { attempt: options.resumeAttempt || 0 } : null;
  await updateProject(projectId, { status: 'rendering', renderingOn, renderAudioRevision: job.audioRevision, renderPartialFilename: filename, renderError: null, renderResume }).catch(logWriteFailure('rendering'));
  const all = [...plan.segments, ...(plan.outro ? [plan.outro] : [])];
  const cached = all.filter((segment) => existsSync(segment.path)).length;
  console.log(`🎬 Rendering music video [${jobId.slice(0, 8)}]: project=${projectId.slice(0, 8)} segments=${all.length} cached=${cached} duration=${plan.songSec.toFixed(2)}s`);
  const { signal } = job.overlayAbort;
  const finish = (status, settled) => {
    releaseProjectRender(projectId);
    emitRenderSettled(projectId, job, settled);
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
    if (plan.deferredTitleCard) await (await import('./titleCardFinish.js')).applyTitleCardFinish({ project, path: outputPath, jobId, leadSec, songSec: plan.songSec,
      width: plan.width, height: plan.height, fps: plan.fps, signal, ffmpeg: plan.ffmpeg });
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
    let settled;
    const thumb = await withBackupAssetPublication(async () => {
      const poster = await generateThumbnail(outputPath, jobId, { atSec });
      await appendToVideoHistory({
        id: jobId, prompt: `Music Video: ${project.name}`, modelId: 'music-video', seed: 0,
        width: plan.width, height: plan.height, numFrames: Math.round(durationSec * plan.fps), fps: plan.fps,
        filename, thumbnail: poster, createdAt: new Date().toISOString(), musicVideoProjectId: projectId,
      });
      settled = await writeSettled('complete', { renderHistoryId: jobId, renderDependencies: captureMusicVideoEvidence(project, { clipFrames: false }) });
      return poster;
    });
    await retireOldFinals(projectId, jobId);
    // Older takes of each shot are dropped once the new cut is published.
    const pruned = await pruneSegments(plan, { startedAtMs, current: true }).catch(err => { console.warn(`⚠️ Music-video segment cleanup failed: ${err.message}`); return 0; });
    finish('complete', settled);
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
    await writeSettled(status, { renderError: canceled ? null : reason.slice(0, 2000) });
    finish(status);
  });
  return { jobId };
}

async function assertCurrentRenderApproval(projectId, preparedProject, options) {
  const current = await getProject(projectId);
  // The final render needs the approved storyboard; the animated proof is optional.
  assertProductionApproval(current, 'storyboard', { startedBy: options.startedBy });
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
  assertProductionApproval(project, 'storyboard', { startedBy: options?.startedBy });
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
    const cold = coldOpenScenes(project);
    if (seeked && cold.length) {
      let allowed = new Set();
      if (project.composition?.mode === 'blender') {
        const { readBlenderManifest } = await import('./blender/manifest.js');
        const manifest = await readBlenderManifest(project.id);
        const sceneMap = normalizeBlenderRecord(project.blender).sceneMap || {};
        allowed = new Set((manifest?.shots || []).filter((shot) => shot.start < 0).map((shot) => sceneMap[shot.id]).filter(Boolean));
      }
      const stray = cold.filter((scene) => !allowed.has(scene.sceneId));
      if (stray.length) {
        throw new ServerError(`${nameShots(project, stray.map((scene) => scene.sceneId))}: a cold open before the song plays in a footage render. Switch the render style to composed or footage, or move ${stray.length === 1 ? 'the shot' : 'the shots'} back onto the song`,
          { status: 422, code: 'PRE_MUSIC_NEEDS_FOOTAGE' });
      }
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
    const job = { id: jobId, projectId, status: 'running', clients: [], process: null, totalDuration, audioRevision: audioRevisionOf(project) };
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
    await updateProject(projectId, { status: 'rendering', renderingOn, renderAudioRevision: job.audioRevision, renderPartialFilename: filename, renderError: null }).catch((err) => {
      maintenance.markCurrentUnsettled();
      console.error(`❌ Music-video render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→rendering write failed: ${err.message}`);
    });
    const writeSettled = (status, extra) => settleRenderProject(projectId, job, status, extra).catch((updateErr) => {
      maintenance.markCurrentUnsettled();
      console.error(`❌ Music-video render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→${status} write failed: ${updateErr.message}`);
    });

    console.log(`🎬 Rendering music video [${jobId.slice(0, 8)}]: project=${projectId.slice(0, 8)} clips=${clips.length} duration=${totalDuration.toFixed(2)}s`);

    // Terminal failure or cancel across the encode and post-encode passes. A
    // cancel is a user action (stdout); a failure is an error (#7945).
    const settleFailure = async (canceled, reason, { unlinkOutput = true } = {}) => {
      job.status = canceled ? 'canceled' : 'error';
      job.lastError = reason;
      const log = canceled ? console.log : console.error;
      log(`${canceled ? '🛑' : '❌'} Music-video render ${canceled ? 'cancelled' : 'failed'} [${jobId.slice(0, 8)}]: ${reason}`);
      if (unlinkOutput) await unlink(outputPath).catch(() => {});
      broadcastSse(job, { type: canceled ? 'canceled' : 'error', error: reason });
      releaseProjectRender(projectId);
      // A cancel restores the pre-render status (so a cancelled re-render of a
      // 'complete' project stays 'complete'); a real failure marks it 'failed'.
      const targetStatus = canceled ? priorStatus : 'failed';
      await writeSettled(targetStatus, { renderError: canceled ? null : reason.slice(0, 2000) });
      emitRenderSettled(projectId, job);
      closeJobAfterDelay(jobs, jobId);
      permit.finish();
    };

    const runPostEncodePass = async (label, run) => {
      job.overlayAbort = new AbortController();
      const { signal } = job.overlayAbort;
      try {
        await run(signal);
        return true;
      } catch (err) {
        await settleFailure(signal.aborted, signal.aborted ? 'Render cancelled' : `${label} failed: ${err.message}`);
        return false;
      } finally {
        job.overlayAbort = null;
      }
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
          await settleFailure(false, `Failed to spawn ffmpeg: ${err.message}`, { unlinkOutput: false });
        },
        onClose: async (code, signal) => {
          job.process = null;
          await dropGraphFile();
          if (code !== 0) {
            const canceled = isMusicVideoRenderCanceled(job, signal);
            await settleFailure(canceled, canceled ? 'Render cancelled' : signal ? `Killed by signal ${signal}` : `ffmpeg exit ${code}`);
            return;
          }
          // Grade the cold open and outro with the rest of the film.
          if (coldOpen && !await runPostEncodePass('Cold open', async (signal) => {
            const { prependColdOpen } = await import('./coldOpen.js');
            leadSec = await prependColdOpen({ project, coldOpen, path: outputPath, ffmpeg, jobId, signal });
          })) return;
          if (outroSec > 0 && !await runPostEncodePass('Outro scene', (signal) =>
            appendStatsOutro({ project, path: outputPath, jobId, signal }))) return;

          // Step the cut before adding grain and weave, which move every frame.
          const hold = projectFrameHold(project);
          if (hold && !await runPostEncodePass('Frame hold', (signal) =>
            applyFrameHold({ path: outputPath, sections, leadSec, signal, ffmpeg, ...hold }))) return;

          if (finishing && !await runPostEncodePass('Film look pass', (signal) =>
            applyFilmLookFinish({ project, path: outputPath, jobId, signal,
              onProgress: (fraction) => broadcastSse(job, { type: 'progress', progress: encodeTop + (1 - encodeTop) * fraction }) }))) return;

          // Success finalization runs in an event callback (no request to bubble
          // to) — a throw in thumbnailing/history I/O would otherwise leave the
          // project stuck 'rendering' and projectRenders un-cleared (every later
          // render 409s). Wrap it so any failure still emits a terminal frame and
          // releases the slot.
          let settled;
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
              settled = await writeSettled('complete', { renderHistoryId: jobId, renderDependencies: captureMusicVideoEvidence(project, { clipFrames: false }) });
              return poster;
            });
            await retireOldFinals(projectId, jobId);
            emitRenderSettled(projectId, job, settled);
            console.log(`✅ Music video rendered [${jobId.slice(0, 8)}]: ${filename}`);
            broadcastSse(job, { type: 'complete', result: { id: jobId, filename, thumbnail: thumb, path: `/data/videos/${filename}` } });
          } catch (err) {
            permit.markUnsettled();
            job.status = 'error';
            job.lastError = `Finalize failed: ${err.message}`;
            console.error(`❌ Music-video render finalize failed [${jobId.slice(0, 8)}]: ${err.message}`);
            broadcastSse(job, { type: 'error', error: 'Render finalize failed' });
            await writeSettled('failed', { renderError: job.lastError.slice(0, 2000) });
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
  const projects = await listProjects();
  const stuck = projects.filter((p) => p?.status === 'rendering'
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
  const blenderProjectIds = projects.filter((project) => project.composition?.mode === 'blender').map((project) => project.id);
  if (resumes.length || blenderProjectIds.length) scheduleRenderResumes(resumes, blenderProjectIds);
}

// A shot-by-shot final render the user started is started again after a
// restart: every shot it finished is cached, so the rerun only renders the
// shots left and stitches. Bounded, so a render that itself takes the server
// down is not restarted forever.
const MAX_RENDER_RESUMES = 2;
const RENDER_RESUME_DELAY_MS = 15_000;

function scheduleRenderResumes(resumes, projectIds) {
  // After boot settles (maintenance admission, the media lane): the render
  // admits like any other.
  setTimeout(async () => {
    if (projectIds.length) await import('./blender/queue.js').then(({ resumePendingBlenderRenders }) => resumePendingBlenderRenders(projectIds, MAX_RENDER_RESUMES))
      .catch((err) => console.error(`❌ Blender boot recovery could not start: ${err.message}`));
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
