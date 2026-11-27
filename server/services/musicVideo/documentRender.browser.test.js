import { describe, expect, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { browserSuiteCanRun } from '../../lib/browserSuiteGate.js';
import { mockNoPeers } from '../../lib/mockPathsDataRoot.js';
import {
  browser, buildDocumentPreview, cleanupTempDataRoots, encodeDocumentComposition, ffmpeg, importDocumentTemplate, it, mockCaptureBrowserService, near,
  PATHS, prepareDocumentRender, prerequisites, projects, refuseCompositionVideoPublication, useDocumentRenderBrowserFixture,
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
});
