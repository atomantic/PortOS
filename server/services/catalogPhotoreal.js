/**
 * Environments › Photoreal: build a place's greybox in Blender and render its saved
 * cameras. Runs only on the user's tap, through the operator-checked Blender tool
 * (Code Animation › Blender execution) with PortOS's own script; the greybox is data.
 *
 * Each render attaches to the place as a reference image tagged
 * `photoreal:<shotId>`, replacing that shot's previous render unless the shot uses it
 * as its photo plate. The latest `.blend` is kept per place for opening in Blender.
 * A fly-through glides one camera through the chosen cameras in order and saves
 * the MP4 to Media History, where it can be picked as a video reference.
 * One render per place at a time; progress goes out as `catalog:photoreal` frames.
 */

import { access, readFile, mkdir, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PATHS } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { maintenance } from '../lib/maintenanceAdmission.js';
import { H264_ENCODE_ARGS } from '../lib/ffmpeg.js';
import { launchDetached } from '../lib/launchDetached.js';
import { resolveGreybox } from '../lib/greyboxScene.js';
import { resolvePhotorealLook } from '../lib/photorealLook.js';
import {
  GREYBOX_BLENDER_PY, greyboxBlenderJob, photorealFlythroughFrameFile, photorealShotFile, photorealShotRole,
} from '../lib/greyboxBlender.js';
import * as catalogDB from './catalogDB.js';
import { catalogEvents } from './catalogEvents.js';
import { uploadIngredientMediaFile } from './catalogMedia.js';

const BLEND_DIR = 'photoreal-blends';
const WORKSPACES = 'photoreal-workspaces';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const refuse = (message, code, status = 400) => new ServerError(message, { status, code });

const deps = {
  resolveTool: async () => (await import('./codeAnimation/execution.js')).resolveBlenderTool(),
  lastCheckedVersion: async () => (await import('./codeAnimation/execution.js')).lastCheckedBlenderVersion(),
  findFfmpeg: async () => (await import('../lib/ffmpeg.js')).findFfmpeg(),
  runFfmpeg: async (args) => (await import('../lib/ffmpeg.js')).runFfmpegProcess(args),
  saveVideo: async (path, name) => (await import('./videoUpload.js')).saveUploadedGalleryVideoFile(path, name),
  launch: (executable, args) => launchDetached(executable, args),
};

export const __setPhotorealDepsForTests = (overrides) => Object.assign(deps, overrides);

// ingredientId → latest job. In memory: a render is a disposable process; the
// renders it attached and the .blend it kept are the durable results.
const jobs = new Map();

// Ingredient ids are slug-safe; anything else never reaches a file path.
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const blendPath = (ingredientId) => join(PATHS.data, BLEND_DIR, `${ingredientId}.blend`);
const blendUrl = (ingredientId) => `/api/catalog/ingredients/${encodeURIComponent(ingredientId)}/photoreal/blend`;

/** The kept `.blend` for a place, or null when none has been built. */
export async function photorealBlendPath(ingredientId) {
  if (!SAFE_ID.test(ingredientId)) return null;
  const path = blendPath(ingredientId);
  return access(path).then(() => path, () => null);
}

/**
 * Open the kept `.blend` in the operator-checked Blender on this machine, as a
 * normal window. The next render replaces that file, so keep edits with Save As.
 */
export async function openPhotorealBlend(ingredientId) {
  const path = await photorealBlendPath(ingredientId);
  if (!path) throw refuse('Render this place once first; that builds the Blender scene.', 'PHOTOREAL_NO_BLEND', 404);
  const tool = await deps.resolveTool();
  // The file is PortOS's own build; scripts stay off as in every render.
  await deps.launch(tool.executable, ['--disable-autoexec', path]).catch((err) => {
    throw refuse(`Blender did not start: ${err.message}`, 'PHOTOREAL_OPEN_FAILED', 500);
  });
  console.log(`🧊 Opened the photoreal scene for place ${ingredientId.slice(0, 12)} in Blender ${tool.version}`);
  return { opened: true, blenderVersion: tool.version };
}

function publish(job) {
  jobs.set(job.ingredientId, job);
  catalogEvents.emit('photoreal', { ingredientId: job.ingredientId, job });
}

async function requireSpecGreybox(ingredientId) {
  const place = await catalogDB.getIngredient(ingredientId);
  if (!place) throw refuse('Place not found', 'NOT_FOUND', 404);
  if (place.type !== 'place') throw refuse('Photoreal renders belong to a place', 'GREYBOX_NOT_A_PLACE');
  const scene = resolveGreybox(place.payload);
  if (!scene) throw refuse('Save a greybox for this place first.', 'GREYBOX_MISSING', 422);
  if (scene.source !== 'spec') throw refuse('Switch the Greybox layout source to the saved parts; an attached .glb is not rebuilt in Blender yet.', 'GREYBOX_NOT_RENDERABLE', 422);
  return { place, scene };
}

/** What the tab shows on open. Memory and file reads only; starts nothing. */
export async function getPhotorealStatus(ingredientId) {
  return {
    job: jobs.get(ingredientId) || null,
    blendUrl: (await photorealBlendPath(ingredientId)) ? blendUrl(ingredientId) : null,
    blenderVersion: await deps.lastCheckedVersion(),
    // Where this machine keeps the scene and the stills, shown so the operator can find them.
    files: SAFE_ID.test(ingredientId) ? { blend: blendPath(ingredientId), renders: PATHS.images } : null,
  };
}

/** Validate, then render in the background; answers with the running job. */
export async function startPhotorealRender(ingredientId, { shotIds, engine, samples, flythroughSeconds = null }) {
  if (jobs.get(ingredientId)?.state === 'running') throw refuse('A render is already running for this place.', 'PHOTOREAL_BUSY', 409);
  const { place, scene } = await requireSpecGreybox(ingredientId);
  if (!SAFE_ID.test(place.id)) throw refuse('This place id cannot name a scene file.', 'PHOTOREAL_BAD_ID');
  const known = new Set(scene.shots.map((s) => s.id));
  const unknown = shotIds.filter((id) => !known.has(id));
  if (unknown.length) throw refuse(`Save these cameras on the greybox first: ${unknown.join(', ')}.`, 'GREYBOX_SHOT_UNKNOWN', 404);
  if (flythroughSeconds && shotIds.length < 2) throw refuse('A fly-through needs at least two cameras to travel between.', 'PHOTOREAL_FLYTHROUGH_SHOTS');
  // Checked before Blender starts, so a missing encoder never costs a render.
  if (flythroughSeconds && !(await deps.findFfmpeg())) throw refuse('A fly-through needs ffmpeg to make its MP4; install ffmpeg first.', 'FFMPEG_MISSING', 503);
  const tool = await deps.resolveTool();
  // Validation can overlap another request; claim the slot only after its awaits.
  if (jobs.get(ingredientId)?.state === 'running') throw refuse('A render is already running for this place.', 'PHOTOREAL_BUSY', 409);
  const job = {
    id: `pr-${Date.now().toString(36)}`, ingredientId, state: 'running', engine, shotIds, samples: greyboxBlenderJob(scene, { shotIds, engine, samples }).samples,
    ...(flythroughSeconds ? { flythroughSeconds } : {}),
    startedAt: new Date().toISOString(), finishedAt: null, error: null, report: null, video: null, blenderVersion: tool.version,
  };
  publish(job);
  maintenance.run('composition', 'Photoreal environment render', () => runRender({ place, scene, tool, job, samples }), { continuation: true })
    .catch((err) => {
      console.error(`❌ Photoreal render for place ${ingredientId.slice(0, 12)} failed: ${err.message}`);
      publish({ ...job, state: 'failed', error: err.message, finishedAt: new Date().toISOString() });
    });
  return job;
}

async function runRender({ place, scene, tool, job, samples }) {
  // The look dresses parts by id; a rule for a part since removed just matches nothing.
  const config = greyboxBlenderJob(scene, { shotIds: job.shotIds, engine: job.engine, samples, look: resolvePhotorealLook(place.payload), flythroughSeconds: job.flythroughSeconds });
  const fly = config.flythrough;
  let report = null;
  const outputs = {};
  // The frames are encoded while the worker still holds its output directory.
  const encodeDir = fly ? await mkdtemp(join(tmpdir(), 'portos-flythrough-')) : null;
  try {
    // Cycles on a GPU and EEVEE both need more than the 8 GiB worker default.
    const wallSeconds = Math.min(86400, 600 + (fly ? fly.frames * (job.engine === 'cycles' ? 300 : 30) : job.shotIds.length * (job.engine === 'cycles' ? 1800 : 120)));
    const run = await tool.worker({
      tool: { executable: tool.executable, argv: (entry) => ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', entry] },
      workspaceRoot: join(PATHS.data, WORKSPACES), entrypoint: 'greybox-blender.py',
      files: [{ path: 'greybox-blender.py', content: GREYBOX_BLENDER_PY }, { path: 'greybox-blender.json', content: JSON.stringify(config) }],
      limits: { wallSeconds, diskBytes: (fly ? 16 : 4) * 1024 ** 3, memoryBytes: 24 * 1024 ** 3 },
      onOutput: async (directory, files) => {
        const sizes = new Map(files.map((f) => [f.path, f.bytes]));
        const names = new Set(sizes.keys());
        if (!names.has('report.json') || !names.has('blockout.blend')) throw new Error('Blender finished without its report or scene file');
        if (sizes.get('report.json') > 128 * 1024) throw new Error('Blender report is oversized');
        report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
        await mkdir(join(PATHS.data, BLEND_DIR), { recursive: true });
        await copyFile(join(directory, 'blockout.blend'), blendPath(place.id));
        if (fly) {
          outputs.video = await encodeFlythrough(directory, names, fly, encodeDir);
          return;
        }
        for (const shotId of job.shotIds) {
          const name = photorealShotFile(shotId);
          if (!names.has(name)) throw new Error(`Blender did not render camera "${shotId}"`);
          const bytes = await readFile(join(directory, name));
          if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`Blender's render of camera "${shotId}" is not a PNG`);
          outputs[shotId] = bytes;
        }
      },
    });
    if (run.status !== 'completed' || !report) throw new Error(`Blender stopped before finishing (${run.status}${run.reason ? `: ${run.reason}` : ''})`);
    let video = null;
    if (fly) {
      const labels = job.shotIds.map((id) => scene.shots.find((s) => s.id === id)?.label || id);
      const entry = await deps.saveVideo(outputs.video, `${place.name} fly-through (${labels.join(' → ')}).mp4`);
      video = { id: entry.id, filename: entry.filename };
      console.log(`🎥 Photoreal ${job.engine} fly-through for place ${place.id.slice(0, 12)}: ${fly.frames} frames on ${report.device}${report.backend ? `/${report.backend}` : ''}`);
    } else {
      await attachRenders(place, scene, job, outputs, report);
      console.log(`🎥 Photoreal ${job.engine} render for place ${place.id.slice(0, 12)}: ${job.shotIds.length} camera(s) on ${report.device}${report.backend ? `/${report.backend}` : ''}`);
    }
    publish({ ...job, state: 'done', report, video, finishedAt: new Date().toISOString() });
    if (!fly) catalogEvents.emit('primitive-changed', { ingredientId: place.id });
  } finally {
    if (encodeDir) await rm(encodeDir, { recursive: true, force: true });
  }
}

// Every numbered frame must be a PNG; the MP4 is H.264 at the job's frame rate.
async function encodeFlythrough(directory, names, fly, encodeDir) {
  for (let frame = 1; frame <= fly.frames; frame++) {
    if (!names.has(photorealFlythroughFrameFile(frame))) throw new Error(`Blender did not render fly-through frame ${frame}`);
  }
  const first = await readFile(join(directory, photorealFlythroughFrameFile(1)));
  if (!first.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Blender\'s fly-through frames are not PNGs');
  const ffmpeg = await deps.findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg is no longer available to encode the fly-through');
  const output = join(encodeDir, 'flythrough.mp4');
  const encoded = await deps.runFfmpeg({ bin: ffmpeg, args: [
    '-framerate', String(fly.fps), '-start_number', '1', '-i', join(directory, 'frame-%04d.png'),
    '-frames:v', String(fly.frames), ...H264_ENCODE_ARGS, '-movflags', '+faststart', '-y', output,
  ] });
  if (!encoded.ok) throw new Error(`Fly-through MP4 encode failed: ${encoded.reason}`);
  return output;
}

async function attachRenders(place, scene, job, outputs, report) {
  // Re-read so a plate picked while rendering is honoured below.
  const current = resolveGreybox((await catalogDB.getIngredient(place.id))?.payload) || scene;
  const plates = new Set(current.shots.map((s) => s.plate).filter(Boolean));
  const existing = (await catalogDB.listMediaForIngredient(place.id) || []).filter((m) => !m.deleted);
  for (const shotId of job.shotIds) {
    const shot = current.shots.find((s) => s.id === shotId) || scene.shots.find((s) => s.id === shotId);
    const seconds = report.shots?.find((s) => s.shotId === shotId)?.seconds;
    const role = photorealShotRole(shotId);
    const media = await uploadIngredientMediaFile({
      ingredientId: place.id, dataBase64: outputs[shotId].toString('base64'), mimeType: 'image/png', role,
      caption: `${place.name}: ${shot.label} (Blender ${report.version} ${job.engine === 'cycles' ? 'Cycles' : 'EEVEE'}, ${job.samples} samples${seconds != null ? `, ${seconds}s` : ''})`,
    });
    for (const old of existing) {
      if (old.role === role && old.mediaKey !== media.mediaKey && !plates.has(old.mediaKey)) {
        await catalogDB.detachMedia(place.id, old.mediaKey, old.kind);
      }
    }
  }
}
