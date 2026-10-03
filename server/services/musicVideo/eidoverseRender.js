/** Eidoverse is an optional independent AGPL runtime, never host eval. */
import { mkdtemp, mkdir, writeFile, rm, lstat, realpath, readdir, chmod, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { bufferedSpawn } from '../../lib/bufferedSpawn.js';
import { runStreamingCommand } from '../../lib/streamingSpawn.js';
import { whichFirst } from '../../lib/processEnv.js';
import { musicVideoEidoverseSceneSchema } from '../../lib/musicVideoValidation.js';
import { codeFrameSize, quantizeSongDuration } from './codeTimeline.js';
import { musicVideoAspect } from '../../lib/musicVideoAspect.js';

const EIDOVERSE_RENDER_IMAGE = 'portos-eidoverse-video:1';
const DOCKER_FALLBACKS = ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker'];
const OUTPUT_LIMIT = 2 * 1024 ** 3;
const WALL_MS = 30 * 60 * 1000;

export async function prepareEidoverseRender(project) {
  const scene = musicVideoEidoverseSceneSchema.safeParse(project.composition?.eidoverseScene);
  if (!scene.success) throw new ServerError('Save an Eidoverse scene before rendering.', { status: 422, code: 'EIDOVERSE_SCENE_REQUIRED' });
  const duration = project.audioAnalysis?.durationSec;
  if (!(duration > 0)) throw new ServerError('Analyze the master song before rendering Eidoverse.', { status: 422, code: 'NO_TIMELINE' });
  let docker = await whichFirst('docker');
  for (const candidate of DOCKER_FALLBACKS) {
    if (docker) break;
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) docker = candidate;
  }
  if (!docker) throw new ServerError('Eidoverse Video requires Docker and the optional render image. See docs/EIDOVERSE_VIDEO.md.', { status: 422, code: 'EIDOVERSE_RUNTIME_MISSING' });
  const image = await bufferedSpawn(docker, ['image', 'inspect', '--format', '{{.Id}}', EIDOVERSE_RENDER_IMAGE], { timeoutMs: 15000 });
  const imageId = image.stdout?.trim();
  if (!image.success || !/^sha256:[a-f0-9]{64}$/.test(imageId || '')) throw new ServerError('Build the optional Eidoverse Video render image first. See docs/EIDOVERSE_VIDEO.md.', { status: 422, code: 'EIDOVERSE_RUNTIME_MISSING' });
  return { scene: scene.data, docker, imageId, ...codeFrameSize(musicVideoAspect(project)),
    fps: 24, durationSec: quantizeSongDuration(duration, 24).durationSec };
}

// No checkout, home, credentials, API token, song or Docker socket is mounted.
// Scene code can only see the installed runtime and this job's two directories.
function eidoverseContainerArgs({ name, root, imageId }) {
  return ['run', '--rm', '--pull=never', '--name', name, '--network=none', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256', '--memory=8g', '--cpus=4',
    '--ulimit', `fsize=${OUTPUT_LIMIT}:${OUTPUT_LIMIT}`, '--user=1000:1000', '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m,mode=1777',
    '--mount', `type=bind,src=${join(root, 'input')},dst=/input,readonly`,
    '--mount', `type=bind,src=${join(root, 'output')},dst=/output`,
    '--workdir=/workspace', '--entrypoint=timeout', imageId,
    '--signal=KILL', '1800', 'deno', 'run', '--cached-only', '--frozen', '--node-modules-dir=manual', '--allow-all', '--unstable-webgpu',
    'eidoverse/render_scene.mjs', '/input/scene.json'];
}

// lstat never follows worker-created symlinks. Bound both bytes and entries.
async function outputOverLimit(directory) {
  let bytes = 0;
  let entries = 0;
  for (const name of await readdir(directory)) {
    const info = await lstat(join(directory, name)).catch(() => null);
    if (!info) continue;
    if (++entries > 1024 || info.isDirectory()) return true; // engine output is flat
    bytes += info.size;
    if (bytes > OUTPUT_LIMIT) return true;
  }
  return false;
}

/** Render full song time before trimming: simulations preserve their pre-roll. */
export async function encodeEidoverseComposition({ plan, project, audioPath, outputPath, signal, onProgress, windowStart = 0, windowEnd = plan.durationSec, fade = false }) {
  const { findFfmpeg, runFfmpegProcess, probeVideoDuration, probeVideoGeometry, edgeFadeFilter } = await import('../../lib/ffmpeg.js');
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new ServerError('ffmpeg not found on PATH', { status: 500, code: 'FFMPEG_MISSING' });
  signal?.throwIfAborted();
  const root = await realpath(await mkdtemp(join(tmpdir(), 'portos-eidoverse-')));
  const name = `portos-mv-eido-${randomUUID()}`;
  let removed = false;
  let quotaExceeded = false;
  let quotaTimer;
  let checking = false;
  try {
    await mkdir(join(root, 'input'));
    // The unprivileged image user must be able to traverse/write these mounts.
    await chmod(root, 0o755);
    await mkdir(join(root, 'output'), { mode: 0o777 });
    await chmod(join(root, 'output'), 0o777);
    await writeFile(join(root, 'input', 'scene.json'), JSON.stringify({
      ...plan.scene, width: plan.width, height: plan.height, fps: plan.fps,
      duration: plan.durationSec, outputVideo: '/output/scene.mp4',
    }));
    signal?.throwIfAborted();
    quotaTimer = setInterval(() => {
      if (checking) return;
      checking = true;
      outputOverLimit(join(root, 'output')).then(over => { quotaExceeded ||= over; })
        .catch(() => { quotaExceeded = true; }).finally(() => { checking = false; });
    }, 500);
    const render = await runStreamingCommand(plan.docker, eidoverseContainerArgs({ name, root, imageId: plan.imageId }), (line) => {
      const frame = line.match(/^\[render_scene\] frame (\d+)\/(\d+)/);
      if (frame && Number(frame[2]) > 0) onProgress?.(Math.min(0.9, Number(frame[1]) / Number(frame[2]) * 0.9));
    },
      { timeoutMs: WALL_MS, isCancelled: () => Boolean(signal?.aborted) || quotaExceeded });
    // Killing docker's client does not kill its container. Confirm teardown
    // before touching any worker output, even after normal completion.
    const cleanup = await bufferedSpawn(plan.docker, ['rm', '--force', name], { timeoutMs: 30000 });
    removed = cleanup.success || /no such container/i.test(cleanup.stderr || '');
    if (!removed) throw new ServerError('Eidoverse container cleanup failed; inspect Docker before retrying.', { status: 500, code: 'EIDOVERSE_CLEANUP_FAILED' });
    signal?.throwIfAborted();
    if (quotaExceeded || await outputOverLimit(join(root, 'output'))) throw new ServerError('Eidoverse exceeded its output limit.', { status: 422, code: 'EIDOVERSE_OUTPUT_LIMIT' });
    if (!render.success) throw new ServerError(render.error === 'cancelled' ? 'Render cancelled' : 'Eidoverse rendering failed. Check the scene and optional runtime setup.', { status: 422, code: render.error === 'cancelled' ? 'CANCELED' : 'EIDOVERSE_RENDER_FAILED' });
    const silent = join(root, 'output', 'scene.mp4');
    const info = await lstat(silent);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size === 0 || info.size > OUTPUT_LIMIT) throw new ServerError('Eidoverse produced an invalid video.', { status: 422, code: 'EIDOVERSE_OUTPUT_INVALID' });
    const [duration, geometry] = await Promise.all([probeVideoDuration(silent), probeVideoGeometry(silent)]);
    if (!Number.isFinite(duration) || Math.abs(duration - plan.durationSec) > 1 / plan.fps || geometry?.width !== plan.width || geometry?.height !== plan.height || Math.abs((geometry?.fps || 0) - plan.fps) > 0.01) throw new ServerError('Eidoverse output does not match the song duration and frame size.', { status: 422, code: 'EIDOVERSE_OUTPUT_INVALID' });
    signal?.throwIfAborted();
    onProgress?.(0.9);
    const span = windowEnd - windowStart;
    const mux = await runFfmpegProcess({ bin: ffmpeg, signal, args: [
      '-hide_banner', '-loglevel', 'error', '-ss', String(windowStart), '-i', silent,
      '-ss', String(windowStart), '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0',
      '-t', String(span), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
      '-af', `atrim=duration=${span},apad=whole_dur=${span},asetpts=PTS-STARTPTS${fade ? edgeFadeFilter(span) : ''}`,
      '-movflags', '+faststart', '-y', outputPath,
    ] });
    signal?.throwIfAborted();
    if (!mux.ok) throw new Error(mux.reason || 'Master song mux failed');
    onProgress?.(1);
    const boundaryTimes = [...new Set([0, ...(project.scenes || []).map(s => s.startSec - windowStart)]
      .filter(t => t >= 0 && t < span))].sort((a, b) => a - b);
    return { width: plan.width, height: plan.height, fps: plan.fps, durationSec: span, boundaryTimes };
  } finally {
    clearInterval(quotaTimer);
    if (!removed) {
      const cleanup = await bufferedSpawn(plan.docker, ['rm', '--force', name], { timeoutMs: 30000 });
      removed = cleanup.success || /no such container/i.test(cleanup.stderr || '');
    }
    if (removed) await rm(root, { recursive: true, force: true });
    else console.error('❌ Eidoverse container cleanup failed; retained its private scratch directory.');
  }
}
