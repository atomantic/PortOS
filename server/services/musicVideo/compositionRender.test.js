import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { findFfmpeg, probeVideoDuration } from '../../lib/ffmpeg.js';
import { PATHS } from '../../lib/fileUtils.js';
import { _cleanupTestBrowser } from '../htmlComposition/testBrowserCleanup.js';
import { buildMusicVideoFfmpegArgs } from './render.js';
import { COMPOSITION_SCRATCH_DIR, removeCompositionScratch, renderTypographyOverlays } from './compositionRender.js';

let endpoint;
vi.mock('../browserService.js', () => ({ cdpRequest: path => fetch(`${endpoint}${path}`) }));
vi.mock('../../lib/fileUtils.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-composition-'),
}));

const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => path && existsSync(path));
const ffmpeg = await findFfmpeg();
let proc;
let browser;

const FPS = 24;
const run = (args) => execFileSync(ffmpeg, ['-v', 'error', ...args], { maxBuffer: 64 * 1024 * 1024 });
// Decode a video to raw frames of `pix_fmt`.
const frames = (path, pixFmt) => run(['-i', path, '-f', 'rawvideo', '-pix_fmt', pixFmt, '-']);

// Every overlay pixel with visible alpha lies inside the 10% title-safe area.
function assertInsideSafeArea(path, width, height) {
  const raw = frames(path, 'rgba');
  const frameBytes = width * height * 4;
  const x0 = width * 0.1; const x1 = width * 0.9; const y0 = height * 0.1; const y1 = height * 0.9;
  let drawn = 0;
  for (let f = 0; f < raw.length / frameBytes; f++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (raw[f * frameBytes + (y * width + x) * 4 + 3] <= 8) continue;
        drawn += 1;
        if (x < x0 || x >= x1 || y < y0 || y >= y1) throw new Error(`frame ${f}: text pixel at (${x},${y}) outside the safe area`);
      }
    }
  }
  return drawn;
}

describe.skipIf(!chrome || !ffmpeg)('music-video typography overlay with real Chrome and ffmpeg (#8984)', () => {
  beforeAll(async () => {
    const profile = join(PATHS.data, 'chrome-test-profile');
    proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const ws = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Test Chrome did not start')), 20000);
      proc.once('error', reject);
      proc.stderr.on('data', bytes => {
        const match = bytes.toString().match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    endpoint = new URL(ws).origin.replace('ws:', 'http:');
    browser = await chromium.connectOverCDP(endpoint);
  }, 30000);

  afterAll(() => _cleanupTestBrowser({ browser, proc, cleanup: cleanupTempDataRoots }));

  it('lays timed text over the cut on one continuous audio master, covering the edit within a frame', async () => {
    const dir = join(PATHS.data, 'fixture');
    await mkdir(dir, { recursive: true });
    const [w, h] = [320, 180];
    // Two 1.5s "scenes" (blue, green) cut over a 3s tone.
    run(['-f', 'lavfi', '-i', `color=blue:s=${w}x${h}:r=${FPS}:d=1.5`, '-y', join(dir, 'a.mp4')]);
    run(['-f', 'lavfi', '-i', `color=green:s=${w}x${h}:r=${FPS}:d=1.5`, '-y', join(dir, 'b.mp4')]);
    run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-y', join(dir, 'song.wav')]);
    const clip = (name) => ({ videoPath: join(dir, name), width: w, height: h, fps: FPS, duration: 1.5, sourceSec: 1.5, loop: false, inSec: 0, outSec: 1.5 });
    const clips = [clip('a.mp4'), clip('b.mp4')];
    // A hero line spanning the cut at 1.5s.
    const cues = [{ id: 'c1', text: 'ACROSS THE CUT', startSec: 1, endSec: 2, template: 'fade', placement: 'center', emphasis: 'hero' }];
    const overlays = await renderTypographyOverlays({ jobId: 'job-a', cues, style: { color: '#ffffff', font: 'sans' }, width: w, height: h, fps: FPS, durationSec: 3 });
    expect(overlays).toEqual([{ path: expect.stringContaining('overlay-0.mov'), startSec: 1, durationSec: 1 }]);

    const output = join(dir, 'out.mp4');
    const { args } = buildMusicVideoFfmpegArgs(clips, join(dir, 'song.wav'), output, { audioDurationSec: 3, overlays });
    run(args.filter((arg, i) => !(arg === '-progress' || args[i - 1] === '-progress')));

    expect(Math.abs(await probeVideoDuration(output) - 3)).toBeLessThanOrEqual(1 / FPS);
    // One continuous master: the tone never drops out across the cut or the text.
    const pcm = run(['-i', output, '-map', '0:a', '-ac', '1', '-ar', '8000', '-f', 's16le', '-']);
    const samples = new Int16Array(Uint8Array.from(pcm).buffer);
    expect(Math.abs(samples.length / 8000 - 3)).toBeLessThanOrEqual(1 / FPS);
    for (let start = 0; start + 80 <= samples.length - 800; start += 80) {
      let peak = 0;
      for (let i = start; i < start + 80; i++) peak = Math.max(peak, Math.abs(samples[i]));
      expect(peak, `silent 10ms window at ${start / 8000}s`).toBeGreaterThan(1000);
    }

    const rgb = frames(output, 'rgb24');
    const frameBytes = w * h * 3;
    expect(rgb.length / frameBytes).toBe(3 * FPS);
    const whiteIn = (f) => {
      let n = 0;
      for (let p = 0; p < w * h; p++) {
        const o = f * frameBytes + p * 3;
        if (rgb[o] > 200 && rgb[o + 1] > 200 && rgb[o + 2] > 200) n += 1;
      }
      return n;
    };
    // No text before the cue; text drawn over BOTH scenes on either side of the cut; gone after.
    expect(whiteIn(12)).toBe(0);
    expect(whiteIn(33)).toBeGreaterThan(100);
    expect(whiteIn(39)).toBeGreaterThan(100);
    expect(whiteIn(60)).toBe(0);
    // Footage passes through untouched outside the text: the corner keeps its scene colour.
    const corner = (f) => [...rgb.subarray(f * frameBytes, f * frameBytes + 3)];
    expect(corner(33)[2]).toBeGreaterThan(200); // blue scene
    expect(corner(39)[1]).toBeGreaterThan(100); // green scene

    // Same time, same frame: a second capture of the same cues decodes identically.
    const again = await renderTypographyOverlays({ jobId: 'job-b', cues, style: {}, width: w, height: h, fps: FPS, durationSec: 3 });
    expect(frames(again[0].path, 'rgba').equals(frames(overlays[0].path, 'rgba'))).toBe(true);
    await removeCompositionScratch('job-a');
    await removeCompositionScratch('job-b');
    expect(await readdir(join(PATHS.data, COMPOSITION_SCRATCH_DIR))).toEqual([]);
  }, 60000);

  it.each([['16:9', 480, 270], ['9:16', 270, 480], ['a small 16:9 frame', 160, 90]])('keeps every motion template inside the title-safe area at %s', async (_label, width, height) => {
    const long = 'A deliberately long lyric line that has to wrap and shrink to stay inside the frame';
    const cues = [
      { id: 'hero', text: long, startSec: 0, endSec: 0.75, template: 'pop', placement: 'center', emphasis: 'hero' },
      { id: 'low', text: long, startSec: 1, endSec: 1.75, template: 'rise', placement: 'lower', emphasis: 'subtitle' },
      { id: 'up', text: long, startSec: 2, endSec: 2.75, template: 'typewriter', placement: 'upper', emphasis: 'subtitle' },
      // Worst case: a maximum-length hero line that cannot fit even at the minimum size.
      { id: 'max', text: 'W'.repeat(500), startSec: 3, endSec: 3.75, template: 'rise', placement: 'lower', emphasis: 'hero' },
    ];
    const overlays = await renderTypographyOverlays({ jobId: `safe-${width}`, cues, style: { font: 'serif' }, width, height, fps: 12, durationSec: 4 });
    let drawn = 0;
    for (const overlay of overlays) drawn += assertInsideSafeArea(overlay.path, width, height);
    expect(drawn).toBeGreaterThan(1000);
  }, 60000);

  it('cancels a capture in progress and leaves no overlay behind', async () => {
    const controller = new AbortController();
    const cues = [{ id: 'c', text: 'Cancel me', startSec: 0, endSec: 20, template: 'fade', placement: 'lower', emphasis: 'subtitle' }];
    const capture = renderTypographyOverlays({ jobId: 'job-cancel', cues, style: {}, width: 320, height: 180, fps: 24, durationSec: 20, signal: controller.signal,
      onProgress: (fraction) => { if (fraction > 0.05) controller.abort(new Error('Render cancelled')); } });
    await expect(capture).rejects.toThrow();
    await removeCompositionScratch('job-cancel');
    expect(existsSync(join(PATHS.data, COMPOSITION_SCRATCH_DIR, 'job-cancel'))).toBe(false);
  }, 60000);
});
