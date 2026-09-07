import { describe, expect, it, vi, beforeEach } from 'vitest';

// Pure argv construction over a stubbed ffmpeg — the passes themselves are
// exercised through upscaleJob, and running real ffmpeg here would make the
// suite depend on a binary CI does not guarantee.
const ffmpeg = vi.hoisted(() => ({ runs: [] }));

vi.mock('../../lib/ffmpeg.js', () => ({
  findFfmpeg: vi.fn(async () => '/fixture/bin/ffmpeg'),
  runFfmpegProcess: vi.fn(async (call) => { ffmpeg.runs.push(call); return { ok: true }; }),
  bt709TagFilter: vi.fn(async () => null),
  H264_ENCODE_ARGS: ['-c:v', 'libx264'],
  BT709_CONTAINER_ARGS: ['-color_primaries', 'bt709'],
}));

const { padSourceForUpscale, finalizeUpscaleOutput } = await import('./upscaleFfmpeg.js');

const argFor = (flag) => {
  const args = ffmpeg.runs.at(-1).args;
  return args[args.indexOf(flag) + 1];
};

beforeEach(() => { ffmpeg.runs.length = 0; });

describe('padSourceForUpscale', () => {
  it('pads right/bottom and clones the tail for exactly the planned frames', async () => {
    await padSourceForUpscale('/fixture/src.mp4', '/fixture/aligned.mp4', {
      width: 864, height: 512, padFrames: 4, fps: 25,
    });
    // 4 frames at 25fps = 0.16s of held final frame. `stop_mode=clone` rather
    // than black so the model is not asked to synthesize detail into a cut.
    expect(argFor('-vf')).toBe('pad=864:512:0:0:color=black,tpad=stop_mode=clone:stop_duration=0.160000');
    expect(ffmpeg.runs.at(-1).args).toContain('-an');
  });

  it('omits the tail filter entirely when no frames need padding', async () => {
    await padSourceForUpscale('/fixture/src.mp4', '/fixture/aligned.mp4', {
      width: 768, height: 512, padFrames: 0, fps: 24,
    });
    expect(argFor('-vf')).toBe('pad=768:512:0:0:color=black');
  });

  it('refuses rather than guessing when the source frame rate is unknown', async () => {
    const result = await padSourceForUpscale('/fixture/src.mp4', '/fixture/aligned.mp4', {
      width: 768, height: 512, padFrames: 8, fps: null,
    });
    expect(result).toEqual({ ok: false, reason: 'source frame rate unknown' });
    expect(ffmpeg.runs).toHaveLength(0);
  });
});

describe('finalizeUpscaleOutput', () => {
  const finalize = (extra = {}) => finalizeUpscaleOutput('/fixture/rendered.mp4', '/fixture/final.mp4', {
    width: 1536, height: 1024, frameCount: 121, audioSourcePath: '/fixture/src.mp4', ...extra,
  });

  it('crops the padding back off at the origin it was added and trims the tail', async () => {
    await finalize();
    expect(argFor('-filter_complex')).toBe('[0:v]crop=1536:1024:0:0[v]');
    expect(argFor('-frames:v')).toBe('121');
  });

  // #6514: an AAC track a few ms short of its video must not trim it — the
  // frame bound is the only output-length bound (see the source comment).
  it('never lets the audio track shorten the video', async () => {
    await finalize();
    expect(ffmpeg.runs.at(-1).args.filter((a) => a === '-shortest' || a === '-t')).toEqual([]);
  });

  it('maps the source audio OPTIONALLY, so a silent source is a silent output rather than a failure', async () => {
    await finalize();
    const args = ffmpeg.runs.at(-1).args;
    // The trailing `?` is the whole no-audio contract: ffmpeg skips a missing
    // stream instead of exiting non-zero.
    expect(args.join(' ')).toContain('-map [v] -map 1:a:0?');
    expect(args.join(' ')).toContain('-c:a copy');
    // The original clip is the audio INPUT and is never an output target.
    expect(args.filter((a) => a === '/fixture/src.mp4')).toHaveLength(1);
    expect(args.at(-1)).toBe('/fixture/final.mp4');
  });

  it('refuses rather than writing a wrong-sized deliverable when the geometry is unknown', async () => {
    expect(await finalize({ frameCount: null })).toEqual({ ok: false, reason: 'upscale output geometry unknown' });
    expect(ffmpeg.runs).toHaveLength(0);
  });
});
