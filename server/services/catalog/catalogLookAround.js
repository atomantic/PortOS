/**
 * Place "look around" (#16145): one hosted image-to-video clip from a place's main plate, panned on a
 * locked tripod, becomes a set of camera-angle plates that share one geometry and one light.
 *
 * `startLookAround` previews (`dryRun`) or queues the render; the preview and the queued job build the
 * fal request with the same code, so the shown prompt and price are what is sent and billed. The clip
 * lands in video history tagged `lookAround` and nothing touches the place yet. `scoreLookAroundClip`
 * decodes the clip, scores every sampled frame for blur and places it in the sweep from the frames
 * themselves (catalogLookAround.js). `saveLookAroundAngles` is the only write: each kept moment is
 * pulled at the clip's resolution into the gallery and attached as a `plate` reference whose
 * `library.angle` records the clip, moment and main plate; the clip joins the place as video media;
 * an optional sharpness-only image edit lands beside each raw angle with the same lineage.
 */

import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS, resolveImageInputPath, rmGuarded, unlinkGuarded } from '../../lib/fileUtils.js';
import {
  FFMPEG_FRAME_TIMEOUT_MS, FFMPEG_SCAN_TIMEOUT_MS, findFfmpeg, probeVideoGeometry, runFfmpegProcess, safeUnder, vfrSyncArgs,
} from '../../lib/ffmpeg.js';
import { buildFalVideoRequest, FAL_VIDEO_MODELS, getFalVideoModel } from '../../lib/falVideoModels.js';
import { decodeGreyscaleFrame, scoreFrame } from '../../lib/frameQuality.js';
import { promptAddition } from '../../lib/modelInput.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import {
  analyzeLookAroundFrames, columnProfile, composeLookAroundPrompt, DEFAULT_LOOK_AROUND_MODEL, DEFAULT_LOOK_AROUND_MOTION,
  LOOK_AROUND_CLIP_ROLE, LOOK_AROUND_MOTIONS, lookAroundAngleLabel, pickLookAroundStrip,
} from '../../lib/catalog/catalogLookAround.js';
import * as catalogDB from './catalogDB.js';
import { assertCatalogIdentityWritable } from '../catalogDB/identityAccess.js';
import { getSettings } from '../settings.js';
import { isVideoModeUsable, VIDEO_GEN_MODE } from '../videoGen/modes.js';
import { loadHistory } from '../videoGen/history.js';

const refuse = (status, code, message) => { throw new ServerError(message, { status, code }); };

// Scan density: enough frames to find a sharp one every few degrees without decoding the whole clip.
const SCAN_WIDTH = 480;
const SCAN_MAX_FRAMES = 96;
const SCAN_MAX_FPS = 4;
const THUMB_WIDTH = 240;
// Frames scoring at or below this are too blurred to suggest (focus is 0..1, log-compressed).
const MIN_SUGGESTED_SHARPNESS = 0.2;

export const LOOK_AROUND_CLEANUP_ADDITION = promptAddition('look-around-cleanup', 'Sharpness-only clean-up',
  'Restore sharpness in this still from a slow camera pan: remove motion blur and compression artifacts and recover fine detail. Change nothing else. Keep the exact framing, perspective, geometry, objects, materials, colors, light and time of day. Do not add or remove anything. No people, no text.');

const ownerFor = (ingredientId) => `catalog-look-around:${ingredientId}`;
const isImageMedia = (m) => m && !m.deleted && (m.kind === 'portrait' || m.kind === 'reference');

const deps = {
  getIngredient: (id) => catalogDB.getIngredient(id),
  listMedia: (id) => catalogDB.listMediaForIngredient(id),
  attachMedia: (...args) => catalogDB.attachMedia(...args),
  assertWritable: (id) => assertCatalogIdentityWritable(id),
  getSettings: () => getSettings(),
  loadHistory: () => loadHistory(),
  resolveImage: (key) => resolveImageInputPath(key),
  readImageDimensions: async (path) => (await import('../imageGen/regen.js')).readImageDimensions(path),
  probe: (path) => probeVideoGeometry(path),
  // A tampered history filename must not point ffmpeg outside data/videos.
  clipPath: (filename) => {
    const path = typeof filename === 'string' ? safeUnder(PATHS.videos, filename) : null;
    return path && existsSync(path) ? path : null;
  },
  enqueueJob: async (job) => (await import('../mediaJobQueue/index.js')).enqueueJob(job),
  listJobs: async (filter) => (await import('../mediaJobQueue/index.js')).listJobs(filter),
  scanFrames: (videoPath, options) => scanClipFrames(videoPath, options),
  extractFrame: (videoPath, atSec, outPath) => extractClipFrame(videoPath, atSec, outPath),
  saveGalleryImage: async (tempPath) => (await import('../imageGen/local.js')).saveUploadedGalleryImage(null, tempPath),
  // The record's image render target (its universe's pin, else the character-sheet default), as refinement uses.
  cleanupTarget: async (id) => {
    const { catalogImageBackend, resolveCatalogImageTarget } = await import('./catalogMediaRefinement.js');
    const target = await resolveCatalogImageTarget(id);
    return { ...target, backend: catalogImageBackend(target) };
  },
  previewCleanup: async (body) => (await import('../imageGen/promptPreview.js')).previewImagePrompt(body),
  enqueueCleanup: async (body, options) => (await import('./catalogMediaRefinement.js')).enqueueCatalogImage(body, options),
};
export const __setLookAroundDepsForTests = (overrides) => Object.assign(deps, overrides);

async function requirePlace(ingredientId, { write = false } = {}) {
  if (write) await deps.assertWritable(ingredientId);
  const place = await deps.getIngredient(ingredientId);
  if (!place) refuse(404, 'NOT_FOUND', 'Place not found');
  if (place.type !== 'place') refuse(409, 'LOOK_AROUND_NOT_A_PLACE', 'Look around works on a place');
  return place;
}

/** The place's main plate: a plate that is not itself an angle, else the portrait, else the newest reference. */
function mainPlateOf(media) {
  const images = (Array.isArray(media) ? media : []).filter(isImageMedia);
  return images.find((m) => m.role === 'plate' && !m.library?.angle)
    || images.find((m) => m.kind === 'portrait')
    || images.find((m) => !m.library?.angle) || null;
}

const lookAroundModels = () => FAL_VIDEO_MODELS.filter((m) => m.kind === 'i2v');

function lookAroundOptions() {
  return {
    motions: Object.values(LOOK_AROUND_MOTIONS).map(({ id, label, sweepDeg, defaultSec }) => ({ id, label, sweepDeg, defaultSec })),
    models: lookAroundModels().map((m) => ({
      id: m.id, label: m.label, duration: m.duration,
      resolutions: m.resolution?.options ? [...m.resolution.options] : [], defaultResolution: m.resolution?.default ?? null,
    })),
    defaults: { motion: DEFAULT_LOOK_AROUND_MOTION, modelId: DEFAULT_LOOK_AROUND_MODEL },
  };
}

const clipSummary = (row) => ({
  id: row.id, filename: row.filename, createdAt: row.createdAt, modelId: row.modelId, duration: row.duration ?? null,
  resolution: row.resolution ?? null, estimatedCostUsd: row.estimatedCostUsd ?? null, prompt: row.prompt || '',
  motion: row.lookAround.motion, sourceMediaKey: row.lookAround.sourceMediaKey,
});

/** The place's look-around options, its main plate, its finished clips (newest first) and renders in flight. */
export async function getLookAround(ingredientId) {
  const place = await requirePlace(ingredientId);
  const ids = new Set([ingredientId, place.id]);
  const [media, history, jobs, settings] = await Promise.all([
    deps.listMedia(place.id), deps.loadHistory(), deps.listJobs({ kind: 'video', owner: ownerFor(place.id) }), deps.getSettings(),
  ]);
  const clips = (Array.isArray(history) ? history : [])
    .filter((row) => row?.lookAround && ids.has(row.lookAround.ingredientId) && typeof row.filename === 'string')
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .map(clipSummary);
  const pending = (jobs || []).filter((job) => job.status === 'queued' || job.status === 'running')
    .map((job) => ({ jobId: job.id, status: job.status, progress: job.progress ?? null, motion: job.params?.lookAround?.motion ?? null }));
  return {
    ...lookAroundOptions(), configured: isVideoModeUsable(settings, VIDEO_GEN_MODE.FAL),
    mainPlate: mainPlateOf(media)?.mediaKey ?? null, clips, pending,
  };
}

/**
 * Plan one look-around render and, without `dryRun`, queue it. The prompt is PortOS's for the motion
 * unless the director sent their own, which goes as written.
 */
export async function startLookAround(ingredientId, { sourceImage, motion: motionId = DEFAULT_LOOK_AROUND_MOTION, modelId, seconds, resolution, prompt, dryRun = false } = {}) {
  const place = await requirePlace(ingredientId, { write: !dryRun });
  const media = await deps.listMedia(place.id);
  const source = sourceImage
    ? (media || []).find((m) => isImageMedia(m) && m.mediaKey === sourceImage)
    : mainPlateOf(media);
  if (!source) refuse(422, 'LOOK_AROUND_SOURCE_MISSING', sourceImage ? 'That image is not attached to this place' : 'Add a plate to this place first');
  const sourcePath = deps.resolveImage(source.mediaKey);
  if (!sourcePath) refuse(422, 'LOOK_AROUND_SOURCE_MISSING', `The image "${source.mediaKey}" is not on this machine`);
  const model = getFalVideoModel(modelId || DEFAULT_LOOK_AROUND_MODEL);
  if (model?.kind !== 'i2v') refuse(400, 'VALIDATION_ERROR', 'Choose an image-to-video model');
  const motion = LOOK_AROUND_MOTIONS[motionId];
  const composed = composeLookAroundPrompt(motion.id);
  const text = prompt ?? composed;
  const dims = await deps.readImageDimensions(sourcePath);
  let built;
  try {
    built = buildFalVideoRequest({
      modelId: model.id, prompt: text, seconds: seconds ?? motion.defaultSec, resolution, imageUrl: 'pending:image',
      width: dims?.width, height: dims?.height,
    });
  } catch (err) {
    if (err?.code !== 'FAL_MODEL_INPUT') throw err;
    return refuse(400, 'VALIDATION_ERROR', err.message);
  }
  const settings = await deps.getSettings();
  const plan = {
    sourceImage: source.mediaKey, motion: motion.id, modelId: model.id, modelLabel: model.label,
    seconds: built.seconds, resolution: built.resolution, estimatedCostUsd: built.estimatedCostUsd,
    prompt: text, composedPrompt: composed, promptIsDefault: text === composed, body: built.body,
    configured: isVideoModeUsable(settings, VIDEO_GEN_MODE.FAL),
  };
  if (dryRun) return { dryRun: true, ...plan };
  if (!plan.configured) refuse(400, 'FAL_NOT_CONFIGURED', 'No fal.ai API key configured — set it in Settings → Credentials or the FAL_KEY env var');

  // These are the fields videoGen/fal.js rebuilds the request from, so the sent body equals `plan.body`.
  const { jobId } = await deps.enqueueJob({ kind: 'video', owner: ownerFor(place.id), params: {
    mode: VIDEO_GEN_MODE.FAL, videoMode: 'image', modelId: model.id, prompt: text, negativePrompt: '',
    sourceImagePath: sourcePath, duration: built.seconds,
    ...(built.resolution ? { resolution: built.resolution } : {}),
    ...(dims ? { width: dims.width, height: dims.height } : {}),
    lookAround: { ingredientId: place.id, motion: motion.id, sourceMediaKey: source.mediaKey },
  } });
  console.log(`🧭 look-around ${place.id.slice(0, 8)} ${motion.id} → ${model.id} ${built.seconds}s request ${jobId.slice(0, 8)}`);
  return { dryRun: false, jobId, ...plan };
}

async function requireClip(place, ingredientId, clipId) {
  const history = await deps.loadHistory();
  const row = (Array.isArray(history) ? history : []).find((entry) => entry?.id === clipId);
  if (!row) refuse(404, 'NOT_FOUND', 'Clip not found');
  if (!row.lookAround || ![ingredientId, place.id].includes(row.lookAround.ingredientId)) {
    refuse(409, 'LOOK_AROUND_CLIP_MISMATCH', 'That clip is not a look-around of this place');
  }
  const videoPath = deps.clipPath(row.filename);
  if (!videoPath) refuse(409, 'LOOK_AROUND_CLIP_MISSING', 'The clip file is missing on this machine');
  const geometry = await deps.probe(videoPath);
  if (!geometry) refuse(422, 'LOOK_AROUND_CLIP_UNREADABLE', 'The clip could not be read');
  return { row, videoPath, geometry };
}

async function scanClipFrames(videoPath, { dir, fps, width }) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) refuse(500, 'FFMPEG_MISSING', 'ffmpeg not found on PATH');
  const scan = await runFfmpegProcess({
    bin: ffmpeg,
    args: ['-i', videoPath, '-vf', `fps=${fps},scale=${width}:-2`, ...await vfrSyncArgs(ffmpeg),
      '-frames:v', String(SCAN_MAX_FRAMES), '-y', join(dir, 'scan-%03d.png')],
    timeoutMs: FFMPEG_SCAN_TIMEOUT_MS,
  });
  if (!scan.ok) refuse(500, 'FFMPEG_FAILED', `Could not read the clip's frames: ${scan.reason}`);
  const paths = [];
  for (let i = 1; i <= SCAN_MAX_FRAMES; i++) {
    const path = join(dir, `scan-${String(i).padStart(3, '0')}.png`);
    if (!existsSync(path)) break;
    paths.push(path);
  }
  return paths;
}

async function extractClipFrame(videoPath, atSec, outPath) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) refuse(500, 'FFMPEG_MISSING', 'ffmpeg not found on PATH');
  const result = await runFfmpegProcess({
    bin: ffmpeg, args: ['-ss', atSec.toFixed(3), '-i', videoPath, '-frames:v', '1', '-update', '1', '-y', outPath],
    timeoutMs: FFMPEG_FRAME_TIMEOUT_MS,
  });
  if (!result.ok || !existsSync(outPath)) refuse(500, 'FFMPEG_FAILED', `Could not pull the frame at ${atSec.toFixed(2)}s`);
}

// The last analysis of each clip, so saving angles without explicit bearings reuses the picker's labels.
const analysisCache = new Map();
const ANALYSIS_CACHE_SIZE = 8;

async function analyzeClip(row, videoPath, geometry, { thumbs }) {
  const fps = Math.min(SCAN_MAX_FPS, SCAN_MAX_FRAMES / Math.max(1, geometry.durationSec));
  const dir = await mkdtemp(join(tmpdir(), 'lookaround-'));
  try {
    const paths = await deps.scanFrames(videoPath, { dir, fps, width: SCAN_WIDTH });
    const frames = [];
    for (let i = 0; i < paths.length; i++) {
      const frame = await decodeGreyscaleFrame(paths[i]);
      if (!frame) continue;
      const scored = scoreFrame(frame);
      frames.push({ atSec: Math.round((i / fps) * 1000) / 1000, sharpness: Math.round(scored.focus * 1e4) / 1e4,
        usable: scored.usable, profile: columnProfile(frame), path: paths[i] });
    }
    if (!frames.length) refuse(422, 'LOOK_AROUND_CLIP_UNREADABLE', 'No frames could be read from the clip');
    const analysis = analyzeLookAroundFrames(frames, { motion: row.lookAround.motion, durationSec: geometry.durationSec, width: SCAN_WIDTH });
    const strip = pickLookAroundStrip(analysis.frames.filter((frame) => frame.usable), { minSharpness: MIN_SUGGESTED_SHARPNESS });
    const { default: sharp } = await import('sharp');
    const stripWithThumbs = thumbs ? await Promise.all(strip.map(async (frame) => ({
      ...frame, thumb: `data:image/jpeg;base64,${(await sharp(frame.path).resize({ width: THUMB_WIDTH }).jpeg({ quality: 72 }).toBuffer()).toString('base64')}`,
    }))) : strip;
    const result = {
      clipId: row.id, filename: row.filename, durationSec: geometry.durationSec, width: geometry.width, height: geometry.height,
      motion: row.lookAround.motion, sourceMediaKey: row.lookAround.sourceMediaKey,
      direction: analysis.direction, directionSource: analysis.direction === null ? 'none' : analysis.directionSource, requestedDirection: analysis.requestedDirection,
      frames: analysis.frames.map(({ path: _path, ...frame }) => frame),
      strip: stripWithThumbs.map(({ path: _path, usable: _usable, ...frame }) => frame),
    };
    analysisCache.delete(row.id);
    analysisCache.set(row.id, result.frames);
    if (analysisCache.size > ANALYSIS_CACHE_SIZE) analysisCache.delete(analysisCache.keys().next().value);
    return result;
  } finally {
    await rmGuarded(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Score every sampled frame of a look-around clip and suggest the sharpest across its sweep. Writes nothing. */
export async function scoreLookAroundClip(ingredientId, clipId) {
  const place = await requirePlace(ingredientId);
  const { row, videoPath, geometry } = await requireClip(place, ingredientId, clipId);
  const result = await analyzeClip(row, videoPath, geometry, { thumbs: true });
  console.log(`🧭 look-around scored ${result.frames.length} frames of ${clipId.slice(0, 8)}: ${result.strip.length} suggested, turned ${result.direction ?? 'none'} (${result.directionSource})`);
  return result;
}

const nearestFrame = (frames, atSec) => frames.reduce((best, frame) => (Math.abs(frame.atSec - atSec) < Math.abs(best.atSec - atSec) ? frame : best));

/**
 * Plan (and without `dryRun`, store) the angles the director kept. A `bearingDeg` they set wins;
 * otherwise the bearing comes from the frames, as the picker showed it.
 */
export async function saveLookAroundAngles(ingredientId, clipId, { angles, cleanup = false, dryRun = false } = {}) {
  const place = await requirePlace(ingredientId, { write: !dryRun });
  const { row, videoPath, geometry } = await requireClip(place, ingredientId, clipId);
  const { motion, sourceMediaKey } = row.lookAround;
  if (angles.some((angle) => angle.atSec > geometry.durationSec + 0.05)) refuse(400, 'VALIDATION_ERROR', `The clip is ${geometry.durationSec.toFixed(2)}s long`);
  const frames = angles.every((angle) => angle.bearingDeg !== undefined) ? null
    : analysisCache.get(row.id) || (await analyzeClip(row, videoPath, geometry, { thumbs: false })).frames;
  const planned = angles.map(({ atSec, bearingDeg, name }) => {
    const placed = frames ? nearestFrame(frames, atSec) : null;
    const bearing = bearingDeg ?? placed.bearingDeg;
    const progress = placed?.progress ?? atSec / geometry.durationSec;
    const angleLabel = lookAroundAngleLabel({ motion, bearingDeg: bearing, progress });
    const label = name ? `${angleLabel} · ${name}` : angleLabel;
    return { atSec, bearingDeg: Math.round(bearing) % 360, name: name || null, label,
      angle: { clipId: row.id, atSec, sourceMediaKey, bearingDeg: Math.round(bearing) % 360, motion } };
  });

  const target = cleanup ? await deps.cleanupTarget(place.id) : null;
  const cleanupBody = (initImageFile, dims) => ({
    ...target.backend, prompt: LOOK_AROUND_CLEANUP_ADDITION.text, promptAdditions: [LOOK_AROUND_CLEANUP_ADDITION], initImageFile, ...dims,
  });
  if (dryRun) {
    // Each kept frame is the edit's input; the main plate stands in so the exact wrapper text is shown.
    const preview = cleanup ? await deps.previewCleanup(cleanupBody(sourceMediaKey, { width: geometry.width, height: geometry.height })) : null;
    return { dryRun: true, clipId: row.id, angles: planned, cleanup: preview ? { ...preview, mode: target.mode, inputNote: 'Each kept frame is sent as the image to edit.' } : null };
  }

  const saved = [];
  for (const angle of planned) {
    const tempPath = join(tmpdir(), `lookaround-${randomUUID()}.png`);
    try {
      await deps.extractFrame(videoPath, angle.atSec, tempPath);
      const image = await deps.saveGalleryImage(tempPath);
      const media = await withBackupAssetPublication(() => deps.attachMedia(place.id, image.filename, 'reference', {
        role: 'plate', caption: angle.label, library: { variant: { label: angle.label }, angle: angle.angle },
      }));
      saved.push({ media, angle });
    } finally {
      await unlinkGuarded(tempPath).catch(() => {});
    }
  }
  const clip = await deps.attachMedia(place.id, row.filename, 'video', {
    role: LOOK_AROUND_CLIP_ROLE, caption: `Look around (${LOOK_AROUND_MOTIONS[motion]?.label || motion}) from ${sourceMediaKey}`,
  });
  const cleanupJobs = [];
  if (cleanup) {
    for (const { media, angle } of saved) {
      const { jobId } = await deps.enqueueCleanup(cleanupBody(media.mediaKey, { width: geometry.width, height: geometry.height }), {
        settings: target.settings, local: target.local, cloud: target.cloud,
        catalogAttach: { ingredientId: place.id, kind: 'reference', role: 'plate', library: {
          variant: { label: `${angle.label} · sharpened` }, angle: angle.angle, derivedFrom: { mediaKey: media.mediaKey, kind: 'reference' },
        } },
      });
      cleanupJobs.push(jobId);
    }
  }
  console.log(`🧭 look-around kept ${saved.length} angles of ${clipId.slice(0, 8)} on ${place.id.slice(0, 8)}${cleanupJobs.length ? `, ${cleanupJobs.length} clean-ups queued` : ''}`);
  return { dryRun: false, clipId: row.id, angles: saved.map(({ media }) => media), clip, cleanupJobs };
}
