#!/usr/bin/env node

import { spawn } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { planRef2vaAudioSegments } from '../server/services/videoGen/ref2vaPlan.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

export const MAX_REF2VA_XFADE_INPUTS = 8;

let activeChild = null;
let cancellationSignal = null;

const signalChildGroup = (child, signal) => {
  if (!child?.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* child already exited */ }
  }
};

const requestCancellation = (signal) => {
  cancellationSignal ||= signal;
  signalChildGroup(activeChild, signal);
};

const installCancellationHandlers = () => {
  const onTerm = () => requestCancellation('SIGTERM');
  const onInterrupt = () => requestCancellation('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInterrupt);
  return () => {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInterrupt);
  };
};

const spawnTracked = (bin, args) => {
  if (cancellationSignal) throw new Error(`Cancelled by ${cancellationSignal}`);
  // Each expensive child leads its own process group. The detached-job parent
  // may only be able to signal this wrapper PID on macOS; the handlers above
  // forward that cancellation to the active child and every descendant it
  // spawned (mere.run and ffmpeg included).
  const child = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  activeChild = child;
  child.once('close', () => {
    if (activeChild === child) activeChild = null;
  });
  return child;
};

const parseArgs = (argv) => {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value == null) throw new Error(`Invalid argument near ${key || '(end)'}`);
    out[key.slice(2)] = value;
  }
  return out;
};

const run = (bin, args, { forwardOutput = false } = {}) => new Promise((resolve, reject) => {
  let child;
  try {
    child = spawnTracked(bin, args);
  } catch (err) {
    reject(err);
    return;
  }
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    if (forwardOutput) process.stderr.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8192);
    if (forwardOutput) process.stderr.write(chunk);
  });
  child.on('error', reject);
  child.on('close', (code, signal) => {
    if (cancellationSignal) reject(new Error(`Cancelled by ${cancellationSignal}`));
    else if (code === 0) resolve();
    else reject(new Error(`${bin} ${signal ? `was killed by ${signal}` : `exited ${code}`}: ${stderr.trim()}`));
  });
});

const probeDuration = (ffprobe, path) => new Promise((resolve, reject) => {
  let stdout = '';
  let stderr = '';
  let child;
  try {
    child = spawnTracked(ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', path,
    ]);
  } catch (err) {
    reject(err);
    return;
  }
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
  child.on('error', reject);
  child.on('close', (code) => {
    const duration = Number(stdout.trim());
    if (cancellationSignal) reject(new Error(`Cancelled by ${cancellationSignal}`));
    else if (code === 0 && Number.isFinite(duration) && duration > 0) resolve(duration);
    else reject(new Error(`ffprobe could not read source audio duration: ${stderr.trim()}`));
  });
});

const decimals = (value) => Number(value).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');

/**
 * Compose timeline-positioned clips with a bounded fan-in. A single ffmpeg
 * graph over every Ref2VA window eventually exceeds macOS' descriptor limit;
 * grouping at most eight inputs per pass makes supported duration independent
 * of that process limit while re-encoding each frame only O(log n) times.
 */
export const composeRef2vaSegments = async ({
  ffmpeg,
  workDir,
  pieces,
  runCommand = run,
  maxInputs = MAX_REF2VA_XFADE_INPUTS,
}) => {
  if (!Array.isArray(pieces) || pieces.length === 0) {
    throw new TypeError('pieces must contain at least one video');
  }
  if (!Number.isInteger(maxInputs) || maxInputs < 2) {
    throw new TypeError('maxInputs must be an integer of at least 2');
  }

  let level = 0;
  let pending = pieces.map((piece) => ({ ...piece }));
  while (pending.length > 1) {
    const next = [];
    for (let offset = 0; offset < pending.length; offset += maxInputs) {
      const batch = pending.slice(offset, offset + maxInputs);
      if (batch.length === 1) {
        next.push(batch[0]);
        continue;
      }

      const outputPath = join(workDir, `joined-${level}-${offset / maxInputs}.mp4`);
      const origin = batch[0].startSeconds;
      const filterSteps = batch.map((_, index) => (
        `[${index}:v]settb=AVTB,setpts=PTS-STARTPTS[piece${index}]`
      ));
      let currentLabel = 'piece0';
      let currentEnd = batch[0].endSeconds;
      for (let index = 1; index < batch.length; index += 1) {
        const piece = batch[index];
        const overlap = currentEnd - piece.startSeconds;
        if (!(overlap > 0)) throw new Error('Ref2VA video pieces must overlap for continuity');
        const nextLabel = `joined${index}`;
        filterSteps.push(
          `[${currentLabel}][piece${index}]xfade=transition=fade:duration=${decimals(overlap)}:offset=${decimals(piece.startSeconds - origin)}[${nextLabel}]`,
        );
        currentLabel = nextLabel;
        currentEnd = Math.max(currentEnd, piece.endSeconds);
      }
      await runCommand(ffmpeg, [
        '-v', 'error', ...batch.flatMap((piece) => ['-i', piece.path]),
        '-filter_complex', filterSteps.join(';'), '-map', `[${currentLabel}]`,
        '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', outputPath,
      ]);
      await Promise.all(batch.map((piece) => rm(piece.path, { force: true })));
      next.push({ path: outputPath, startSeconds: origin, endSeconds: currentEnd });
    }
    pending = next;
    level += 1;
  }
  return pending[0].path;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const required = ['runtime-bin', 'model-root', 'prompt', 'image', 'audio', 'width', 'height', 'fps', 'seed', 'steps', 'ffmpeg', 'ffprobe', 'output'];
  for (const key of required) {
    if (!args[key]) throw new Error(`Missing --${key}`);
  }

  const sourceDuration = await probeDuration(args.ffprobe, args.audio);
  const audioStart = Number(args['audio-start'] || 0);
  const segments = planRef2vaAudioSegments(sourceDuration, { startSeconds: audioStart });
  const workDir = await mkdtemp(join(tmpdir(), 'portos-h3-ref2va-'));
  let currentImage = args.image;
  const segmentPieces = [];

  process.stderr.write(`RUNTIME:${JSON.stringify({ runtime: 'minimax_h3_ref2va', versions: { 'mere.run': '0.47.0' } })}\n`);
  process.stderr.write(`STATUS:Planning ${segments.length} continuity-linked audio window${segments.length === 1 ? '' : 's'} for ${decimals(sourceDuration - audioStart)} seconds\n`);

  try {
    for (const segment of segments) {
      const displayIndex = segment.index + 1;
      const audioPath = join(workDir, `audio-${segment.index}.wav`);
      const rawVideoPath = join(workDir, `raw-${segment.index}.mp4`);
      const timelineVideoPath = join(workDir, `segment-${segment.index}.mp4`);
      const nextImagePath = join(workDir, `continuity-${segment.index}.png`);
      const outputDuration = decimals(segment.durationSeconds);
      const referenceDuration = decimals(segment.referenceDurationSeconds);
      const trimStart = decimals(segment.trimStartSeconds);
      // This marker describes work that is STARTING, so report completed
      // windows (0-based) rather than the display index. Reporting 3/3 at the
      // start of the final window left the UI parked at 100% throughout the
      // most expensive part of the render.
      process.stderr.write(`STAGE:ref2va-window:step:${segment.index}:${segments.length}:Rendering audio window ${displayIndex}/${segments.length}\n`);

      await run(args.ffmpeg, [
        '-v', 'error', '-ss', decimals(segment.referenceStartSeconds), '-i', args.audio,
        '-t', referenceDuration, '-vn', '-ac', '2', '-ar', '32000', '-c:a', 'pcm_s16le',
        '-y', audioPath,
      ]);

      await run(args['runtime-bin'], [
        'video', 'generate', args.prompt,
        '--model-root', args['model-root'],
        '--reference', `image:${currentImage}`,
        '--reference', `audio:${audioPath}`,
        '--duration', referenceDuration,
        '--width', args.width,
        '--height', args.height,
        '--fps', args.fps,
        '--seed', String(Number(args.seed) + segment.index),
        '--steps', args.steps,
        '--h3-weight-mode', 'quantized',
        '--h3-acceleration', 'maximum',
        '--h3-window-frames', '124',
        '--h3-window-overlap', '35',
        '--output', rawVideoPath,
      ], { forwardOutput: true });

      // Preserve later windows' generated warm-up picture so xfade can blend
      // the overlapping source-audio interval instead of making a hard cut.
      // The first window has no preceding picture to blend against, so trim
      // any requested-offset warm-up there. tpad covers a runtime result that
      // lands one H3 cadence short.
      const timelineTrimStart = segment.index === 0 ? trimStart : '0';
      const timelineDuration = segment.index === 0 ? outputDuration : referenceDuration;
      await run(args.ffmpeg, [
        '-v', 'error', '-i', rawVideoPath, '-ss', timelineTrimStart,
        '-vf', 'tpad=stop_mode=clone:stop_duration=1', '-t', timelineDuration,
        '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', timelineVideoPath,
      ]);
      const timelineStart = segment.index === 0
        ? segment.startSeconds
        : segment.referenceStartSeconds;
      segmentPieces.push({
        path: timelineVideoPath,
        startSeconds: timelineStart,
        endSeconds: timelineStart + Number(timelineDuration),
      });

      if (displayIndex < segments.length) {
        await run(args.ffmpeg, [
          '-v', 'error', '-sseof', '-0.05', '-i', timelineVideoPath,
          '-frames:v', '1', '-y', nextImagePath,
        ]);
        currentImage = nextImagePath;
      }
    }

    process.stderr.write('STAGE:ref2va-mux\n');
    const concatenated = await composeRef2vaSegments({
      ffmpeg: args.ffmpeg,
      workDir,
      pieces: segmentPieces,
    });

    const finalDuration = decimals(sourceDuration - audioStart);
    await run(args.ffmpeg, [
      '-v', 'error', '-i', concatenated, '-ss', decimals(audioStart), '-i', args.audio,
      '-filter_complex', '[0:v]tpad=stop_mode=clone:stop_duration=1[v]',
      '-map', '[v]', '-map', '1:a:0', '-t', finalDuration,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', args.output,
    ]);
    process.stderr.write(`STATUS:MiniMax H3 Ref2VA saved ${args.output} with the full ${finalDuration}-second source audio\n`);
    process.stdout.write(`${JSON.stringify({ video_path: args.output, duration: Number(finalDuration), segments: segments.length })}\n`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};

if (isDirectlyInvoked(import.meta.url)) {
  const removeCancellationHandlers = installCancellationHandlers();
  main().catch((err) => {
    process.stderr.write(`ERROR:${err.message}\n`);
    process.exitCode = 1;
  }).finally(removeCancellationHandlers);
}
