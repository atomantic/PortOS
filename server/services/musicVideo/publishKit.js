import { CANCEL_ALREADY_TERMINAL } from '../../lib/cancelResponse.js';
import { assertRenderCleanupIdle } from './renderCleanupActivity.js';
/**
 * Music Video — publishing kit (#9281).
 *
 * Everything a release needs that the project already knows: platform encodes
 * of the final render (an X-sized up-to-1080p, a 720p preview, a hook teaser),
 * thumbnail candidates, an SRT of the timed lyrics, YouTube chapters, and
 * per-platform copy the director edits. `project.publishKit` is an additive
 * field on the whole-record LWW body (same posture as `excerpts`), so an older
 * peer carries it through untouched.
 *
 * The build runs ffmpeg, plus one browser render of the 9:16 cut when the
 * composition lays itself out at that frame; the copy is ONE user-triggered
 * LLM call (AI Provider Usage Policy) and every field stays editable afterwards.
 */
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { copyFile, unlink, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { FINISHED_OUTPUT_ADMISSION_MS } from '../../lib/backupPublicationWait.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { ServerError } from '../../lib/errorHandler.js';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { safeUnder, edgeFadeFilter, findFfmpeg, runFfmpegProcess, probeVideoDuration, probeVideoStreamInfo, probeVideoAudioSampleCount, planLoudnessMaster, reportMasteredLoudness, installEncodedVideo, MASTER_LOUDNESS, AAC_ENCODE_ARGS } from '../../lib/ffmpeg.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { listProjects, mutateProjectRecord } from './projects.js';
import { requireProject } from './requireProject.js';
import { kitCutWindows, SOCIAL_VIDEO_ARGS } from './socialCuts.js';
import { musicVideoAspect } from '../../lib/musicVideo/musicVideoAspect.js';
import { publishCropRect } from '../../lib/musicVideo/musicVideoPublishCrop.js';
import { defaultVerticalFrameOptions, projectTimedLyricLines } from '../../lib/musicVideo/musicVideoVerticalFrame.js';
import { musicVideoDependencyChanges } from '../../lib/musicVideo/musicVideoDependencies.js';
import { buildChapters, buildSrt, buildPublishCopyPrompt, parsePublishCopy, normalizeCopyOptions, PUBLISH_PLATFORMS } from './publishKitText.js';
import { canonicalizeSunoUrl, isSunoShareLink } from '../sunoShareLink.js';
import { admittedRenderMap } from '../renderActivity.js';
import { pickThumbnailFrames, scoreThumbnailFrame, thumbnailCandidates } from './thumbnailFrames.js';

import { resolveRenderVideoFile } from './finalRenderFile.js';

const jobs = new Map();
const projectBuilds = admittedRenderMap('music-video-publish-kit', { noun: 'publishing kit build', link: (projectId) => `/music-video/${encodeURIComponent(projectId)}` });
// 9:16 canvas: the full frame fitted to width over a blurred, cover-scaled copy of itself, so edge text is never cropped.
export const VERTICAL_FIT_FILTER = 'split[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:4[b];[fg]scale=1080:1920:force_original_aspect_ratio=decrease[f];[b][f]overlay=(W-w)/2:(H-h)/2,setsar=1';
const AUDIO_ARGS = [...AAC_ENCODE_ARGS, '-movflags', '+faststart'];

export const attachPublishKitSseClient = (jobId, res) => attachSse(jobs, jobId, res);
export const projectPublishKit = (project) => (project?.publishKit && typeof project.publishKit === 'object' ? project.publishKit : {});

const kitError = (status, code, message, context) => new ServerError(message, { status, code, ...(context ? { context } : {}) });

/**
 * The build running for a project (`{ jobId, status }`), so a reloaded page can
 * reattach. Only once its SSE job exists: during the prerequisite lookup the
 * reservation holds the slot but there is nothing to attach to yet.
 */
export const isPublishKitBuildActive = (projectId) => projectBuilds.has(projectId);

export const getActivePublishKitBuild = (projectId) => {
  const jobId = projectBuilds.get(projectId);
  return jobId && jobs.get(jobId)?.status === 'running' ? { jobId, status: 'running' } : null;
};

/** The final render's file (the YouTube master), or a 409 naming what's missing. */
export async function finalRenderFile(project) {
  if (!project.renderHistoryId) throw kitError(409, 'NO_FINAL_RENDER', 'Render the final video before building the publishing kit');
  const resolved = await resolveRenderVideoFile(project.renderHistoryId);
  if (!resolved) throw kitError(409, 'NO_FINAL_RENDER', 'The final render file is missing — render the final video again');
  return resolved;
}

const staleCropPreview = () => kitError(409, 'PUBLISH_CROP_PREVIEW_STALE', 'The master or hook window changed. Refresh the crop preview before building.');
const readPublishPlatforms = async () => (await import('./publish/platforms.js')).getPublishPlatforms().catch(() => null);
const publishWindows = (project, platforms) => kitCutWindows(project, { sunoHook: platforms?.sunoHook?.enabled === true });

async function resolveCropPreview(project, { entry, path }, expected) {
  const [{ width, height }, durationSec] = await Promise.all([probeVideoStreamInfo(path), probeVideoDuration(path)]);
  // Resolve the current master and hook inputs after probing, just before kickoff.
  const [current, platforms] = await Promise.all([requireProject(project.id), readPublishPlatforms()]);
  if (current.renderHistoryId !== project.renderHistoryId) throw staleCropPreview();
  const windows = publishWindows(current, platforms);
  const { vertical } = windows;
  const endSec = Math.min(vertical?.endSec ?? 0, durationSec ?? 0);
  if (musicVideoAspect(current) !== '16:9' || !vertical || endSec <= vertical.startSec || width <= height || !publishCropRect(width, height, 0.5)) {
    if (expected) throw staleCropPreview();
    throw kitError(409, 'PUBLISH_CROP_UNAVAILABLE', 'Crop preview needs a readable landscape final render and a hook window inside it.');
  }
  const preview = { renderHistoryId: current.renderHistoryId, filename: entry.filename, width, height, startSec: vertical.startSec, endSec };
  if (expected && Object.entries(preview).some(([key, value]) => expected[key] !== value)) throw staleCropPreview();
  return { preview, windows: { ...windows, vertical: { ...vertical, endSec } } };
}

export async function getPublishKitCropPreview(projectId) {
  const project = await requireProject(projectId);
  const { preview } = await resolveCropPreview(project, await finalRenderFile(project));
  return preview;
}

/** A file an older build left behind, deleted only once no project's kit still names it (a clone shares the record). */
export async function releaseKitFiles(filenames, keep = []) {
  if (!filenames.length) return;
  const others = await listProjects();
  const referenced = new Set(keep);
  for (const p of others) {
    const kit = projectPublishKit(p);
    // A made YouTube thumbnail (and each A/B variant) also holds the kit frame it was made from,
    // so a rebuild leaves it there to re-set in new lettering.
    const made = [kit.coverArt, kit.youtubeThumbnail, ...(Array.isArray(kit.youtubeThumbnailTests) ? kit.youtubeThumbnailTests : [])].filter(Boolean);
    const madeFrom = made.map((t) => (t.source?.kind === 'thumbnail' ? t.source.filename : null));
    for (const f of [...(kit.exports || []).map((e) => e.filename), ...(kit.thumbnails || []), ...(kit.frames || []), kit.captionsFilename, kit.coverArt?.filename, ...made.map((t) => t.filename), ...madeFrom]) if (f) referenced.add(f);
  }
  for (const name of filenames) {
    if (referenced.has(name)) continue;
    const root = /\.(jpg|png)$/.test(name) ? PATHS.videoThumbnails : PATHS.videos;
    const path = safeUnder(root, name);
    if (path) await unlink(path).catch(() => {});
  }
}

async function masterPublishCopy(bin, path, signal) {
  const samples = await probeVideoAudioSampleCount(path);
  signal.throwIfAborted();
  if (samples == null) throw new Error('The copy has no measurable audio track duration');
  // The MP4 carries the intended audio length even when its last AAC frame
  // decodes more samples. Keep that length and the original stream timestamps.
  const trim = `atrim=end_sample=${samples}`;
  const { filter, before } = await planLoudnessMaster({ bin, inputArgs: ['-i', path], prefilter: trim, signal, preserveDynamics: true });
  const outputPath = `${path}.mastering.mp4`;
  let attenuation = '';
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await runFfmpegProcess({ bin, signal, args: [
        '-hide_banner', '-loglevel', 'error', '-copyts', '-i', path,
        '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-af', `${trim},${filter}${attenuation}`, ...AUDIO_ARGS,
        '-avoid_negative_ts', 'disabled', '-y', outputPath,
      ] });
      if (!result.ok) throw new Error(`Audio remux failed: ${result.reason || 'ffmpeg error'}`);
      const loudness = await reportMasteredLoudness({ bin, outputPath, before, signal });
      signal.throwIfAborted();
      // A rounded reading equal to the ceiling can still be over it. If AAC
      // used up the headroom, back off and encode again from the same source.
      if (loudness.truePeakDb < MASTER_LOUDNESS.truePeakDb) {
        const installed = await installEncodedVideo(outputPath, path, 'publish-kit loudness');
        if (!installed.ok) throw new Error(installed.reason);
        return loudness;
      }
      const correction = MASTER_LOUDNESS.truePeakDb - loudness.truePeakDb - 0.5;
      attenuation = `,volume=${correction.toFixed(2)}dB`;
    }
    throw new Error(`The delivered audio exceeds the ${MASTER_LOUDNESS.truePeakDb} dB true-peak ceiling`);
  } finally {
    await unlink(outputPath).catch(() => {});
  }
}

/**
 * Start a kit build: encodes, thumbnails, captions and chapters from the
 * current final render. Returns `{ jobId }`; progress streams over SSE and the
 * record carries the result.
 */
export async function startPublishKitBuild(projectId, { crop, loudnessPreset = 'as-mixed', vertical } = {}) {
  assertRenderCleanupIdle(projectId);
  if (projectBuilds.has(projectId)) throw kitError(409, 'PUBLISH_KIT_BUILD_IN_PROGRESS', 'A publishing kit build is already running for this project', getActivePublishKitBuild(projectId) || undefined);
  const jobId = `mvpk-${randomUUID()}`;
  // Reserve synchronously: final-render lookup and ffmpeg probing can overlap
  // another request before there is a background job to put in the registry.
  projectBuilds.set(projectId, jobId);
  try {
    return await projectBuilds.run(projectId, () => beginPublishKitBuild(projectId, jobId, { crop, loudnessPreset, vertical }));
  } catch (error) {
    projectBuilds.delete(projectId);
    throw error;
  }
}

async function beginPublishKitBuild(projectId, jobId, { crop, loudnessPreset, vertical: verticalOptions }) {
  const project = await requireProject(projectId);
  if (crop && crop.renderHistoryId !== project.renderHistoryId) throw staleCropPreview();
  const master = await finalRenderFile(project);
  const { entry, path: masterPath } = master;
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw kitError(500, 'FFMPEG_MISSING', 'ffmpeg not found on PATH');
  const cropPlan = crop ? await resolveCropPreview(project, master, crop) : null;
  const rect = cropPlan ? publishCropRect(crop.width, crop.height, crop.position) : null;
  const job = { id: jobId, projectId, status: 'running', clients: [], abort: new AbortController() };
  const { signal } = job.abort;
  const pendingFiles = new Set();
  jobs.set(jobId, job);
  const tag = jobId.slice(5, 13);
  console.log(`📦 Building music-video publishing kit [${tag}]: project=${projectId.slice(0, 8)}`);

  const run = async () => {
    await ensureDir(PATHS.videos);
    await ensureDir(PATHS.videoThumbnails);
    const durationSec = Number(entry.durationSec) > 0 ? Number(entry.durationSec) : await probeVideoDuration(masterPath);
    const stem = `music-video-${projectId.slice(3, 11)}-${Date.now()}-${tag}`;
    // The vertical cut follows the teaser's hook unless the director posts Suno Hooks and that hook opens too late for one.
    const { teaser, vertical: hookVertical } = cropPlan?.windows ?? publishWindows(project, await readPublishPlatforms());
    const fullVertical = verticalOptions?.span === 'full' && durationSec > 0;
    const framedVertical = verticalOptions?.mode === 'framed' && musicVideoAspect(project) === '16:9';
    const vertical = fullVertical ? { startSec: 0, endSec: durationSec } : hookVertical;
    const verticalFade = !fullVertical;
    const verticalLabel = vertical
      ? (fullVertical ? `Vertical 9:16 full (${Math.round(vertical.endSec - vertical.startSec)}s)` : `Vertical 9:16 ${Math.round(vertical.endSec - vertical.startSec)}s`)
      : '';
    const encodes = [
      { kind: 'x-1080p', label: 'X / social up to 1080p (12 Mbps)', filename: `${stem}-x-1080p.mp4`,
        args: ['-i', masterPath, '-vf', "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease", ...SOCIAL_VIDEO_ARGS, ...AUDIO_ARGS] },
      { kind: 'preview-720p', label: '720p preview', filename: `${stem}-preview-720p.mp4`,
        args: ['-i', masterPath, '-vf', "scale=-2:'min(720,ih)'", '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p', ...AUDIO_ARGS] },
      ...(teaser ? [{ kind: 'teaser', label: `Teaser ${Math.round(teaser.endSec - teaser.startSec)}s`, filename: `${stem}-teaser.mp4`, window: teaser,
        args: ['-ss', String(teaser.startSec), '-t', String(teaser.endSec - teaser.startSec), '-i', masterPath, ...SOCIAL_VIDEO_ARGS,
          '-af', `asetpts=PTS-STARTPTS${edgeFadeFilter(teaser.endSec - teaser.startSec)}`, ...AUDIO_ARGS] }] : []),
      // #10150: Shorts/TikTok/Reels need 9:16. Supports framed 16:9 (header + footer inside TikTok safe zone),
      // custom horizontal crop, native 9:16 composition reflow, or blurred-fit fallback (#10377).
      ...(vertical && (framedVertical || rect || musicVideoAspect(project) === '16:9') ? [{
        kind: 'vertical-9x16', label: verticalLabel, filename: `${stem}-vertical.mp4`, window: vertical,
        layout: framedVertical ? 'framed' : rect ? 'crop' : 'fit',
        framed: framedVertical ? async (outputPath, onProgress) => {
          const { renderVerticalFramedVideo } = await import('./verticalFrameRender.js');
          const defaults = defaultVerticalFrameOptions(project);
          await renderVerticalFramedVideo({
            ffmpeg, masterPath, outputPath,
            startSec: vertical.startSec, endSec: vertical.endSec,
            frameOptions: { ...defaults, ...verticalOptions },
            lyrics: projectTimedLyricLines(project),
            beats: project?.audioAnalysis?.beats || [],
            videoArgs: SOCIAL_VIDEO_ARGS, audioArgs: AUDIO_ARGS,
            fade: verticalFade, signal, onProgress,
          });
        } : null,
        native: (framedVertical || rect || fullVertical) ? null : async (outputPath, onProgress) => (await import('./excerptRender.js')).renderSeekedWindow(project, {
          startSec: vertical.startSec, endSec: vertical.endSec, aspect: '9:16', fade: true, videoArgs: SOCIAL_VIDEO_ARGS, outputPath, jobId: `${jobId}-vertical`, signal, onProgress,
        }),
        args: [
          ...(vertical.startSec > 0 ? ['-ss', String(vertical.startSec)] : []),
          '-t', String(vertical.endSec - vertical.startSec), '-i', masterPath,
          '-vf', rect ? `crop=${rect.width}:${rect.height}:${rect.x}:${rect.y}:exact=1,scale=1080:1920,setsar=1` : VERTICAL_FIT_FILTER, ...SOCIAL_VIDEO_ARGS,
          '-af', `asetpts=PTS-STARTPTS${verticalFade ? edgeFadeFilter(vertical.endSec - vertical.startSec) : ''}`, ...AUDIO_ARGS,
        ],
      }] : []),
    ];
    const candidates = thumbnailCandidates(project, durationSec);
    const total = encodes.length + candidates.length;
    let done = 0;
    const step = () => broadcastSse(job, { type: 'progress', progress: Math.min(0.99, ++done / total) });
    // The native cut renders the composition as it is now; the rest of the kit is the master.
    // Only when the master was rendered from exactly this composition do they match.
    const matchesMaster = Boolean(project.renderDependencies) && !musicVideoDependencyChanges(project, project.renderDependencies).length;
    // A native cut that isn't available (footage, a document without the 9:16 frame, a composition
    // changed since the master, a failed render) falls back to the fitted master; a cancel still
    // cancels and leaves no partial file behind.
    const renderNative = async (encode, out) => {
      if (!matchesMaster) {
        encode.fitReason = 'changed';
        console.log(`📐 ${encode.label} [${tag}]: the composition changed since the final render (or was never recorded), fitting the master`);
        return false;
      }
      try {
        const slot = done;
        const progress = (fraction) => broadcastSse(job, { type: 'progress', progress: Math.min(0.99, (slot + Math.max(0, Math.min(1, fraction))) / total) });
        if (await encode.native(out, progress)) { encode.layout = 'native'; return true; }
        encode.fitReason = 'footage';
      } catch (error) {
        if (signal.aborted) throw error;
        encode.fitReason = 'unavailable';
        console.warn(`⚠️ Native ${encode.label} unavailable [${tag}], fitting the master instead: ${error.message}`);
      }
      await unlink(out).catch(() => {});
      return false;
    };
    for (const encode of encodes) {
      signal.throwIfAborted();
      const out = join(PATHS.videos, encode.filename);
      pendingFiles.add(out);
      if (encode.framed) {
        const slot = done;
        const progress = (fraction) => broadcastSse(job, { type: 'progress', progress: Math.min(0.99, (slot + Math.max(0, Math.min(1, fraction))) / total) });
        await encode.framed(out, progress);
      } else if (!(encode.native && await renderNative(encode, out))) {
        const result = await runFfmpegProcess({ bin: ffmpeg, signal, args: ['-hide_banner', '-loglevel', 'error', ...encode.args, '-y', out] });
        if (!result.ok) throw new Error(`${encode.label} encode failed: ${result.reason || 'ffmpeg error'}`);
      }
      if (loudnessPreset === 'web') {
        encode.loudness = await masterPublishCopy(ffmpeg, out, signal).catch(error => {
          throw new Error(`${encode.label} Web mastering failed: ${error.message}`, { cause: error });
        });
      }
      const { width, height } = await probeVideoStreamInfo(out);
      Object.assign(encode, { width, height });
      step();
    }
    // Cut every candidate, keep the best frame of each shot, and drop the rest.
    // Keep the master dimensions; the cover and YouTube composers apply their own crops.
    const scored = [];
    for (const [i, c] of candidates.entries()) {
      signal.throwIfAborted();
      const name = `${stem}-thumb-${i + 1}.jpg`;
      const path = join(PATHS.videoThumbnails, name);
      pendingFiles.add(path);
      const result = await runFfmpegProcess({ bin: ffmpeg, signal, args: ['-hide_banner', '-loglevel', 'error', '-ss', String(c.t), '-i', masterPath, '-frames:v', '1', '-q:v', '2', '-y', path] });
      if (result.ok) scored.push({ ...c, name, score: await scoreThumbnailFrame(path).catch(() => NaN) });
      else await unlink(path).catch(() => {});
      step();
    }
    const thumbnails = pickThumbnailFrames(scored).map((c) => c.name);
    await Promise.all(scored.filter((c) => !thumbnails.includes(c.name)).map((c) => unlink(join(PATHS.videoThumbnails, c.name)).catch(() => {})));
    const srt = buildSrt(project);
    const captionsFilename = srt ? `${stem}-captions.srt` : null;
    if (srt) {
      const path = join(PATHS.videos, captionsFilename);
      pendingFiles.add(path);
      await writeFile(path, srt);
    }
    const previous = projectPublishKit(project);
    const staleFiles = [...(previous.exports || []).map((e) => e.filename), ...(previous.thumbnails || []), previous.captionsFilename].filter(Boolean);
    // ffmpeg wrote the kit's files in place; the row that first names them
    // commits under a backup lease (#9982). Stale files go only after it.
    signal.throwIfAborted();
    await withBackupAssetPublication(() => {
      if (signal.aborted) return;
      return mutateProjectRecord(projectId, (current) => {
        // Cancellation while waiting for the record lock is a settled no-op.
        if (signal.aborted) return { project: current, skipPersist: true };
        job.committing = true;
        const kit = projectPublishKit(current);
        return { project: { ...current, publishKit: {
          ...kit,
          builtAt: new Date().toISOString(),
          master: { filename: entry.filename, renderHistoryId: project.renderHistoryId },
          exports: encodes.map(({ kind, label, filename, width, height, window, layout, fitReason, loudness }) => ({ kind, label, filename, width, height, ...(window ? { startSec: window.startSec, endSec: window.endSec } : {}), ...(layout ? { layout } : {}), ...(layout === 'fit' && fitReason ? { fitReason } : {}), ...(loudness ? { loudness } : {}) })),
          thumbnails,
          thumbnail: thumbnails.includes(kit.thumbnail) ? kit.thumbnail : (thumbnails[0] || null),
          captionsFilename,
          chapters: buildChapters(current),
        } } };
      });
    }, waitForBackup('kit build', signal)).catch(err => {
      if (!signal.aborted) projectBuilds.markUnsettled(projectId);
      throw err;
    });
    signal.throwIfAborted();
    job.published = true;
    await releaseKitFiles(staleFiles, [...encodes.map(e => e.filename), ...thumbnails, captionsFilename]);
  };

  Promise.resolve().then(run).then(() => {
    job.status = 'complete';
    projectBuilds.delete(projectId);
    console.log(`✅ Music-video publishing kit built [${tag}]`);
    broadcastSse(job, { type: 'complete', result: { projectId } });
    closeJobAfterDelay(jobs, jobId);
  }).catch(async (err) => {
    if (!job.committing) {
      await Promise.all([...pendingFiles].map(path => unlink(path).catch(() => {})));
    } else if (!job.published && !err.backupPublicationUncertain) {
      // A failed mutation can have committed before record presentation failed.
      // Reconcile against saved references, including any clones of the kit.
      await releaseKitFiles([...pendingFiles].map(path => basename(path))).catch(() => {
        console.error(`❌ Could not reconcile publishing kit files [${tag}] after the record write failed`);
      });
    }
    const canceled = signal.aborted;
    job.status = canceled ? 'canceled' : 'error';
    projectBuilds.delete(projectId);
    const log = canceled ? console.log : console.error;
    log(`${canceled ? '🛑' : '❌'} Music-video publishing kit ${canceled ? 'cancelled' : 'failed'} [${tag}]: ${err.message}`);
    broadcastSse(job, { type: canceled ? 'canceled' : 'error', error: canceled ? 'Publishing kit build cancelled' : err.message });
    closeJobAfterDelay(jobs, jobId);
  });
  return { jobId };
}

export function cancelPublishKitBuild(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  if (job.status !== 'running' || job.committing) return CANCEL_ALREADY_TERMINAL;
  job.abort.abort();
  return true;
}

/** Capture a director-selected moment without changing the master or calling a provider. */
export async function capturePublishKitFrame(projectId, atSec) {
  assertRenderCleanupIdle(projectId);
  const project = await requireProject(projectId);
  const { entry, path: masterPath } = await finalRenderFile(project);
  const duration = Number(entry.durationSec) > 0 ? Number(entry.durationSec) : await probeVideoDuration(masterPath);
  if (!Number.isFinite(atSec) || atSec < 0 || atSec >= duration) throw kitError(422, 'VALIDATION_ERROR', 'Choose a time inside the final video');
  const filename = `music-video-${projectId.slice(3, 11)}-frame-${randomUUID()}.png`;
  await ensureDir(PATHS.videoThumbnails);
  const output = join(PATHS.videoThumbnails, filename);
  const rendered = project.composition?.mode === 'blender'
    ? await (await import('./publishKitBlenderFrame.js')).publishKitBlenderFrame(project, atSec) : null;
  const write = async () => {
    if (rendered) return copyFile(rendered, output);
    const bin = await findFfmpeg();
    if (!bin) throw kitError(500, 'FFMPEG_MISSING', 'ffmpeg not found on PATH');
    const result = await runFfmpegProcess({ bin, args: ['-hide_banner', '-loglevel', 'error', '-ss', String(atSec), '-i', masterPath, '-frames:v', '1', '-y', output] });
    if (!result.ok || !existsSync(output)) throw kitError(500, 'FRAME_CAPTURE_FAILED', 'The video frame could not be captured');
  };
  const dropped = [];
  const result = await write().then(() => withBackupAssetPublication(() => mutateProjectRecord(projectId, current => {
    const kit = projectPublishKit(current);
    const frames = [filename, ...(kit.frames || [])];
    dropped.push(...frames.slice(12));
    return { project: { ...current, publishKit: { ...kit, frames: frames.slice(0, 12) } } };
  }), waitForBackup('frame capture'))).catch(async error => { await unlink(output).catch(() => {}); throw error; });
  await releaseKitFiles(dropped);
  return result;
}

/** The files already exist, so a backup cut holding admission is a pause, never a reason to fail the build. */
const waitForBackup = (what, signal) => ({
  timeoutMs: FINISHED_OUTPUT_ADMISSION_MS,
  onWait: () => {
    signal?.throwIfAborted();
    console.log(`⏸️ Music-video publishing kit ${what} waiting for the backup to finish before saving`);
  },
});

/** Merge edited copy fields per platform (only known platforms and string/array fields). */
export async function updatePublishKitCopy(projectId, patch, deps = {}) {
  await requireProject(projectId);
  // Keep the song page, not a Suno share link: the Suno posts find the song by the id in its URL.
  // A link that can't be followed now is kept as typed; publishing follows it again.
  if (isSunoShareLink(patch?.links?.song)) {
    patch = { ...patch, links: { ...patch.links, song: await canonicalizeSunoUrl(patch.links.song, deps).catch(() => patch.links.song) } };
  }
  return mutateProjectRecord(projectId, (current) => {
    const kit = projectPublishKit(current);
    const copy = { ...(kit.copy || {}) };
    let postEdited = false;
    for (const platform of PUBLISH_PLATFORMS) {
      if (patch?.[platform] && typeof patch[platform] === 'object') {
        copy[platform] = { ...(copy[platform] || {}), ...patch[platform] };
        postEdited = true;
      }
    }
    // Only a post's own text counts as hand-edited copy a redraft must not silently replace.
    const next = { ...kit, copy, ...(postEdited ? { copyEditedAt: new Date().toISOString() } : {}) };
    if (typeof patch?.notes === 'string') next.notes = patch.notes;
    if (patch?.links && typeof patch.links === 'object') {
      const links = { ...(kit.links || {}) };
      for (const [key, url] of Object.entries(patch.links)) {
        if (url) links[key] = url; else delete links[key];
      }
      next.links = links;
    }
    if (patch?.flyer && typeof patch.flyer === 'object') next.flyer = { ...(kit.flyer || {}), ...patch.flyer };
    if (patch?.postOptions && typeof patch.postOptions === 'object') {
      const postOptions = { ...(kit.postOptions || {}) };
      for (const [target, answers] of Object.entries(patch.postOptions)) {
        const kept = Object.fromEntries(Object.entries(answers || {}).filter(([, v]) => v !== '' && v != null));
        if (Object.keys(kept).length) postOptions[target] = kept; else delete postOptions[target];
      }
      next.postOptions = postOptions;
    }
    if (patch?.draftOptions && typeof patch.draftOptions === 'object') {
      const prior = kit.draftOptions || {};
      next.draftOptions = {
        ...prior,
        ...(patch.draftOptions.include ? { include: { ...(prior.include || {}), ...patch.draftOptions.include } } : {}),
        ...(patch.draftOptions.length ? { length: patch.draftOptions.length } : {}),
      };
    }
    if (Array.isArray(patch?.skippedTargets)) {
      const unique = [...new Set(patch.skippedTargets)];
      if (unique.length) next.skippedTargets = unique; else delete next.skippedTargets;
    }
    return { project: { ...current, publishKit: next } };
  });
}

const sameTags = (a, b) => Array.isArray(b) && b.length > 0 && a.length === b.length && a.every((t, i) => t === b[i]);

/** True when a post was written or edited by hand after the last draft (or with no draft yet). */
function copyEditedSinceDraft(kit) {
  const edited = Date.parse(kit?.copyEditedAt || '');
  if (!Number.isFinite(edited)) return false;
  const drafted = Date.parse(kit?.copyDraftedAt || '');
  return !Number.isFinite(drafted) || edited > drafted;
}

/** Generation spend across the project's production runs (what the copy may claim). */
function spentUsd(project) {
  const total = (project.productionRuns || []).reduce((sum, run) => sum + (Number.isFinite(Number(run?.usage?.spentUsd)) ? Number(run.usage.spentUsd) : 0), 0);
  return total > 0 ? total : null;
}

/**
 * Draft the copy for every platform the director posts to, in ONE provider call they asked for.
 * `notes` (their making-of story) and what they chose to include (`include`,
 * `length`) are saved with the kit so a redraft reuses them. A draft replaces
 * the posts' text, so once a post was written or edited by hand since the last
 * draft it is refused (409 PUBLISH_COPY_EDITED) unless `replaceEdited` says the
 * director agreed to replace it. Fields the draft does not return (YouTube tags
 * with hashtags off) keep what was there.
 */
export async function draftPublishKitCopy(projectId, { providerId = null, model = null, notes = '', links = {}, include, length, replaceEdited = false } = {}, deps = {}) {
  const project = await requireProject(projectId);
  if (!replaceEdited && copyEditedSinceDraft(projectPublishKit(project))) {
    throw kitError(409, 'PUBLISH_COPY_EDITED', 'The posts were edited by hand since the last draft; confirm replacing them to draft again');
  }
  const { getPublishPlatforms, publishHistory } = await import('./publish/platforms.js');
  const enabled = deps.platforms || await getPublishPlatforms();
  // Only where the director posts (#9287), minus any skipped for this release; Suno's caption reuses the YouTube description.
  const skipped = new Set(projectPublishKit(project).skippedTargets || []);
  const platforms = PUBLISH_PLATFORMS.filter((p) => !skipped.has(p) && (enabled[p]?.enabled || (p === 'youtube' && enabled.suno?.enabled && !skipped.has('suno'))));
  if (!platforms.length) throw kitError(409, 'PUBLISH_NO_PLATFORMS', 'Turn on at least one platform under "Where you post" before drafting copy');
  const history = deps.history || await publishHistory().catch(() => ({}));
  const lessons = Object.entries(history).flatMap(([platform, h]) => (h?.notes || []).map((n) => ({ platform, ...n })));
  const { resolveProviderAndModel, runPromptThroughProvider } = deps.runner || await import('../promptRunner.js');
  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  if (!provider) throw kitError(503, 'NO_PROVIDER', 'No AI provider is available to draft the copy');
  const options = normalizeCopyOptions({ include, length });
  const prompt = buildPublishCopyPrompt(project, { notes, spentUsd: spentUsd(project), links, platforms, lessons, ...options });
  const { text } = await runPromptThroughProvider({ provider, model: selectedModel, prompt, source: 'music-video-publish-copy' });
  const copy = parsePublishCopy(text, platforms, { hashtags: options.include.hashtags });
  if (!copy) throw kitError(502, 'PUBLISH_COPY_UNPARSEABLE', 'The copy draft came back without usable JSON — try again or another model');
  return mutateProjectRecord(projectId, (current) => {
    const kit = projectPublishKit(current);
    const merged = { ...(kit.copy || {}) };
    for (const [platform, fields] of Object.entries(copy)) merged[platform] = { ...(merged[platform] || {}), ...fields };
    // With hashtags off the draft returns no tags: typed tags stay, but tags an
    // earlier draft wrote (still unedited) go, so none remain unasked.
    const youtube = merged.youtube;
    if (copy.youtube && !('tags' in copy.youtube) && Array.isArray(youtube?.tags) && sameTags(youtube.tags, kit.draftedTags)) {
      merged.youtube = { ...youtube, tags: [] };
    }
    // A draft without YouTube keeps the record of what the last YouTube draft wrote.
    const draftedTags = copy.youtube ? (Array.isArray(copy.youtube.tags) ? copy.youtube.tags : []) : (kit.draftedTags || []);
    return { project: { ...current, publishKit: { ...kit, copy: merged, draftedTags, notes, draftOptions: options, links: { ...(kit.links || {}), ...links }, copyDraftedAt: new Date().toISOString() } } };
  });
}
