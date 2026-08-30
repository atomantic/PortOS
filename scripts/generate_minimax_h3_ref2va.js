#!/usr/bin/env node

import { spawn } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { planRef2vaAudioSegments } from '../server/services/videoGen/ref2vaPlan.js';

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
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
    if (code === 0) resolve();
    else reject(new Error(`${bin} ${signal ? `was killed by ${signal}` : `exited ${code}`}: ${stderr.trim()}`));
  });
});

const probeDuration = (ffprobe, path) => new Promise((resolve, reject) => {
  let stdout = '';
  let stderr = '';
  const child = spawn(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', path,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
  child.on('error', reject);
  child.on('close', (code) => {
    const duration = Number(stdout.trim());
    if (code === 0 && Number.isFinite(duration) && duration > 0) resolve(duration);
    else reject(new Error(`ffprobe could not read source audio duration: ${stderr.trim()}`));
  });
});

const decimals = (value) => Number(value).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');

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
  const segmentVideos = [];

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
      segmentVideos.push(timelineVideoPath);

      if (displayIndex < segments.length) {
        await run(args.ffmpeg, [
          '-v', 'error', '-sseof', '-0.05', '-i', timelineVideoPath,
          '-frames:v', '1', '-y', nextImagePath,
        ]);
        currentImage = nextImagePath;
      }
    }

    process.stderr.write('STAGE:ref2va-mux\n');
    const concatenated = join(workDir, 'concatenated.mp4');
    if (segmentVideos.length === 1) {
      await run(args.ffmpeg, [
        '-v', 'error', '-i', segmentVideos[0], '-an', '-c:v', 'copy', '-y', concatenated,
      ]);
    } else {
      const inputArgs = segmentVideos.flatMap((path) => ['-i', path]);
      const filterSteps = segmentVideos.map((_, index) => (
        `[${index}:v]settb=AVTB,setpts=PTS-STARTPTS[segment${index}]`
      ));
      let currentLabel = 'segment0';
      for (let index = 1; index < segmentVideos.length; index += 1) {
        const segment = segments[index];
        const nextLabel = `joined${index}`;
        const offset = decimals(segment.referenceStartSeconds - audioStart);
        filterSteps.push(
          `[${currentLabel}][segment${index}]xfade=transition=fade:duration=${decimals(segment.trimStartSeconds)}:offset=${offset}[${nextLabel}]`,
        );
        currentLabel = nextLabel;
      }
      await run(args.ffmpeg, [
        '-v', 'error', ...inputArgs,
        '-filter_complex', filterSteps.join(';'), '-map', `[${currentLabel}]`,
        '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', concatenated,
      ]);
    }

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

main().catch((err) => {
  process.stderr.write(`ERROR:${err.message}\n`);
  process.exitCode = 1;
});
