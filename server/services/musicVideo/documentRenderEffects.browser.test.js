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

const canRun = browserSuiteCanRun('documentRenderEffects browser suite', prerequisites, { onUnavailable: cleanupTempDataRoots });

describe.skipIf(!canRun)('document render effects with real Chrome and ffmpeg', () => {
  useDocumentRenderBrowserFixture();

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
});
