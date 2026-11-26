import { describe, expect, it as vitestIt, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { browserSuiteCanRun } from '../../lib/browserSuiteGate.js';
import { mockNoPeers } from '../../lib/mockPathsDataRoot.js';
import {
  browser, buildDocumentPreview, cleanupTempDataRoots, encodeDocumentComposition, ffmpeg, importDocumentTemplate, it, mockCaptureBrowserService,
  ownedChildren, PATHS, prepareDocumentRender, PREVIEW_MEDIA_BUDGET_BYTES, prerequisites, projects, refuseCompositionVideoPublication, testDeadline, useDocumentRenderBrowserFixture,
} from './documentRender.browser.test.fixture.js';

// The planner prunes sealed mocks declared by the suite itself.
vi.mock('./projects.js', async () => import('./projectsFile.js'));
vi.mock('../instances.js', () => mockNoPeers());
vi.mock('../mediaCollectionRules.js', () => ({ fileCompositionVideos: refuseCompositionVideoPublication }));
vi.mock('../browserService.js', () => mockCaptureBrowserService());

const canRun = browserSuiteCanRun('documentRender browser suite', prerequisites, { onUnavailable: cleanupTempDataRoots });

describe.skipIf(!canRun)('layered template with real Chrome and ffmpeg', () => {
  useDocumentRenderBrowserFixture();

  // #15950: exercise the shipped module graph through preview's sandbox and
  // the real excerpt encoder, not a hand-built canvas fixture.
  it('previews cel animation at three song times and renders a no-edit excerpt', async () => {
    const created = await projects.createProject({ name: 'Cel template proof' });
    await projects.mutateProjectRecord(created.id, current => ({ project: { ...current,
      audioAnalysis: { durationSec: 16, bpm: 120, beats: Array.from({ length: 33 }, (_, i) => i / 2), sections: [] },
    } }));
    await importDocumentTemplate(created.id, 'cel');
    const project = await projects.getProject(created.id);
    const preview = await buildDocumentPreview(project);
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.setContent(preview.html);
      await page.waitForFunction(() => globalThis.portosComposition);
      const frames = [];
      for (const t of [0.5, 3, 13, 0.5]) {
        frames.push(await page.evaluate(async time => {
          await globalThis.portosComposition.seek(time);
          const source = document.getElementById('stage');
          const sample = document.createElement('canvas'); sample.width = 64; sample.height = 36;
          const context = sample.getContext('2d'); context.drawImage(source, 0, 0, 64, 36);
          const bytes = [...context.getImageData(0, 0, 64, 36).data];
          return { width: source.width, height: source.height, bytes };
        }, t));
        if (process.env.PORTOS_CEL_PROOF_DIR) {
          await mkdir(process.env.PORTOS_CEL_PROOF_DIR, { recursive: true });
          await page.screenshot({ path: join(process.env.PORTOS_CEL_PROOF_DIR, `cel-${t}.png`) });
        }
      }
      expect(errors).toEqual([]);
      expect(frames[0]).toEqual(frames[3]);
      expect(new Set(frames.slice(0, 3).map(frame => JSON.stringify(frame.bytes))).size).toBe(3);
      for (const frame of frames) {
        expect(frame.width).toBe(1920); expect(frame.height).toBe(1080);
        expect(new Set(frame.bytes.filter((_, i) => i % 4 !== 3)).size).toBeGreaterThan(32);
      }
    } finally { await page.close(); }
    await mkdir(PATHS.music, { recursive: true });
    await mkdir(PATHS.videos, { recursive: true });
    const audio = join(PATHS.music, 'cel-proof.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=16', audio]);
    const output = join(PATHS.videos, 'cel-proof.mp4');
    await encodeDocumentComposition({ project, plan: await prepareDocumentRender(project), jobId: 'cel-proof',
      audioPath: audio, outputPath: output, windowStart: 3, windowEnd: 3.125 });
    const pixels = execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    expect(pixels.length).toBe(3 * 64 * 36 * 3);
    expect(new Set(pixels).size).toBeGreaterThan(32);
  }, 90000);

  // Five solid photos as one still shot: the encoded full render and a
  // mid-shot excerpt, plus a live preview page whose `pixel(frame, x, y)` reads
  // the Canvas at frame centre offsets (fractions of the frame, 64x36 readback).
  const SEQUENCE_COLORS = ['#ee2222', '#22ee22', '#2222ee', '#eeee22', '#ee22ee'];
  const rgbOf = hex => hex.slice(1).match(/../g).map(part => parseInt(part, 16));
  async function renderPhotoSequence(label, photoSequence, run) {
    await mkdir(PATHS.images, { recursive: true });
    const names = SEQUENCE_COLORS.map((_, i) => `${label}-${i}.png`);
    const photos = await Promise.all(SEQUENCE_COLORS.map(background => sharp({ create: { width: 64, height: 36, channels: 3, background } }).png().toBuffer()));
    await Promise.all(names.map((name, i) => writeFile(join(PATHS.images, name), photos[i])));
    const created = await projects.createProject({ name: `Synthetic ${label}` });
    await projects.mutateProjectRecord(created.id, current => ({ project: { ...current,
      audioAnalysis: { durationSec: 2, beats: [0, 0.5, 1, 1.5, 2], sections: [] },
      scenes: [{ sceneId: 'photos', order: 0, startSec: 0, endSec: 2, visualLayer: 'still', stillMove: 'hold',
        photoSequence: { enabled: true, imageIds: names, ...photoSequence } }],
    } }));
    await importDocumentTemplate(created.id);
    const project = await projects.getProject(created.id);
    await mkdir(PATHS.music, { recursive: true });
    await mkdir(PATHS.videos, { recursive: true });
    const audio = join(PATHS.music, `${label}.wav`);
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', audio]);
    const encode = async (name, windowStart, windowEnd) => {
      const output = join(PATHS.videos, name);
      await encodeDocumentComposition({ project, plan: await prepareDocumentRender(project), jobId: name.replace('.mp4', ''),
        audioPath: audio, outputPath: output, windowStart, windowEnd });
      return execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 8 * 1024 * 1024 });
    };
    const full = await encode(`${label}-full.mp4`, 0, 2);
    const excerpt = await encode(`${label}-excerpt.mp4`, 9 / 24, 33 / 24);
    const frameBytes = 64 * 36 * 3;
    expect(full.length).toBe(48 * frameBytes);
    expect(excerpt.length).toBe(24 * frameBytes);
    const encodedAt = (raw, frame, x = 0, y = 0) => {
      const at = frame * frameBytes + (Math.round(18 + y * 36) * 64 + Math.round(32 + x * 64)) * 3;
      return [...raw.subarray(at, at + 3)];
    };
    const preview = await buildDocumentPreview(project);
    const assets = preview.assets.filter(asset => asset.url.startsWith('/data/images/')).map(asset => ({
      key: asset.key, encoded: photos[names.indexOf(decodeURIComponent(asset.url.split('/').at(-1)))].toString('base64'),
    }));
    const page = await browser.newPage();
    try {
      await page.setContent(preview.html);
      await page.evaluate(assets => {
        addEventListener('message', ({ data }) => {
          if (data?.type !== 'portos-mv:request') return;
          const asset = assets.find(asset => asset.key === data.key);
          if (!asset) return;
          const blob = new Blob([Uint8Array.from(atob(asset.encoded), c => c.charCodeAt(0))], { type: 'image/png' });
          window.postMessage({ type: 'portos-mv:asset', key: asset.key, blob }, '*');
        });
        window.postMessage({ type: 'portos-mv:manifest', keys: assets.map(asset => asset.key) }, '*');
      }, assets);
      await page.waitForFunction(() => globalThis.portosComposition);
      const live = (frame, x = 0, y = 0) => page.evaluate(async ({ t, x, y }) => {
        await globalThis.portosComposition.seek(t);
        const canvas = document.getElementById('stage');
        return [...canvas.getContext('2d').getImageData(Math.round(canvas.width * (0.5 + x)), Math.round(canvas.height * (0.5 + y)), 1, 1).data].slice(0, 3);
      }, { t: frame / 24, x, y });
      await run({ full: (frame, x, y) => encodedAt(full, frame, x, y), excerpt: (frame, x, y) => encodedAt(excerpt, frame - 9, x, y), live });
    } finally { await page.close(); }
  }
  const near = (actual, expected, tolerance) => actual.forEach((v, i) => expect(Math.abs(v - expected[i])).toBeLessThan(tolerance));

  // Catches dropped multi-photo assets, wrong Canvas switching boundaries and
  // excerpt-relative phase resets by comparing live and encoded frame pixels.
  it('plays five photos identically in the document preview, export and mid-sequence excerpt', async () => {
    await renderPhotoSequence('photo-sequence', { intervalFrames: 6, rate: 'half' }, async ({ full, excerpt, live }) => {
      for (const frame of [0, 5, 6, 11, 12, 18, 24, 29, 30, 35, 36, 6]) {
        const shown = await live(frame);
        near(full(frame), shown, 16);
        // Verify the expected image independently of the shared selector.
        near(shown, rgbOf(SEQUENCE_COLORS[Math.floor(frame / 6) % 5]), 35);
        if (frame >= 9 && frame < 33) near(excerpt(frame), full(frame), 12);
      }
    });
  }, 60000);

  // #14277: catches a document engine that drops earlier photos during the
  // overlap, ignores layouts, or composes differently in preview and export.
  it('keeps overlapping laid-out photos in place identically in the document preview, export and excerpt', async () => {
    // Prints far enough apart that video chroma subsampling never bleeds between them.
    const spots = [[-0.3, -0.25], [0, -0.25], [0.3, -0.25], [-0.15, 0.25], [0.15, 0.25]];
    const layouts = spots.map(([x, y]) => ({ x, y, scale: 0.2, rotation: 0, opacity: 1 }));
    await renderPhotoSequence('photo-stack', { intervalFrames: 6, rate: 'frames', overlapFrames: 12, layouts }, async ({ full, excerpt, live }) => {
      for (const frame of [0, 5, 6, 13, 17, 18, 24, 30, 35]) {
        // Independent of the shared layer list: step k shows from 6k until 6(k+1) + 12.
        const visible = new Set([0, 1, 2, 3, 4, 5].filter(k => frame >= 6 * k && frame < 6 * (k + 1) + 12).map(k => k % 5));
        for (const [i, [x, y]] of spots.entries()) {
          const shown = await live(frame, x, y);
          near(full(frame, x, y), shown, 24);
          const dominant = rgbOf(SEQUENCE_COLORS[i]).map(v => v > 128);
          if (visible.has(i)) shown.forEach((v, c) => expect(dominant[c] ? v > 110 : v < 110, `frame ${frame} photo ${i}`).toBe(true));
          else expect(Math.max(...shown), `frame ${frame} photo ${i} hidden`).toBeLessThan(70);
          if (frame >= 9 && frame < 33) near(excerpt(frame, x, y), full(frame, x, y), 12);
        }
      }
    });
  }, 90000);

  // Uniquely catches dropped effect data, missing staged modules and preview/export curve drift.
  it('develops a still from white in the encoded document render and live preview', async () => {
    await mkdir(PATHS.images, { recursive: true });
    const image = await sharp({ create: { width: 64, height: 36, channels: 3, background: '#ee6721' } }).png().toBuffer();
    await writeFile(join(PATHS.images, 'effect-still.png'), image);
    const created = await projects.createProject({ name: 'Synthetic image effect' });
    await projects.mutateProjectRecord(created.id, current => ({ project: { ...current,
      audioAnalysis: { durationSec: 2, sections: [] },
      scenes: [{ sceneId: 'develop', startSec: 0.25, endSec: 2, visualLayer: 'still', stillMove: 'hold',
        referenceImageId: 'effect-still.png', imageEffect: 'flash-develop', imageEffectSec: 0.5 }],
    } }));
    await importDocumentTemplate(created.id);
    const project = await projects.getProject(created.id);
    await mkdir(PATHS.music, { recursive: true });
    await mkdir(PATHS.videos, { recursive: true });
    const master = join(PATHS.music, 'still-effect.wav');
    const output = join(PATHS.videos, 'still-effect.mp4');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', master]);
    await encodeDocumentComposition({ project, plan: await prepareDocumentRender(project), jobId: 'still-effect',
      audioPath: master, outputPath: output, windowStart: 0.25, windowEnd: 1.25 + 1 / 24 });
    const renderedFrames = execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const page = await browser.newPage();
    try {
      const loadPreview = async current => {
        const preview = await buildDocumentPreview(current);
        await page.setContent(preview.html);
        await page.evaluate(({ key, encoded }) => {
          addEventListener('message', ({ data }) => {
            if (data?.type !== 'portos-mv:request') return;
            const blob = new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], { type: 'image/png' });
            window.postMessage({ type: 'portos-mv:asset', key, blob }, '*');
          });
          window.postMessage({ type: 'portos-mv:manifest', keys: [key] }, '*');
        }, { key: preview.assets[0].key, encoded: image.toString('base64') });
        await page.waitForFunction(() => globalThis.portosComposition);
      };
      await loadPreview(project);
      const pixels = [];
      for (const t of [0.25, 0.5, 0.75, 1.25]) {
        const sample = `(async () => {
          await portosComposition.seek(${t});
          const canvas = document.getElementById('stage');
          return [...canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data].slice(0, 3);
        })()`;
        const live = await page.evaluate(sample);
        const offset = (Math.round((t - 0.25) * 24) * 64 * 36 + 18 * 64 + 32) * 3;
        const rendered = [...renderedFrames.subarray(offset, offset + 3)];
        expect(rendered).toHaveLength(3);
        // H.264/YUV conversion and downscaling can change a pixel slightly.
        rendered.forEach((channel, index) => expect(Math.abs(channel - live[index])).toBeLessThan(16));
        pixels.push(live);
      }
      expect(pixels[0]).toEqual([255, 255, 255]);
      expect(pixels[1][0] - pixels[1][2]).toBeLessThan(pixels[2][0] - pixels[2][2]);
      expect(pixels[2][0]).toBeGreaterThan(pixels[2][1] + 80);
      expect(pixels[2][1]).toBeGreaterThan(pixels[2][2] + 40);
      // A developed still is exactly the no-effect picture at the same song time.
      await loadPreview({ ...project, scenes: project.scenes.map(scene => ({ ...scene, imageEffect: null })) });
      const held = await page.evaluate(async () => {
        await globalThis.portosComposition.seek(1.25);
        const canvas = document.getElementById('stage');
        return [...canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data].slice(0, 3);
      });
      expect(held).toEqual(pixels[3]);
    } finally {
      await page.close();
      await rm(output, { force: true });
    }
  }, 60000);

  it('renders an end flash and a timed light leak identically in preview, full export and a mid-effect excerpt', async () => {
    await mkdir(PATHS.images, { recursive: true });
    const names = ['effect-start.png', 'effect-end.png'];
    const colors = ['#d02020', '#2040d0'];
    const images = await Promise.all(colors.map(background => sharp({ create: { width: 64, height: 36, channels: 3, background } }).png().toBuffer()));
    await Promise.all(names.map((name, i) => writeFile(join(PATHS.images, name), images[i])));
    const created = await projects.createProject({ name: 'Synthetic selected effects' });
    await projects.mutateProjectRecord(created.id, current => ({ project: { ...current,
      audioAnalysis: { durationSec: 2, sections: [{ id: 'hook', label: 'Hook', startSec: 0, endSec: 2 }] },
      scenes: [{ sceneId: 'effect', startSec: 0.26, endSec: 2, visualLayer: 'still', stillMove: 'hold',
        referenceImageId: names[0], endImageId: names[1], imageEffect: 'end-flash', imageEffectSec: 0.5,
        glitches: [{ atSec: 0.9, style: 'light-leak', lengthSec: 0.25, color: '#00ff00', edge: 'right', strength: 0.8 }] }],
    } }));
    await importDocumentTemplate(created.id);
    const project = await projects.getProject(created.id);
    await mkdir(PATHS.music, { recursive: true });
    await mkdir(PATHS.videos, { recursive: true });
    const audio = join(PATHS.music, 'selected-effects.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', audio]);
    const encode = async (name, windowStart, windowEnd) => {
      const outputPath = join(PATHS.videos, name);
      await encodeDocumentComposition({ project, plan: await prepareDocumentRender(project), jobId: name.replace('.mp4', ''),
        audioPath: audio, outputPath, windowStart, windowEnd });
      return execFileSync(ffmpeg, ['-v', 'error', '-i', outputPath, '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    };
    const full = await encode('selected-effects-full.mp4', 0, 2);
    const excerpt = await encode('selected-effects-excerpt.mp4', 29 / 24, 37 / 24);
    const pixel = (raw, frame, x) => {
      const index = (frame * 64 * 36 + 18 * 64 + x) * 3;
      return [...raw.subarray(index, index + 3)];
    };
    const preview = await buildDocumentPreview(project);
    const assets = preview.assets.filter(asset => asset.url.startsWith('/data/images/')).map(asset => ({
      key: asset.key, encoded: images[names.indexOf(decodeURIComponent(asset.url.split('/').at(-1)))].toString('base64'),
    }));
    const page = await browser.newPage();
    try {
      await page.setContent(preview.html);
      await page.evaluate(assets => {
        addEventListener('message', ({ data }) => {
          if (data?.type !== 'portos-mv:request') return;
          const asset = assets.find(item => item.key === data.key);
          if (!asset) return;
          const blob = new Blob([Uint8Array.from(atob(asset.encoded), c => c.charCodeAt(0))], { type: 'image/png' });
          window.postMessage({ type: 'portos-mv:asset', key: asset.key, blob }, '*');
        });
        window.postMessage({ type: 'portos-mv:manifest', keys: assets.map(asset => asset.key) }, '*');
      }, assets);
      await page.waitForFunction(() => globalThis.portosComposition);
      const live = (frame, x) => page.evaluate(async ({ frame, x }) => {
        await globalThis.portosComposition.seek(frame / 24);
        const canvas = document.getElementById('stage');
        return [...canvas.getContext('2d').getImageData(Math.round(canvas.width * x / 64), canvas.height / 2, 1, 1).data].slice(0, 3);
      }, { frame, x });
      for (const frame of [8, 17, 18, 24, 29, 30, 33, 36]) {
        for (const x of [8, 32, 56]) {
          const shown = await live(frame, x);
          near(pixel(full, frame, x), shown, 24);
          if (frame >= 29 && frame < 37) near(pixel(excerpt, frame - 29, x), shown, 24);
        }
      }
      const before = await live(8, 32), flash = await live(18, 32), after = await live(24, 32);
      expect(before[0]).toBeGreaterThan(before[2] + 80);
      expect(Math.min(...flash)).toBeGreaterThan(240);
      expect(after[2]).toBeGreaterThan(after[0] + 80);
      const leak = await live(30, 56), clean = await live(36, 56);
      expect(leak[1]).toBeGreaterThan(clean[1] + 10);
    } finally { await page.close(); }
  }, 90000);

  // Catches a grade applied by whole-scene time: the outgoing picture under a wipe would
  // take the incoming scene's look from the cut until the wipe has covered it (#14835).
  it('keeps each picture of a wipe on its own scene grade in a full export and an excerpt', async () => {
    await mkdir(PATHS.images, { recursive: true });
    const names = ['grade-wipe-red.png', 'grade-wipe-blue.png', 'grade-wipe-green.png'];
    const colors = ['#d02020', '#2040d0', '#20c020'];
    await Promise.all(names.map(async (name, i) => writeFile(join(PATHS.images, name),
      await sharp({ create: { width: 64, height: 36, channels: 3, background: colors[i] } }).png().toBuffer())));
    const created = await projects.createProject({ name: 'Synthetic graded wipes' });
    const still = (sceneId, startSec, image, extra = {}) => ({ sceneId, startSec, endSec: startSec + 1, visualLayer: 'still', stillMove: 'hold', referenceImageId: image, ...extra });
    await projects.mutateProjectRecord(created.id, current => ({ project: { ...current,
      audioAnalysis: { durationSec: 3, sections: [] },
      scenes: [
        still('a', 0, names[0], { wipeOut: { style: 'iris', lengthSec: 0.5 } }),
        still('b', 1, names[1], { wipeOut: { style: 'push-left', lengthSec: 0.5 } }),
        still('c', 2, names[2]),
      ],
      composition: { ...current.composition, grade: { preset: 'neutral', grain: 0, sections: [{ sceneId: 'a', preset: 'monochrome' }, { sceneId: 'c', preset: 'monochrome' }] } },
    } }));
    await importDocumentTemplate(created.id);
    const project = await projects.getProject(created.id);
    await mkdir(PATHS.music, { recursive: true });
    await mkdir(PATHS.videos, { recursive: true });
    const audio = join(PATHS.music, 'graded-wipes.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', audio]);
    const encode = async (name, windowStart, windowEnd) => {
      const outputPath = join(PATHS.videos, name);
      // Grade isolation does not depend on resolution, and 1080p software rendering
      // took this test past its deadline on CI runners (#14845).
      const plan = { ...(await prepareDocumentRender(project)), frame: { width: 1280, height: 720 } };
      await encodeDocumentComposition({ project, plan, jobId: name.replace('.mp4', ''), audioPath: audio, outputPath, windowStart, windowEnd });
      const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', outputPath, '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      return (frame, x, y = 18) => [...raw.subarray((frame * 64 * 36 + y * 64 + x) * 3, (frame * 64 * 36 + y * 64 + x) * 3 + 3)];
    };
    const chroma = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b);
    const full = await encode('graded-wipes-full.mp4', 0, 3);
    const excerpt = await encode('graded-wipes-excerpt.mp4', 28 / 24, 32 / 24);
    // Monochrome into neutral: the iris opens blue over a held picture that stays gray.
    for (const frame of [24, 28, 31]) {
      expect(chroma(full(frame, 2))).toBeLessThan(24);
      expect(full(frame, 32)[2]).toBeGreaterThan(full(frame, 32)[0] + 60);
    }
    for (let n = 0; n < 4; n++) {
      expect(chroma(excerpt(n, 2))).toBeLessThan(24);
      expect(excerpt(n, 32)[2]).toBeGreaterThan(excerpt(n, 32)[0] + 60);
    }
    // Neutral into monochrome: the outgoing picture keeps its color, the one pushing in is gray.
    expect(full(52, 4)[2]).toBeGreaterThan(full(52, 4)[1] + 60);
    expect(chroma(full(52, 60))).toBeLessThan(24);
    // Past the wipes, each shot's own grade over the whole frame.
    expect(chroma(full(23, 32))).toBeLessThan(24);
    expect(full(40, 2)[2]).toBeGreaterThan(full(40, 2)[0] + 60);
    expect(chroma(full(64, 32))).toBeLessThan(24);
  }, 120000);

  // Catches a document drawing a wipe on other frames than its cut, losing the
  // held outgoing frame or the edge color, or the export and preview disagreeing.
  it('paints shape and move wipes from their cuts identically in preview, full export and a mid-wipe excerpt', async () => {
    await mkdir(PATHS.images, { recursive: true });
    const names = ['wipe-red.png', 'wipe-blue.png', 'wipe-green.png'];
    const colors = ['#d02020', '#2040d0', '#20c020'];
    const images = await Promise.all(colors.map(background => sharp({ create: { width: 64, height: 36, channels: 3, background } }).png().toBuffer()));
    await Promise.all(names.map((name, i) => writeFile(join(PATHS.images, name), images[i])));
    const created = await projects.createProject({ name: 'Synthetic wipes' });
    const still = (sceneId, startSec, image, extra = {}) => ({ sceneId, startSec, endSec: startSec + 1, visualLayer: 'still', stillMove: 'hold', referenceImageId: image, ...extra });
    await projects.mutateProjectRecord(created.id, current => ({ project: { ...current,
      audioAnalysis: { durationSec: 3, sections: [] },
      scenes: [
        still('a', 0, names[0], { wipeOut: { style: 'iris', lengthSec: 0.5, color: '#ffff00' } }),
        still('b', 1, names[1], { wipeOut: { style: 'push-left', lengthSec: 0.5 } }),
        still('c', 2, names[2]),
      ],
    } }));
    await importDocumentTemplate(created.id);
    const project = await projects.getProject(created.id);
    await mkdir(PATHS.music, { recursive: true });
    await mkdir(PATHS.videos, { recursive: true });
    const audio = join(PATHS.music, 'wipes.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', audio]);
    const encode = async (name, windowStart, windowEnd) => {
      const outputPath = join(PATHS.videos, name);
      await encodeDocumentComposition({ project, plan: await prepareDocumentRender(project), jobId: name.replace('.mp4', ''),
        audioPath: audio, outputPath, windowStart, windowEnd });
      return execFileSync(ffmpeg, ['-v', 'error', '-i', outputPath, '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    };
    const full = await encode('wipes-full.mp4', 0, 3);
    const excerpt = await encode('wipes-excerpt.mp4', 50 / 24, 58 / 24);
    const pixel = (raw, frame, x, y = 18) => {
      const index = (frame * 64 * 36 + y * 64 + x) * 3;
      return [...raw.subarray(index, index + 3)];
    };
    const preview = await buildDocumentPreview(project);
    const assets = preview.assets.filter(asset => asset.url.startsWith('/data/images/')).map(asset => ({
      key: asset.key, encoded: images[names.indexOf(decodeURIComponent(asset.url.split('/').at(-1)))].toString('base64'),
    }));
    const page = await browser.newPage();
    try {
      await page.setContent(preview.html);
      await page.evaluate(assets => {
        addEventListener('message', ({ data }) => {
          if (data?.type !== 'portos-mv:request') return;
          const asset = assets.find(item => item.key === data.key);
          if (!asset) return;
          const blob = new Blob([Uint8Array.from(atob(asset.encoded), c => c.charCodeAt(0))], { type: 'image/png' });
          window.postMessage({ type: 'portos-mv:asset', key: asset.key, blob }, '*');
        });
        window.postMessage({ type: 'portos-mv:manifest', keys: assets.map(asset => asset.key) }, '*');
      }, assets);
      await page.waitForFunction(() => globalThis.portosComposition);
      const live = (frame, x, y = 18) => page.evaluate(async ({ frame, x, y }) => {
        await globalThis.portosComposition.seek(frame / 24);
        const canvas = document.getElementById('stage');
        return [...canvas.getContext('2d').getImageData(Math.round(canvas.width * x / 64), Math.round(canvas.height * y / 36), 1, 1).data].slice(0, 3);
      }, { frame, x, y });
      for (const frame of [23, 24, 30, 36, 47, 48, 52, 56, 60]) {
        for (const x of [4, 32, 60]) {
          const shown = await live(frame, x);
          near(pixel(full, frame, x), shown, 24);
          if (frame >= 50 && frame < 58) near(pixel(excerpt, frame - 50, x), shown, 24);
        }
      }
      // The iris opens on the cut: the incoming centre at once, the frame's edge still outgoing.
      const [cutCentre, cutEdge] = [await live(24, 32), await live(24, 4)];
      expect(cutCentre[2]).toBeGreaterThan(cutCentre[0] + 80);
      expect(cutEdge[0]).toBeGreaterThan(cutEdge[2] + 80);
      expect((await live(36, 4))[2]).toBeGreaterThan((await live(36, 4))[0] + 60);
      // Pushed left: the incoming shot enters from the right.
      const [pushLeft, pushRight] = [await live(52, 4), await live(52, 60)];
      expect(pushLeft[2]).toBeGreaterThan(pushLeft[1] + 60);
      expect(pushRight[1]).toBeGreaterThan(pushRight[2] + 60);
    } finally { await page.close(); }
  }, 90000);

  it('repaints a chroma effect independently of the last image rendered', async () => {
    await mkdir(PATHS.images, { recursive: true });
    const names = ['chroma-red.png', 'chroma-blue.png'];
    const images = await Promise.all(['#ee2222', '#2222ee'].map(background => sharp({ create: { width: 64, height: 36, channels: 3, background } }).png().toBuffer()));
    await Promise.all(names.map((name, i) => writeFile(join(PATHS.images, name), images[i])));
    const created = await projects.createProject({ name: 'Synthetic deterministic effect' });
    await projects.mutateProjectRecord(created.id, current => ({ project: { ...current,
      audioAnalysis: { durationSec: 2, sections: [] },
      scenes: names.map((name, i) => ({ sceneId: `s${i}`, startSec: i, endSec: i + 1, visualLayer: 'still', stillMove: 'hold',
        referenceImageId: name, glitches: [{ atSec: 0, style: 'color-split' }] })),
    } }));
    await importDocumentTemplate(created.id);
    const preview = await buildDocumentPreview(await projects.getProject(created.id));
    const assets = preview.assets.map(asset => ({ key: asset.key,
      encoded: images[names.indexOf(decodeURIComponent(asset.url.split('/').at(-1)))].toString('base64') }));
    const page = await browser.newPage();
    try {
      await page.setContent(preview.html);
      await page.evaluate(assets => {
        addEventListener('message', ({ data }) => {
          if (data?.type !== 'portos-mv:request') return;
          const asset = assets.find(item => item.key === data.key);
          if (!asset) return;
          const blob = new Blob([Uint8Array.from(atob(asset.encoded), c => c.charCodeAt(0))], { type: 'image/png' });
          window.postMessage({ type: 'portos-mv:asset', key: asset.key, blob }, '*');
        });
        window.postMessage({ type: 'portos-mv:manifest', keys: assets.map(asset => asset.key) }, '*');
      }, assets);
      await page.waitForFunction(() => globalThis.portosComposition);
      const [first, second] = await page.evaluate(async () => {
        const context = document.getElementById('stage').getContext('2d');
        await globalThis.portosComposition.seek(0);
        await globalThis.portosComposition.seek(1);
        const first = [...context.getImageData(0, 500, 80, 20).data];
        await globalThis.portosComposition.seek(1);
        return [first, [...context.getImageData(0, 500, 80, 20).data]];
      });
      expect(first).toEqual(second);
      // The shifted blue channel leaves the left edge black, not a blue mask.
      expect(first[2]).toBeLessThan(80);
    } finally { await page.close(); }
  }, 30000);

  it('keeps network refusal inside the owned capture browser and leaves the browsing session alive', async () => {
    const { openComposition } = await import('../htmlComposition/browser.js');
    const directory = 'compositions/synthetic-owned-refusal';
    await mkdir(join(PATHS.data, directory), { recursive: true });
    await writeFile(join(PATHS.data, directory, 'index.html'), '<!doctype html><title>Synthetic contained capture</title>');
    const page = await openComposition(directory, { ownedBrowser: true, signal: testDeadline.signal });
    try {
      await expect((async () => {
        await page.evaluate("fetch('https://example.invalid/refused').catch(() => null)");
        page.check();
      })()).rejects.toThrow(/Refused composition request/);
    } finally { await page.close(); }
    expect(browser.isConnected()).toBe(true);
    const untouched = await browser.newPage();
    expect(await untouched.evaluate(() => 6 * 7)).toBe(42);
    await untouched.close();
  }, 30000);

  it('fails the capture with a clear error when a document still uploads tainted pixels to WebGL (#10594)', async () => {
    const { openComposition } = await import('../htmlComposition/browser.js');
    const directory = 'compositions/synthetic-tainted-texture';
    await mkdir(join(PATHS.data, directory), { recursive: true });
    await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 255, g: 0, b: 0 } } }).jpeg().toFile(join(PATHS.data, directory, 'still.jpg'));
    await writeFile(join(PATHS.data, directory, 'index.html'), '<!doctype html><title>Synthetic tainted texture</title>');
    const page = await openComposition(directory, { ownedBrowser: true, signal: testDeadline.signal });
    try {
      // Opting the image back out of CORS taints the canvas; the upload error
      // is swallowed here exactly as three.js swallows it.
      await expect((async () => {
        await page.evaluate(`(async () => {
          const image = new Image();
          image.src = 'still.jpg';
          image.removeAttribute('crossorigin');
          await image.decode();
          const source = document.createElement('canvas');
          source.getContext('2d').drawImage(image, 0, 0);
          const gl = document.createElement('canvas').getContext('webgl2');
          gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
          try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); } catch {}
        })()`);
        page.check();
      })()).rejects.toThrow(/cross-origin pixels into a WebGL texture.*Tainted canvases/);
    } finally { await page.close(); }
  }, 30000);

  it('lets a composition upload its own images to WebGL through a 2D canvas', async () => {
    const { openComposition } = await import('../htmlComposition/browser.js');
    const directory = 'compositions/synthetic-canvas-texture';
    await mkdir(join(PATHS.data, directory, 'media'), { recursive: true });
    await writeFile(join(PATHS.data, directory, 'media/still.jpg'),
      await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).jpeg().toBuffer());
    await writeFile(join(PATHS.data, directory, 'index.html'), '<!doctype html><title>Canvas texture</title>');
    const page = await openComposition(directory, { ownedBrowser: true, signal: testDeadline.signal });
    try {
      // The sandboxed page has an opaque origin; an image loaded without CORS
      // would taint the canvas and texImage2D would throw a SecurityError.
      const outcome = await page.evaluate(`new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 8;
          canvas.getContext('2d').drawImage(img, 0, 0);
          const gl = document.createElement('canvas').getContext('webgl');
          try {
            gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
            resolve(gl.getError() === gl.NO_ERROR ? 'uploaded' : 'gl-error');
          } catch (error) { resolve(error.name); }
        };
        img.onerror = () => resolve('image-failed');
        img.src = 'media/still.jpg';
      })`);
      expect(outcome).toBe('uploaded');
    } finally { await page.close(); }
  }, 30000);

  it('revokes idle preview media past the budget, keeps what a media element still plays, and asks again on reuse', async () => {
    const created = await projects.createProject({ name: 'Synthetic bridge budget' });
    await projects.mutateProjectRecord(created.id, (current) => ({ project: { ...current,
      audioAnalysis: { durationSec: 1, beats: [0], downbeats: [0], sections: [{ id: 'song', label: 'Verse', startSec: 0, endSec: 1 }] },
      composition: { mode: 'document' },
      scenes: [{ sceneId: 'card', startSec: 0, endSec: 1, visualLayer: 'card', cardText: '' }],
    } }));
    await importDocumentTemplate(created.id);
    const page = await browser.newPage();
    await page.setContent((await buildDocumentPreview(await projects.getProject(created.id))).html);
    const result = await page.evaluate(async (size) => {
      const requested = [];
      const revoked = [];
      const revoke = URL.revokeObjectURL;
      URL.revokeObjectURL = (url) => { revoked.push(url); revoke(url); };
      // Idle time is read from performance.now, so the test moves the clock instead of sleeping.
      const now = performance.now.bind(performance);
      let offset = 0;
      performance.now = () => now() + offset;
      addEventListener('message', ({ data }) => {
        if (data?.type !== 'portos-mv:request') return;
        requested.push(data.key);
        postMessage({ type: 'portos-mv:asset', key: data.key, blob: new Blob([new Uint8Array(size)]) }, '*');
      });
      postMessage({ type: 'portos-mv:manifest', keys: ['media/clip.webm', 'media/a.jpg', 'media/b.jpg'] }, '*');
      const video = document.createElement('video');
      video.src = 'media/clip.webm';
      while (!video.getAttribute('src')?.startsWith('blob:')) await new Promise((resolve) => setTimeout(resolve, 10));
      const first = await window.PORTOS_MV_ASSET('media/a.jpg');
      const again = await window.PORTOS_MV_ASSET('media/a.jpg');
      offset += 60000;
      await window.PORTOS_MV_ASSET('media/b.jpg'); // three files now exceed the budget
      const reused = await window.PORTOS_MV_ASSET('media/a.jpg');
      return { requested, revoked, first, again, reused, video: video.getAttribute('src') };
    }, Math.ceil(PREVIEW_MEDIA_BUDGET_BYTES * 0.6));
    await page.close();
    expect(result.again).toBe(result.first);
    // The idle file goes; the clip a <video> still points at stays though it is older.
    expect(result.revoked).toEqual([result.first]);
    expect(result.revoked).not.toContain(result.video);
    expect(result.requested).toEqual(['media/clip.webm', 'media/a.jpg', 'media/b.jpg', 'media/a.jpg']);
    expect(result.reused).toMatch(/^blob:/);
    expect(result.reused).not.toBe(result.first);
  }, 30000);

  it('lets img.decode() and complete wait for a bridged src instead of rejecting on an unset image', async () => {
    const created = await projects.createProject({ name: 'Synthetic bridge decode' });
    await projects.mutateProjectRecord(created.id, (current) => ({ project: { ...current,
      audioAnalysis: { durationSec: 1, beats: [0], downbeats: [0], sections: [{ id: 'song', label: 'Verse', startSec: 0, endSec: 1 }] },
      composition: { mode: 'document' },
      scenes: [{ sceneId: 'card', startSec: 0, endSec: 1, visualLayer: 'card', cardText: '' }],
    } }));
    await importDocumentTemplate(created.id);
    const page = await browser.newPage();
    await page.setContent((await buildDocumentPreview(await projects.getProject(created.id))).html);
    const result = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 2;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      addEventListener('message', ({ data }) => {
        if (data?.type !== 'portos-mv:request') return;
        setTimeout(() => postMessage({ type: 'portos-mv:asset', key: data.key, blob }, '*'), 50);
      });
      postMessage({ type: 'portos-mv:manifest', keys: ['media/a.png'] }, '*');
      const img = new Image();
      img.src = 'media/a.png';
      const pendingComplete = img.complete;
      await img.decode();
      return { pendingComplete, complete: img.complete, src: img.src.slice(0, 5), width: img.naturalWidth };
    });
    await page.close();
    expect(result).toEqual({ pendingComplete: false, complete: true, src: 'blob:', width: 2 });
  }, 30000);

  it('propagates a deadline through a pending seek and waits for owned Chrome cleanup', async () => {
    const directory = 'music-video/mv-cancel/composition/doc-cancel';
    await mkdir(join(PATHS.data, directory), { recursive: true });
    await mkdir(PATHS.music, { recursive: true });
    await mkdir(PATHS.videos, { recursive: true });
    await writeFile(join(PATHS.data, directory, 'index.html'), '<!doctype html><style>body{margin:0;background:#123456}</style><script>window.portosComposition={durationSec:2,fps:12,width:1280,height:720,seek:t=>t>0?new Promise(()=>{}):undefined};</script>');
    const master = join(PATHS.music, 'cancel.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', master]);
    const project = { id: 'mv-cancel', name: 'Synthetic cancellation', scenes: [], audioAnalysis: { durationSec: 2, sections: [] }, composition: { mode: 'document', document: { directory } } };
    const outputPath = join(PATHS.videos, 'cancel.mp4');
    const controller = new AbortController();
    const before = ownedChildren.length;
    const originalSignal = testDeadline.signal;
    testDeadline.signal = AbortSignal.any([originalSignal, controller.signal]);
    try {
      // Start the next seek before the injected test deadline fires. It never
      // resolves: cancellation must reach the outer browser, not only ffmpeg.
      await expect(encodeDocumentComposition({ project, plan: await prepareDocumentRender(project), jobId: 'cancel-proof', audioPath: master, outputPath,
        onProgress: () => queueMicrotask(() => controller.abort(new Error('Synthetic capture deadline'))),
      })).rejects.toThrow('Synthetic capture deadline');
    } finally { testDeadline.signal = originalSignal; }
    expect(ownedChildren).toHaveLength(before + 1);
    const owned = ownedChildren.at(-1);
    expect(owned.closed).toBe(true);
    expect(existsSync(owned.profile)).toBe(false);
    expect(existsSync(`${outputPath}.silent.mp4`)).toBe(false);
    expect(browser.isConnected()).toBe(true);
  }, 30000);

  const threeIt = existsSync(new URL('../../../client/node_modules/three/package.json', import.meta.url)) ? it : vitestIt.skip;
  threeIt('uploads document images and footage drawn to a 2D canvas as a WebGL texture in an excerpt (#10594)', async () => {
    // A hand-authored document, not the shipped template: plain new Image(),
    // markup <img> and <video> sources with no crossorigin attribute, drawn to
    // a 2D canvas that three.js uploads as a CanvasTexture on a full-frame quad.
    const directory = 'music-video/mv-canvas-texture/composition/doc-canvas-texture';
    const dir = join(PATHS.data, directory);
    await mkdir(join(dir, 'media'), { recursive: true });
    await mkdir(join(dir, 'vendor'), { recursive: true });
    await mkdir(PATHS.music, { recursive: true });
    await mkdir(PATHS.videos, { recursive: true });
    const tile = (r, g, b) => sharp({ create: { width: 64, height: 64, channels: 3, background: { r, g, b } } }).jpeg();
    await tile(255, 128, 0).toFile(join(dir, 'media', 'scripted.jpg'));
    await tile(0, 200, 0).toFile(join(dir, 'media', 'markup.jpg'));
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=12:d=1', '-c:v', 'libvpx', '-b:v', '200k', join(dir, 'media', 'clip.webm')]);
    const three = dirname(createRequire(new URL('../../../client/package.json', import.meta.url)).resolve('three'));
    for (const name of ['three.module.js', 'three.core.js']) await copyFile(join(three, name), join(dir, 'vendor', name));
    await writeFile(join(dir, 'index.html'), `<!doctype html><style>html,body{margin:0;background:#000}canvas{display:block}</style>
      <img id="markup" src="media/markup.jpg" style="display:none">
      <script type="module">
        import * as THREE from './vendor/three.module.js';
        const scripted = new Image();
        scripted.src = 'media/scripted.jpg';
        const clip = document.createElement('video');
        clip.muted = true; clip.preload = 'auto'; clip.src = 'media/clip.webm';
        const clipReady = new Promise((resolve, reject) => { clip.onloadeddata = resolve; clip.onerror = () => reject(new Error('clip failed')); });
        const source = document.createElement('canvas'); source.width = 192; source.height = 64;
        const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true });
        renderer.setSize(1280, 720, false);
        document.body.append(renderer.domElement);
        const texture = new THREE.CanvasTexture(source);
        const scene = new THREE.Scene();
        scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: texture })));
        const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        window.portosComposition = { durationSec: 1, fps: 12, width: 1280, height: 720, seek: async () => {
          await Promise.all([scripted.decode(), document.getElementById('markup').decode(), clipReady]);
          const ctx = source.getContext('2d');
          ctx.drawImage(scripted, 0, 0, 64, 64);
          ctx.drawImage(document.getElementById('markup'), 64, 0, 64, 64);
          ctx.drawImage(clip, 128, 0, 64, 64);
          texture.needsUpdate = true;
          renderer.render(scene, camera);
        } };
      </script>`);
    const master = join(PATHS.music, 'canvas-texture.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', master]);
    const project = { id: 'mv-canvas-texture', name: 'Synthetic canvas texture', scenes: [], audioAnalysis: { durationSec: 1, sections: [] }, composition: { mode: 'document', document: { directory } } };
    const outputPath = join(PATHS.videos, 'canvas-texture.mp4');
    await encodeDocumentComposition({ project, plan: await prepareDocumentRender(project), jobId: 'canvas-texture', audioPath: master, outputPath, windowStart: 0.25, windowEnd: 0.5 });
    const frame = execFileSync(ffmpeg, ['-v', 'error', '-i', outputPath, '-frames:v', '1', '-vf', 'scale=96:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const at = (x) => [...frame.subarray((18 * 96 + x) * 3, (18 * 96 + x) * 3 + 3)];
    const [orange, green, blue] = [at(16), at(48), at(80)];
    expect(orange[0], `scripted image ${orange}`).toBeGreaterThan(200);
    expect(orange[0], `scripted image ${orange}`).toBeGreaterThan(orange[2] + 120);
    expect(green[1], `markup image ${green}`).toBeGreaterThan(green[0] + 100);
    expect(blue[2], `video frame ${blue}`).toBeGreaterThan(blue[0] + 100);
    await rm(outputPath, { force: true });
  }, 60000);
});
