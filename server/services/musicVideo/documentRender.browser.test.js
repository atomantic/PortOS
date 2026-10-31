import { richSceneSource } from './__richSceneFixture.js';
import { _withTestPreviewLoadDiagnostics } from './testPreviewLoadDiagnostics.js';
/**
 * The shipped layered template with real Chrome and ffmpeg: an excerpt of a
 * composition-document project seeks the selected take's <video> on SONG time
 * (streamed to the page by byte range), renders frame-for-frame identically
 * every time, and carries the master song. Skips without Chrome or ffmpeg.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy, ownTestBodies } from '../../lib/mockPathsDataRoot.js';
import { browserSuiteCanRun, chromeWithH264, resolveTestChrome } from '../../lib/browserSuiteGate.js';

const { it, drain } = ownTestBodies(vitestIt);
const lifecycle = vi.hoisted(() => ({ diagnostics: null, chromeProcess: null, fixtureWritersSettled: false }));
vi.mock('node:fs/promises', async original => {
  const actual = await original();
  return { ...actual, rm: (...args) => lifecycle.diagnostics
    ? lifecycle.diagnostics.remove(actual.rm, ...args) : actual.rm(...args) };
});
vi.mock('../../lib/childProcess.js', async original => {
  const actual = await original();
  return { ...actual, spawn(...args) {
    const child = actual.spawn(...args);
    lifecycle.diagnostics?.track(child, args[1]);
    return child;
  } };
});
const { createOwnedBrowserDiagnostics } = await import('../../test/ownedBrowserDiagnostics.js');
lifecycle.diagnostics = createOwnedBrowserDiagnostics();
const ownedChildren = lifecycle.diagnostics.children;

// This suite measures encoder pixels; the actual operator boundary is exercised in musicVideoProductionReview.browser.test.js.
vi.mock('./productionReview.js', async original => ({ ...await original(), assertProductionApproval: () => {} }));

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
vi.mock('../browserService.js', () => ({ loadConfig: async () => ({ chromePath: chrome }), cdpRequest: vi.fn((path) => fetch(`${endpoint}${path}`)) }));
vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-document-browser-'),
}));

const { findFfmpeg } = await import('../../lib/ffmpeg.js');
const { _cleanupTestBrowser, _createTestArtifactsRoot, _waitForTestChrome, _testBrowserCleanupSettled, _testChromeCaptureArgs } = await import('../htmlComposition/testBrowserCleanup.js');

afterAll(() => {
  lifecycle.diagnostics.dispose();
  if (!lifecycle.chromeProcess || (lifecycle.fixtureWritersSettled && _testBrowserCleanupSettled(lifecycle.chromeProcess))) cleanupTempDataRoots();
});

const chrome = resolveTestChrome();
const ffmpeg = await findFfmpeg();
// Imported discovery helpers can initialize mocked paths even on a skip.
const canRun = browserSuiteCanRun('documentRender browser suite', { 'Chrome with H.264': await chromeWithH264(chrome), ffmpeg }, { onUnavailable: cleanupTempDataRoots });

describe.skipIf(!canRun)('layered template with real Chrome and ffmpeg', () => {
  let proc;
  let browser;
  let artifacts;
  const detachedChromeProcessGroupId = () => process.platform === 'win32' ? undefined : proc?.pid;
  let closingFixture;
  const closeFixture = () => closingFixture ??= _cleanupTestBrowser({ browser, proc, artifacts, cleanup: () => {}, detachedProcessGroupId: detachedChromeProcessGroupId() });
  let PATHS, encodeDocumentComposition, prepareDocumentRender, documentRenderClock, importDocumentTemplate;
  let generateMixedMediaDocument, regenerateMixedMediaSection, acceptMixedMediaDocument, buildDocumentPreview, PREVIEW_MEDIA_BUDGET_BYTES, projects;
  beforeAll(async () => {
    // Keep collection read-only when Chrome/ffmpeg prerequisites skip the suite.
    ({ PATHS } = await import('../../lib/paths.js'));
    const renderer = await import('./documentRender.js');
    ({ prepareDocumentRender, documentRenderClock } = renderer);
    // The test deadline owns staging, Chrome, capture and muxing together.
    // An encoder-only signal leaves Chrome alive when Vitest times out.
    encodeDocumentComposition = options => renderer.encodeDocumentComposition({
      ...options, signal: AbortSignal.any([options.signal, testSignal].filter(Boolean)),
    });
    ({ importDocumentTemplate } = await import('./compositionDocument.js'));
    ({ generateMixedMediaDocument, regenerateMixedMediaSection, acceptMixedMediaDocument } = await import('./documentGeneration.js'));
    ({ buildDocumentPreview, PREVIEW_MEDIA_BUDGET_BYTES } = await import('./documentPreview.js'));
    projects = await import('./projects.js');
    const profile = join(PATHS.data, 'chrome-test-profile');
    proc = spawn(chrome, _testChromeCaptureArgs(profile), { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
    lifecycle.chromeProcess = proc;
    lifecycle.fixtureWritersSettled = false;
    const ws = await _waitForTestChrome(proc);
    endpoint = new URL(ws).origin.replace('ws:', 'http:');
    artifacts = _createTestArtifactsRoot();
    browser = await chromium.connectOverCDP(endpoint, { artifactsDir: artifacts.path });
  }, 30000);
  afterAll(async () => {
    try {
      await drain();
      for (const owned of ownedChildren) {
        expect(owned.closed, `owned capture child closed before fixture teardown; ${lifecycle.diagnostics.describe(owned)}`).toBe(true);
        expect(existsSync(owned.profile), `owned capture profile removed before fixture teardown; ${lifecycle.diagnostics.describe(owned)}`).toBe(false);
      }
      lifecycle.fixtureWritersSettled = true;
    } finally { await closeFixture(); }
  }, 35000);

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

  it('keeps network refusal inside the owned capture browser and leaves the browsing session alive', async () => {
    const { openComposition } = await import('../htmlComposition/browser.js');
    const directory = 'compositions/synthetic-owned-refusal';
    await mkdir(join(PATHS.data, directory), { recursive: true });
    await writeFile(join(PATHS.data, directory, 'index.html'), '<!doctype html><title>Synthetic contained capture</title>');
    const page = await openComposition(directory, { ownedBrowser: true, signal: testSignal });
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
    const page = await openComposition(directory, { ownedBrowser: true, signal: testSignal });
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
    const page = await openComposition(directory, { ownedBrowser: true, signal: testSignal });
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

  // Server-only CI does not install client dependencies; the full local install
  // exercises this cross-workspace package/render contract alongside the UI proof.
  const threeIt = existsSync(new URL('../../../client/node_modules/three/package.json', import.meta.url)) ? it : vitestIt.skip;
  // Hosted coverage exercises the generated adapter and encoded content without
  // certifying live playback throughput or judging creative quality.
  threeIt('generates and exports a Three.js scene with visible authored content', async () => {
    const created = await projects.createProject({ name: 'Synthetic generated export', mediaMode: 'code-only' });
    await projects.mutateProjectRecord(created.id, current => ({ project: { ...current,
      audioAnalysis: { durationSec: 1, beats: [0], downbeats: [0], sections: [{ id: 'world', label: 'World', startSec: 0, endSec: 1 }] },
      composition: { mode: 'document', authoringRenderer: 'three' },
    } }));
    author.response = JSON.stringify({ sections: [{ id: 'world', source: `function render(ctx, env) {
      const { THREE, scene, camera } = ctx;
      camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0);
      scene.add(new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.MeshBasicMaterial({ color: 0xff0000 })));
    }` }] });
    try {
      const candidate = await generateMixedMediaDocument(created.id, { providerId: 'stub-provider' });
      await acceptMixedMediaDocument(created.id, candidate.document.directory);
    } finally { author.response = null; }
    const project = await projects.getProject(created.id);
    await mkdir(PATHS.music, { recursive: true }); await mkdir(PATHS.videos, { recursive: true });
    const master = join(PATHS.music, 'generated-smoke.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', master]);
    const outputPath = join(PATHS.videos, 'generated-smoke.mp4');
    const result = await encodeDocumentComposition({ project, plan: await prepareDocumentRender(project),
      jobId: 'generated-smoke', audioPath: master, outputPath, windowStart: 0, windowEnd: 2/24 });
    expect(result).toMatchObject({ width: 1920, height: 1080, fps: 24 });
    const rendered = execFileSync(ffmpeg, ['-v', 'error', '-i', outputPath, '-frames:v', '1', '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const center = (18 * 64 + 32) * 3;
    expect(rendered[center]).toBeGreaterThan(150);
    expect(rendered[center + 1]).toBeLessThan(80);
    expect(rendered[center + 2]).toBeLessThan(80);
  }, 60000);

  threeIt('[fidelity] [local-performance] authors a local Three.js world and renders the same deterministic scene through module preview and export', async ({ signal }) => {
    let bodyError;
    let page;
    const abort = () => {
      // The cached verdict is awaited below and by suite teardown. Termination
      // must begin before drain can wait on a blocked renderer evaluation.
      closeFixture().catch(() => {});
    };
    const newPage = async options => {
      signal.throwIfAborted();
      const page = await browser.newPage(options);
      if (signal.aborted) { await closeFixture(); signal.throwIfAborted(); }
      return page;
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
    signal.throwIfAborted();
    const created = await projects.createProject({ name: 'Synthetic authored world', mediaMode: 'code-only' });
    await projects.mutateProjectRecord(created.id, (current) => ({ project: { ...current,
      audioAnalysis: { durationSec: 1, beats: [0, 0.5], downbeats: [0], sections: [{ id: 'world', label: 'World', startSec: 0, endSec: 1 }] },
      lyricCues: [{ id: 'line', text: 'EXAMPLE LYRIC', startSec: 0, endSec: 1, words: [{ w: 'EXAMPLE', startSec: 0 }, { w: 'LYRIC', startSec: 0.5 }] }],
      composition: { mode: 'document', authoringRenderer: 'three' },
    } }));
    author.response = JSON.stringify({ sections: [{ id: 'world', source: richSceneSource }] });
    const candidate = await generateMixedMediaDocument(created.id, { providerId: 'stub-provider' });
    await acceptMixedMediaDocument(created.id, candidate.document.directory);
    author.response = null;
    const project = await projects.getProject(created.id);
    const preview = await buildDocumentPreview(project);
    expect(preview.assets).toEqual([]);
    expect(preview.html).toContain("img-src 'none'");
    const { readDocumentFiles } = await import('./compositionDocument.js');
    const referenceFiles = await readDocumentFiles(project);
    referenceFiles.set('engine.js', referenceFiles.get('engine-reference.js'));
    // Keep only one eager WebGL world alive: retain the reference pixels, then
    // retire its page before creating the generated preview in the same browser.
    const referenceFrames = [];
    let portrait;
    const reference = await newPage({ viewport: { width: 1920, height: 1080 } });
    try {
      await _withTestPreviewLoadDiagnostics(reference, async markReadiness => {
        await reference.setContent((await buildDocumentPreview(project, { files: referenceFiles })).html);
        markReadiness();
        await reference.waitForFunction(() => typeof window.portosComposition?.seek === 'function');
      });
      await reference.evaluate(() => {
        window.priorThreeEvents = window.PORTOS_MV.song.narrativeEvents;
        window.PORTOS_MV.song.narrativeEvents = [{ kind: 'silence', startFrame: 5, endFrame: 9 }];
      });
      for (const t of [0, 0.03125, 0.25, 0.5, 0.03125]) {
        const pixels = await reference.evaluate(async t => {
          await window.portosComposition.seek(t);
          return { world: document.getElementById('world').toDataURL(), type: document.getElementById('type').toDataURL() };
        }, t);
        referenceFrames.push({ t, pixels });
      }
      await reference.evaluate(() => window.portosComposition.layout({ width: 1080, height: 1920 }));
      portrait = await reference.evaluate(async () => {
        await window.portosComposition.seek(0.03125);
        return { world: document.getElementById('world').toDataURL(), type: document.getElementById('type').toDataURL() };
      });
      await reference.evaluate(() => {
        window.PORTOS_MV.song.narrativeEvents = window.priorThreeEvents;
        window.portosComposition.layout({ width: 1920, height: 1080 });
      });
    } finally { await reference.close(); }
    page = await newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    const warnings = []; page.on('console', (message) => { if (message.type() === 'warning') warnings.push(message.text()); });
    await page.evaluate(() => {
      const live = new Set();
      const create = WebGL2RenderingContext.prototype.createTexture;
      const remove = WebGL2RenderingContext.prototype.deleteTexture;
      WebGL2RenderingContext.prototype.createTexture = function (...args) { const value = create.apply(this, args); live.add(value); return value; };
      WebGL2RenderingContext.prototype.deleteTexture = function (value) { live.delete(value); return remove.call(this, value); };
      window.liveTextureCount = () => live.size;
    });
    await _withTestPreviewLoadDiagnostics(page, async markReadiness => {
      await page.setContent(preview.html);
      markReadiness();
      await page.waitForFunction(() => typeof window.portosComposition?.seek === 'function');
    });
    const transports = await page.evaluate(() => ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport'].map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
      let message; try { new globalThis[key](); } catch (error) { message = error.message; }
      return { key, configurable: descriptor.configurable, writable: descriptor.writable, message };
    }));
    expect(transports).toEqual(['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport'].map(key => ({ key, configurable: false, writable: false, message: `${key} is disabled in compositions` })));
    const at = (t) => page.evaluate(async (t) => {
      await window.portosComposition.seek(t);
      return { world: document.getElementById('world').toDataURL(), type: document.getElementById('type').toDataURL() };
    }, t);
    await page.evaluate(() => {
      window.priorThreeEvents = window.PORTOS_MV.song.narrativeEvents;
      window.PORTOS_MV.song.narrativeEvents = [{ kind: 'silence', startFrame: 5, endFrame: 9 }];
    });
    for (const { t, pixels } of referenceFrames) expect(await at(t)).toEqual(pixels);
    await page.evaluate(() => window.portosComposition.layout({ width: 1080, height: 1920 }));
    expect(await at(0.03125)).toEqual(portrait);
    await page.evaluate(() => {
      window.PORTOS_MV.song.narrativeEvents = window.priorThreeEvents;
      window.portosComposition.layout({ width: 1920, height: 1080 });
    });
    const live = await page.evaluate(async () => {
      const api = window.portosComposition.previewPlayback;
      const times = [], failures = [];
      const original = window.PORTOS_MV_GENERATED.sections.world;
      const receive = ({ data }) => { if (data?.type === 'portos-mv:playback-error') failures.push(data.message); };
      addEventListener('message', receive);
      window.PORTOS_MV_GENERATED.sections.world = (ctx, env) => { times.push(env.t); return original(ctx, env); };
      try {
        const prepared = await api.prepare({ epoch: 1, sequence: 1, t: 0 });
        const played = await api.play({ epoch: 1, sequence: 2, t: 0, workerTime: api.clock() });
        for (let i = 0; i < 8; i++) await new Promise(resolve => requestAnimationFrame(resolve));
        await api.pause({ epoch: 2, t: 0 });
        return { prepared, played, times, failures };
      } finally { window.PORTOS_MV_GENERATED.sections.world = original; removeEventListener('message', receive); }
    });
    expect(live.prepared.status).toBe('prepared');
    expect(live.played.status).toBe('playing');
    expect(live.failures).toEqual([]);
    expect(new Set(live.times).size).toBeGreaterThan(1);
    const beforeCancel = await at(0);
    await page.evaluate(() => {
      window.originalTitleReady = window.__portosTitleCard.ready;
      window.__portosTitleCard.ready = () => new Promise(resolve => { window.releaseThreeTitle = resolve; });
      window.pendingThreeExact = window.portosComposition.seek(0.75);
    });
    try {
      await page.waitForFunction(() => typeof window.releaseThreeTitle === 'function');
      expect(await page.evaluate(() => ({ world: document.getElementById('world').toDataURL(), type: document.getElementById('type').toDataURL() }))).toEqual(beforeCancel);
      await page.evaluate(async () => {
        const paused = window.portosComposition.previewPlayback.pause({ epoch: 3, t: 0 });
        window.releaseThreeTitle();
        await Promise.all([paused, window.pendingThreeExact]);
      });
      expect(await page.evaluate(() => ({ world: document.getElementById('world').toDataURL(), type: document.getElementById('type').toDataURL() }))).toEqual(beforeCancel);
    } finally {
      if (!signal.aborted && !page.isClosed()) await page.evaluate(async () => {
        window.releaseThreeTitle?.();
        await window.pendingThreeExact;
        window.__portosTitleCard.ready = window.originalTitleReady;
      });
    }
    const first = await at(0);
    const pixels = await sharp(Buffer.from(first.world.split(',')[1], 'base64')).resize(64,36).removeAlpha().raw().toBuffer();
    const textures = await page.evaluate(() => window.liveTextureCount());
    const moved = await at(0.5);
    expect(moved.world).not.toBe(first.world);
    expect(await at(0)).toEqual(first);
    expect(await page.evaluate(() => window.liveTextureCount())).toBe(textures);
    expect(errors).toEqual([]);
    // ctx.lens drives the host post stack: a wide aperture focused in front of
    // the character softens every edge without allocating new GPU textures.
    const edgeEnergy = () => page.evaluate(async () => {
      await window.portosComposition.seek(0);
      const probe = document.createElement('canvas'); probe.width = 480; probe.height = 270;
      const g = probe.getContext('2d'); g.drawImage(document.getElementById('world'), 0, 0, 480, 270);
      const { data } = g.getImageData(0, 0, 480, 270);
      let sum = 0; for (let i = 4; i < data.length; i += 4) sum += Math.abs(data[i] - data[i - 4]);
      return sum;
    });
    const withLens = (lens) => page.evaluate((lens) => {
      window.authoredWorld ??= window.PORTOS_MV_GENERATED.sections.world;
      window.PORTOS_MV_GENERATED.sections.world = (ctx, env) => { window.authoredWorld(ctx, env); Object.assign(ctx.lens, lens); };
    }, lens);
    await withLens({ grain: 0 });
    const focused = await edgeEnergy();
    await withLens({ grain: 0, focus: 1, aperture: 24, maxBlur: 24 });
    expect(await edgeEnergy()).toBeLessThan(focused * 0.8);
    // A Vector3 focus is view-space depth, not straight-line distance from the
    // camera's local position: an off-axis head seen through a rig-parented
    // camera stays as sharp as with no depth of field at all.
    // focus 'card' passes the Vector3; 'local' passes the straight-line distance
    // from the camera's local position, the depth the old code used.
    const headSharpness = (focusOn) => page.evaluate(async (focusOn) => {
      window.PORTOS_MV_GENERATED.sections.world = (ctx, env) => {
        window.authoredWorld(ctx, env);
        const { THREE, scene, camera } = ctx;
        const rig = new THREE.Group(); rig.position.set(2.5, 0, 8); scene.add(rig); rig.add(camera);
        // A striped target card at the focus point: its edges blur visibly if
        // the focal plane misses it.
        const head = new THREE.Vector3(0, 2.2, 0.6);
        // No manual matrix update: the engine must resolve the rig itself.
        const at = camera.position.clone().add(rig.position);
        const card = new THREE.Group(); card.position.copy(head); scene.add(card);
        card.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x000000 })));
        for (let i = -2; i <= 2; i++) { const bar = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 1), new THREE.MeshBasicMaterial({ color: 0xffffff })); bar.position.set(i * 0.18, 0, 0.001); card.add(bar); }
        card.lookAt(at);
        Object.assign(ctx.lens, { focus: focusOn === 'card' ? head : head.distanceTo(camera.position), aperture: 24, maxBlur: 32 });
        window.projectHead = () => head.clone().project(camera);
      };
      await window.portosComposition.seek(0);
      // The render has refreshed every matrix, so the projection is exact here.
      window.headOnScreen = window.projectHead();
      const world = document.getElementById('world');
      const x = Math.round((window.headOnScreen.x + 1) / 2 * world.width) - 40, y = Math.round((1 - window.headOnScreen.y) / 2 * world.height) - 40;
      const probe = document.createElement('canvas'); probe.width = 80; probe.height = 80;
      const g = probe.getContext('2d'); g.drawImage(world, x, y, 80, 80, 0, 0, 80, 80);
      const { data } = g.getImageData(0, 0, 80, 80);
      let sum = 0; for (let i = 4; i < data.length; i += 4) sum += Math.abs(data[i] - data[i - 4]);
      return { sum, offAxis: Math.abs(window.headOnScreen.x) };
    }, focusOn);
    const focusedHead = await headSharpness('card');
    const missedHead = await headSharpness('local');
    expect(focusedHead.offAxis).toBeGreaterThan(0.1);
    expect(focusedHead.sum).toBeGreaterThan(missedHead.sum * 1.5);
    expect(await page.evaluate(() => window.liveTextureCount())).toBe(textures);
    expect(warnings.filter((text) => text.includes('PCFSoftShadowMap'))).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
    signal.throwIfAborted();
    await mkdir(PATHS.music, { recursive: true }); await mkdir(PATHS.videos, { recursive: true });
    const master = join(PATHS.music, 'world.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', master]);
    const outputPath = join(PATHS.videos, 'world.mp4');
    const result = await encodeDocumentComposition({ project, plan: await prepareDocumentRender(project), jobId: 'world-proof', audioPath: master, outputPath, windowStart: 0, windowEnd: 2/24 });
    expect(result).toMatchObject({ width: 1920, height: 1080, fps: 24 });
    const rendered = execFileSync(ffmpeg, ['-v', 'error', '-i', outputPath, '-frames:v', '1', '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    expect(rendered.reduce((sum, v, i) => sum + Math.abs(v-pixels[i]), 0) / pixels.length).toBeLessThan(15);
    } catch (error) {
      bodyError = error;
      throw error;
    } finally {
      const cleanupErrors = [];
      try {
        if (!signal.aborted && page && !page.isClosed()) await page.close().catch(error => cleanupErrors.push(error));
        // Keep the listener installed while ordinary page closure is pending.
        // If cancellation starts there, await its cached fixture verdict too.
        if (signal.aborted) await closeFixture().catch(error => cleanupErrors.push(error));
        if (cleanupErrors.length) throw new AggregateError([...(bodyError ? [bodyError] : []), ...cleanupErrors],
          'Three test or owned browser cleanup failed', { cause: bodyError ?? cleanupErrors[0] });
      } finally { signal.removeEventListener('abort', abort); }
    }
  }, 120000);

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

  it('keeps event frames identical across shuffled seeks, an excerpt and a full render, and freezes silence', async () => {
    const created = await projects.createProject({ name: 'Synthetic event proof' });
    const base = { durationSec: 0.2, narrativeFunction: 'Mark the story turn', mediumRationale: 'Exact code graphics' };
    await projects.mutateProjectRecord(created.id, (current) => ({ project: { ...current,
      audioAnalysis: { durationSec: 2, beats: [0, 0.5, 1, 1.5], downbeats: [0], sections: [{ id: 'song', label: 'Hook', startSec: 0, endSec: 2 }],
        features: { envelopes: { fps: 2, rms: [1, 1, 1, 1], low: [1, 1, 1, 1], mid: [0, 0, 0, 0], high: [0, 0, 0, 0] }, onsets: { low: [0.51], mid: [], high: [] } } },
      lyricCues: [{ id: 'line', text: 'UP', startSec: 0.8, words: [{ w: 'UP', startSec: 0.8 }] }],
      composition: { mode: 'document', reactiveSections: [{ sectionId: 'song', gain: 1, maxGain: 0.2 }], narrativeEvents: [
        { ...base, id: 'hit', name: 'Impact', kind: 'impact', text: 'TURN', anchor: { kind: 'onset', band: 'low', index: 0 } },
        { ...base, id: 'count', name: 'Count', kind: 'counter-change', fromValue: 0, toValue: 9, anchor: { kind: 'word', cueId: 'line', wordIndex: 0 } },
        { ...base, id: 'quiet', name: 'Quiet', kind: 'silence', durationSec: 0.4, anchor: { kind: 'time', atSec: 1 } },
        { ...base, id: 'quiet-more', name: 'Keep quiet', kind: 'silence', durationSec: 0.2, anchor: { kind: 'time', atSec: 1.25 } },
        { ...base, id: 'motif', name: 'Kite', kind: 'motif-transformation', before: 'Fold', after: 'Flight', anchor: { kind: 'time', atSec: 1.5 } },
        { ...base, id: 'reveal', name: 'Reveal', kind: 'reveal', anchor: { kind: 'time', atSec: 1.8 } },
      ] },
      scenes: [{ sceneId: 'card', startSec: 0, endSec: 2, visualLayer: 'card', cardText: '' }],
    } }));
    await importDocumentTemplate(created.id);
    const project = await projects.getProject(created.id);
    const preview = await buildDocumentPreview(project);
    const page = await browser.newPage();
    await page.setContent(preview.html);
    await page.evaluate(() => window.postMessage({ type: 'portos-mv:manifest', keys: [] }, '*'));
    const at = (frame) => page.evaluate(async (frame) => {
      await window.portosComposition.seek(frame / 24);
      return { pixels: document.getElementById('stage').toDataURL(), state: window.PORTOS_MV_EVENT_STATE(window.PORTOS_MV.song, frame / 24, 24) };
    }, frame);
    const hit = await at(13);
    expect(hit.state.activeEvents[0].id).toBe('hit');
    expect((await at(12)).state.activeEvents).toEqual([]);
    expect(hit.pixels).not.toBe((await at(12)).pixels);
    expect((await at(20)).state.activeEvents[0].id).toBe('count');
    expect((await at(36)).state.activeEvents[0].id).toBe('motif');
    expect((await at(44)).state.activeEvents[0].id).toBe('reveal');
    const held = await at(24);
    expect(held.state).toMatchObject({ hold: true, reactiveGain: 0, frame: 24 });
    expect((await at(30)).pixels).toBe(held.pixels);
    expect((await at(34)).pixels).toBe(held.pixels); // overlapping holds share one frozen frame
    expect((await at(13)).pixels).toBe(hit.pixels);
    expect(hit.state.reactiveGain).toBe(0.2);
    await page.close();

    await mkdir(PATHS.music, { recursive: true });
    await mkdir(PATHS.videos, { recursive: true });
    const master = join(PATHS.music, 'event-master.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', master]);
    const plan = { ...(await prepareDocumentRender(project)), frame: { width: 1280, height: 720 } };
    const full = join(PATHS.videos, 'event-full.mp4');
    const excerpt = join(PATHS.videos, 'event-excerpt.mp4');
    await encodeDocumentComposition({ project, plan, jobId: 'event-full', audioPath: master, outputPath: full });
    await encodeDocumentComposition({ project, plan, jobId: 'event-excerpt', audioPath: master, outputPath: excerpt, windowStart: 13 / 24, windowEnd: 18 / 24 });
    const pixels = (path) => execFileSync(ffmpeg, ['-v', 'error', '-i', path, '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 });
    const fullPixels = pixels(full); const excerptPixels = pixels(excerpt); const frameBytes = 64 * 36 * 3;
    expect(excerptPixels.length).toBe(frameBytes * 5);
    for (let frame = 0; frame < 5; frame++) {
      const expected = fullPixels.subarray((frame + 13) * frameBytes, (frame + 14) * frameBytes);
      const actual = excerptPixels.subarray(frame * frameBytes, (frame + 1) * frameBytes);
      const difference = actual.reduce((sum, value, i) => sum + Math.abs(value - expected[i]), 0) / frameBytes;
      expect(difference, `event frame ${frame + 13}`).toBeLessThan(5); // lossy encoder tolerance
    }
  }, 120000);

  // Uniquely catches correct timing metadata paired with an unretimed staged file.
  [
    { timing: { speedFps: 24, offsetFrames: 12 }, samples: [[0, 1], [5, 1], [6, 2]] },
    { timing: { speedFps: 24, offsetFrames: -6 }, samples: [[0, 0], [11, 0], [12, 1], [17, 1], [18, 2]] },
    { timing: { offsetFrames: -6 }, samples: [[0, 0], [17, 0], [18, 1], [29, 1], [30, 2]] },
  ].forEach(({ timing, samples }) => it(`renders shot speed and offset ${JSON.stringify(timing)} into the document pixels`, async () => {
    await mkdir(PATHS.videos, { recursive: true });
    await mkdir(PATHS.music, { recursive: true });
    const clip = join(PATHS.videos, 'timed-rgb.webm');
    execFileSync(ffmpeg, ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=64x36:r=24:d=0.5',
      '-f', 'lavfi', '-i', 'color=c=lime:s=64x36:r=24:d=0.5',
      '-f', 'lavfi', '-i', 'color=c=blue:s=64x36:r=24:d=0.5',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0', '-c:v', 'libvpx', clip]);
    const master = join(PATHS.music, 'timed-master.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1.5', master]);
    const created = await projects.createProject({ name: 'Synthetic shot timing' });
    await writeFile(join(PATHS.data, 'video-history.json'), JSON.stringify([{ id: 'vh-timed', filename: 'timed-rgb.webm', numFrames: 36, fps: 24, width: 64, height: 36 }]));
    await projects.mutateProjectRecord(created.id, current => ({ project: { ...current,
      audioAnalysis: { durationSec: 1.5, sections: [] },
      scenes: [{ sceneId: 'timed', startSec: 0, endSec: 1.5, videoHistoryId: 'vh-timed', ...timing }],
    } }));
    await importDocumentTemplate(created.id);
    const project = await projects.getProject(created.id);
    const outputPath = join(PATHS.videos, 'timed-output.mp4');
    await encodeDocumentComposition({ project, plan: await prepareDocumentRender(project), jobId: 'timed-pixels', audioPath: master, outputPath });
    const pixels = execFileSync(ffmpeg, ['-v', 'error', '-i', outputPath, '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    for (const [frame, channel] of samples) {
      const at = (frame * 64 * 36 + 18 * 64 + 32) * 3;
      const rgb = [...pixels.subarray(at, at + 3)];
      expect(rgb).toHaveLength(3);
      expect(rgb[channel], `frame ${frame}`).toBeGreaterThan(180);
      rgb.forEach((value, i) => { if (i !== channel) expect(value, `frame ${frame}`).toBeLessThan(60); });
    }
  }, 120000));

  // Uniquely catches the live preview bridging raw bytes without the shot's speed/offset (same samples as the render above).
  [
    { timing: { speedFps: 24, offsetFrames: 12 }, samples: [[0, 1], [5, 1], [6, 2]] },
    { timing: { speedFps: 24, offsetFrames: -6 }, samples: [[0, 0], [11, 0], [12, 1], [17, 1], [18, 2]] },
    { timing: { offsetFrames: -6 }, samples: [[0, 0], [17, 0], [18, 1], [29, 1], [30, 2]] },
  ].forEach(({ timing, samples }) => it(`plays shot speed and offset ${JSON.stringify(timing)} in the live preview`, async () => {
    await mkdir(PATHS.videos, { recursive: true });
    const clip = join(PATHS.videos, 'live-timed-rgb.webm');
    execFileSync(ffmpeg, ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=64x36:r=24:d=0.5',
      '-f', 'lavfi', '-i', 'color=c=lime:s=64x36:r=24:d=0.5',
      '-f', 'lavfi', '-i', 'color=c=blue:s=64x36:r=24:d=0.5',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0', '-c:v', 'libvpx', clip]);
    const created = await projects.createProject({ name: 'Synthetic live shot timing' });
    await writeFile(join(PATHS.data, 'video-history.json'), JSON.stringify([{ id: 'vh-live', filename: 'live-timed-rgb.webm', numFrames: 36, fps: 24, width: 64, height: 36 }]));
    await projects.mutateProjectRecord(created.id, current => ({ project: { ...current,
      audioAnalysis: { durationSec: 1.5, sections: [] },
      scenes: [{ sceneId: 'timed', startSec: 0, endSec: 1.5, videoHistoryId: 'vh-live', ...timing }],
    } }));
    await importDocumentTemplate(created.id);
    const preview = await buildDocumentPreview(await projects.getProject(created.id));
    const page = await browser.newPage();
    await page.setContent(preview.html);
    const bytes = (await readFile(clip)).toString('base64');
    await page.evaluate(async (base64) => {
      const blob = new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'video/webm' });
      addEventListener('message', ({ data }) => { if (data?.type === 'portos-mv:request') postMessage({ type: 'portos-mv:asset', key: data.key, blob }, '*'); });
      postMessage({ type: 'portos-mv:manifest', keys: ['media/scene-timed.webm'] }, '*');
      await window.PORTOS_MV_ASSETS;
    }, bytes);
    for (const [frame, channel] of samples) {
      const rgb = await page.evaluate(async (frame) => {
        await window.portosComposition.seek(frame / 24);
        const stage = document.getElementById('stage');
        const probe = document.createElement('canvas'); probe.width = stage.width; probe.height = stage.height;
        const ctx = probe.getContext('2d'); ctx.drawImage(stage, 0, 0);
        return [...ctx.getImageData(stage.width >> 1, stage.height >> 1, 1, 1).data.slice(0, 3)];
      }, frame);
      expect(rgb[channel], `frame ${frame}`).toBeGreaterThan(180);
      rgb.forEach((value, i) => { if (i !== channel) expect(value, `frame ${frame}`).toBeLessThan(60); });
    }
    await page.close();
  }, 120000));

  it('draws the selected take at SONG time in an excerpt, identically on every render, with the master muxed', async () => {
    const { cdpRequest } = await import('../browserService.js');
    const managedCalls = cdpRequest.mock.calls.length;
    const unrelatedPage = await browser.newPage();
    await unrelatedPage.setContent('<title>Unrelated browser session</title>');
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
    await writeFile(join(PATHS.data, 'video-history.json'), JSON.stringify([{ id: 'vh-rgb', filename: 'rgb.webm', numFrames: 72, fps: 24, width: 640, height: 360 }]));
    await projects.mutateProjectRecord(created.id, (current) => ({ project: {
      ...current,
      audioAnalysis: { durationSec: 6, beats: [], downbeats: [], sections: [] },
      scenes: [{ sceneId: 'rgb', order: 0, startSec: 0, endSec: 3, videoHistoryId: 'vh-rgb' }],
    } }));
    await importDocumentTemplate(created.id);
    const project = await projects.getProject(created.id);
    const plan = await prepareDocumentRender(project);

    const render = async (name) => {
      const outputPath = join(PATHS.videos, name);
      const result = await encodeDocumentComposition({ project, plan, jobId: `job-${name.replace(/\W/g, '')}`, audioPath: master, outputPath, windowStart: 1.02, windowEnd: 1.75, collectFootageVisibility: true });
      return { result, outputPath };
    };
    const first = await render('first.mp4');
    // A virtual-origin clip must remain canvas-readable inside the opaque
    // browser sandbox; tainted pixels formerly collapsed every sample to null.
    expect(first.result.footageVisibility).toHaveLength(3);
    expect(first.result.footageVisibility.every(sample => sample.status === 'measured')).toBe(true);
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
    expect(cdpRequest.mock.calls.length).toBe(managedCalls);
    expect(await unrelatedPage.title()).toBe('Unrelated browser session');
    await unrelatedPage.close();
    const hashes = (path) => execFileSync(ffmpeg, ['-v', 'error', '-i', path, '-map', '0:v', '-f', 'framemd5', '-']).toString().split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim());
    expect(hashes(second.outputPath)).toEqual(hashes(first.outputPath));
    // The staged job folder is gone once the render ends.
    expect(existsSync(join(PATHS.data, 'music-video-song-renders', 'job-firstmp4'))).toBe(false);
    await rm(first.outputPath, { force: true });
    await rm(second.outputPath, { force: true });
  }, 120000);

  ['ramps', 'generated-shots'].forEach(fixture => it(`[fidelity] matches bounded grades across real composed/document ${fixture} and song-time excerpts`, async () => {
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
      <img id="reference" src="reference.png"><script>window.portosComposition={durationSec:1,fps:${fps},width:${width},height:${height},seek:async()=>{await document.getElementById('reference').decode()}};</script>`);
    const master = join(PATHS.music, 'grade.wav');
    // A 1s timeline (12 frames) keeps every behavior under test: three scenes
    // with distinct grades and a mid-song excerpt that crosses a scene cut.
    // Real Chrome capture costs ~250ms per 720p frame, so frame count is the
    // knob that keeps this far from the per-test limit on a loaded host (#10132).
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', master]);
    const source = join(PATHS.videos, 'grade-source.mkv');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-loop', '1', '-i', reference, '-t', '1', '-r', String(fps), '-c:v', 'ffv1', '-pix_fmt', 'yuv420p', source]);
    const scenes = [{ sceneId: 'a', startSec: 0, endSec: 0.5 }, { sceneId: 'b', startSec: 0.5, endSec: 0.75 }, { sceneId: 'c', startSec: 0.75, endSec: 1 }];
    const grade = { preset: 'teal-night', grain: 0.03, sections: [{ sceneId: 'b', preset: 'golden-hour' }, { sceneId: 'c', preset: 'monochrome' }] };
    const project = { id: 'mv-grade', name: 'Synthetic grade reference', scenes,
      audioAnalysis: { durationSec: 1, sections: [] }, composition: { mode: 'document', grade, document: { directory } } };
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
    expect(documentRgb.length).toBe(frameSize * fps);
    expect(composedRgb.length).toBe(documentRgb.length);
    const mae = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
    // Browser RGB and video YUV420 differ by conversion/subsampling and H.264
    // quantization; palette parity is bounded rather than falsely byte-exact.
    expect(mae(documentRgb, composedRgb)).toBeLessThan(5);
    const excerpt = join(PATHS.videos, 'grade-excerpt.mp4');
    await encodeDocumentComposition({ project, plan, jobId: 'grade-excerpt', audioPath: master, outputPath: excerpt, windowStart: 0.25, windowEnd: 0.75 });
    const excerptRgb = decode(excerpt);
    // Independently encoded H.264 portrait textures have more prediction error
    // than ramps. Retain the ramp's bound and use 3/255 for the new fixture;
    // the repeated excerpt below must still be decoded byte-identical.
    const excerptTolerance = fixture === 'ramps' ? 2 : 3;
    const excerptError = mae(excerptRgb, documentRgb.subarray(3 * frameSize, 9 * frameSize));
    expect(excerptError).toBeLessThan(excerptTolerance);
    const repeat = join(PATHS.videos, 'grade-repeat.mp4');
    await encodeDocumentComposition({ project, plan, jobId: 'grade-repeat', audioPath: master, outputPath: repeat, windowStart: 0.25, windowEnd: 0.75 });
    expect(decode(repeat).equals(excerptRgb)).toBe(true);
    const composedExcerpt = join(PATHS.videos, 'grade-composed-excerpt.mp4');
    execFileSync(ffmpeg, ['-v', 'error', ...buildMusicVideoFfmpegArgs(clips, master, composedExcerpt, {
      grade, frameGrid: true, excerpt: { startSec: 0.25, endSec: 0.75 },
    }).args], { stdio: 'pipe' });
    const composedExcerptError = mae(decode(composedExcerpt), composedRgb.subarray(3 * frameSize, 9 * frameSize));
    expect(composedExcerptError).toBeLessThan(excerptTolerance);
    let neutralExcerptError = null;
    if (fixture === 'generated-shots') {
      const neutralProject = { ...project, composition: { ...project.composition, grade: null } };
      const neutralFull = join(PATHS.videos, 'neutral-full.mp4');
      const neutralExcerpt = join(PATHS.videos, 'neutral-excerpt.mp4');
      await encodeDocumentComposition({ project: neutralProject, plan, jobId: 'neutral-full', audioPath: master, outputPath: neutralFull });
      await encodeDocumentComposition({ project: neutralProject, plan, jobId: 'neutral-excerpt', audioPath: master, outputPath: neutralExcerpt, windowStart: 0.25, windowEnd: 0.75 });
      neutralExcerptError = mae(decode(neutralExcerpt), decode(neutralFull).subarray(3 * frameSize, 9 * frameSize));
      expect(neutralExcerptError).toBeLessThan(3);
      // A codec baseline independently bounds the additional grading error,
      // rather than letting a textured fixture excuse arbitrary divergence.
      expect(excerptError).toBeLessThan(neutralExcerptError + 1);
    }
    const pixel = (rgb, frame, x, y) => [...rgb.subarray(frame * frameSize + (y * width + x) * 3, frame * frameSize + (y * width + x) * 3 + 3)];
    if (fixture === 'ramps') {
      const cool = pixel(documentRgb, 3, 640, 90);
      const warm = pixel(documentRgb, 6, 640, 90);
      const monochrome = pixel(documentRgb, 9, 640, 270);
      expect(Math.max(...monochrome) - Math.min(...monochrome)).toBeLessThan(4);
      expect(cool[2]).toBeGreaterThan(cool[0] + 15);
      expect(warm[0]).toBeGreaterThan(warm[2] + 15);
      expect(Math.max(...pixel(documentRgb, 3, 0, 90))).toBeLessThan(5);
      expect(Math.min(...pixel(documentRgb, 3, width - 1, 90))).toBeGreaterThan(248);
    }
    // Optional local proof export: only synthetic fixtures, never live records.
    if (process.env.PORTOS_GRADE_PROOF_DIR) {
      const proof = join(process.env.PORTOS_GRADE_PROOF_DIR, fixture);
      await mkdir(proof, { recursive: true });
      await copyFile(reference, join(proof, 'reference.png'));
      for (const [label, path] of [['document', document], ['composed', composed], ['excerpt', excerpt]]) {
        execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', path, '-vf', "select='eq(n,3)+eq(n,6)+eq(n,9)',scale=480:270,tile=3x1", '-frames:v', '1', join(proof, `${label}.png`)]);
      }
      await writeFile(join(proof, 'metrics.json'), JSON.stringify({ paletteMeanAbsoluteError: mae(documentRgb, composedRgb), excerptMeanAbsoluteError: excerptError, composedExcerptMeanAbsoluteError: composedExcerptError, neutralExcerptMeanAbsoluteError: neutralExcerptError, repeatIdentical: true }, null, 2));
    }
  }, 120000));

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
    const originalSignal = testSignal;
    testSignal = AbortSignal.any([originalSignal, controller.signal]);
    try {
      // Start the next seek before the injected test deadline fires. It never
      // resolves: cancellation must reach the outer browser, not only ffmpeg.
      await expect(encodeDocumentComposition({ project, plan: await prepareDocumentRender(project), jobId: 'cancel-proof', audioPath: master, outputPath,
        onProgress: () => queueMicrotask(() => controller.abort(new Error('Synthetic capture deadline'))),
      })).rejects.toThrow('Synthetic capture deadline');
    } finally { testSignal = originalSignal; }
    expect(ownedChildren).toHaveLength(before + 1);
    const owned = ownedChildren.at(-1);
    expect(owned.closed, lifecycle.diagnostics.describe(owned)).toBe(true);
    expect(existsSync(owned.profile), lifecycle.diagnostics.describe(owned)).toBe(false);
    expect(existsSync(`${outputPath}.silent.mp4`)).toBe(false);
    expect(browser.isConnected()).toBe(true);
  }, 30000);

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

  it('renders a generated 3-second card/still/clip document with the selected performance in-point', async () => {
    await mkdir(PATHS.videos, { recursive: true });
    await mkdir(PATHS.images, { recursive: true });
    await mkdir(PATHS.music, { recursive: true });
    const clip = join(PATHS.videos, 'generated-rgb.webm');
    execFileSync(ffmpeg, ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=24:d=1', '-f', 'lavfi', '-i', 'color=c=lime:s=640x360:r=24:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=24:d=1',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0', '-c:v', 'libvpx', '-b:v', '1M', '-g', '24', clip]);
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=yellow:s=640x360:d=1', '-frames:v', '1', join(PATHS.images, 'generated-still.png')]);
    const master = join(PATHS.music, 'generated-master.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', master]);
    const created = await projects.createProject({ name: 'Generated Example' });
    await writeFile(join(PATHS.data, 'video-history.json'), JSON.stringify([{ id: 'vh-generated', filename: 'generated-rgb.webm', numFrames: 72, fps: 24, width: 640, height: 360 }]));
    await projects.mutateProjectRecord(created.id, (current) => ({ project: {
      ...current,
      audioAnalysis: { durationSec: 3, beats: [0, 1, 2], downbeats: [0, 1, 2], sections: [
        { id: 'intro', startSec: 0, endSec: 1 }, { id: 'still', startSec: 1, endSec: 2 }, { id: 'clip', startSec: 2, endSec: 3 },
      ] },
      productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 },
      treatment: { shotDirections: [
        { sceneId: 'card', medium: 'procedural', mediumRationale: 'Graphic opening' },
        { sceneId: 'image', medium: 'still', mediumRationale: 'Use selected image' },
        { sceneId: 'video', medium: 'existing-footage', mediumRationale: 'Use selected clip' },
      ] },
      scenes: [
        { sceneId: 'card', order: 0, startSec: 0, endSec: 1 },
        { sceneId: 'image', order: 1, startSec: 1, endSec: 2, referenceImageId: 'generated-still.png' },
        { sceneId: 'video', order: 2, startSec: 2, endSec: 3, shotMode: 'performance', videoHistoryId: 'vh-generated', takes: [
          { kind: 'video', assetId: 'vh-generated', shotInstruction: { shotMode: 'performance', edit: { inSec: 1, outSec: 3 } } },
        ] },
      ],
    } }));
    author.calls = 0;
    const staged = await generateMixedMediaDocument(created.id);
    expect(author.calls).toBe(1);
    expect((await projects.getProject(created.id)).composition.document).toBeUndefined();
    await acceptMixedMediaDocument(created.id, staged.document.directory);
    const project = await projects.getProject(created.id);
    const preview = await buildDocumentPreview(project);
    expect(preview.html).toContain('PORTOS_MV_GENERATED');
    expect(preview.html).toContain('"inSec":1');
    // Plays the PortOS page's side of the lazy bridge: the manifest first, then each file only when asked.
    const previewFrames = async (current, times, requested = []) => {
      const page = await browser.newPage();
      const prepared = await buildDocumentPreview(current);
      await page.setContent(prepared.html);
      const files = Object.fromEntries(await Promise.all(prepared.assets.map(async (asset) => [asset.key,
        (await readFile(asset.key.endsWith('.webm') ? clip : join(PATHS.images, 'generated-still.png'))).toString('base64')])));
      await page.evaluate(async (encoded) => {
        window.requested = [];
        addEventListener('message', ({ data }) => {
          if (data?.type !== 'portos-mv:request') return;
          window.requested.push(data.key);
          const value = encoded[data.key];
          const blob = value && new Blob([Uint8Array.from(atob(value), (c) => c.charCodeAt(0))], { type: data.key.endsWith('.webm') ? 'video/webm' : 'image/png' });
          window.postMessage({ type: 'portos-mv:asset', key: data.key, blob: blob || null }, '*');
        });
        window.postMessage({ type: 'portos-mv:manifest', keys: Object.keys(encoded) }, '*');
        await window.PORTOS_MV_ASSETS;
      }, files);
      const pixels = [];
      for (const time of times) {
        pixels.push(await page.evaluate(async (t) => {
          await window.portosComposition.seek(t);
          const canvas = document.getElementById('stage');
          return [...canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data].slice(0, 3);
        }, time));
        requested.push(await page.evaluate(() => window.requested.splice(0)));
      }
      await page.close();
      return pixels;
    };
    const requested = [];
    const beforeProof = await previewFrames(project, [0, 1, 2], requested);
    const [stillKey, clipKey] = [preview.assets.find((asset) => asset.key.endsWith('.png')).key, preview.assets.find((asset) => asset.key.endsWith('.webm')).key];
    // Nothing is fetched up front: the card frame needs no media, and each file is fetched once, when first named.
    expect(requested[0]).toEqual([]);
    expect(requested.flat().sort()).toEqual([clipKey, stillKey].sort());
    // A far scrub on a fresh preview fetches only that time's clip and still paints the complete frame.
    const farRequested = [];
    expect(await previewFrames(project, [2], farRequested)).toEqual([beforeProof[2]]);
    expect(farRequested).toEqual([[clipKey]]);
    // The full-duration proof samples static section boundaries. A 3s song at
    // the supported 12fps minimum keeps one section per second at 36 frames of
    // real Chrome capture (a 30s song was 360 frames, ~100s, and timed out on a
    // loaded host: #10132).
    const plan = { ...(await prepareDocumentRender(project)), clock: documentRenderClock(3, 12), frame: { width: 1280, height: 720 } };
    const renderAt = async (time, name) => {
      const outputPath = join(PATHS.videos, name);
      await encodeDocumentComposition({ project, plan, jobId: name.replace(/\W/g, ''), audioPath: master, outputPath, windowStart: time, windowEnd: time + 1 / 24 });
      const frame = execFileSync(ffmpeg, ['-v', 'error', '-i', outputPath, '-frames:v', '1', '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      await rm(outputPath, { force: true });
      return [...frame.subarray((18 * 64 + 32) * 3, (18 * 64 + 32) * 3 + 3)];
    };
    const card = await renderAt(0, 'generated-card.mp4');
    const still = await renderAt(1, 'generated-still.mp4');
    const firstClip = await renderAt(2, 'generated-clip.mp4');
    const repeated = await renderAt(2, 'generated-clip-again.mp4');
    const fullPath = join(PATHS.videos, 'generated-full.mp4');
    await encodeDocumentComposition({ project, plan, jobId: 'generated-full', audioPath: master, outputPath: fullPath });
    const fullPixel = (time) => {
      const frame = execFileSync(ffmpeg, ['-v', 'error', '-ss', String(time), '-i', fullPath, '-frames:v', '1', '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      return [...frame.subarray((18 * 64 + 32) * 3, (18 * 64 + 32) * 3 + 3)];
    };
    for (const [index, time] of [0, 1, 2].entries()) {
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
    const afterProof = await previewFrames(await projects.getProject(created.id), [0, 1, 2]);
    expect(afterProof[0]).toEqual(beforeProof[0]);
    expect(afterProof[1]).not.toEqual(beforeProof[1]);
    expect(afterProof[2]).toEqual(beforeProof[2]);
    author.response = null;
  }, 180000);
});
