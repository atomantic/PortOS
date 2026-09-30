import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { findFfmpeg, probeVideoDuration, runFfmpegProcess, edgeFadeFilter } from '../../lib/ffmpeg.js';
import { pcmToWavBuffer } from '../../lib/chiptuneRender.js';
import { prepareCodeRender, _muxExactArgs } from './codeRender.js';

const ffmpeg = await findFfmpeg();

const project = {
  composition: { mode: 'code', textCues: [{ id: 'c', text: 'kept', startSec: 0, endSec: 1 }] },
  scenes: [{ sceneId: 's1', startSec: 0, endSec: 2, takes: [{ id: 't1' }] }],
  audioAnalysis: {
    durationSec: 2,
    beats: [0, 0.5, 1, 1.5],
    downbeats: [0, 1],
    sections: [{ id: 'a', label: 'All', startSec: 0, endSec: 2 }],
  },
  lyricCues: [{ id: 'l', text: 'la', startSec: 0.5, endSec: 1 }],
};

describe('code render plan (#9076)', () => {
  it('plans a code render without footage generation', () => {
    const plan = prepareCodeRender(project);
    expect(plan.footageGeneration).toBe(false);
    expect(plan.durationSec).toBeGreaterThanOrEqual(2 - 1e-9);
    expect(plan.durationSec - 2).toBeLessThan(1 / 24 + 1e-9);
    expect(plan.html).toContain('portosComposition');
    expect(plan.song.lyrics[0].text).toBe('la');
  });
});

describe.skipIf(!ffmpeg)('code render mux (#9076)', () => {
  it('muxes the song so the file covers it within one frame and does not fade', async () => {
    const plan = prepareCodeRender({ ...project, audioAnalysis: { ...project.audioAnalysis, durationSec: 2.01, sections: [{ id: 'a', label: 'All', startSec: 0, endSec: 2.01 }] } });
    const dir = await mkdtemp(join(tmpdir(), 'portos-code-mux-'));
    try {
      const silent = join(dir, 'silent.mp4');
      const wav = join(dir, 'click.wav');
      const out = join(dir, 'out.mp4');
      const made = await runFfmpegProcess({
        bin: ffmpeg,
        args: ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=32x18:r=24:d=${plan.durationSec}`, '-frames:v', String(plan.song.frames), '-y', silent],
      });
      expect(made.ok).toBe(true);
      const rate = 24000;
      const samples = new Float32Array(Math.ceil(rate * 2.01));
      for (let i = 0; i < samples.length; i += rate / 2) samples[i] = 0.8;
      await writeFile(wav, pcmToWavBuffer(samples, { sampleRate: rate }));
      const muxed = await runFfmpegProcess({
        bin: ffmpeg,
        args: _muxExactArgs(silent, wav, out, plan.durationSec, 0),
      });
      expect(muxed.ok).toBe(true);
      const duration = await probeVideoDuration(out);
      expect(Math.abs(duration - plan.durationSec)).toBeLessThan(1 / 24 + 0.02);
      expect(duration).toBeGreaterThanOrEqual(2.01 - 1 / 24);
      const args = _muxExactArgs(silent, wav, out, plan.durationSec, 0).join(' ');
      expect(args).not.toContain('afade');
      expect(await readFile(out)).toBeInstanceOf(Buffer);
      // A social cut (#9280) fades its edges without changing the length: ffmpeg
      // accepts the fade chain and the file still covers the song.
      const faded = join(dir, 'faded.mp4');
      const fadedMux = await runFfmpegProcess({
        bin: ffmpeg,
        args: _muxExactArgs(silent, wav, faded, plan.durationSec, 0, edgeFadeFilter(plan.durationSec)),
      });
      expect(fadedMux.ok).toBe(true);
      expect(Math.abs((await probeVideoDuration(faded)) - plan.durationSec)).toBeLessThan(1 / 24 + 0.02);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
