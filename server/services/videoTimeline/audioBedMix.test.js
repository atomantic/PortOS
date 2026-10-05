import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AUDIO_NORM, buildAudioBedMix, PEAK_CEILING_LINEAR } from './audioBedMix.js';

const bed = { assetPath: '/lib/bed.wav', offsetSec: 0, durationSec: 4, volume: 1 };
const mix = (extra) => buildAudioBedMix({ beds: [bed], firstInputIdx: 1, mainLabel: '[master]', outLabel: '[mixa]', ...extra });

describe('buildAudioBedMix peak guard', () => {
  it('leaves the mix exactly as before unless asked', () => {
    expect(mix().filters.at(-1)).toMatch(/amix=inputs=2:duration=first:dropout_transition=0:normalize=0\[mixa\]$/);
  });

  it('ends the mix with an alimiter at the ceiling and no gain stage', () => {
    const { filters } = mix({ limitPeak: true });
    expect(filters.at(-2)).toMatch(/normalize=0\[bedmix\]$/);
    expect(filters.at(-1)).toBe(`[bedmix]alimiter=limit=${PEAK_CEILING_LINEAR}:level=disabled,${AUDIO_NORM}[mixa]`);
    expect(filters.join(';')).not.toMatch(/loudnorm|volume=/);
  });
});

let hasFfmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { hasFfmpeg = false; }

describe.skipIf(!hasFfmpeg)('buildAudioBedMix peak guard (real ffmpeg)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portos-bedmix-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const peak = (path) => spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-af', 'astats=measure_overall=Peak_level', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  it('keeps a hot song plus a hot bed under the ceiling', () => {
    const song = join(dir, 'song.wav');
    const bedPath = join(dir, 'bed.wav');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', '4', '-af', 'volume=18dB', '-c:a', 'pcm_f32le', '-y', song]);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', '4', '-af', 'volume=18dB', '-c:a', 'pcm_f32le', '-y', bedPath]);
    const { inputs, filters } = buildAudioBedMix({ beds: [{ ...bed, assetPath: bedPath }], firstInputIdx: 1, mainLabel: '[master]', outLabel: '[mixa]', limitPeak: true });
    const out = join(dir, 'mix.wav');
    const run = (graph, file) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', song, ...inputs, '-filter_complex', graph, '-map', '[mixa]', '-c:a', 'pcm_f32le', '-y', file]);
    run([`[0:a]${AUDIO_NORM}[master]`, ...filters].join(';'), out);
    const unguarded = join(dir, 'unguarded.wav');
    run([`[0:a]${AUDIO_NORM}[master]`, ...buildAudioBedMix({ beds: [{ ...bed, assetPath: bedPath }], firstInputIdx: 1, mainLabel: '[master]', outLabel: '[mixa]' }).filters].join(';'), unguarded);
    const level = (path) => Number(/Peak level dB:\s*(-?[\d.]+)/.exec(peak(path))?.[1]);
    expect(level(unguarded)).toBeGreaterThan(0);
    expect(level(out)).toBeLessThanOrEqual(-1.4);
  });
});
