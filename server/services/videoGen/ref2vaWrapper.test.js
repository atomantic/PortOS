import { execFile, spawn } from 'child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findFfmpeg, findFfprobe } from '../../lib/ffmpeg.js';
import {
  composeRef2vaSegments,
  MAX_REF2VA_XFADE_INPUTS,
} from '../../../scripts/generate_minimax_h3_ref2va.js';

const execFileAsync = promisify(execFile);
const WRAPPER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'scripts', 'generate_minimax_h3_ref2va.js',
);

describe('MiniMax H3 Ref2VA arbitrary-length wrapper', () => {
  let root;
  let ffmpeg;
  let ffprobe;
  let wrapperProcess;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'portos-ref2va-wrapper-test-'));
    ffmpeg = await findFfmpeg();
    ffprobe = await findFfprobe();
  });

  afterEach(async () => {
    if (wrapperProcess && wrapperProcess.exitCode == null && wrapperProcess.signalCode == null) {
      wrapperProcess.kill('SIGKILL');
    }
    await rm(root, { recursive: true, force: true });
  });

  it('keeps each xfade pass below a bounded input count for long timelines', async () => {
    const calls = [];
    const pieces = Array.from({ length: 65 }, (_, index) => ({
      path: join(root, `segment-${index}.mp4`),
      startSeconds: index === 0 ? 0 : index * 12,
      endSeconds: (index === 0 ? 0 : index * 12) + 15,
    }));

    await composeRef2vaSegments({
      ffmpeg: '/mock/ffmpeg',
      workDir: root,
      pieces,
      runCommand: async (_bin, args) => { calls.push(args); },
    });

    expect(calls.length).toBeGreaterThan(1);
    expect(Math.max(...calls.map((args) => args.filter((arg) => arg === '-i').length)))
      .toBe(MAX_REF2VA_XFADE_INPUTS);
  });

  it.skipIf(process.platform === 'win32')('forwards wrapper cancellation to the active runtime process group', async () => {
    const audio = join(root, 'source.wav');
    const image = join(root, 'source.png');
    const output = join(root, 'output.mp4');
    const runtimePidFile = join(root, 'runtime.pid');
    const fakeFfmpeg = join(root, 'fake-ffmpeg');
    const fakeFfprobe = join(root, 'fake-ffprobe');
    const fakeRuntime = join(root, 'fake-mere-run');

    await Promise.all([
      writeFile(audio, ''),
      writeFile(image, ''),
      writeFile(fakeFfmpeg, '#!/bin/sh\nfor last do :; done\n: > "$last"\n'),
      writeFile(fakeFfprobe, '#!/bin/sh\nprintf "5\\n"\n'),
      writeFile(fakeRuntime, '#!/bin/sh\nprintf "%s" "$$" > "$FAKE_RUNTIME_PID_FILE"\ntrap \'exit 143\' TERM INT\nwhile :; do sleep 1; done\n'),
    ]);
    await Promise.all([fakeFfmpeg, fakeFfprobe, fakeRuntime].map((path) => chmod(path, 0o755)));

    wrapperProcess = spawn(process.execPath, [
      WRAPPER,
      '--runtime-bin', fakeRuntime,
      '--model-root', root,
      '--prompt', 'one continuous awakening',
      '--image', image,
      '--audio', audio,
      '--width', '64',
      '--height', '64',
      '--fps', '24',
      '--seed', '17',
      '--steps', '9',
      '--ffmpeg', fakeFfmpeg,
      '--ffprobe', fakeFfprobe,
      '--output', output,
    ], {
      env: { ...process.env, FAKE_RUNTIME_PID_FILE: runtimePidFile },
      stdio: 'ignore',
    });

    await vi.waitFor(async () => {
      expect(Number(await readFile(runtimePidFile, 'utf8'))).toBeGreaterThan(0);
    }, { timeout: 5000, interval: 25 });
    const runtimePid = Number(await readFile(runtimePidFile, 'utf8'));

    wrapperProcess.kill('SIGTERM');
    await vi.waitFor(() => {
      expect(wrapperProcess.exitCode != null || wrapperProcess.signalCode != null).toBe(true);
    }, { timeout: 5000, interval: 25 });
    await vi.waitFor(() => {
      let alive = true;
      try { process.kill(runtimePid, 0); } catch { alive = false; }
      expect(alive).toBe(false);
    }, { timeout: 5000, interval: 25 });
  }, 15000);

  it('renders and crossfades every <=15s window, carries its last frame, and restores the full source audio', async () => {
    if (!ffmpeg || !ffprobe) return;
    const audio = join(root, 'source.wav');
    const image = join(root, 'source.png');
    const output = join(root, 'output.mp4');
    const calls = join(root, 'calls.jsonl');
    const fakeRuntime = join(root, 'fake-mere-run.js');

    await execFileAsync(ffmpeg, [
      '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=32000:duration=31.25',
      '-ac', '2', '-c:a', 'pcm_s16le', '-y', audio,
    ]);
    await execFileAsync(ffmpeg, [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64',
      '-frames:v', '1', '-y', image,
    ]);
    await writeFile(fakeRuntime, `#!/usr/bin/env node
import { appendFileSync } from 'fs';
import { execFileSync } from 'child_process';
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const references = args.flatMap((arg, index) => arg === '--reference' ? [args[index + 1]] : []);
appendFileSync(process.env.FAKE_MERE_LOG, JSON.stringify({ duration: value('--duration'), references }) + '\\n');
execFileSync(process.env.FAKE_FFMPEG, [
  '-v', 'error', '-f', 'lavfi', '-i', 'color=c=navy:s=' + value('--width') + 'x' + value('--height') + ':r=' + value('--fps') + ':d=' + value('--duration'),
  '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', value('--output'),
]);
`);
    await chmod(fakeRuntime, 0o755);

    const { stderr } = await execFileAsync(process.execPath, [
      WRAPPER,
      '--runtime-bin', fakeRuntime,
      '--model-root', root,
      '--prompt', 'one continuous awakening',
      '--image', image,
      '--audio', audio,
      '--width', '64',
      '--height', '64',
      '--fps', '24',
      '--seed', '17',
      '--steps', '9',
      '--ffmpeg', ffmpeg,
      '--ffprobe', ffprobe,
      '--output', output,
    ], {
      env: { ...process.env, FAKE_FFMPEG: ffmpeg, FAKE_MERE_LOG: calls },
      timeout: 120000,
    });

    expect(stderr).toContain('STAGE:ref2va-window:step:0:3:Rendering audio window 1/3');
    expect(stderr).toContain('STAGE:ref2va-window:step:1:3:Rendering audio window 2/3');
    expect(stderr).toContain('STAGE:ref2va-window:step:2:3:Rendering audio window 3/3');
    expect(stderr).not.toContain('STAGE:ref2va-window:step:3:3');

    const invocations = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
    // Every later call borrows three seconds of prior audio as startup warm-up,
    // still under the 15-second reference cap. The wrapper crossfades those
    // overlapping seconds, so the delivered duration remains 31.25 seconds.
    expect(invocations.map((call) => Number(call.duration))).toEqual([15, 15, 7.25]);
    expect(invocations[0].references[0]).toBe(`image:${image}`);
    expect(invocations[1].references[0]).toMatch(/image:.*continuity-0\.png$/);
    expect(invocations[2].references[0]).toMatch(/image:.*continuity-1\.png$/);
    expect(invocations.every((call) => call.references[1]?.startsWith('audio:'))).toBe(true);

    const { stdout } = await execFileAsync(ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', output,
    ]);
    expect(Number(stdout.trim())).toBeCloseTo(31.25, 1);
    const { stdout: audioStreams } = await execFileAsync(ffprobe, [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index',
      '-of', 'csv=p=0', output,
    ]);
    expect(audioStreams.trim()).not.toBe('');
  }, 120000);
});
