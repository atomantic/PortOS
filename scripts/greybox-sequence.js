#!/usr/bin/env node
/** Offline prototype; never reads or changes catalog or music-video records. */
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { greyboxSequenceSchema, greyboxSequenceFrames, evaluateGreyboxSequence } from '../server/lib/greyboxSequence.js';

async function main() {
  const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' }, shot: { type: 'string' }, 'plan-only': { type: 'boolean' } } });
  if (!values.input || !values.output) throw new Error('Usage: node scripts/greybox-sequence.js --input plan.json --output NEW_DIRECTORY [--shot camera-id] [--plan-only]');
  const source = await readFile(resolve(values.input), 'utf8');
  const plan = greyboxSequenceSchema.parse(JSON.parse(source));
  const frames = greyboxSequenceFrames(plan).filter((frame) => !values.shot || frame.clipId === values.shot);
  if (!frames.length) throw new Error('No frames selected; check --shot');
  for (const frame of frames) evaluateGreyboxSequence(plan, frame.clipId, frame.timeSec);
  const output = resolve(values.output);
  await mkdir(output, { recursive: false }); // Existing and partial exports are never overwritten.
  await writeFile(join(output, 'source.json'), source, { flag: 'wx' });
  const manifest = {
    version: 1, sourceSha256: createHash('sha256').update(source).digest('hex'), fps: plan.fps,
    coordinateSystem: 'meters, Y up, floor y=0', timing: 'absolute master seconds; half-open shot ranges',
    status: values['plan-only'] ? 'planned' : 'capturing',
    limitations: ['Position/facing proxies only, not skeletal skating or foot-contact reference.', 'Layout pass only; no depth, normals, masks, GLB animation or generative-model submission.'],
    frames,
  };
  const saveManifest = () => writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await saveManifest();
  if (values['plan-only']) { console.log(`📋 Planned ${frames.length} frames; no browser or encoder started`); return; }
  const { renderGreyboxFrames } = await import('../server/services/greyboxRender.js');
  const { findFfmpeg, runFfmpegProcess, H264_ENCODE_ARGS, BT709_CONTAINER_ARGS, bt709TagFilter } = await import('../server/lib/ffmpeg.js');
  const bin = await findFfmpeg({ requiredEncoder: 'libx264' });
  if (!bin) throw new Error('An installed ffmpeg with libx264 is required; nothing will be downloaded');
  const paths = new Map();
  for (const shotId of new Set(frames.map((f) => f.clipId))) {
    const directory = join(output, shotId);
    await mkdir(directory);
    paths.set(shotId, directory);
  }
  function* samples() {
    for (const frame of frames) yield evaluateGreyboxSequence(plan, frame.clipId, frame.timeSec);
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Sequence export interrupted'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    await renderGreyboxFrames(samples(), async (png, index) => {
      const frame = frames[index];
      await writeFile(join(paths.get(frame.clipId), `frame-${String(frame.shotFrame).padStart(6, '0')}.png`), Buffer.from(png, 'base64'), { flag: 'wx' });
      if (index % plan.fps === 0) console.log(`🎞️ Captured ${index + 1}/${frames.length} frames`);
    }, { signal: controller.signal });
    const colorFilter = await bt709TagFilter(bin);
    for (const [shotId, directory] of paths) {
      controller.signal.throwIfAborted();
      const count = frames.filter((frame) => frame.clipId === shotId).length;
      await copyFile(join(directory, 'frame-000000.png'), join(directory, 'start.png'));
      await copyFile(join(directory, `frame-${String(count - 1).padStart(6, '0')}.png`), join(directory, 'end.png'));
      const result = await runFfmpegProcess({ bin, signal: controller.signal, args: ['-n', '-framerate', String(plan.fps), '-i', join(directory, 'frame-%06d.png'), ...(colorFilter ? ['-vf', colorFilter] : []), ...H264_ENCODE_ARGS, ...BT709_CONTAINER_ARGS, '-an', join(directory, 'reference.mp4')] });
      if (!result.ok) throw new Error(`Could not encode ${shotId}: ${result.reason}`);
    }
    manifest.status = 'complete';
    await saveManifest();
    console.log(`✅ Exported ${paths.size} reference clips and their start/end frames`);
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

main().catch((error) => { console.error(`❌ ${error.message}`); process.exitCode = 1; });
