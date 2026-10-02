/** Native sequence adapter; authority comes only from checked machine settings. */
import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, copyFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { PATHS } from '../../lib/paths.js';
import { ServerError } from '../../lib/errorHandler.js';
import { findFfmpeg, runFfmpegProcess, H264_ENCODE_ARGS, BT709_CONTAINER_ARGS, bt709TagFilter,
  probeVideoGeometry, probeFrameCount, generateThumbnail } from '../../lib/ffmpeg.js';
import { mutateVideoHistory } from '../videoGen/history.js';
import { writeRunArtifact } from './projectFiles.js';
import { resolveBlenderExecution } from './execution.js';
import { BLENDER_DRIVER } from './blenderDriver.js';

const fail = message => new ServerError(message, { status: 422, code: 'CODE_ANIMATION_BLENDER_RENDER_FAILED' });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// A measured full 1080p EEVEE Next/Metal pilot peaked near 9.7 GiB resident, over the 8 GiB worker default
// (CPU Cycles stays under it), so only the GPU engine gets headroom; the watchdog still applies.
const GPU_ENGINE_LIMITS = { BLENDER_EEVEE_NEXT: { memoryBytes: 16 * 1024 ** 3 } };
const frameName = frame => `frame-${String(frame).padStart(6, '0')}.png`;

/** Validate every image and persist the baked scene, report and real sequence. */
export async function renderBlenderSequence({ revision, runtime, projectId, runId, signal, reserve, phase, times = [], captureTimes = [], diskBytes, wallSeconds }, {
  resolveRuntime = resolveBlenderExecution, retain = writeRunArtifact,
} = {}) {
  const checked = await resolveRuntime(revision.manifest.renderer, runtime);
  signal?.throwIfAborted();
  const source = revision.files.find(file => file.path === revision.entryPath);
  if (!source || source.encoding !== 'utf8' || !revision.entryPath.endsWith('.py')) throw fail('Blender scene entrypoint must be a UTF-8 Python file defining build_scene(config)');
  const format = revision.manifest.format;
  const count = Math.round(format.durationSeconds * format.fps);
  if (!count || Math.abs(count / format.fps - format.durationSeconds) > 1e-8) throw fail('Duration must land on the frame grid');
  const frames = phase === 'style' ? [...new Set(captureTimes.map(t => Math.min(count, 1 + Math.round(t * format.fps))))] : Array.from({ length: count }, (_, i) => i + 1);
  const config = { ...format, version: checked.provenance.version, engine: checked.provenance.engine,
    frameCount: count, frames, seed: revision.manifest.seed ?? 0, samples: phase === 'final' ? 16 : 4,
    entrypoint: revision.entryPath };
  if (revision.files.some(file => ['portos-driver.py', 'portos-render.json'].includes(file.path))) throw fail('Package uses a reserved driver filename');
  const id = randomUUID();
  const artifacts = [];
  const samples = [];
  const captures = [];
  let report;
  let encoded = null;
  const persist = async (name, bytes) => {
    await reserve(bytes.length);
    const artifact = await retain(projectId, runId, `${phase}-${id}-${name}`, bytes);
    artifacts.push({ name, ...artifact });
    return artifact;
  };
  const run = await checked.worker({
    tool: { executable: checked.executable, argv: entry => ['--background', '--factory-startup', '--disable-autoexec', '--threads', '2', '--python-exit-code', '1', '--python', entry] },
    workspaceRoot: join(PATHS.data, 'code-animation-workspaces'), entrypoint: 'portos-driver.py', signal,
    files: [...revision.files, { path: 'portos-driver.py', content: BLENDER_DRIVER }, { path: 'portos-render.json', content: JSON.stringify(config) }],
    limits: { wallSeconds: Math.max(1, Math.min(86400, Math.ceil(wallSeconds))), diskBytes: Math.max(1024, diskBytes), ...GPU_ENGINE_LIMITS[config.engine] },
    onOutput: async (directory, outputs) => {
      signal?.throwIfAborted();
      const metadata = outputs.find(file => file.path === 'report.json');
      if (!metadata || metadata.bytes > 128 * 1024) throw fail('Missing or oversized Blender report');
      report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
      if (report.version !== config.version || report.engine !== config.engine || report.device !== checked.provenance.device
        || report.backend !== checked.provenance.backend || report.width !== format.width || report.height !== format.height
        || report.fps !== format.fps || report.frameCount !== count || report.samples !== config.samples || report.seed !== config.seed
        || JSON.stringify(report.frames) !== JSON.stringify(frames) || !report.baked || !report.cameraSmooth
        || !Array.isArray(report.cadence) || !report.cadence.length
        || report.cadence.some(item => ![2, 3].includes(item.step) || item.holdsVerified !== true || item.motionBlur !== false)) throw fail('Blender output does not match the requested runtime, cadence or format');
      const expected = new Set(['report.json', 'scene.blend', ...frames.map(frameName)]);
      if (outputs.length !== expected.size || outputs.some(file => !expected.has(file.path))) throw fail('Blender output files do not match the requested sequence');
      const { default: sharp } = await import('sharp');
      for (const frame of frames) {
        signal?.throwIfAborted();
        const bytes = await readFile(join(directory, frameName(frame)));
        const image = sharp(bytes, { limitInputPixels: format.width * format.height });
        const meta = await image.metadata();
        if (meta.format !== 'png' || meta.width !== format.width || meta.height !== format.height) throw fail('Blender frame geometry is invalid');
        // Full decode catches truncated payloads; hash pixels for repeatability.
        const pixels = await image.ensureAlpha().raw().toBuffer();
        const small = await sharp(pixels, { raw: { width: format.width, height: format.height, channels: 4 } }).resize(16, 9).greyscale().raw().toBuffer();
        const mean = small.reduce((sum, value) => sum + value, 0) / small.length;
        const deviation = Math.sqrt(small.reduce((sum, value) => sum + (value - mean) ** 2, 0) / small.length);
        const t = (frame - 1) / format.fps;
        if (phase !== 'style' || times.some(time => Math.round(time * format.fps) === frame - 1)) samples.push({ t, renderHash: hash(pixels), mean, deviation });
        for (const requested of captureTimes.filter(time => Math.round(time * format.fps) === frame - 1)) captures.push({ t: requested, bytes });
        await persist(frameName(frame), bytes);
      }
      const blend = await readFile(join(directory, 'scene.blend'));
      if (blend.subarray(0, 7).toString() !== 'BLENDER') throw fail('Baked scene artifact is invalid');
      await persist('scene.blend', blend);
      await persist('report.json', Buffer.from(JSON.stringify(report)));
      if (phase !== 'style') {
        const ffmpeg = await findFfmpeg();
        if (!ffmpeg) throw fail('ffmpeg is required for the Blender sequence');
        const video = join(directory, 'sequence.mp4');
        const tag = await bt709TagFilter();
        signal?.throwIfAborted();
        const result = await runFfmpegProcess({ bin: ffmpeg, signal, args: ['-hide_banner', '-loglevel', 'error', '-framerate', String(format.fps),
          '-start_number', '1', '-i', join(directory, 'frame-%06d.png'), '-frames:v', String(count),
          '-vf', ['scale=in_range=pc:out_range=tv:out_color_matrix=bt709', tag].filter(Boolean).join(','),
          ...H264_ENCODE_ARGS, ...BT709_CONTAINER_ARGS, '-movflags', '+faststart', '-n', video] });
        signal?.throwIfAborted();
        if (!result.ok) throw fail(`Sequence encoding failed: ${result.reason}`);
        const geometry = await probeVideoGeometry(video);
        const frameCount = await probeFrameCount(video);
        if (!geometry || geometry.width !== format.width || geometry.height !== format.height || geometry.fps !== format.fps || geometry.numFrames !== count || frameCount !== count || Math.abs(geometry.durationSec - count / format.fps) > 1 / format.fps) throw fail('Encoded Blender sequence failed frame validation');
        const videoBytes = await readFile(video);
        const artifact = await persist('sequence.mp4', videoBytes);
        encoded = { artifact, geometry };
      }
    },
  });
  signal?.throwIfAborted();
  if (run.status !== 'completed' || !run.processGroupClear || !report) throw fail(`Blender worker ${run.reason || run.status}; no render accepted`);
  // A save during native execution revokes publication as well as the next
  // spawn. Retained artifacts remain evidence from the old binding only.
  await resolveRuntime(revision.manifest.renderer, runtime);
  signal?.throwIfAborted();
  return { contract: { width: format.width, height: format.height, fps: format.fps, durationSec: count / format.fps },
    samples, frames: captures, artifacts, sequence: encoded, renderer: { ...report, ...checked.provenance, durationMs: run.durationMs } };
}

export async function publishBlenderVideo(sequence, { revision, signal, reserve }) {
  const id = randomUUID();
  const filename = `blender-${id}.mp4`;
  const destination = join(PATHS.videos, filename);
  const source = join(PATHS.data, sequence.sequence.artifact.relativePath);
  let success = false;
  let thumbnail = null;
  await mkdir(PATHS.videos, { recursive: true });
  try {
    signal?.throwIfAborted();
    await reserve((await stat(source)).size);
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    thumbnail = await generateThumbnail(destination, id);
    if (!thumbnail) throw fail('Blender thumbnail generation failed');
    signal?.throwIfAborted();
    const commit = () => mutateVideoHistory(history => {
      history.unshift({ id, filename, thumbnail, modelId: 'code-animation-blender', prompt: revision.manifest.title,
        ...sequence.sequence.geometry, seed: revision.manifest.seed ?? 0, createdAt: new Date().toISOString(),
        codeAnimation: { revisionId: revision.id, sourceHash: revision.sourceHash, renderer: sequence.renderer } });
      return history;
    });
    success = true;
    return { id, filename, thumbnail, path: `/data/videos/${filename}`, renderer: sequence.renderer, artifacts: sequence.artifacts,
      commit, cleanup: async () => { await rm(destination, { force: true }); await rm(join(PATHS.videoThumbnails, thumbnail), { force: true }); } };
  } finally {
    if (!success) {
      await rm(destination, { force: true });
      if (thumbnail) await rm(join(PATHS.videoThumbnails, thumbnail), { force: true });
    }
  }
}
