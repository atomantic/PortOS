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

// --- Layered lanes (schemaVersion 2) -----------------------------------

const stillSegment = (overrides = {}) => ({
  type: 'still',
  index: 0,
  assetKind: 'images',
  assetFile: 'plate.png',
  assetPath: '/data/images/plate.png',
  duration: 3,
  fadeInSec: 0,
  fadeOutSec: 0,
  ...overrides,
});

const filterOf = (args) => args[args.indexOf('-filter_complex') + 1];

describe('buildFfmpegArgs — stills in the video lane', () => {
  it('loops a still for exactly its hold and normalizes it to the canonical geometry', () => {
    const { args, totalDuration, canonW, canonH } = buildFfmpegArgs({
      segments: [baseClip({ width: 1024, height: 576, fps: 30 }), stillSegment()],
      canonW: 1024, canonH: 576, fps: 30,
    }, '/out.mp4');

    expect(totalDuration).toBe(7);
    expect(canonW).toBe(1024);
    expect(canonH).toBe(576);

    const inputs = args.slice(0, args.indexOf('-filter_complex'));
    // clip (0) + its real audio, then the still (1) + an anullsrc stub (2).
    expect(inputs).toContain('-loop');
    expect(inputs).toContain('/data/images/plate.png');

    const filter = filterOf(args);
    // The still is scaled/padded to the SAME canvas as the clip, and forced to
    // yuv420p so concat's link parameters match.
    expect(filter).toContain('[1:v]scale=1024:576');
    expect(filter).toContain('format=yuv420p');
    expect(filter).toContain('trim=start=0:end=3');
    // A still has no audio of its own — it gets the silent stub.
    expect(filter).toContain('[2:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a1]');
    expect(filter).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]');
  });

  it('falls back to 720p24 for a stills-only project rather than inheriting undefined geometry', () => {
    const { args, canonW, canonH, fps } = buildFfmpegArgs({ segments: [stillSegment()] }, '/out.mp4');
    expect(canonW).toBe(1280);
    expect(canonH).toBe(720);
    expect(fps).toBe(24);
    expect(filterOf(args)).toContain('scale=1280:720');
  });
});

describe('buildFfmpegArgs — fades', () => {
  it('emits video and audio fades anchored to the segment, not the source', () => {
    const filter = filterOf(buildFfmpegArgs({
      segments: [baseClip({ inSec: 2, outSec: 6, duration: 4, fadeInSec: 0.5, fadeOutSec: 1 })],
    }, '/out.mp4').args);

    // setpts rebases the segment to t=0, so the fades are relative to that.
    expect(filter).toContain('setpts=PTS-STARTPTS,fade=t=in:st=0:d=0.5,fade=t=out:st=3:d=1[v0]');
    expect(filter).toContain('asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.5,afade=t=out:st=3:d=1[a0]');
  });

  it('omits fade filters entirely when both fades are zero', () => {
    const filter = filterOf(buildFfmpegArgs({ segments: [baseClip()] }, '/out.mp4').args);
    expect(filter).not.toContain('fade=');
  });

  it('applies the clip volume multiplier to the segment audio', () => {
    const filter = filterOf(buildFfmpegArgs({
      segments: [baseClip({ volume: 0.5 })], clipVolume: 0.5,
    }, '/out.mp4').args);
    expect(filter).toContain('volume=0.25');
  });

  it('leaves a silent stub un-shaped — there is nothing to fade or attenuate', () => {
    const filter = filterOf(buildFfmpegArgs({
      segments: [baseClip({ hasAudio: false, fadeInSec: 1, fadeOutSec: 1, volume: 0.2 })], clipVolume: 0.5,
    }, '/out.mp4').args);
    expect(filter).toContain('[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a0]');
    expect(filter).not.toContain('afade=');
  });
});

describe('buildFfmpegArgs — overlay lane', () => {
  const overlay = (overrides = {}) => ({
    type: 'image',
    assetKind: 'images',
    assetFile: 'logo.png',
    assetPath: '/data/images/logo.png',
    startSec: 1,
    durationSec: 2,
    x: 0.5,
    y: 0.25,
    width: 0.25,
    opacity: 1,
    fadeInSec: 0,
    fadeOutSec: 0,
    ...overrides,
  });

  it('composites over the concat output, gated to its window and sized against the canvas', () => {
    const { args } = buildFfmpegArgs({
      segments: [baseClip({ width: 800, height: 400, duration: 4 })],
      overlays: [overlay()],
      canonW: 800, canonH: 400, fps: 24,
    }, '/out.mp4');
    const filter = filterOf(args);

    // The concat now feeds an intermediate label, not [outv].
    expect(filter).toContain('concat=n=1:v=1:a=1[cv][outa]');
    // 0.25 × 800 = 200 wide, -2 keeps the derived height even.
    expect(filter).toContain('[1:v]scale=200:-2,fps=24,format=rgba[ov0]');
    expect(filter).toContain("[cv][ov0]overlay=x=400:y=100:eof_action=pass:enable='between(t,1,3)'[outv]");

    // The overlay input is looped for the WHOLE timeline so overlay() never
    // stalls waiting on a late-starting secondary stream.
    const inputs = args.slice(0, args.indexOf('-filter_complex'));
    const loopIdx = inputs.lastIndexOf('-loop');
    expect(inputs.slice(loopIdx, loopIdx + 6)).toEqual(['-loop', '1', '-t', '4', '-i', '/data/images/logo.png']);
  });

  it('drives partial opacity and alpha fades on the shared timeline clock', () => {
    const filter = filterOf(buildFfmpegArgs({
      segments: [baseClip({ duration: 6, outSec: 6 })],
      overlays: [overlay({ startSec: 2, durationSec: 3, opacity: 0.5, fadeInSec: 0.5, fadeOutSec: 1 })],
    }, '/out.mp4').args);

    expect(filter).toContain('colorchannelmixer=aa=0.5');
    // Fade-in starts at the overlay's PROJECT start, not 0 — the input runs
    // for the whole timeline.
    expect(filter).toContain('fade=t=in:st=2:d=0.5:alpha=1');
    expect(filter).toContain('fade=t=out:st=4:d=1:alpha=1');
  });

  it('chains multiple overlays so each composites onto the previous result', () => {
    const filter = filterOf(buildFfmpegArgs({
      segments: [baseClip()],
      overlays: [overlay(), overlay({ assetFile: 'badge.png', assetPath: '/data/images/badge.png', startSec: 0 })],
    }, '/out.mp4').args);

    expect(filter).toContain('[cv][ov0]overlay=');
    expect(filter).toContain('[ovc0]');
    expect(filter).toContain('[ovc0][ov1]overlay=');
    expect(filter.match(/\[outv\]/g)).toHaveLength(1);
  });
});

describe('buildFfmpegArgs — audio bed', () => {
  const bed = (overrides = {}) => ({
    assetKind: 'music',
    assetFile: 'bed.mp3',
    assetPath: '/data/music/bed.mp3',
    startSec: 0,
    offsetSec: 0,
    durationSec: 4,
    volume: 1,
    fadeInSec: 0,
    fadeOutSec: 0,
    ...overrides,
  });

  it('mixes a bed under the lane audio without normalizing the levels down', () => {
    const filter = filterOf(buildFfmpegArgs({
      segments: [baseClip()], audioTracks: [bed()],
    }, '/out.mp4').args);

    expect(filter).toContain('concat=n=1:v=1:a=1[outv][ca]');
    expect(filter).toContain('[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start=0:end=4,asetpts=PTS-STARTPTS[bed0]');
    expect(filter).toContain('[ca][bed0]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[outa]');
  });

  it('trims from the source offset, shapes, then delays to the project start', () => {
    const filter = filterOf(buildFfmpegArgs({
      segments: [baseClip({ duration: 10, outSec: 10 })],
      audioTracks: [bed({ startSec: 2.5, offsetSec: 30, durationSec: 5, volume: 0.4, fadeInSec: 1, fadeOutSec: 2 })],
    }, '/out.mp4').args);

    // Fades are on the track's own clock (post-atrim), so they come BEFORE adelay.
    expect(filter).toContain('atrim=start=30:end=35,asetpts=PTS-STARTPTS,volume=0.4,afade=t=in:st=0:d=1,afade=t=out:st=3:d=2,adelay=2500|2500[bed0]');
  });

  it('mixes several beds in one amix pass', () => {
    const filter = filterOf(buildFfmpegArgs({
      segments: [baseClip()],
      audioTracks: [bed(), bed({ assetFile: 'sfx.wav', assetPath: '/data/audio/sfx.wav', assetKind: 'audio' })],
    }, '/out.mp4').args);
    expect(filter).toContain('[ca][bed0][bed1]amix=inputs=3:');
  });
});

describe('buildFfmpegArgs — combined lanes and input indexing', () => {
  it('keeps input indices consistent across silent stubs, overlays and beds', () => {
    const { args } = buildFfmpegArgs({
      segments: [
        baseClip({ hasAudio: false, duration: 2, outSec: 2 }), // input 0 (video) + 1 (anullsrc)
        stillSegment({ duration: 1 }),                          // input 2 (still) + 3 (anullsrc)
        baseClip({ hasAudio: true, duration: 3, outSec: 3 }),   // input 4 (video + audio)
      ],
      overlays: [{
        type: 'image', assetKind: 'images', assetFile: 'logo.png', assetPath: '/logo.png',
        startSec: 0, durationSec: 1, x: 0, y: 0, width: 0.5, opacity: 1, fadeInSec: 0, fadeOutSec: 0,
      }],                                                       // input 5
      audioTracks: [{
        assetKind: 'music', assetFile: 'bed.mp3', assetPath: '/bed.mp3',
        startSec: 0, offsetSec: 0, durationSec: 2, volume: 1, fadeInSec: 0, fadeOutSec: 0,
      }],                                                       // input 6
      canonW: 768, canonH: 512, fps: 24,
    }, '/out.mp4');

    const filter = filterOf(args);
    expect(filter).toContain('[0:v]scale=768:512');
    expect(filter).toContain('[1:a]aresample=48000');
    expect(filter).toContain('[2:v]scale=768:512');
    expect(filter).toContain('[3:a]aresample=48000');
    expect(filter).toContain('[4:v]scale=768:512');
    expect(filter).toContain('[4:a]aresample=48000');
    expect(filter).toContain('[5:v]scale=384:-2');
    expect(filter).toContain('[6:a]aresample=48000');
    // Both post-lanes are present, so concat feeds intermediate labels.
    expect(filter).toContain('concat=n=3:v=1:a=1[cv][ca]');
    expect(args).toContain('[outv]');
    expect(args).toContain('[outa]');
  });

  it('accepts the v1 bare-array signature and produces the same minimal graph', () => {
    const fromArray = buildFfmpegArgs([baseClip()], '/out.mp4');
    const fromObject = buildFfmpegArgs({ segments: [baseClip()] }, '/out.mp4');
    expect(fromArray.args).toEqual(fromObject.args);
  });

  it('rounds float noise out of the graph instead of leaking it', () => {
    const filter = filterOf(buildFfmpegArgs({
      segments: [baseClip({ inSec: 0.1, outSec: 0.3, duration: 0.2, fadeOutSec: 0.1 })],
    }, '/out.mp4').args);
    // 0.3 - 0.1 === 0.19999999999999998 in IEEE 754.
    expect(filter).toContain('fade=t=out:st=0.1:d=0.1');
    expect(filter).not.toContain('0.19999');
  });
});
