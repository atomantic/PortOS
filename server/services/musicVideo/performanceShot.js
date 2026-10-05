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
} from '../../lib/musicVideoShotTiming.js';
import { getProject } from './projects.js';
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

// Recorded vs current scene times agree within a millisecond.
const SAME_TIME_SEC = 0.001;

const STALE_REASON_LABELS = Object.freeze({
  'not-lip-synced': 'not lip-synced',
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
 *   - `retimed` (stale) — the scene's song interval moved since the take;
 *   - `audio-rehashed` (NOT stale, informational) — the master's bytes
 *     changed (a re-master or re-encode) but the take's window did not.
 *
 * Staleness is judged on the take's window, not the whole file (#9266): the
 * take's stored loudness fingerprint (or, for an older take, the same window
 * of its old master when that file is still in the track's render history)
 * is compared with the new master. With neither, a changed master is stale.
 * The master is hashed only when there is a performance take to check, and
 * decoded only when its hash changed.
 */
async function reviewPerformanceTakes(project, masterPath) {
  const results = [];
  const selected = [];
  let sha256 = null;
  for (const scene of Array.isArray(project?.scenes) ? project.scenes : []) {
    const supplied = (scene.takes || []).find((take) => take.kind === 'video' && take.assetId === scene.videoHistoryId)?.shotInstruction;
    if (scene.videoHistoryId && !['still', 'card', 'code'].includes(scene.visualLayer) && supplied?.audioConditioning) {
      sha256 ??= await hashFile(masterPath);
      if (supplied.audioConditioning.sourceSha256 !== sha256) results.push({ sceneId: scene.sceneId, reason: 'source-audio-changed', stale: true });
      else if (Math.round(scene.startSec * 48000) !== supplied.audioConditioning.startSample
        || scene.endSec !== supplied.songInterval?.endSec) results.push({ sceneId: scene.sceneId, reason: 'retimed', stale: true });
    }
    if (!isPerformanceScene(scene) || !scene.videoHistoryId) continue;
    const instruction = selectedPerformanceInstruction(scene);
    if (instruction) selected.push({ scene, instruction });
    else results.push({ sceneId: scene.sceneId, reason: 'not-lip-synced', stale: true });
  }
  if (selected.length === 0) return results;
  sha256 ??= await hashFile(masterPath);
  let currentEnvelope = null;
  const oldEnvelope = legacyMasterLookup(project, masterPath);
  const windowUnchanged = async (instruction) => {
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
    const interval = instruction.songInterval || {};
    const rehashed = instruction.audio?.sha256 !== sha256;
    // A window that cannot be compared (decode failure) stays stale — the
    // pre-#9266 answer — rather than rendering a take out of sync.
    const unchanged = !rehashed || await windowUnchanged(instruction).catch((err) => {
      console.warn(`⚠️ Music Video: could not compare scene ${scene.sceneId}'s sung window with the new master: ${err.message}`);
      return false;
    });
    if (!unchanged) results.push({ sceneId: scene.sceneId, reason: 'audio-changed', stale: true });
    else if (!(Math.abs(interval.startSec - scene.startSec) <= SAME_TIME_SEC && Math.abs(interval.endSec - scene.endSec) <= SAME_TIME_SEC)) {
      results.push({ sceneId: scene.sceneId, reason: 'retimed', stale: true });
    } else if (rehashed) results.push({ sceneId: scene.sceneId, reason: 'audio-rehashed', stale: false });
  }
  return results;
}

/** The stale entries of `reviewPerformanceTakes`: `[{ sceneId, reason }]`. */
export async function findStalePerformanceTakes(project, masterPath) {
  return (await reviewPerformanceTakes(project, masterPath))
    .filter((r) => r.stale)
    .map(({ sceneId, reason }) => ({ sceneId, reason }));
}

/**
 * The one staleness gate every renderer that draws performance takes runs
 * (concat, composed, document, and their excerpts): a performance take sings
 * one stretch of one recording, so a re-timed scene or a changed sung window
 * would put mouth motion over the wrong audio. Throws 422
 * STALE_PERFORMANCE_TAKES naming each scene's reason.
 */
export async function assertCurrentPerformanceTakes(project, masterPath) {
  const reviewed = await reviewPerformanceTakes(project, masterPath);
  const rehashed = reviewed.filter((r) => r.reason === 'audio-rehashed').length;
  if (rehashed > 0) console.log(`🎵 Music Video: ${rehashed} lip-sync take${rehashed === 1 ? '' : 's'} still match${rehashed === 1 ? 'es' : ''} the re-mastered song in ${rehashed === 1 ? 'its' : 'their'} sung window`);
  const stale = reviewed.filter((r) => r.stale).map(({ sceneId, reason }) => ({ sceneId, reason }));
  if (stale.length === 0) return;
  if (stale.some(({ sceneId }) => {
    const scene = project.scenes.find((entry) => entry.sceneId === sceneId);
    return scene?.takes?.some((take) => take.assetId === scene.videoHistoryId && take.shotInstruction?.audioConditioning);
  })) {
    throw new ServerError('A supplied-audio shot no longer matches the selected recording or scene interval; regenerate it before rendering',
      { status: 422, code: 'MUSIC_VIDEO_STALE_SOURCE_AUDIO_TAKES', context: { stale } });
  }
  const counts = new Map();
  for (const { reason } of stale) counts.set(reason, (counts.get(reason) || 0) + 1);
  const why = [...counts].map(([reason, n]) => `${n} ${STALE_REASON_LABELS[reason] || reason}`).join(', ');
  throw new ServerError(
    `${stale.length} performance shot${stale.length === 1 ? ' has' : 's have'} no lip-synced take of the current song interval and recording (${why}) — regenerate ${stale.length === 1 ? 'it' : 'them'}, or switch to Cutaway, before rendering`,
    { status: 422, code: 'STALE_PERFORMANCE_TAKES', context: { stale } },
  );
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
 * default (1080P). Throws a 4xx ServerError when the scene is a performance
 * shot the backend or its timing cannot deliver.
 */
export async function preparePerformanceShot({ musicVideo, backend, sourceImagePath, mode, resolution = null }) {
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

  const capability = performanceCapability(backend);
  if (!capability) throw refuse(performanceBlockedReason(backend), 'MUSIC_VIDEO_PERFORMANCE_UNSUPPORTED');
  // The lip-sync route is image + source audio; any other semantic mode would
  // ask it for something it does not do.
  if (mode && mode !== 'image') {
    throw refuse(`A performance shot renders from its reference frame and the song — mode '${mode}' is not supported.`, 'MUSIC_VIDEO_PERFORMANCE_MODE_UNSUPPORTED');
  }

  // Lazy: render.js pulls the whole render pipeline, which a cutaway
  // submission (the common case) never needs.
  const { resolveMasterAudioPath } = await import('./render.js');
  const masterPath = await resolveMasterAudioPath(project);
  if (scene.performanceRepair) await assertCurrentPerformanceTakes(project, masterPath);
  const songDurationSec = await probeVideoDuration(masterPath);
  if (songDurationSec == null) throw refuse('Could not read the song duration for this performance shot', 'MUSIC_VIDEO_AUDIO_UNREADABLE');
  const plan = planPerformanceWindow({ startSec: scene.startSec, endSec: scene.endSec, songDurationSec, capability });
  if (!plan.ok) throw refuse(plan.message, plan.code);
  if (scene.performanceRepair && (plan.windowStartSec !== scene.startSec || plan.windowEndSec !== scene.endSec)) {
    throw refuse('Review needed: this provider cannot continue only the remaining audio interval', 'PERFORMANCE_REPAIR_REVIEW_NEEDED', 409);
  }
  const offered = getFalVideoModel(capability.modelId)?.resolution?.options || capability.resolutions || [];
  const pick = (value) => (typeof value === 'string' ? offered.find((o) => o.toLowerCase() === value.trim().toLowerCase()) : null);
  const takeResolution = pick(resolution) || pick(project.videoSettings?.falLipSyncResolution) || capability.defaultResolution;

  // An optional vocal stem conditions the provider in place of the mix. It
  // is re-checked here because the file could have been replaced on disk or
  // arrived from a peer since it was attached.
  const conditioningSource = project.performanceConditioningSource || (project.vocalStemFilename ? 'vocal-stem' : 'master');
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
        selection: project.performanceConditioningSource ? 'user' : 'legacy-default',
        voiceIsolation: 'unverified',
      },
    },
    songInterval: { startSec: scene.startSec, endSec: scene.endSec },
    audioWindow: { startSec: plan.windowStartSec, endSec: plan.windowEndSec, durationSec: plan.windowSec },
    edit: { inSec: plan.editInSec, outSec: plan.editOutSec, targetSec: plan.spanSec },
    cues: clipRelativeCues(project.lyricCues, plan.windowStartSec, plan.windowEndSec),
    referenceImageId: typeof sourceImagePath === 'string' ? basename(sourceImagePath) : null,
    performance: (scene.visualIntent || scene.prompt || '').slice(0, 2000),
    capability: {
      provider: capability.provider,
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
