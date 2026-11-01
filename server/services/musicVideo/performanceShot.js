import { assertShotActionContract } from '../../lib/musicVideoActionContract.js';
/**
 * Music Video performance shots (#8977) — the submission-boundary half.
 *
 * A performance scene (`scene.shotMode === 'performance'`) is a visible singer
 * that must follow the MASTER recording. At the moment a scene render is
 * submitted this module:
 *
 *   1. refuses the render unless the resolved backend has a verified
 *      source-audio lip-sync capability (lib/musicVideoShotTiming.js) — Grok and
 *      local lanes are cutaway-only, and nothing silently falls back to a lane
 *      that would invent an unrelated voice or ignore the song;
 *   2. plans the provider-bounded audio window (a short shot is padded to a
 *      supported contextual window with an explicit edit in-point; an over-long
 *      shot is refused so it is split rather than truncated by the provider);
 *   3. slices exactly that window out of the master with ffmpeg — decoded from
 *      the start and cut with `atrim` on sample timestamps, written as PCM WAV
 *      (no encoder priming delay), so the clip's audio timebase IS the song's;
 *   4. builds the immutable shot instruction record the finished take carries:
 *      the audio revision (content hash), absolute song interval, window, edit
 *      in/out points, clip-relative lyric cues, reference frame, intended
 *      performance, capability snapshot, target edit duration and the coverage
 *      the provider will generate.
 *
 * When the project carries a vocal stem (vocalStem.js) the window is cut from
 * the stem instead of the mix, at the same song times, after re-checking that
 * the stem still shares the master's timebase. The instruction records which
 * recording conditioned the take.
 *
 * The sliced WAV is staged under data/uploads so the media-job queue owns and
 * deletes it on every terminal path (completion, failure, cancel, restart).
 * The master stays untouched and remains the only audio in the final render.
 */

import { createHash, randomUUID } from 'crypto';
import { createReadStream, existsSync } from 'fs';
import { unlink } from 'fs/promises';
import { basename, join } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { findFfmpeg, probeVideoDuration, runFfmpegProcess, safeUnder } from '../../lib/ffmpeg.js';
import { compareWindowFingerprint, computeRmsEnvelope, windowFingerprint } from '../../lib/audioFingerprint.js';
import { getFalVideoModel } from '../../lib/falVideoModels.js';
import {
  clipRelativeCues,
  isPerformanceScene,
  performanceBlockedReason,
  performanceCapability,
  planPerformanceWindow,
  selectedPerformanceInstruction,
  SOURCE_AUDIO_MUSIC,
} from '../../lib/musicVideoShotTiming.js';
import { clipOffsetSec, clipReversed, clipSpeedRate } from '../../lib/musicVideoLayers.js';
import { getProject } from './projects.js';
import { clipLocks, nameShots } from './productionReview.js';
import { assertVocalStemTimebase, resolveVocalStemPath } from './vocalStem.js';

export const SHOT_INSTRUCTION_VERSION = 2;

const hashFile = (path) => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(path)
    .on('data', (chunk) => hash.update(chunk))
    .on('error', reject)
    .on('end', () => resolve(hash.digest('hex')));
});

/**
 * Cut `[startSec, endSec]` of `sourcePath` into a new PCM WAV at `outPath`.
 */
async function sliceAudioWindow(sourcePath, outPath, { startSec, endSec }) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new ServerError('ffmpeg is required to slice the song for a performance shot', { status: 500, code: 'FFMPEG_MISSING' });
  const result = await runFfmpegProcess({
    bin: ffmpeg,
    args: [
      '-v', 'error',
      '-i', sourcePath,
      '-vn',
      '-af', `atrim=start=${startSec}:end=${endSec},asetpts=PTS-STARTPTS`,
      '-c:a', 'pcm_s16le',
      '-y', outPath,
    ],
  });
  if (!result.ok) {
    await unlink(outPath).catch(() => {});
    throw new ServerError(`Failed to slice the song for a performance shot: ${result.reason}`, { status: 500, code: 'MUSIC_VIDEO_AUDIO_SLICE_FAILED' });
  }
  return outPath;
}

const refuse = (message, code, status = 400) => new ServerError(message, { status, code });

// A shot's Offset moves its clip in whole 24 fps frames, so a slid shot whose
// Offset lines its take back up with the song lands within half a frame.
const IN_SYNC_SEC = 0.5 / 24;

/**
 * Whether a take still plays its sung audio under the words after the shot
 * was re-timed. The render starts the take at its in-point plus `Offset`, at
 * the shot's (new) start: the song moment it plays there is the one at its
 * in-point (`madeAtSec`) plus that Offset. A shot whose start did not
 * move (stretched or shortened at its end), or one slid with a matching
 * Offset, is in sync; the render's coverage check still refuses a shot the
 * take runs out under. A speed change always puts the mouth off the words.
 */
// The song moment a lip-sync take plays at its edit in-point, as the render
// places it: the take's audio window starts at clip time 0.
const madeAtSec = (instruction) => (Number.isFinite(instruction.audioWindow?.startSec)
  ? instruction.audioWindow.startSec + instruction.edit.inSec : instruction.songInterval?.startSec);

const playsInSync = (scene, madeAtSec) => Number.isFinite(madeAtSec) && clipSpeedRate(scene) === 1 && !clipReversed(scene)
  && Math.abs(madeAtSec + clipOffsetSec(scene) - scene.startSec) <= IN_SYNC_SEC;

const STALE_REASON_LABELS = Object.freeze({
  'not-lip-synced': 'no lip-sync record',
  retimed: 're-timed',
  'audio-changed': 'sung window changed in the song',
});

// A take made before #9266 carries no window fingerprint. Its old master can
// still be found among the linked track's earlier renders (the library keeps
// every take's bytes under data/music/), matched by the content hash the take
// recorded. Hashes and envelopes are computed at most once per file per check.
function legacyMasterLookup(project, masterPath) {
  let candidates = null;
  const envelopes = new Map();
  const listCandidates = async () => {
    if (candidates) return candidates;
    candidates = [];
    if (!project?.trackId) return candidates;
    const { getTrack } = await import('../tracks/index.js');
    const track = await getTrack(project.trackId).catch(() => null);
    const seen = new Set([masterPath]);
    for (const render of Array.isArray(track?.renders) ? track.renders : []) {
      const path = render?.audioFilename ? safeUnder(PATHS.music, render.audioFilename) : null;
      if (!path || seen.has(path) || !existsSync(path)) continue;
      seen.add(path);
      candidates.push({ path, sha256: null });
    }
    return candidates;
  };
  return async function envelopeForSha(sha256) {
    if (typeof sha256 !== 'string' || !sha256) return null;
    if (envelopes.has(sha256)) return envelopes.get(sha256);
    let envelope = null;
    for (const candidate of await listCandidates()) {
      candidate.sha256 ??= await hashFile(candidate.path).catch(() => '');
      if (candidate.sha256 !== sha256) continue;
      envelope = await computeRmsEnvelope(candidate.path);
      break;
    }
    envelopes.set(sha256, envelope);
    return envelope;
  };
}

/**
 * Review every performance scene's SELECTED clip against the current master.
 * Returns `[{ sceneId, reason, stale }]`:
 *
 *   - `not-lip-synced` (stale) — no performance instruction: a cutaway render
 *     or an import made before the scene became a performance;
 *   - `audio-changed` (stale) — the master was replaced AND the take's own
 *     audio window sounds different in it;
 *   - `retimed` (stale) — the shot moved since the take, and its Offset (or a
 *     speed change) no longer plays the take's audio under the song;
 *   - `audio-rehashed` (NOT stale, informational) — the master's bytes
 *     changed (a re-master or re-encode) but the take's window did not.
 *
 * Staleness is judged on the take's window, not the whole file (#9266): the
 * take's stored loudness fingerprint (or, for an older take, the same window
 * of its old master when that file is still in the track's render history)
 * is compared with the new master. With neither, a changed master is stale.
 * The master is hashed only when there is a performance take to check, and
 * decoded only when its hash changed. `decode: false` (a read-only caller
 * without host control) never starts that ffmpeg decode: a rehashed master's
 * window is taken as unchanged, and the renders that follow re-check it.
 */
async function reviewPerformanceTakes(project, masterPath, { decode = true } = {}) {
  const results = [];
  const selected = [];
  let sha256 = null;
  for (const scene of Array.isArray(project?.scenes) ? project.scenes : []) {
    const supplied = (scene.takes || []).find((take) => take.kind === 'video' && take.assetId === scene.videoHistoryId)?.shotInstruction;
    if (scene.videoHistoryId && !['still', 'card', 'code'].includes(scene.visualLayer) && supplied?.audioConditioning) {
      sha256 ??= await hashFile(masterPath);
      if (supplied.audioConditioning.sourceSha256 !== sha256) results.push({ sceneId: scene.sceneId, reason: 'source-audio-changed', stale: true });
      else if (!playsInSync(scene, supplied.audioConditioning.startSample / 48000)) results.push({ sceneId: scene.sceneId, reason: 'retimed', stale: true });
    }
    // A supplied-audio take (local LTX hearing the song) was judged above.
    if (!isPerformanceScene(scene) || !scene.videoHistoryId || supplied?.audioConditioning) continue;
    const instruction = selectedPerformanceInstruction(scene);
    if (instruction) selected.push({ scene, instruction });
    else results.push({ sceneId: scene.sceneId, reason: 'not-lip-synced', stale: true });
  }
  if (selected.length === 0) return results;
  sha256 ??= await hashFile(masterPath);
  let currentEnvelope = null;
  const oldEnvelope = legacyMasterLookup(project, masterPath);
  const windowUnchanged = async (instruction) => {
    if (!decode) return true;
    let fingerprint = instruction.audio?.windowFingerprint;
    if (!fingerprint) {
      const envelope = await oldEnvelope(instruction.audio?.sha256);
      fingerprint = envelope && instruction.audioWindow ? windowFingerprint(envelope, instruction.audioWindow) : null;
      if (!fingerprint) return false;
    }
    currentEnvelope ??= await computeRmsEnvelope(masterPath);
    return compareWindowFingerprint(fingerprint, currentEnvelope).same;
  };
  for (const { scene, instruction } of selected) {
    const rehashed = instruction.audio?.sha256 !== sha256;
    // A window that cannot be compared (decode failure) stays stale — the
    // pre-#9266 answer — rather than rendering a take out of sync.
    const unchanged = !rehashed || await windowUnchanged(instruction).catch((err) => {
      console.warn(`⚠️ Music Video: could not compare scene ${scene.sceneId}'s sung window with the new master: ${err.message}`);
      return false;
    });
    if (!unchanged) results.push({ sceneId: scene.sceneId, reason: 'audio-changed', stale: true });
    else if (!playsInSync(scene, madeAtSec(instruction))) {
      results.push({ sceneId: scene.sceneId, reason: 'retimed', stale: true });
    } else if (rehashed) results.push({ sceneId: scene.sceneId, reason: 'audio-rehashed', stale: false });
  }
  return results;
}

/** The stale entries of `reviewPerformanceTakes`: `[{ sceneId, reason }]`. */
export async function findStalePerformanceTakes(project, masterPath, options) {
  return (await reviewPerformanceTakes(project, masterPath, options))
    .filter((r) => r.stale)
    .map(({ sceneId, reason }) => ({ sceneId, reason }));
}

/**
 * A draft never waits on lip sync. Each performance (or supplied-audio) shot
 * whose selected take is stale for the current song stands in as a cutaway:
 * its newest cutaway clip (a video take with no performance or song-audio
 * instruction), else its still. Final renders keep the strict gate below.
 */
export async function withDraftPerformanceFallbacks(project, masterPath, options) {
  const stale = new Set((await findStalePerformanceTakes(project, masterPath, options)).map(({ sceneId }) => sceneId));
  if (!stale.size) return project;
  return { ...project, scenes: project.scenes.map((scene) => {
    if (!stale.has(scene.sceneId)) return scene;
    const cutaway = (scene.takes || []).filter((take) => take?.kind === 'video' && take.assetId
      && take.shotInstruction?.shotMode !== 'performance' && !take.shotInstruction?.audioConditioning).at(-1);
    return { ...scene, shotMode: 'cutaway', videoHistoryId: cutaway?.assetId || null };
  }) };
}

/**
 * The one staleness gate every renderer that draws performance takes runs
 * (concat, composed, document, and their excerpts): a performance take sings
 * one stretch of one recording, so a re-timed scene or a changed sung window
 * would put mouth motion over the wrong audio. A shot whose clip is locked
 * renders as locked: the director approved that clip as it plays. Any other
 * stale shot blocks, named by number with its reason. Throws 422
 * STALE_PERFORMANCE_TAKES (or MUSIC_VIDEO_STALE_SOURCE_AUDIO_TAKES when a
 * supplied-audio take is among them); `context.stale` lists
 * `{ sceneId, reason, cutaway }`, `cutaway` marking the shots a switch to
 * Cutaway fixes: those with no lip-sync take. A lip-sync take switched to
 * Cutaway loses its in-point and plays from its first frame, out of sync.
 */
export async function assertCurrentPerformanceTakes(project, masterPath, options) {
  const reviewed = await reviewPerformanceTakes(project, masterPath, options);
  const rehashed = reviewed.filter((r) => r.reason === 'audio-rehashed').length;
  // An unchecked window (decode: false) proves nothing, so it logs nothing.
  if (rehashed > 0 && options?.decode !== false) console.log(`🎵 Music Video: ${rehashed} lip-sync take${rehashed === 1 ? '' : 's'} still match${rehashed === 1 ? 'es' : ''} the re-mastered song in ${rehashed === 1 ? 'its' : 'their'} sung window`);
  // Legacy approval compatibility: clips locked before lock removal stay exempt.
  const locks = clipLocks(project);
  const stale = reviewed.filter((r) => r.stale && locks?.[r.sceneId] !== 'locked')
    .map(({ sceneId, reason }) => ({ sceneId, reason, cutaway: reason === 'not-lip-synced' }));
  if (stale.length === 0) return;
  const shots = nameShots(project, stale.map(({ sceneId, reason }) => ({ sceneId, note: STALE_REASON_LABELS[reason] || reason })));
  const one = stale.length === 1;
  const them = one ? 'it' : 'them';
  const fixes = [`Regenerate ${them}`,
    ...(stale.every((entry) => entry.cutaway) ? [`switch ${them} to Cutaway`] : [])];
  const fix = fixes.length > 1 ? `${fixes.slice(0, -1).join(', ')} or ${fixes.at(-1)}` : fixes[0];
  const suppliedAudio = ({ sceneId }) => {
    const scene = project.scenes.find((entry) => entry.sceneId === sceneId);
    return !!scene?.takes?.some((take) => take.assetId === scene.videoHistoryId && take.shotInstruction?.audioConditioning);
  };
  const code = stale.some(suppliedAudio) ? 'MUSIC_VIDEO_STALE_SOURCE_AUDIO_TAKES' : 'STALE_PERFORMANCE_TAKES';
  throw new ServerError(`${shots}: the selected take may not sing in sync with the song. ${fix}`,
    { status: 422, code, context: { stale } });
}

/**
 * Prepare a Music Video scene render's performance inputs.
 *
 * Returns `null` for a cutaway scene (nothing to add), or
 * `{ audioFilePath, shotInstruction, modelId, resolution, enableTranscription }`
 * (`enableTranscription` is off when the project sets `videoSettings.falLipSyncTranscription: false`)
 * for a performance scene on a capable backend. `resolution` is the take's
 * output resolution: the request's own when the lip-sync route offers it, else
 * the project's `videoSettings.falLipSyncResolution`, else the capability
 * default (1080P). `musicModelId` is a music-driven model picked for this one
 * take (ignored unless it is a curated music lane). Throws a 4xx ServerError when the scene is a performance
 * shot the backend or its timing cannot deliver.
 */
export async function preparePerformanceShot({ musicVideo, backend, sourceImagePath, mode, resolution = null, musicModelId = null }) {
  if (!musicVideo?.projectId || !musicVideo?.sceneId) return null;
  const project = await getProject(musicVideo.projectId);
  const scene = project?.scenes?.find((s) => s.sceneId === musicVideo.sceneId);
  // An unknown project/scene is not a performance shot; the render proceeds as
  // before and the completion hook refuses to attach it to a deleted scene.
  assertShotActionContract(scene);
  if (!isPerformanceScene(scene)) return null;
  if (scene.performanceRepair) {
    const { assertRevisionOpenForGeneration } = await import('./revision.js');
    if (musicVideo.revisionId !== scene.performanceRepair.revisionId) throw refuse('A continuation must use its reserved repair revision', 'PERFORMANCE_REPAIR_REVISION_REQUIRED', 409);
    assertRevisionOpenForGeneration(project, musicVideo.revisionId, { sceneId: scene.sceneId, kind: 'video' });
    if (!sourceImagePath || basename(sourceImagePath) !== scene.referenceImageId) throw refuse('Use the accepted boundary frame for this continuation', 'PERFORMANCE_REPAIR_STALE', 409);
  }

  // A music-driven scene renders on the project's audio-to-video model; a
  // lip-sync scene on the lip-sync route.
  // A shot card can pick another music-driven model for this take (one PortOS curates, else the project's).
  const picked = backend === 'fal' && musicModelId && Object.hasOwn(SOURCE_AUDIO_MUSIC.fal, musicModelId);
  const videoSettings = picked ? { ...project.videoSettings, falMusicModelId: musicModelId } : project.videoSettings;
  const capability = performanceCapability(backend, { scene, videoSettings });
  if (!capability) throw refuse(performanceBlockedReason(backend), 'MUSIC_VIDEO_PERFORMANCE_UNSUPPORTED');
  const musicDriven = capability.style === 'music';
  // The lip-sync route is image + source audio; any other semantic mode would
  // ask it for something it does not do. Local LTX renders it as a2v, which
  // the audio-reactive local lane already asks for.
  if (mode && mode !== 'image' && !(mode === 'a2v' && capability.provider === 'local')) {
    throw refuse(`A performance shot renders from its reference frame and the song — mode '${mode}' is not supported.`, 'MUSIC_VIDEO_PERFORMANCE_MODE_UNSUPPORTED');
  }

  // Lazy: render.js pulls the whole render pipeline, which a cutaway
  // submission (the common case) never needs.
  const { resolveMasterAudioPath } = await import('./render.js');
  const masterPath = await resolveMasterAudioPath(project);
  if (scene.performanceRepair) await assertCurrentPerformanceTakes(project, masterPath);
  const songDurationSec = await probeVideoDuration(masterPath);
  if (songDurationSec == null) throw refuse('Could not read the song duration for this performance shot', 'MUSIC_VIDEO_AUDIO_UNREADABLE');
  // The shot card's "Whole sung line" asks for a take covering the full line
  // the shot sits in; a continuation only ever re-renders its own interval.
  const lineCues = musicVideo.wholeLine === true && !scene.performanceRepair ? (project.lyricCues || []) : null;
  const plan = planPerformanceWindow({ startSec: scene.startSec, endSec: scene.endSec, songDurationSec, capability, lineCues });
  if (!plan.ok) throw refuse(plan.message, plan.code);
  if (scene.performanceRepair && (plan.windowStartSec !== scene.startSec || plan.windowEndSec !== scene.endSec)) {
    throw refuse('Review needed: this provider cannot continue only the remaining audio interval', 'PERFORMANCE_REPAIR_REVIEW_NEEDED', 409);
  }
  const offered = getFalVideoModel(capability.modelId)?.resolution?.options || capability.resolutions || [];
  const pick = (value) => (typeof value === 'string' ? offered.find((o) => o.toLowerCase() === value.trim().toLowerCase()) : null);
  const pinnedResolution = musicDriven ? project.videoSettings?.falMusicResolution : project.videoSettings?.falLipSyncResolution;
  const takeResolution = pick(resolution) || pick(pinnedResolution) || capability.defaultResolution;

  // An optional vocal stem conditions the provider in place of the mix. It
  // is re-checked here because the file could have been replaced on disk or
  // arrived from a peer since it was attached.
  // A music-driven take always hears the full mix: the drums, bass and
  // everything else a vocal stem leaves out are what drive its motion.
  const conditioningSource = musicDriven ? 'master'
    : project.performanceConditioningSource || (project.vocalStemFilename ? 'vocal-stem' : 'master');
  const stemPath = conditioningSource === 'master' ? null : resolveVocalStemPath(project);
  if (conditioningSource !== 'master' && !stemPath) throw refuse('Attach the selected singer stem before rendering', 'MUSIC_VIDEO_VOCAL_STEM_MISSING');
  if (stemPath) assertVocalStemTimebase(await probeVideoDuration(stemPath), songDurationSec);

  const audioSha256 = await hashFile(masterPath);
  // #9266: the MASTER's loudness over this window, so a later re-master that
  // leaves these bars alone keeps the take. Best-effort — a take without one
  // falls back to the old-master lookup, and then to whole-file staleness.
  const windowFingerprintRecord = await computeRmsEnvelope(masterPath)
    .then((envelope) => windowFingerprint(envelope, { startSec: plan.windowStartSec, endSec: plan.windowEndSec }))
    .catch((err) => {
      console.warn(`⚠️ Music Video: could not fingerprint the performance window for scene ${scene.sceneId}: ${err.message}`);
      return null;
    });
  const conditioningSha256 = stemPath ? await hashFile(stemPath) : audioSha256;
  await ensureDir(PATHS.uploads);
  const audioFilePath = join(PATHS.uploads, `mv-performance-${randomUUID()}.wav`);
  await sliceAudioWindow(stemPath || masterPath, audioFilePath, { startSec: plan.windowStartSec, endSec: plan.windowEndSec });
  // Verify the cut before anything is paid for: the provider rejects short
  // audio and silently clips long audio, and both would break the edit points.
  const slicedSec = await probeVideoDuration(audioFilePath);
  if (slicedSec == null || slicedSec < capability.minAudioSec || slicedSec > capability.maxAudioSec) {
    await unlink(audioFilePath).catch(() => {});
    throw refuse(
      `The sliced performance audio is ${slicedSec == null ? 'unreadable' : `${slicedSec.toFixed(3)}s`} — outside ${capability.label}'s ${capability.minAudioSec}–${capability.maxAudioSec}s window.`,
      'MUSIC_VIDEO_PERFORMANCE_AUDIO_INVALID',
      500,
    );
  }

  // Transcript guidance is on by default where the route offers it; a project
  // can turn it off (videoSettings.falLipSyncTranscription === false) when the
  // provider's transcript mishears sung words and shapes the mouth for them.
  const transcription = capability.transcription === true && project.videoSettings?.falLipSyncTranscription !== false;
  const shotInstruction = {
    version: SHOT_INSTRUCTION_VERSION,
    ...(scene.performanceRepair ? { repair: { ...scene.performanceRepair, role: 'continuation' } } : {}),
    shotMode: 'performance',
    performanceStyle: capability.style,
    createdAt: new Date().toISOString(),
    speaker: scene.performanceSpeaker || null,
    audio: {
      source: project.trackId ? 'track' : 'upload',
      sha256: audioSha256,
      songDurationSec,
      windowFingerprint: windowFingerprintRecord,
      // What the provider heard: the master itself, or a vocal stem on the
      // master's timebase. `sha256` above stays the master's, so a take
      // is stale only when the song changes, not when a stem is swapped —
      // and then only when `windowFingerprint` says this window changed.
      conditioning: {
        source: conditioningSource, sha256: conditioningSha256, filename: basename(stemPath || masterPath),
        selection: musicDriven ? 'music-driven' : project.performanceConditioningSource ? 'user' : 'legacy-default',
        voiceIsolation: 'unverified',
      },
    },
    songInterval: { startSec: scene.startSec, endSec: scene.endSec },
    audioWindow: {
      startSec: plan.windowStartSec, endSec: plan.windowEndSec, durationSec: plan.windowSec,
      ...(lineCues && !plan.lineTooLong ? { wholeLine: { startSec: plan.lineStartSec, endSec: plan.lineEndSec } } : {}),
    },
    edit: { inSec: plan.editInSec, outSec: plan.editOutSec, targetSec: plan.spanSec },
    cues: clipRelativeCues(project.lyricCues, plan.windowStartSec, plan.windowEndSec),
    referenceImageId: typeof sourceImagePath === 'string' ? basename(sourceImagePath) : null,
    performance: (scene.visualIntent || scene.prompt || '').slice(0, 2000),
    capability: {
      provider: capability.provider,
      style: capability.style,
      modelId: capability.modelId,
      minAudioSec: capability.minAudioSec,
      maxAudioSec: capability.maxAudioSec,
      transcription: capability.transcription,
      resolution: takeResolution,
    },
    // Whether this take asked the provider to transcribe the audio first.
    transcription,
    // The provider's output length follows the submitted audio.
    generatedCoverageSec: plan.windowSec,
  };
  return {
    audioFilePath,
    shotInstruction,
    modelId: capability.modelId,
    resolution: takeResolution,
    enableTranscription: transcription,
  };
}
