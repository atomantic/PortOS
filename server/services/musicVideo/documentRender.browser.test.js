import { richSceneSource } from './__richSceneFixture.js';
/**
 * The shipped layered template with real Chrome and ffmpeg: an excerpt of a
 * composition-document project seeks the selected take's <video> on SONG time
 * (streamed to the page by byte range), renders frame-for-frame identically
 * every time, and carries the master song. Skips without Chrome or ffmpeg.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy, ownTestBodies } from '../../lib/mockPathsDataRoot.js';
import { browserSuiteCanRun } from '../../lib/browserSuiteGate.js';

const { it, drain } = ownTestBodies(vitestIt);
const ownedChildren = vi.hoisted(() => []);
vi.mock('../../lib/childProcess.js', async original => {
  const actual = await original();
  return { ...actual, spawn(...args) {
    const child = actual.spawn(...args);
    const profileArg = args[1]?.find(arg => arg.startsWith('--user-data-dir=') && arg.includes('portos-composition-browser-'));
    if (profileArg) {
      const owned = { profile: profileArg.slice('--user-data-dir='.length), closed: false };
      child.once('close', () => { owned.closed = true; });
      ownedChildren.push(owned);
    }
    return child;
  } };
});

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
const { _cleanupTestBrowser, _waitForTestChrome, _testChromeCaptureArgs } = await import('../htmlComposition/testBrowserCleanup.js');

afterAll(() => cleanupTempDataRoots());

const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((path) => path && existsSync(path));
const ffmpeg = await findFfmpeg();
// Imported discovery helpers can initialize mocked paths even on a skip.
const canRun = browserSuiteCanRun('documentRender browser suite', { Chrome: chrome, ffmpeg }, { onUnavailable: cleanupTempDataRoots });

describe.skipIf(!canRun)('layered template with real Chrome and ffmpeg', () => {
  let proc;
  let browser;
  let PATHS, encodeDocumentComposition, prepareDocumentRender, documentRenderClock, importDocumentTemplate;
  let generateMixedMediaDocument, regenerateMixedMediaSection, acceptMixedMediaDocument, buildDocumentPreview, projects;
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
    ({ buildDocumentPreview } = await import('./documentPreview.js'));
    projects = await import('./projects.js');
    const profile = join(PATHS.data, 'chrome-test-profile');
    proc = spawn(chrome, _testChromeCaptureArgs(profile), { stdio: ['ignore', 'ignore', 'pipe'] });
    const ws = await _waitForTestChrome(proc);
    endpoint = new URL(ws).origin.replace('ws:', 'http:');
    browser = await chromium.connectOverCDP(endpoint);
  }, 30000);
  afterAll(async () => {
    try {
      await drain();
      for (const owned of ownedChildren) {
        expect(owned.closed, 'owned capture child closed before fixture teardown').toBe(true);
        expect(existsSync(owned.profile), 'owned capture profile removed before fixture teardown').toBe(false);
      }
    } finally { await _cleanupTestBrowser({ browser, proc, cleanup: () => {} }); }
  });

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

  // Server-only CI does not install client dependencies; the full local install
  // exercises this cross-workspace package/render contract alongside the UI proof.
  const threeIt = existsSync(new URL('../../../client/node_modules/three/package.json', import.meta.url)) ? it : vitestIt.skip;
  threeIt('authors a local Three.js world and renders the same deterministic scene through module preview and export', async () => {
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
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
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
    await page.setContent(preview.html);
    await page.waitForFunction(() => typeof window.portosComposition?.seek === 'function');
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
    const first = await at(0);
    const textures = await page.evaluate(() => window.liveTextureCount());
    const moved = await at(0.5);
    expect(moved.world).not.toBe(first.world);
    expect(await at(0)).toEqual(first);
    expect(await page.evaluate(() => window.liveTextureCount())).toBe(textures);
    const pixels = await sharp(Buffer.from(first.world.split(',')[1], 'base64')).resize(64,36).removeAlpha().raw().toBuffer();
    const orange = [...Array(pixels.length / 3).keys()].filter((i) => pixels[i*3] > pixels[i*3+2] * 1.5 && pixels[i*3] > 100).length;
    expect(orange).toBeGreaterThan(15); // authored character, not a blank backdrop/overlay-only fallback
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
    const headSharpness = (aperture) => page.evaluate(async (aperture) => {
      window.PORTOS_MV_GENERATED.sections.world = (ctx, env) => {
        window.authoredWorld(ctx, env);
        const { THREE, scene, camera } = ctx;
        const rig = new THREE.Group(); rig.position.set(2.5, 0, 4); scene.add(rig); rig.add(camera);
        // A striped target card at the focus point: its edges blur visibly if
        // the focal plane misses it.
        const head = new THREE.Vector3(0, 2.2, 0.6);
        rig.updateMatrixWorld(true);
        const card = new THREE.Group(); card.position.copy(head); scene.add(card);
        card.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x000000 })));
        for (let i = -2; i <= 2; i++) { const bar = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 1), new THREE.MeshBasicMaterial({ color: 0xffffff })); bar.position.set(i * 0.18, 0, 0.001); card.add(bar); }
        card.lookAt(camera.getWorldPosition(new THREE.Vector3()));
        Object.assign(ctx.lens, { grain: 0, vignette: 0, bloom: 0, focus: head, aperture, maxBlur: 24 });
        window.headOnScreen = head.clone().project(camera);
      };
      await window.portosComposition.seek(0);
      const world = document.getElementById('world');
      const x = Math.round((window.headOnScreen.x + 1) / 2 * world.width) - 40, y = Math.round((1 - window.headOnScreen.y) / 2 * world.height) - 40;
      const probe = document.createElement('canvas'); probe.width = 80; probe.height = 80;
      const g = probe.getContext('2d'); g.drawImage(world, x, y, 80, 80, 0, 0, 80, 80);
      const { data } = g.getImageData(0, 0, 80, 80);
      let sum = 0; for (let i = 4; i < data.length; i += 4) sum += Math.abs(data[i] - data[i - 4]);
      return { sum, offAxis: Math.abs(window.headOnScreen.x) };
    }, aperture);
    const sharpHead = await headSharpness(0);
    const focusedHead = await headSharpness(18);
    expect(sharpHead.offAxis).toBeGreaterThan(0.1);
    expect(focusedHead.sum).toBeGreaterThan(sharpHead.sum * 0.99); // straight-line distance from the local position gives ~0.95
    expect(await page.evaluate(() => window.liveTextureCount())).toBe(textures);
    expect(warnings.filter((text) => text.includes('PCFSoftShadowMap'))).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
    await mkdir(PATHS.music, { recursive: true }); await mkdir(PATHS.videos, { recursive: true });
    const master = join(PATHS.music, 'world.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', master]);
    const outputPath = join(PATHS.videos, 'world.mp4');
    const result = await encodeDocumentComposition({ project, plan: await prepareDocumentRender(project), jobId: 'world-proof', audioPath: master, outputPath, windowStart: 0, windowEnd: 2/24 });
    expect(result).toMatchObject({ width: 1920, height: 1080, fps: 24 });
    const rendered = execFileSync(ffmpeg, ['-v', 'error', '-i', outputPath, '-frames:v', '1', '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    expect(rendered.reduce((sum, v, i) => sum + Math.abs(v-pixels[i]), 0) / pixels.length).toBeLessThan(15);
  }, 120000);

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
    await page.evaluate(() => window.postMessage({ type: 'portos-mv:assets', files: {} }, '*'));
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

  ['ramps', 'generated-shots'].forEach(fixture => it(`matches bounded grades across real composed/document ${fixture} and song-time excerpts`, async () => {
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
    expect(owned.closed).toBe(true);
    expect(existsSync(owned.profile)).toBe(false);
    expect(existsSync(`${outputPath}.silent.mp4`)).toBe(false);
    expect(browser.isConnected()).toBe(true);
  }, 30000);

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
    const beforeProof = await previewFrames(project, [0, 1, 2]);
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
