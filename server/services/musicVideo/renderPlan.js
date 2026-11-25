/**
 * Music Video render plan: resolve the master audio, every shot's clip, the
 * beat snap, the cold open and the sound bed into the clip list the final
 * render and the shot segment cache both cut from. Split out of render.js so
 * shotSegments.js can plan without importing the render orchestrator (#17578).
 */
import { shotImageTreatmentAspect } from '../../lib/musicVideo/musicVideoImageTreatments.js';
import { existsSync } from 'fs';
import { basename } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { findFfmpeg, hasAudioStream, safeUnder, probeVideoDuration, probeVideoGeometry } from '../../lib/ffmpeg.js';
import { assertMusicVideoMediaSelections } from '../../lib/musicVideo/musicVideoMediaPolicy.js';
import { loadHistory } from '../videoGen/history.js';
import { getTrack } from '../tracks/index.js';
import { nameShots } from './productionReview.js';
import { resolveMasterAudioPath } from './masterAudioPath.js';
import { COVERAGE_TOLERANCE_SEC, MUSIC_VIDEO_FRAME_FITS, clipLoops, clipNeedsMoreFootage, clipPlaybackWindow, clipReversed, sceneHasAuthoredSpan, sceneUsesAuthoredTiming, sceneVisualLayer, wordTimedScenes } from '../../lib/musicVideo/musicVideoLayers.js';
import { assertSongAudioCurrent } from '../../lib/musicVideo/musicVideoSongAudio.js';
import { musicVideoAspect } from '../../lib/musicVideo/musicVideoAspect.js';
import { coldOpenPlan, withSongScenesOnly } from '../../lib/musicVideo/musicVideoColdOpen.js';
import { selectedPerformanceInstruction } from '../../lib/musicVideo/musicVideoShotTiming.js';
import { resolveSourceTake, scenePlayableClipId } from '../../lib/musicVideo/musicVideoSourceTake.js';
import { assertCurrentPerformanceTakes, withDraftPerformanceFallbacks } from './performanceShot.js';
import { songClipSound } from '../../lib/musicVideo/musicVideoClipSound.js';
import { projectSoundBed } from './soundBed.js';
import { audioLayerBeds } from './audioLayers.js';
import { rendersIntercut, usesLoudTierEverywhere } from '../../lib/musicVideo/musicVideoProductionMedium.js';
import { plannedTransitions, sceneCutEffect } from '../../lib/musicVideo/musicVideoCutEffects.js';
import { applyCameraCutDefaults, sceneTransitions } from '../../lib/musicVideo/musicVideoTransitions.js';
import { MUSIC_VIDEO_CAMERA_FRAME_ASPECTS, musicVideoOverscan, shotCamera } from '../../lib/musicVideo/musicVideoFilmLook.js';
import { stillMoveForCamera } from '../../lib/cameraMovements.js';
import { isEndFrameImageEffect, sceneImageEffect, scenePhotoSequence } from '../../lib/musicVideo/musicVideoImageEffects.js';
import { osdDateText } from './renderFfmpegArgs.js';

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
function sectionClip(scene, layer, planned, { layered, project }) {
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
  return stillClip(scene, section, { layered, project });
}

// Lazy import pays for Sharp only when at least one image is treated.
async function treatedRenderPath(scene, id, original, project) {
  if (!original || !scene.imageTreatments?.length) return original;
  const { resolveTreatedShotImage } = await import('./imageTreatments.js');
  return resolveTreatedShotImage(scene, id, original, shotImageTreatmentAspect(project, scene, id));
}

async function stillClip(scene, section, { layered, project }) {
  const sequence = layered && scenePhotoSequence(scene);
  const photoPaths = sequence ? await Promise.all(sequence.imageIds.map(async id => {
    const original = safeUnder(PATHS.images, id);
    return original && existsSync(original) ? treatedRenderPath(scene, id, original, project) : null;
  })) : null;
  if (sequence && (!photoPaths.length || photoPaths.some(path => !path || !existsSync(path)))) {
    throw new ServerError('A selected sequence photo is missing. Pick the missing photos before rendering.', {
      status: 404, code: 'MISSING_SEQUENCE_PHOTOS', context: { sceneId: scene.sceneId,
        imageIds: sequence.imageIds.filter((id, i) => !photoPaths[i] || !existsSync(photoPaths[i])) },
    });
  }
  const source = photoPaths?.[0] || (scene.referenceImageId ? safeUnder(PATHS.images, scene.referenceImageId) : null);
  if (!source || !existsSync(source)) return { problem: 'missing-still' };
  const imagePath = photoPaths?.[0] || await treatedRenderPath(scene, scene.referenceImageId, source, project);
  // The shot's Move plays as set; a planned camera move (#10589) only seeds it when the shot is made.
  // An image effect (a camera flash that develops, musicVideoImageEffects.js) plays over the still.
  // An end-frame effect also reads the shot's end frame; without it on disk the still plays alone.
  const effect = sceneImageEffect(scene, { layered });
  const endSource = effect && isEndFrameImageEffect(effect.effect) ? safeUnder(PATHS.images, scene.endImageId) : null;
  const endImagePath = endSource && existsSync(endSource) ? await treatedRenderPath(scene, scene.endImageId, endSource, project) : null;
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
async function footageClip(scene, entry, planned, editOverride = undefined, project = null) {
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
    ...await footageFrameFit(scene, project),
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
      ? await footageClip(shot, historyMap.get(played.videoHistoryId), planned, resolved ? { inSec: resolved.inSec, outSec: resolved.outSec } : undefined, project)
      : await sectionClip(shot, layer, planned, { layered, project });
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
async function footageFrameFit(scene, project) {
  const fit = MUSIC_VIDEO_FRAME_FITS.includes(scene.frameFit) ? scene.frameFit : 'fill';
  if (fit !== 'still') return { frameFit: fit };
  const stillPath = scene.referenceImageId ? safeUnder(PATHS.images, scene.referenceImageId) : null;
  return stillPath && existsSync(stillPath)
    ? { frameFit: 'still', stillPath: await treatedRenderPath(scene, scene.referenceImageId, stillPath, project) }
    : { frameFit: 'black' };
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
  // Lazy: only an intercut project loads the re-cutter.
  const clips = rendersIntercut(project)
    ? (await import('./intercut.js')).intercutClips(snapped, {
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
