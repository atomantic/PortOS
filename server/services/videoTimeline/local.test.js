import { describe, it, expect } from 'vitest';
import { buildFfmpegArgs } from './local.js';

const baseClip = (overrides = {}) => ({
  index: 0,
  clipId: 'clip-1',
  videoPath: '/tmp/clip-1.mp4',
  inSec: 0,
  outSec: 4,
  duration: 4,
  width: 768,
  height: 512,
  fps: 24,
  hasAudio: true,
  ...overrides,
});

describe('buildFfmpegArgs', () => {
  it('throws on empty clip list', () => {
    expect(() => buildFfmpegArgs([], '/out.mp4')).toThrow(/empty/i);
  });

  it('produces a single-clip filter_complex with audio passthrough', () => {
    const clips = [baseClip()];
    const { args, totalDuration, canonW, canonH } = buildFfmpegArgs(clips, '/out.mp4');

    expect(totalDuration).toBe(4);
    expect(canonW).toBe(768);
    expect(canonH).toBe(512);

    const fcIdx = args.indexOf('-filter_complex');
    expect(fcIdx).toBeGreaterThan(-1);
    const filter = args[fcIdx + 1];

    // Single clip → only one input, audio uses the same input idx (0:a)
    expect(filter).toContain('[0:v]scale=768:512');
    expect(filter).toContain('trim=start=0:end=4');
    expect(filter).toContain('[0:a]aresample=48000');
    expect(filter).toContain('atrim=start=0:end=4');
    // Final concat for n=1 still wraps the streams
    expect(filter).toContain('[v0][a0]concat=n=1:v=1:a=1[outv][outa]');
  });

  it('inserts anullsrc inputs for clips without audio', () => {
    const clips = [
      baseClip({ hasAudio: false, duration: 3, outSec: 3 }),
      baseClip({ hasAudio: true, duration: 5, outSec: 5 }),
    ];
    const { args } = buildFfmpegArgs(clips, '/out.mp4');

    // Inputs: -i clip0, -f lavfi -t 3 -i anullsrc..., -i clip1
    // Indices: 0 = clip0 video, 1 = silent stub, 2 = clip1 (with audio at 2:a)
    const inputs = args.slice(0, args.indexOf('-filter_complex'));
    expect(inputs.filter((a) => a === '-i')).toHaveLength(3);
    expect(inputs).toContain('-f');
    expect(inputs).toContain('lavfi');
    expect(inputs).toContain('anullsrc=channel_layout=stereo:sample_rate=48000');

    const filter = args[args.indexOf('-filter_complex') + 1];
    // Clip 0's video uses input 0; its audio uses input 1 (silent stub) and
    // is normalized to match the real-audio sample-format/layout so concat
    // accepts both branches.
    expect(filter).toContain('[0:v]scale=768:512');
    expect(filter).toContain('[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a0]');
    // Clip 1's video uses input 2; its audio uses input 2 (real audio)
    expect(filter).toContain('[2:v]scale=768:512');
    expect(filter).toContain('[2:a]aresample=48000');
  });

  it('encodes a 3-clip mixed-audio timeline correctly', () => {
    const clips = [
      baseClip({ hasAudio: true, inSec: 0, outSec: 2, duration: 2 }),
      baseClip({ hasAudio: false, inSec: 1, outSec: 4, duration: 3 }),
      baseClip({ hasAudio: true, inSec: 0.5, outSec: 3, duration: 2.5 }),
    ];
    const { args, totalDuration } = buildFfmpegArgs(clips, '/out.mp4');

    expect(totalDuration).toBeCloseTo(7.5);

    const filter = args[args.indexOf('-filter_complex') + 1];
    // Final concat must include all 3 clip pairs in order
    expect(filter).toContain('[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[outv][outa]');
    // Trims preserve per-clip in/out
    expect(filter).toContain('trim=start=0:end=2');
    expect(filter).toContain('trim=start=1:end=4');
    expect(filter).toContain('trim=start=0.5:end=3');
  });

  it('uses canonical dims from the first clip for scale+pad on every clip', () => {
    const clips = [
      baseClip({ width: 1024, height: 576 }),
      baseClip({ width: 768, height: 512 }), // different — should still be padded to 1024x576
    ];
    const { args, canonW, canonH } = buildFfmpegArgs(clips, '/out.mp4');
    expect(canonW).toBe(1024);
    expect(canonH).toBe(576);
    const filter = args[args.indexOf('-filter_complex') + 1];
    // Both video chains scale to 1024:576
    const scales = filter.match(/scale=1024:576/g) || [];
    expect(scales).toHaveLength(2);
  });

  it('emits encoder + faststart + progress flags', () => {
    const { args } = buildFfmpegArgs([baseClip()], '/out.mp4');
    expect(args).toContain('-c:v');
    expect(args).toContain('libx264');
    expect(args).toContain('-c:a');
    expect(args).toContain('aac');
    expect(args).toContain('-movflags');
    expect(args).toContain('+faststart');
    expect(args).toContain('-progress');
    expect(args).toContain('pipe:2');
    expect(args[args.length - 1]).toBe('/out.mp4');
  });
});
