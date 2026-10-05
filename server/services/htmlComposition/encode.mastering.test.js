import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { MASTER_LOUDNESS, SILENT_LUFS } from '../../lib/ffmpeg.js';
import { encodeComposition } from './encode.js';

const loudnormJson = (inputI, inputTp = '-6.00') => `[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "${inputI}",\n\t"input_tp" : "${inputTp}",\n\t"input_lra" : "2.00",\n\t"input_thresh" : "-40.00",\n\t"output_i" : "-14.00",\n\t"output_tp" : "-1.50",\n\t"output_lra" : "1.00",\n\t"output_thresh" : "-24.00",\n\t"normalization_type" : "dynamic",\n\t"target_offset" : "0.30"\n}\n`;

const FRAME = Buffer.alloc(16, 1).toString('base64');
const page = { check() {}, async evaluate() {}, async send(method) { return method === 'Page.captureScreenshot' ? { data: FRAME } : {}; } };
const contract = { fps: 4, durationSec: 1, width: 64, height: 64, motionBlur: 1 };
const fakeEncoder = () => {
  const spawned = [];
  const spawnProcess = (_bin, args) => {
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = new EventEmitter();
    proc.stdin.write = (_bytes, cb) => { cb?.(); return true; };
    proc.stdin.end = () => proc.emit('close', 0, null);
    spawned.push(args);
    return proc;
  };
  return { spawned, spawnProcess };
};
const options = (extra) => ({ locateFfmpeg: async () => '/usr/bin/ffmpeg', tagFilter: async () => null, ...extra });

describe('encodeComposition loudness mastering (fake ffmpeg)', () => {
  it('measures the trimmed bed, then applies a linear loudnorm inside the encode and reports before/after', async () => {
    const runs = [];
    const runFfmpeg = vi.fn(async ({ args }) => {
      runs.push(args);
      return { ok: true, stderr: loudnormJson(runs.length === 1 ? '-27.30' : '-14.10', runs.length === 1 ? '-24.00' : '-1.60') };
    });
    const { spawned, spawnProcess } = fakeEncoder();
    const result = await encodeComposition(page, contract, '/tmp/out.mp4', options({ musicPath: '/lib/bed.wav', master: true, runFfmpeg, spawnProcess }));
    // Pass 1 analyses the same looped, trimmed audio the encode will use.
    expect(runs[0].join(' ')).toContain('-stream_loop -1 -i /lib/bed.wav');
    expect(runs[0].join(' ')).toContain(`atrim=duration=1,asetpts=PTS-STARTPTS,loudnorm=I=${MASTER_LOUDNESS.targetLufs}:TP=${MASTER_LOUDNESS.truePeakDb - 0.5}:LRA=${MASTER_LOUDNESS.lra}:print_format=json`);
    // Pass 2 is linear, fed the pass-1 numbers, before the tail fade.
    const af = spawned[0][spawned[0].indexOf('-af') + 1];
    expect(af).toMatch(/^atrim=duration=1,asetpts=PTS-STARTPTS,loudnorm=I=-14:TP=-2:LRA=11:measured_I=-27.3:measured_TP=-24:measured_LRA=2:measured_thresh=-40:offset=0.3:linear=true,aresample=48000,afade=t=out:st=0.5:d=0.5$/);
    // Pass 3 reads the finished file.
    expect(runs[1]).toContain('/tmp/out.mp4');
    expect(result.loudness).toEqual({ integratedLufs: -14.1, truePeakDb: -1.6, loudnessRange: 2, masteredFrom: { integratedLufs: -27.3, truePeakDb: -24 }, targetLufs: -14 });
  });

  it('refuses a silent bed before spending a single frame, naming the cause', async () => {
    const runFfmpeg = async () => ({ ok: true, stderr: loudnormJson('-inf', '-inf') });
    const { spawned, spawnProcess } = fakeEncoder();
    await expect(encodeComposition(page, contract, '/tmp/out.mp4', options({ musicPath: '/lib/bed.wav', master: true, runFfmpeg, spawnProcess })))
      .rejects.toThrow(/Soundtrack is silent: measured no signal \(below -50 LUFS\)/);
    expect(spawned).toHaveLength(0);
    expect(SILENT_LUFS).toBe(-50);
  });

  it('says why when the bed cannot be measured', async () => {
    const runFfmpeg = async () => ({ ok: false, reason: 'ffmpeg exit 1: Output file does not contain any stream' });
    await expect(encodeComposition(page, contract, '/tmp/out.mp4', options({ musicPath: '/lib/bed.wav', master: true, runFfmpeg, spawnProcess: fakeEncoder().spawnProcess })))
      .rejects.toThrow(/could not measure the soundtrack: ffmpeg exit 1/);
  });

  it('master off reproduces the unmastered mux and never measures', async () => {
    const runFfmpeg = vi.fn();
    const { spawned, spawnProcess } = fakeEncoder();
    const result = await encodeComposition(page, contract, '/tmp/out.mp4', options({ musicPath: '/lib/bed.wav', master: false, runFfmpeg, spawnProcess }));
    expect(runFfmpeg).not.toHaveBeenCalled();
    expect(spawned[0][spawned[0].indexOf('-af') + 1]).toBe('atrim=duration=1,asetpts=PTS-STARTPTS,afade=t=out:st=0.5:d=0.5');
    expect(result.loudness).toBeUndefined();
  });

  it('never masters an exact music-video master', async () => {
    const runFfmpeg = vi.fn();
    const { spawned, spawnProcess } = fakeEncoder();
    await encodeComposition(page, contract, '/tmp/out.mp4', options({ audio: { path: '/masters/song.wav', startSec: 3 }, master: true, runFfmpeg, spawnProcess }));
    expect(runFfmpeg).not.toHaveBeenCalled();
    expect(spawned[0]).not.toContain('-af');
  });
});

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

describe.skipIf(!hasFfmpeg)('encodeComposition loudness mastering (real ffmpeg)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portos-mastering-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it.each([
    ['a sine peaking near -30 dBFS', 'sine=frequency=440:sample_rate=24000', 'volume=-12dB'],
    ['noise at full scale', 'anoisesrc=color=pink:sample_rate=24000:amplitude=1', 'alimiter=limit=1:level=disabled'],
  ])('masters %s to the target with true peak under the ceiling', async (label, source, filter) => {
    const png = (await sharp({ create: { width: 64, height: 64, channels: 3, background: '#223' } }).png().toBuffer()).toString('base64');
    const real = { ...page, async send(method) { return method === 'Page.captureScreenshot' ? { data: png } : {}; } };
    const musicPath = join(dir, `${label.replace(/\W+/g, '-')}.wav`);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', source, '-t', '6', '-af', filter, '-ac', '1', '-y', musicPath]);
    const out = join(dir, `out-${label.replace(/\W+/g, '-')}.mp4`);
    const { loudness } = await encodeComposition(real, { fps: 5, durationSec: 6, width: 64, height: 64, motionBlur: 1 }, out, { musicPath, master: true });
    expect(Math.abs(loudness.integratedLufs - MASTER_LOUDNESS.targetLufs)).toBeLessThanOrEqual(1);
    expect(loudness.truePeakDb).toBeLessThanOrEqual(MASTER_LOUDNESS.truePeakDb);
    expect(loudness.masteredFrom.integratedLufs).not.toBe(loudness.integratedLufs);
  }, 60000);
});
