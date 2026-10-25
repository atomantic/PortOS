import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { findFfmpeg, findFfprobe, probeVideoDuration } from '../../lib/ffmpeg.js';
import { PATHS } from '../../lib/fileUtils.js';
import { _cleanupTestBrowser, _createTestArtifactsRoot, _waitForTestChrome } from '../htmlComposition/testBrowserCleanup.js';
import { beatSnapClips, buildMusicVideoFfmpegArgs, resolveSceneClips } from './render.js';
import { composedLyricWindows, projectTypographyPlan, renderableCues, sectionCardCues } from './composition.js';
import { COMPOSITION_SCRATCH_DIR, removeCompositionScratch, renderTypographyOverlays } from './compositionRender.js';
import { browserSuiteCanRun, resolveTestChrome } from '../../lib/browserSuiteGate.js';

let endpoint;
vi.mock('../browserService.js', () => ({ cdpRequest: path => fetch(`${endpoint}${path}`) }));
vi.mock('../../lib/fileUtils.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-composition-'),
}));

const chrome = resolveTestChrome();
const ffmpeg = await findFfmpeg();
const ffprobe = await findFfprobe();
// Vitest runs no hooks for a file whose every test is skipped, so on a runner
// without Chrome or the media tools the afterAll below never fires — yet importing
// compositionRender.js above already minted the lazy root (#9045).
const canRun = browserSuiteCanRun('music-video typography overlay', { Chrome: chrome, ffmpeg, ffprobe }, { onUnavailable: cleanupTempDataRoots });
let proc;
let browser;
let artifacts;
const detachedChromeProcessGroupId = () => process.platform === 'win32' ? undefined : proc?.pid;

const FPS = 24;
const run = (args) => execFileSync(ffmpeg, ['-v', 'error', ...args], { maxBuffer: 256 * 1024 * 1024 });
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

describe.skipIf(!canRun)('music-video typography overlay with real Chrome and ffmpeg (#8984)', () => {
  beforeAll(async () => {
    // A per-run profile: a fixed path can be locked by an earlier run, and Chrome's exit must not hide behind a timeout.
    await mkdir(PATHS.data, { recursive: true });
    const profile = await mkdtemp(join(PATHS.data, 'chrome-test-profile-'));
    proc = spawn(chrome, ['--headless=new', '--mute-audio', '--no-sandbox', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
    const ws = await _waitForTestChrome(proc);
    endpoint = new URL(ws).origin.replace('ws:', 'http:');
    artifacts = _createTestArtifactsRoot();
    browser = await chromium.connectOverCDP(endpoint, { artifactsDir: artifacts.path });
  }, 30000);

  afterAll(async () => {
    await _cleanupTestBrowser({ browser, proc, artifacts, cleanup: cleanupTempDataRoots, detachedProcessGroupId: detachedChromeProcessGroupId() });
  }, 25000);

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

  it('draws a composed render\'s lyrics in the shared lyric type when it has no subtitle cues', async () => {
    const [w, h] = [320, 180];
    const words = (text, start) => text.split(' ').map((word, i) => ({ w: word, startSec: start + i * 0.3, endSec: start + i * 0.3 + 0.25 }));
    const project = {
      audioAnalysis: { durationSec: 4 }, lyricMarkers: [], scenes: [],
      lyricCues: [{ text: 'found a shot', startSec: 1, endSec: 1.85, words: words('found a shot', 1) }],
      composition: { mode: 'composed', textCues: [] },
    };
    const windows = composedLyricWindows(project, 4);
    const overlays = await renderTypographyOverlays({ jobId: 'job-lyrics', cues: [], style: {}, width: w, height: h, fps: FPS, durationSec: 4,
      lyrics: { project, windows } });
    expect(overlays).toEqual([{ path: expect.stringContaining('lyrics-overlay-0.mov'), startSec: 1, durationSec: 69 / FPS }]); // 1s to 1.85s + the 2s tail, snapped out to whole frames
    const raw = frames(overlays[0].path, 'rgba');
    const frameBytes = w * h * 4;
    const drawn = (f) => {
      const box = { n: 0, minY: h };
      for (let p = 0; p < w * h; p++) {
        if (raw[f * frameBytes + p * 4 + 3] <= 8) continue;
        box.n += 1; box.minY = Math.min(box.minY, Math.floor(p / w));
      }
      return box;
    };
    // The whole line is up after its last onset, in the lower-left zone, and it has left by the window's end.
    const shown = drawn(Math.round(0.9 * FPS));
    expect(shown.n).toBeGreaterThan(100);
    expect(shown.minY).toBeGreaterThan(h / 2);
    expect(drawn(raw.length / frameBytes - 1).n).toBe(0);
    await removeCompositionScratch('job-lyrics');
  }, 60000);

  // #8985 acceptance: footage, a still with a push-in, a code-rendered title
  // card and animated text on one 30s timebase under one continuous song.
  it('renders footage, a still, a title card and text on one timebase without gaps, repeats or audio resets', async () => {
    const [w, h] = [320, 180];
    await mkdir(PATHS.videos, { recursive: true });
    await mkdir(PATHS.images, { recursive: true });
    const dir = join(PATHS.data, 'fixture-layers');
    await mkdir(dir, { recursive: true });
    run(['-f', 'lavfi', '-i', `color=blue:s=${w}x${h}:r=${FPS}:d=8`, '-y', join(PATHS.videos, 'a.mp4')]);
    run(['-f', 'lavfi', '-i', `color=magenta:s=${w}x${h}:r=${FPS}:d=11`, '-y', join(PATHS.videos, 'b.mp4')]);
    run(['-f', 'lavfi', '-i', 'color=red:s=640x360', '-frames:v', '1', '-y', join(PATHS.images, 'still.png')]);
    run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=30', '-y', join(dir, 'song.wav')]);
    const entry = (id, filename, sec) => ({ id, filename, width: w, height: h, fps: FPS, numFrames: sec * FPS });
    await writeFile(join(PATHS.data, 'video-history.json'), JSON.stringify([entry('h-a', 'a.mp4', 8), entry('h-b', 'b.mp4', 11)]));
    const scenes = [
      { sceneId: 's1', order: 0, videoHistoryId: 'h-a', startSec: 0, endSec: 8, beatAligned: true, loop: false },
      // An off-grid boundary (15.37s is not a whole frame) and no footage.
      { sceneId: 's2', order: 1, visualLayer: 'still', stillMove: 'push', referenceImageId: 'still.png', videoHistoryId: null, startSec: 8, endSec: 15.37 },
      { sceneId: 's3', order: 2, visualLayer: 'card', cardText: 'CHAPTER TWO', cardColor: '#202020', videoHistoryId: null, startSec: 15.37, endSec: 19 },
      { sceneId: 's4', order: 3, videoHistoryId: 'h-b', startSec: 19, endSec: 30, beatAligned: true, loop: false },
    ];
    const composition = { mode: 'composed', style: { color: '#ffffff', font: 'sans' },
      textCues: [{ id: 'c1', text: 'OVER THE CUT', startSec: 7, endSec: 9, template: 'rise', placement: 'center', emphasis: 'hero' }] };
    const clips = beatSnapClips(await resolveSceneClips({ scenes, composition }, { layered: true }), null, { scenes });
    const song = join(dir, 'song.wav');
    const output = join(dir, 'out.mp4');
    const plan = buildMusicVideoFfmpegArgs(clips, song, output, { audioDurationSec: 30, frameGrid: true });
    // Every section starts where the previous one ends, on the frame grid.
    expect(plan.sections.map((s) => [s.layer, Math.round(s.startSec * FPS), Math.round(s.endSec * FPS)])).toEqual([
      ['footage', 0, 192], ['still', 192, 369], ['card', 369, 456], ['footage', 456, 720],
    ]);
    const cues = [...renderableCues(composition, plan.totalDuration), ...sectionCardCues(clips, plan.sections, plan.totalDuration)];
    const overlays = await renderTypographyOverlays({ jobId: 'job-layers', cues, style: composition.style, width: w, height: h, fps: FPS, durationSec: plan.totalDuration });
    const { args } = buildMusicVideoFfmpegArgs(clips, song, output, { audioDurationSec: 30, overlays, frameGrid: true });
    run(args.filter((arg, i) => !(arg === '-progress' || args[i - 1] === '-progress')));

    expect(Math.abs(await probeVideoDuration(output) - 30)).toBeLessThanOrEqual(1 / FPS);
    const pcm = run(['-i', output, '-map', '0:a', '-ac', '1', '-ar', '8000', '-f', 's16le', '-']);
    const samples = new Int16Array(Uint8Array.from(pcm).buffer);
    expect(Math.abs(samples.length / 8000 - 30)).toBeLessThanOrEqual(1 / FPS);
    for (let start = 0; start + 80 <= samples.length - 800; start += 80) {
      let peak = 0;
      for (let i = start; i < start + 80; i++) peak = Math.max(peak, Math.abs(samples[i]));
      expect(peak, `silent 10ms window at ${start / 8000}s`).toBeGreaterThan(1000);
    }

    const rgb = frames(output, 'rgb24');
    const frameBytes = w * h * 3;
    expect(rgb.length / frameBytes).toBe(30 * FPS);
    const corner = (f) => [...rgb.subarray(f * frameBytes, f * frameBytes + 3)];
    const whiteIn = (f) => {
      let n = 0;
      for (let p = 0; p < w * h; p++) {
        const o = f * frameBytes + p * 3;
        if (rgb[o] > 200 && rgb[o + 1] > 200 && rgb[o + 2] > 200) n += 1;
      }
      return n;
    };
    const isBlue = ([r, g, b]) => b > 200 && r < 60 && g < 60;
    const isRed = ([r, g, b]) => r > 200 && g < 60 && b < 60;
    const isCard = ([r, g, b]) => Math.max(r, g, b) < 60;
    const isMagenta = ([r, g, b]) => r > 200 && b > 200 && g < 60;
    // Each section holds its own picture right up to its boundary frame — no
    // gap, no black filler, and no footage repeated into the still or card.
    expect(isBlue(corner(0)) && isBlue(corner(191))).toBe(true);
    expect(isRed(corner(192)) && isRed(corner(368))).toBe(true);
    expect(isCard(corner(369)) && isCard(corner(455))).toBe(true);
    expect(isMagenta(corner(456)) && isMagenta(corner(719))).toBe(true);
    // The lyric cue is drawn across the footage→still cut; the card carries its own title.
    expect(whiteIn(100)).toBe(0);
    expect(whiteIn(186)).toBeGreaterThan(100);
    expect(whiteIn(200)).toBeGreaterThan(100);
    expect(whiteIn(280)).toBe(0);
    expect(whiteIn(420)).toBeGreaterThan(100);
    expect(whiteIn(600)).toBe(0);
    await removeCompositionScratch('job-layers');
  }, 120000);

  // #11185: a silence card planned with no text shows its spoken line (the
  // " / " joiner becomes a line break) in the lyric type's cream and ink, with
  // its own face shipped, inside the title-safe area and on no plate.
  it('draws a blank card\'s lyric line in the lyric type, inside the safe area', async () => {
    const [w, h] = [384, 256];
    const scenes = [{ sceneId: 'quiet', order: 0, visualLayer: 'card', cardText: '', lyricText: 'Example spoken line / Then the answer', startSec: 0, endSec: 2 }];
    const clips = await resolveSceneClips({ scenes }, { layered: true });
    expect(clips[0].cardText).toBe('Example spoken line / Then the answer');
    const plan = buildMusicVideoFfmpegArgs(clips, null, join(PATHS.data, 'unused.mp4'), { audioDurationSec: 2, frameGrid: true });
    const cues = sectionCardCues(clips, plan.sections, 2);
    expect(cues).toMatchObject([{ text: 'Example spoken line\nThen the answer', card: true }]);
    const overlays = await renderTypographyOverlays({ jobId: 'job-card', cues, style: {}, width: w, height: h, fps: 12, durationSec: 2 });
    expect(existsSync(join(PATHS.data, COMPOSITION_SCRATCH_DIR, 'job-card', 'doc', 'archivo-variable.woff2'))).toBe(true);
    expect(assertInsideSafeArea(overlays[0].path, w, h)).toBeGreaterThan(1000);
    // A mid-card frame shows the cream fill inside its ink outline.
    const raw = frames(overlays[0].path, 'rgba');
    const frame = raw.subarray(12 * w * h * 4, 13 * w * h * 4);
    let cream = 0;
    let ink = 0;
    for (let p = 0; p < w * h; p++) {
      const [r, g, b, a] = frame.subarray(p * 4, p * 4 + 4);
      if (a < 250) continue;
      if (r > 220 && g > 210 && b > 190 && b < r) cream += 1;
      else if (r < 40 && g < 40 && b < 40) ink += 1;
    }
    expect(cream).toBeGreaterThan(300);
    expect(ink).toBeGreaterThan(300);
    await removeCompositionScratch('job-card');
  }, 60000);

  // The opening title card reaches composed renders: the overlay page draws it
  // with the same runtime as the live preview, in its lower-left corner.
  it('draws the opening title card over a composed render, lower left', async () => {
    const [w, h] = [384, 216];
    const project = { composition: { mode: 'composed' }, titleCard: {
      enabled: true, title: 'Example Song', artist: 'Example Artist', year: '2026', style: 'mtv',
      position: 'lower-left', startSec: 0, endSec: 2, fadeSec: 0.25 } };
    const { cues, style } = projectTypographyPlan(project, [], [], 2);
    const overlays = await renderTypographyOverlays({ jobId: 'job-title-card', cues, style, width: w, height: h, fps: 12, durationSec: 2 });
    expect(overlays).toHaveLength(1);
    const raw = frames(overlays[0].path, 'rgba');
    const frame = raw.subarray(12 * w * h * 4, 13 * w * h * 4);
    let lowerLeft = 0;
    let elsewhere = 0;
    for (let p = 0; p < w * h; p++) {
      if (frame[p * 4 + 3] < 128) continue;
      const [x, y] = [p % w, Math.floor(p / w)];
      if (x < w / 2 && y > h / 2) lowerLeft += 1;
      else elsewhere += 1;
    }
    expect(lowerLeft).toBeGreaterThan(1000);
    expect(elsewhere).toBe(0);
    await removeCompositionScratch('job-title-card');
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
