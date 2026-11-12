import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { state } = vi.hoisted(() => ({ state: { candidatePsnr: 42, badFrame: null, invalidGeometry: false, calls: [] } }));
vi.mock('../../lib/ffmpeg.js', () => ({
  findFfmpeg: async () => 'ffmpeg',
  probeVideoGeometry: async () => ({ width: 32, height: 32, fps: 24, numFrames: state.invalidGeometry ? 23 : 24, durationSec: 1 }),
  probeVideoCodecSignature: async () => 'codec_name=h264|profile=High|pix_fmt=yuv420p|color_range=tv|color_space=bt709|color_transfer=bt709|color_primaries=bt709|field_order=progressive',
  BT709_CONTAINER_ARGS: ['-color_trc', 'bt709'], H264_ENCODE_ARGS: ['-c:v', 'libx264'],
  runFfmpegProcess: async ({ args, onStdout }) => {
    state.calls.push(args);
    if (onStdout) {
      const value = args.some(arg => arg.endsWith('candidate.mp4')) ? state.candidatePsnr : 42;
      onStdout(Buffer.from(Array.from({ length: 24 }, (_, n) => `n:${n + 1} psnr_avg:${args.some(arg => arg.endsWith('candidate.mp4')) && n === state.badFrame ? 41 : value}`).join('\n')));
    } else await writeFile(args.at(-1), 'video');
    return { ok: true };
  },
}));
const { admitFilmLookWeb, encodeFilmLookWeb } = await import('./filmLookWebEncoder.js');
const dirs = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); state.calls.length = 0; state.candidatePsnr = 42; state.badFrame = null; state.invalidGeometry = false; });
const directory = async () => { const dir = await mkdtemp(join(tmpdir(), 'film-web-')); dirs.push(dir); return dir; };
const page = ({ failFrame, controller } = {}) => {
  let count = 0;
  const seeks = [];
  return { seeks, check() {}, async send(method) { return method === 'Page.captureScreenshot' ? { data: Buffer.from('png').toString('base64') } : {}; },
    async evaluate(expression) {
      if (expression.includes('portosComposition.seek')) { seeks.push(expression); return { path: 'gpu', drawMs: 0 }; }
      if (expression.includes('frameEncoder.frame')) {
        count++;
        if (count === failFrame) throw new Error('WebCodecs reordered frames');
        if (count === 1 && controller) controller.abort();
        return Buffer.from('frame').toString('base64');
      }
      if (expression.includes('frameEncoder.finish')) return '';
      return undefined;
    } };
};
const contract = { width: 32, height: 32, fps: 24, durationSec: 0.5 };

describe('film look WebCodecs finishing adapter', () => {
  it('muxes all frames with segment-local timestamps and checks representative encoded quality', async () => {
    const dir = await directory(), target = page();
    expect(await admitFilmLookWeb(target, contract, dir)).toBe(false);
    expect(target.seeks).toHaveLength(0);
    expect(await admitFilmLookWeb(target, { ...contract, durationSec: 10 }, dir, { offsetSec: 2 })).toBe(true);
    expect(target.seeks).toHaveLength(24);
    expect(target.seeks[0]).toContain('seek(2)');
    expect(target.seeks.at(-1)).toContain(`seek(${2 + 239 / 24})`);
    expect(state.calls[0].join(' ')).toContain('setts=pts=N/(24*TB):dts=N/(24*TB):duration=1/(24*TB)');
    expect(existsSync(join(dir, 'web-check'))).toBe(false);
    state.candidatePsnr = 41.5;
    expect(await admitFilmLookWeb(page(), { ...contract, durationSec: 10 }, dir)).toBe(true);
    state.candidatePsnr = 41;
    expect(await admitFilmLookWeb(page(), { ...contract, durationSec: 10 }, dir)).toBe(false);
    state.candidatePsnr = 42; state.badFrame = 13;
    expect(await admitFilmLookWeb(page(), { ...contract, durationSec: 10 }, dir)).toBe(false);
    state.invalidGeometry = true;
    await expect(admitFilmLookWeb(page(), { ...contract, durationSec: 10 }, dir)).rejects.toThrow('incompatible stream');
  });

  it('removes the elementary stream on reorder or cancellation', async () => {
    const dir = await directory(), path = join(dir, 'segment.mp4');
    await expect(encodeFilmLookWeb(page({ failFrame: 2 }), contract, path)).rejects.toThrow('reordered frames');
    expect(existsSync(`${path}.web.h264`)).toBe(false);
    const controller = new AbortController();
    await expect(encodeFilmLookWeb(page({ controller }), contract, path, { signal: controller.signal })).rejects.toThrow();
    expect(existsSync(`${path}.web.h264`)).toBe(false);
    expect(state.calls).toHaveLength(0);
  });
});
