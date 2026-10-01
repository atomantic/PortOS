/**
 * The shipped layered template with real Chrome and ffmpeg: an excerpt of a
 * composition-document project seeks the selected take's <video> on SONG time
 * (streamed to the page by byte range), renders frame-for-frame identically
 * every time, and carries the master song. Skips without Chrome or ffmpeg.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const author = vi.hoisted(() => ({ calls: 0, response: null }));
vi.mock('../promptRunner.js', () => ({
  assertProvider: () => {},
  resolveProviderAndModel: async () => ({ provider: { id: 'stub-provider' }, selectedModel: 'fixture-model' }),
  runPromptThroughProvider: async () => {
    author.calls += 1;
    return { text: author.response || JSON.stringify({ sections: ['intro', 'still', 'clip'].map((id) => ({
      id, source: "function render(ctx, env) { if (env.visualLayer === 'card') { ctx.fillStyle = '#123456'; ctx.fillRect(0, 0, env.width, env.height); } }",
    })) }) };
  },
}));

vi.mock('../htmlComposition/encode.js', async importOriginal => {
  const actual = await importOriginal();
  const { _withTestCaptureDiagnostics } = await import('../htmlComposition/testBrowserCleanup.js');
  return { ...actual, encodeComposition: _withTestCaptureDiagnostics(actual.encodeComposition, { getTestSignal: () => testSignal }) };
});

let testSignal;
beforeEach(({ signal }) => { testSignal = signal; });

let endpoint;
vi.mock('../browserService.js', () => ({ cdpRequest: (path) => fetch(`${endpoint}${path}`) }));
vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-document-browser-'),
}));

const { PATHS } = await import('../../lib/paths.js');
const { findFfmpeg } = await import('../../lib/ffmpeg.js');
const { encodeDocumentComposition, prepareDocumentRender } = await import('./documentRender.js');
const { importDocumentTemplate } = await import('./compositionDocument.js');
const { generateMixedMediaDocument, regenerateMixedMediaSection, acceptMixedMediaDocument } = await import('./documentGeneration.js');
const { buildDocumentPreview } = await import('./documentPreview.js');
const projects = await import('./projects.js');
const { _cleanupTestBrowser, _waitForTestChrome, _testChromeCaptureArgs } = await import('../htmlComposition/testBrowserCleanup.js');

afterAll(() => cleanupTempDataRoots());

const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((path) => path && existsSync(path));
const ffmpeg = await findFfmpeg();

describe.skipIf(!chrome || !ffmpeg)('layered template with real Chrome and ffmpeg', () => {
  let proc;
  let browser;
  beforeAll(async () => {
    const profile = join(PATHS.data, 'chrome-test-profile');
    proc = spawn(chrome, _testChromeCaptureArgs(profile), { stdio: ['ignore', 'ignore', 'pipe'] });
    const ws = await _waitForTestChrome(proc);
    endpoint = new URL(ws).origin.replace('ws:', 'http:');
    browser = await chromium.connectOverCDP(endpoint);
  }, 30000);
  afterAll(() => _cleanupTestBrowser({ browser, proc, cleanup: () => {} }));

  it('draws the selected take at SONG time in an excerpt, identically on every render, with the master muxed', async () => {
    // A 3s clip: red, then green, then blue — each second a solid colour.
    await mkdir(PATHS.videos, { recursive: true });
    await mkdir(PATHS.music, { recursive: true });
    const clip = join(PATHS.videos, 'rgb.webm');
    execFileSync(ffmpeg, ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=24:d=1', '-f', 'lavfi', '-i', 'color=c=lime:s=640x360:r=24:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=24:d=1',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0', '-c:v', 'libvpx', '-b:v', '1M', '-g', '24', clip]);
    const master = join(PATHS.music, 'master.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', master]);
    const created = await projects.createProject({ name: 'Excerpt' });
    await projects.mutateProjectRecord(created.id, (current) => ({ project: {
      ...current,
      audioAnalysis: { durationSec: 6, beats: [], downbeats: [], sections: [] },
      scenes: [{ sceneId: 'rgb', order: 0, startSec: 0, endSec: 3, videoHistoryId: 'vh-rgb' }],
    } }));
    await writeFile(join(PATHS.data, 'video-history.json'), JSON.stringify([{ id: 'vh-rgb', filename: 'rgb.webm', numFrames: 72, fps: 24, width: 640, height: 360 }]));
    await importDocumentTemplate(created.id);
    const project = await projects.getProject(created.id);
    const plan = await prepareDocumentRender(project);

    const render = async (name) => {
      const outputPath = join(PATHS.videos, name);
      const result = await encodeDocumentComposition({ project, plan, jobId: `job-${name.replace(/\W/g, '')}`, audioPath: master, outputPath, windowStart: 1.02, windowEnd: 1.75 });
      return { result, outputPath };
    };
    const first = await render('first.mp4');
    // Snapped down to the frame grid: song 1.0s → 1.75s is 18 frames.
    expect(first.result).toMatchObject({ startSec: 1, durationSec: 0.75, width: 1920, height: 1080, fps: 24 });
    const pixels = execFileSync(ffmpeg, ['-v', 'error', '-i', first.outputPath, '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 });
    const frameBytes = 64 * 36 * 3;
    expect(pixels.length / frameBytes).toBe(18);
    for (let n = 0; n < 18; n++) {
      const at = n * frameBytes + (18 * 64 + 32) * 3; // centre pixel
      const [r, g, b] = pixels.subarray(at, at + 3);
      // Song second 1 is the clip's green second — not the red of clip time 0.
      expect(g, `frame ${n}`).toBeGreaterThan(r + 60);
      expect(g, `frame ${n}`).toBeGreaterThan(b + 60);
    }
    const streams = execFileSync(ffmpeg.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', first.outputPath]).toString();
    expect(streams.split('\n').filter(Boolean).sort()).toEqual(['audio', 'video']);

    const second = await render('second.mp4');
    const hashes = (path) => execFileSync(ffmpeg, ['-v', 'error', '-i', path, '-map', '0:v', '-f', 'framemd5', '-']).toString().split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim());
    expect(hashes(second.outputPath)).toEqual(hashes(first.outputPath));
    // The staged job folder is gone once the render ends.
    expect(existsSync(join(PATHS.data, 'music-video-song-renders', 'job-firstmp4'))).toBe(false);
    await rm(first.outputPath, { force: true });
    await rm(second.outputPath, { force: true });
  }, 120000);

  it.each(['ramps', 'generated-shots'])('matches bounded grades across real composed/document %s and song-time excerpts', async (fixture) => {
    // render.js initializes the media registry. Import it only when this test
    // runs: a skipped browser suite never executes afterAll cleanup.
    const { buildMusicVideoFfmpegArgs } = await import('./render.js');
    // Synthetic ramps and a committed, explicitly commissioned generated-shot
    // fixture. Tests access no install data, providers, or network images.
    const width = 1280;
    const height = 720;
    const fps = 12;
    const bytes = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const v = Math.round(255 * x / (width - 1));
      const band = Math.floor(y / 180);
      const rgb = band === 0 ? [v, v, v] : band === 1 ? [v, 72, 104] : band === 2 ? [104, v, 72] : [72, 104, v];
      bytes.set(rgb, (y * width + x) * 3);
    }
    const directory = 'music-video/mv-grade/composition/doc-grade';
    const dir = join(PATHS.data, directory);
    await mkdir(dir, { recursive: true });
    await mkdir(PATHS.music, { recursive: true });
    await mkdir(PATHS.videos, { recursive: true });
    const reference = join(dir, 'reference.png');
    if (fixture === 'generated-shots') {
      await copyFile(new URL('../../../docs/validation/assets/9302/generated-reference.png', import.meta.url), reference);
    } else {
      await sharp(bytes, { raw: { width, height, channels: 3 } }).png().toFile(reference);
    }
    await writeFile(join(dir, 'index.html'), `<!doctype html><style>html,body{margin:0}img{width:${width}px;height:${height}px;display:block}</style>
      <img id="reference" src="reference.png"><script>window.portosComposition={durationSec:2,fps:${fps},width:${width},height:${height},seek:async()=>{await document.getElementById('reference').decode()}};</script>`);
    const master = join(PATHS.music, 'grade.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', master]);
    const source = join(PATHS.videos, 'grade-source.mkv');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-loop', '1', '-i', reference, '-t', '1', '-r', String(fps), '-c:v', 'ffv1', '-pix_fmt', 'yuv420p', source]);
    const scenes = [{ sceneId: 'a', startSec: 0, endSec: 1 }, { sceneId: 'b', startSec: 1, endSec: 1.5 }, { sceneId: 'c', startSec: 1.5, endSec: 2 }];
    const grade = { preset: 'teal-night', grain: 0.03, sections: [{ sceneId: 'b', preset: 'golden-hour' }, { sceneId: 'c', preset: 'monochrome' }] };
    const project = { id: 'mv-grade', name: 'Synthetic grade reference', scenes,
      audioAnalysis: { durationSec: 2, sections: [] }, composition: { mode: 'document', grade, document: { directory } } };
    const plan = await prepareDocumentRender(project);
    const document = join(PATHS.videos, 'grade-document.mp4');
    await encodeDocumentComposition({ project, plan, jobId: 'grade-document', audioPath: master, outputPath: document });
    const clips = scenes.map((scene) => ({ sceneId: scene.sceneId, videoPath: source, inSec: 0, outSec: scene.endSec - scene.startSec, width, height, fps }));
    const composed = join(PATHS.videos, 'grade-composed.mp4');
    const composedArgs = buildMusicVideoFfmpegArgs(clips, master, composed, { grade, frameGrid: true }).args;
    execFileSync(ffmpeg, ['-v', 'error', ...composedArgs], { stdio: 'pipe' });
    const decode = (path, filters = []) => execFileSync(ffmpeg, ['-v', 'error', '-i', path, ...filters, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
    const frameSize = width * height * 3;
    const documentRgb = decode(document);
    const composedRgb = decode(composed);
    expect(documentRgb.length).toBe(frameSize * fps * 2);
    expect(composedRgb.length).toBe(documentRgb.length);
    const mae = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
    // Browser RGB and video YUV420 differ by conversion/subsampling and H.264
    // quantization; palette parity is bounded rather than falsely byte-exact.
    expect(mae(documentRgb, composedRgb)).toBeLessThan(5);
    const excerpt = join(PATHS.videos, 'grade-excerpt.mp4');
    await encodeDocumentComposition({ project, plan, jobId: 'grade-excerpt', audioPath: master, outputPath: excerpt, windowStart: 0.5, windowEnd: 1.5 });
    const excerptRgb = decode(excerpt);
    // Independently encoded H.264 portrait textures have more prediction error
    // than ramps. Retain the ramp's bound and use 3/255 for the new fixture;
    // the repeated excerpt below must still be decoded byte-identical.
    const excerptTolerance = fixture === 'ramps' ? 2 : 3;
    const excerptError = mae(excerptRgb, documentRgb.subarray(6 * frameSize, 18 * frameSize));
    expect(excerptError).toBeLessThan(excerptTolerance);
    const repeat = join(PATHS.videos, 'grade-repeat.mp4');
    await encodeDocumentComposition({ project, plan, jobId: 'grade-repeat', audioPath: master, outputPath: repeat, windowStart: 0.5, windowEnd: 1.5 });
    expect(decode(repeat).equals(excerptRgb)).toBe(true);
    const composedExcerpt = join(PATHS.videos, 'grade-composed-excerpt.mp4');
    execFileSync(ffmpeg, ['-v', 'error', ...buildMusicVideoFfmpegArgs(clips, master, composedExcerpt, {
      grade, frameGrid: true, excerpt: { startSec: 0.5, endSec: 1.5 },
    }).args], { stdio: 'pipe' });
    const composedExcerptError = mae(decode(composedExcerpt), composedRgb.subarray(6 * frameSize, 18 * frameSize));
    expect(composedExcerptError).toBeLessThan(excerptTolerance);
    let neutralExcerptError = null;
    if (fixture === 'generated-shots') {
      const neutralProject = { ...project, composition: { ...project.composition, grade: null } };
      const neutralFull = join(PATHS.videos, 'neutral-full.mp4');
      const neutralExcerpt = join(PATHS.videos, 'neutral-excerpt.mp4');
      await encodeDocumentComposition({ project: neutralProject, plan, jobId: 'neutral-full', audioPath: master, outputPath: neutralFull });
      await encodeDocumentComposition({ project: neutralProject, plan, jobId: 'neutral-excerpt', audioPath: master, outputPath: neutralExcerpt, windowStart: 0.5, windowEnd: 1.5 });
      neutralExcerptError = mae(decode(neutralExcerpt), decode(neutralFull).subarray(6 * frameSize, 18 * frameSize));
      expect(neutralExcerptError).toBeLessThan(3);
      // A codec baseline independently bounds the additional grading error,
      // rather than letting a textured fixture excuse arbitrary divergence.
      expect(excerptError).toBeLessThan(neutralExcerptError + 1);
    }
    const pixel = (rgb, frame, x, y) => [...rgb.subarray(frame * frameSize + (y * width + x) * 3, frame * frameSize + (y * width + x) * 3 + 3)];
    if (fixture === 'ramps') {
      const cool = pixel(documentRgb, 6, 640, 90);
      const warm = pixel(documentRgb, 12, 640, 90);
      const monochrome = pixel(documentRgb, 20, 640, 270);
      expect(Math.max(...monochrome) - Math.min(...monochrome)).toBeLessThan(4);
      expect(cool[2]).toBeGreaterThan(cool[0] + 15);
      expect(warm[0]).toBeGreaterThan(warm[2] + 15);
      expect(Math.max(...pixel(documentRgb, 6, 0, 90))).toBeLessThan(5);
      expect(Math.min(...pixel(documentRgb, 6, width - 1, 90))).toBeGreaterThan(248);
    }
    // Optional local proof export: only synthetic fixtures, never live records.
    if (process.env.PORTOS_GRADE_PROOF_DIR) {
      const proof = join(process.env.PORTOS_GRADE_PROOF_DIR, fixture);
      await mkdir(proof, { recursive: true });
      await copyFile(reference, join(proof, 'reference.png'));
      for (const [label, path] of [['document', document], ['composed', composed], ['excerpt', excerpt]]) {
        execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', path, '-vf', "select='eq(n,6)+eq(n,12)+eq(n,20)',scale=480:270,tile=3x1", '-frames:v', '1', join(proof, `${label}.png`)]);
      }
      await writeFile(join(proof, 'metrics.json'), JSON.stringify({ paletteMeanAbsoluteError: mae(documentRgb, composedRgb), excerptMeanAbsoluteError: excerptError, composedExcerptMeanAbsoluteError: composedExcerptError, neutralExcerptMeanAbsoluteError: neutralExcerptError, repeatIdentical: true }, null, 2));
    }
  }, 120000);

  it('renders a generated 30-second card/still/clip document with the selected performance in-point', async () => {
    await mkdir(PATHS.videos, { recursive: true });
    await mkdir(PATHS.images, { recursive: true });
    await mkdir(PATHS.music, { recursive: true });
    const clip = join(PATHS.videos, 'generated-rgb.webm');
    execFileSync(ffmpeg, ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=24:d=1', '-f', 'lavfi', '-i', 'color=c=lime:s=640x360:r=24:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=24:d=1',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0', '-c:v', 'libvpx', '-b:v', '1M', '-g', '24', clip]);
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=yellow:s=640x360:d=1', '-frames:v', '1', join(PATHS.images, 'generated-still.png')]);
    const master = join(PATHS.music, 'generated-master.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=30', master]);
    const created = await projects.createProject({ name: 'Generated Example' });
    await projects.mutateProjectRecord(created.id, (current) => ({ project: {
      ...current,
      audioAnalysis: { durationSec: 30, beats: [0, 10, 20], downbeats: [0, 10, 20], sections: [
        { id: 'intro', startSec: 0, endSec: 10 }, { id: 'still', startSec: 10, endSec: 20 }, { id: 'clip', startSec: 20, endSec: 30 },
      ] },
      productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 },
      treatment: { shotDirections: [
        { sceneId: 'card', medium: 'procedural', mediumRationale: 'Graphic opening' },
        { sceneId: 'image', medium: 'still', mediumRationale: 'Use selected image' },
        { sceneId: 'video', medium: 'existing-footage', mediumRationale: 'Use selected clip' },
      ] },
      scenes: [
        { sceneId: 'card', order: 0, startSec: 0, endSec: 10 },
        { sceneId: 'image', order: 1, startSec: 10, endSec: 20, referenceImageId: 'generated-still.png' },
        { sceneId: 'video', order: 2, startSec: 20, endSec: 30, shotMode: 'performance', videoHistoryId: 'vh-generated', takes: [
          { kind: 'video', assetId: 'vh-generated', shotInstruction: { shotMode: 'performance', edit: { inSec: 1, outSec: 3 } } },
        ] },
      ],
    } }));
    await writeFile(join(PATHS.data, 'video-history.json'), JSON.stringify([{ id: 'vh-generated', filename: 'generated-rgb.webm', numFrames: 72, fps: 24, width: 640, height: 360 }]));
    author.calls = 0;
    const staged = await generateMixedMediaDocument(created.id);
    expect(author.calls).toBe(1);
    expect((await projects.getProject(created.id)).composition.document).toBeUndefined();
    await acceptMixedMediaDocument(created.id, staged.document.directory);
    const project = await projects.getProject(created.id);
    const preview = await buildDocumentPreview(project);
    expect(preview.html).toContain('PORTOS_MV_GENERATED');
    expect(preview.html).toContain('"inSec":1');
    const previewFrames = async (current, times) => {
      const page = await browser.newPage();
      const prepared = await buildDocumentPreview(current);
      await page.setContent(prepared.html);
      const files = Object.fromEntries(await Promise.all(prepared.assets.map(async (asset) => [asset.key,
        (await readFile(asset.key.endsWith('.webm') ? clip : join(PATHS.images, 'generated-still.png'))).toString('base64')])));
      await page.evaluate(async (encoded) => {
        const blobs = Object.fromEntries(Object.entries(encoded).map(([key, value]) => [key,
          new Blob([Uint8Array.from(atob(value), (c) => c.charCodeAt(0))], { type: key.endsWith('.webm') ? 'video/webm' : 'image/png' })]));
        window.postMessage({ type: 'portos-mv:assets', files: blobs }, '*');
        await window.PORTOS_MV_ASSETS;
      }, files);
      const pixels = [];
      for (const time of times) pixels.push(await page.evaluate(async (t) => {
        await window.portosComposition.seek(t);
        const canvas = document.getElementById('stage');
        return [...canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data].slice(0, 3);
      }, time));
      await page.close();
      return pixels;
    };
    const beforeProof = await previewFrames(project, [0, 10, 20]);
    const plan = { ...(await prepareDocumentRender(project)), frame: { width: 1280, height: 720 } };
    const renderAt = async (time, name) => {
      const outputPath = join(PATHS.videos, name);
      await encodeDocumentComposition({ project, plan, jobId: name.replace(/\W/g, ''), audioPath: master, outputPath, windowStart: time, windowEnd: time + 1 / 24 });
      const frame = execFileSync(ffmpeg, ['-v', 'error', '-i', outputPath, '-frames:v', '1', '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      await rm(outputPath, { force: true });
      return [...frame.subarray((18 * 64 + 32) * 3, (18 * 64 + 32) * 3 + 3)];
    };
    const card = await renderAt(0, 'generated-card.mp4');
    const still = await renderAt(10, 'generated-still.mp4');
    const firstClip = await renderAt(20, 'generated-clip.mp4');
    const repeated = await renderAt(20, 'generated-clip-again.mp4');
    const fullPath = join(PATHS.videos, 'generated-full.mp4');
    await encodeDocumentComposition({ project, plan, jobId: 'generated-full', audioPath: master, outputPath: fullPath });
    const fullPixel = (time) => {
      const frame = execFileSync(ffmpeg, ['-v', 'error', '-ss', String(time), '-i', fullPath, '-frames:v', '1', '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      return [...frame.subarray((18 * 64 + 32) * 3, (18 * 64 + 32) * 3 + 3)];
    };
    for (const [index, time] of [0, 10, 20].entries()) {
      const excerpt = [card, still, firstClip][index];
      const final = fullPixel(time);
      for (let channel = 0; channel < 3; channel++) {
        expect(Math.abs(beforeProof[index][channel] - excerpt[channel]), `preview/excerpt ${time}s channel ${channel}`).toBeLessThan(35);
        expect(Math.abs(final[channel] - excerpt[channel]), `final/excerpt ${time}s channel ${channel}`).toBeLessThan(25);
      }
    }
    await rm(fullPath, { force: true });
    expect(card[2]).toBeGreaterThan(50);
    expect(still[0]).toBeGreaterThan(140);
    expect(still[1]).toBeGreaterThan(140);
    expect(firstClip[1]).toBeGreaterThan(firstClip[0] + 60); // clip time 1s is green, not red
    expect(firstClip).toEqual(repeated);
    author.response = JSON.stringify({ sections: [{ id: 'still', source: "function render(ctx, env) { ctx.fillStyle = '#ff00ff'; ctx.fillRect(0, 0, env.width, env.height); }" }] });
    const revision = await regenerateMixedMediaSection(created.id, 'still', { expectedDraft: project.composition.document.directory });
    await acceptMixedMediaDocument(created.id, revision.document.directory);
    const afterProof = await previewFrames(await projects.getProject(created.id), [0, 10, 20]);
    expect(afterProof[0]).toEqual(beforeProof[0]);
    expect(afterProof[1]).not.toEqual(beforeProof[1]);
    expect(afterProof[2]).toEqual(beforeProof[2]);
    author.response = null;
  }, 180000);
});
