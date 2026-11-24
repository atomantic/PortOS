import { richSceneSource } from './__richSceneFixture.js';
import { _withTestPreviewLoadDiagnostics } from './testPreviewLoadDiagnostics.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createDocumentRenderBrowserFixture } from './testDocumentRenderBrowserFixture.js';
import sharp from 'sharp';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy, ownTestBodies } from '../../lib/mockPathsDataRoot.js';
import { browserSuiteCanRun, chromeWithH264, resolveTestChrome } from '../../lib/browserSuiteGate.js';

const { it, drain } = ownTestBodies(vitestIt);
const lifecycle = vi.hoisted(() => ({ ownedChildren: [], chromeProcess: null, fixtureWritersSettled: false, endpoint: null }));
vi.mock('../../lib/childProcess.js', async original => {
  const actual = await original();
  return { ...actual, spawn(...args) {
    const child = actual.spawn(...args);
    const arg = args[1]?.find?.(value => value.startsWith('--user-data-dir=') && value.includes('portos-composition-browser-'));
    if (arg) {
      const owned = { profile: arg.slice('--user-data-dir='.length), closed: false };
      child.once('close', () => { owned.closed = true; });
      lifecycle.ownedChildren.push(owned);
    }
    return child;
  } };
});
const ownedChildren = lifecycle.ownedChildren;

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

vi.mock('../browserService.js', () => ({ loadConfig: async () => ({ chromePath: chrome }), cdpRequest: vi.fn((path) => fetch(`${lifecycle.endpoint}${path}`)) }));
vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-document-generation-browser-'),
}));

const { findFfmpeg } = await import('../../lib/ffmpeg.js');
const { _testBrowserCleanupSettled, _testChromeCaptureArgs } = await import('../htmlComposition/testBrowserCleanup.js');

afterAll(() => {
  if (!lifecycle.chromeProcess || (lifecycle.fixtureWritersSettled && _testBrowserCleanupSettled(lifecycle.chromeProcess))) cleanupTempDataRoots();
});

const chrome = resolveTestChrome();
const ffmpeg = await findFfmpeg();
// Imported discovery helpers can initialize mocked paths even on a skip.
const canRun = browserSuiteCanRun('documentRenderGeneration browser suite', { 'Chrome with H.264': await chromeWithH264(chrome), ffmpeg }, { onUnavailable: cleanupTempDataRoots });

describe.skipIf(!canRun)('layered template with real Chrome and ffmpeg', () => {
  let browser;
  const { openFixture, closeFixture } = createDocumentRenderBrowserFixture(lifecycle);
  let PATHS, encodeDocumentComposition, prepareDocumentRender, documentRenderClock;
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
    ({ generateMixedMediaDocument, regenerateMixedMediaSection, acceptMixedMediaDocument } = await import('./documentGeneration.js'));
    ({ buildDocumentPreview } = await import('./documentPreview.js'));
    projects = await import('./projects.js');
    const profile = join(PATHS.data, 'chrome-test-profile');
    const proc = spawn(chrome, _testChromeCaptureArgs(profile), { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
    browser = await openFixture(proc);
  }, 30000);
  afterAll(async () => {
    try {
      await drain();
      for (const owned of ownedChildren) {
        expect(owned.closed, `owned capture child closed before fixture teardown`).toBe(true);
        expect(existsSync(owned.profile), `owned capture profile removed before fixture teardown`).toBe(false);
      }
      lifecycle.fixtureWritersSettled = true;
    } finally { await closeFixture(); }
  }, 35000);

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
        // biome-ignore lint/correctness/noUnsafeFinally: cleanup-verification failure must surface and deliberately supersedes the body outcome
        if (cleanupErrors.length) throw new AggregateError([...(bodyError ? [bodyError] : []), ...cleanupErrors],
          'Three test or owned browser cleanup failed', { cause: bodyError ?? cleanupErrors[0] });
      } finally { signal.removeEventListener('abort', abort); }
    }
  }, 120000);

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
