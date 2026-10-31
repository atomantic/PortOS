/**
 * Composition-document render staging, through encodeDocumentComposition with
 * the composition browser stubbed at its boundary: the job folder holds
 * portos-mv.js with each scene's selected take and the take files beside the
 * page, a reserved media name is refused, the page must be (or declare) the
 * project's aspect, and the job folder is removed however the render ends.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { constants, createContext, runInContext } from 'node:vm';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../htmlComposition/encode.js', async (importOriginal) => ({ ...(await importOriginal()), encodeComposition: vi.fn(async () => { throw new Error('stop at encoder'); }) }));
const { encodeComposition } = await import('../htmlComposition/encode.js');

const { browser } = vi.hoisted(() => ({ browser: { seen: null, contract: null, visibility: null, lyricUnfit: [], sampleTimes: [], send: null, closed: [], frameCallbacks: true, capabilityProbes: 0, version: 'Chrome/155.0.8059.41', versionCalls: [], authoredContext: null, authoredInspections: 0 } }));
vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-document-stage-'),
}));
// The staging assertions stop before ffmpeg ever runs; CI images have no
// ffmpeg on PATH, so resolve the lookup instead of depending on the host.
vi.mock('../../lib/ffmpeg.js', async (importOriginal) => ({
  ...(await importOriginal()),
  findFfmpeg: async () => 'ffmpeg',
  probeVideoGeometry: vi.fn(async () => null),
  runFfmpegProcess: vi.fn(async ({ args }) => {
    if (args.includes('-n')) await writeFile(args.at(-1), await readFile(args[args.indexOf('-i') + 1]));
    return { ok: true };
  }),
}));
// Capture the frozen job folder the page would open, then stop the render.
vi.mock('../htmlComposition/browser.js', () => ({
  openComposition: async (directory, options) => {
    const { readFile: read, readdir: list } = await import('node:fs/promises');
    const { join: joinPath } = await import('node:path');
    const { PATHS: paths } = await import('../../lib/paths.js');
    const dir = joinPath(paths.data, directory);
    const media = {};
    for (const name of await list(joinPath(dir, 'media'))) media[name] = await read(joinPath(dir, 'media', name), 'utf8');
    const window = {};
    new Function('window', await read(joinPath(dir, 'portos-mv.js'), 'utf8'))(window);
    browser.seen = { directory, data: window.PORTOS_MV, media, song: JSON.parse(await read(joinPath(dir, 'song.json'), 'utf8')), initScripts: options?.initScripts ?? [] };
    return {
      async evaluate(expression) {
        if (expression.includes('__portosAuthoredPreviewPlayback')) {
          browser.authoredInspections++;
          return runInContext(expression, browser.authoredContext);
        }
        if (expression.includes('requestVideoFrameCallback')) {
          browser.capabilityProbes++;
          const prototype = {};
          if (browser.frameCallbacks === true || browser.frameCallbacks === 'request-only') prototype.requestVideoFrameCallback = () => {};
          if (browser.frameCallbacks === true || browser.frameCallbacks === 'cancel-only') prototype.cancelVideoFrameCallback = () => {};
          return new Function('HTMLVideoElement', `return (${expression});`)({ prototype });
        }
        if (expression.includes('reviewFootage')) { browser.sampleTimes.push(Number(/c.seek\(([^,]+)/.exec(expression)[1])); return browser.visibility; }
        if (expression.includes('lyricFit')) return browser.lyricUnfit;
        if (expression.includes('canPlayType')) return 'probably';
        if (browser.contract) return browser.contract;
        throw new Error('stop after staging');
      },
      check() {},
      async close() { browser.closed.push({ directory, assetsPresent: (await list(dir)).includes('portos-mv.js') }); },
      async send(...args) {
        if (args[0] === 'Browser.getVersion') {
          browser.versionCalls.push(args);
          if (browser.version instanceof Error) throw browser.version;
          return browser.version == null ? {} : { product: browser.version };
        }
        return browser.send?.(...args) ?? {};
      },
    };
  },
}));

const { runFfmpegProcess, probeVideoGeometry } = await import('../../lib/ffmpeg.js');
const { PATHS } = await import('../../lib/paths.js');
const { encodeDocumentComposition, documentRenderClock, openIsolatedDocumentPreview, resolveSceneMedia } = await import('./documentRender.js');

afterAll(() => cleanupTempDataRoots());
beforeEach(() => { runFfmpegProcess.mockClear(); probeVideoGeometry.mockReset(); probeVideoGeometry.mockResolvedValue(null); browser.seen = null; browser.contract = null; browser.visibility = null; browser.lyricUnfit = []; browser.sampleTimes = []; browser.send = null; browser.closed = []; browser.frameCallbacks = true; browser.capabilityProbes = 0; browser.version = 'Chrome/155.0.8059.41'; browser.versionCalls = []; browser.authoredContext = null; browser.authoredInspections = 0; });

const performanceTake = (assetId) => ({ takeId: 'mvt-p', kind: 'video', assetId, status: 'candidate', shotInstruction: { shotMode: 'performance', edit: { inSec: 0.5, outSec: 3.5 } } });

async function fixture({ shipped = {} } = {}) {
  await mkdir(PATHS.videos, { recursive: true });
  await mkdir(PATHS.images, { recursive: true });
  await writeFile(join(PATHS.videos, 'clip-a.mp4'), 'video-a');
  await writeFile(join(PATHS.images, 'still-b.png'), 'image-b');
  await writeFile(join(PATHS.data, 'video-history.json'), JSON.stringify([{ id: 'vh-a', filename: 'clip-a.mp4', numFrames: 96, fps: 24, width: 1280, height: 720 }]));
  const directory = 'music-video/mv-stage/composition/doc-test';
  await rm(join(PATHS.data, directory), { recursive: true, force: true });
  await mkdir(join(PATHS.data, directory), { recursive: true });
  await writeFile(join(PATHS.data, directory, 'index.html'), '<!doctype html><script src="portos-mv.js"></script>');
  for (const [name, body] of Object.entries(shipped)) {
    await mkdir(join(PATHS.data, directory, name, '..'), { recursive: true });
    await writeFile(join(PATHS.data, directory, name), body);
  }
  const project = {
    id: 'mv-stage', name: 'Stage', audioAnalysis: { durationSec: 30, beats: [0, 0.5], downbeats: [0], sections: [] },
    lyricCues: [{ id: 'l1', text: 'first line', startSec: 1, endSec: 2 }],
    composition: { mode: 'document', textCues: [{ id: 'c1', text: 'hero', startSec: 1, endSec: 2, emphasis: 'hero' }], overlay: { enabled: true, ticker: ['a'] } },
    scenes: [
      { sceneId: 'a', order: 0, startSec: 0, endSec: 4, videoHistoryId: 'vh-a', referenceImageId: 'still-b.png' },
      { sceneId: 'b', order: 1, startSec: 4, endSec: 8, videoHistoryId: 'vh-gone', referenceImageId: 'still-b.png', visualLayer: 'still', stillMove: 'push', imageEffect: 'flash-develop', imageEffectSec: 6 },
      { sceneId: 'c', order: 2, startSec: 8, endSec: 9, visualLayer: 'card', cardText: 'Title' },
      { sceneId: 'd', order: 3, startSec: 9, endSec: 12, shotMode: 'performance', videoHistoryId: 'vh-a', takes: [performanceTake('vh-a')] },
    ],
  };
  const plan = { directory, songDurationSec: 30, clock: documentRenderClock(30), frame: { width: 1920, height: 1080 } };
  return { project, plan };
}

const encode = (project, plan, jobId) => encodeDocumentComposition({ project, plan, jobId, audioPath: join(PATHS.data, 'none.wav'), outputPath: join(PATHS.videos, `${jobId}.mp4`) });
const scratchEntries = async () => (await readdir(join(PATHS.data, 'music-video-song-renders')).catch(() => []));
async function canonicalPreview() {
  const value = await fixture(), directory = join(PATHS.data, value.plan.directory);
  await cp(new URL('./documentTemplates/layered/', import.meta.url), directory, { recursive: true });
  await cp(new URL('./documentTemplates/shared/', import.meta.url), directory, { recursive: true });
  await cp(new URL('../../lib/musicVideoImageEffects.js', import.meta.url), join(directory, 'musicVideoImageEffects.js'));
  value.project.composition.document = { directory: value.plan.directory };
  return value;
}

async function authoredPreview(declaration = { version: 1, contract: 'portos-complete-frame-v1' }) {
  const value = await fixture({ shipped: { 'preview-playback.json': JSON.stringify(declaration), 'authored.js': '/* Immutable authored implementation fixture. */' } });
  value.project.composition.document = { directory: value.plan.directory };
  // A non-contextified VM global preserves browser-style throwing accessors.
  browser.authoredContext = createContext(constants.DONT_CONTEXTIFY);
  browser.authoredContext.portosComposition = { previewPlayback: {
    version: 1, fps: 30, presentation: 'atomic-canvas-v1', mediaTiming: 'staged-output-v1',
    clock() { return 1; }, prepare() {}, play() {}, sync() {}, pause() {}, dispose() {},
  } };
  return value;
}

describe('declared authored preview admission through document open', () => {
  it('admits an explicit supported producer without adapting its source', async () => {
    const { project, plan } = await authoredPreview();
    const source = join(PATHS.data, plan.directory);
    const original = await readFile(join(source, 'index.html'));
    const preview = await openIsolatedDocumentPreview({ project, jobId: 'authored-admitted' });
    try {
      expect(preview.playback).toMatchObject({ producer: 'authored-v1', adapted: false, version: 1, fps: 30 });
      expect(browser.authoredInspections).toBe(1);
      expect(await readFile(join(source, 'index.html'))).toEqual(original);
      expect(await readFile(join(PATHS.data, browser.seen.directory, 'index.html'))).toEqual(original);
      expect(await readFile(join(PATHS.data, browser.seen.directory, 'authored.js'), 'utf8')).toBe('/* Immutable authored implementation fixture. */');
      expect(browser.closed).toEqual([]);
    } finally { await preview.page.close(); await rm(preview.scratchRoot, { recursive: true, force: true }); }
  });

  it('leaves a declared page exact when its runtime API is incomplete', async () => {
    const { project } = await authoredPreview();
    delete browser.authoredContext.portosComposition.previewPlayback.pause;
    const preview = await openIsolatedDocumentPreview({ project, jobId: 'authored-incomplete' });
    try {
      expect(preview.playback).toBeUndefined();
      expect(preview.playbackAdapter).toMatchObject({ adapted: false, reason: 'unsupported-runtime' });
      expect(browser.authoredInspections).toBe(1);
      expect(browser.closed).toEqual([]);
    } finally { await preview.page.close(); await rm(preview.scratchRoot, { recursive: true, force: true }); }
  });

  it('does not reinterpret an unknown declaration through the canonical recognizer', async () => {
    const { project, plan } = await canonicalPreview();
    const source = join(PATHS.data, plan.directory);
    await writeFile(join(source, 'preview-playback.json'), JSON.stringify({ version: 2, contract: 'portos-complete-frame-v2' }));
    const original = await readFile(join(source, 'engine.js'));
    const preview = await openIsolatedDocumentPreview({ project, jobId: 'authored-future' });
    try {
      expect(preview.playback).toBeUndefined();
      expect(preview.playbackAdapter).toMatchObject({ adapted: false, reason: 'unsupported-declaration' });
      expect(browser.authoredInspections).toBe(0);
      expect(browser.versionCalls).toEqual([]);
      expect(await readFile(join(PATHS.data, browser.seen.directory, 'engine.js'))).toEqual(original);
      expect(await readFile(join(source, 'engine.js'))).toEqual(original);
    } finally { await preview.page.close(); await rm(preview.scratchRoot, { recursive: true, force: true }); }
  });

  it('retains browser and trusted media-cadence eligibility for an authored producer', async () => {
    const { project } = await authoredPreview();
    await writeFile(join(PATHS.data, 'video-history.json'), JSON.stringify([{ id: 'vh-a', filename: 'clip-a.mp4', width: 1280, height: 720 }]));
    const preview = await openIsolatedDocumentPreview({ project, jobId: 'authored-unknown-cadence' });
    try {
      expect(preview.playback).toBeUndefined();
      expect(preview.playbackAdapter.reason).toBe('unsupported-video-fps');
      expect(browser.authoredInspections).toBe(0);
    } finally { await preview.page.close(); await rm(preview.scratchRoot, { recursive: true, force: true }); }
    const next = await authoredPreview(); browser.version = 'Chrome/154.0.8037.57';
    const older = await openIsolatedDocumentPreview({ project: next.project, jobId: 'authored-older-browser' });
    try {
      expect(older.playback).toBeUndefined();
      expect(older.playbackAdapter.reason).toBe('unsupported-capture-protocol');
      expect(browser.authoredInspections).toBe(0);
    } finally { await older.page.close(); await rm(older.scratchRoot, { recursive: true, force: true }); }
  });

  it('closes a page whose inspection throws before removing its assets', async () => {
    const { project, plan } = await authoredPreview();
    runInContext("Object.defineProperty(globalThis, 'portosComposition', { get() { throw new Error('Synthetic authored root inspection failure'); } });", browser.authoredContext);
    await expect(openIsolatedDocumentPreview({ project, jobId: 'authored-inspection-failed' })).rejects.toThrow('Synthetic authored root inspection failure');
    expect(browser.closed).toEqual([{ directory: browser.seen.directory, assetsPresent: true }]);
    expect(await scratchEntries()).toEqual([]);
    expect(existsSync(join(PATHS.data, plan.directory, 'index.html'))).toBe(true);
  });
});

describe('isolated document preview ownership', () => {
  it.each([
    { label: 'Chrome', product: 'Chrome/155.0.8059.41', supported: true },
    { label: 'headless Chrome', product: 'HeadlessChrome/155.0.8059.41', supported: true },
    { label: 'older baseline', product: 'Chrome/154.0.8037.57', supported: false },
    { label: 'unknown product', product: 'OtherBrowser/155.0.8059.41', supported: false },
    { label: 'missing product', product: null, supported: false },
    { label: 'malformed version', product: 'Chrome/155oops', supported: false },
    { label: 'unsafe major', product: 'Chrome/9007199254740992.0.0.0', supported: false },
    { label: 'nonfinite major', product: `Chrome/${'9'.repeat(400)}.0.0.0`, supported: false },
    { label: 'rejected version probe', product: new Error('Synthetic version probe failure'), supported: false },
  ])('requires the verified owned capture protocol baseline before advertising playback ($label)', async ({ product, supported }) => {
    const { project } = await canonicalPreview(); browser.version = product;
    const preview = await openIsolatedDocumentPreview({ project, jobId: 'preview-protocol' });
    try {
      expect(browser.versionCalls).toEqual([['Browser.getVersion', {}, null]]);
      expect(preview.playbackAdapter).toMatchObject({ adapted: true, captureProtocolSupported: supported });
      if (supported) expect(preview.playback).toMatchObject({ version: 1 });
      else {
        expect(preview.playback).toBeUndefined();
        expect(preview.playbackAdapter.reason).toBe('unsupported-capture-protocol');
        expect(browser.capabilityProbes).toBe(0);
      }
      expect(browser.closed).toEqual([]); // Exact fallback retains the caller's usable page.
    } finally { await preview.page.close(); await rm(preview.scratchRoot, { recursive: true, force: true }); }
  });

  it.each([{ mode: true, supported: true }, { mode: false, supported: false },
    { mode: 'request-only', supported: false }, { mode: 'cancel-only', supported: false }])('advertises cooperative capability only after a supported browser probe ($mode)', async ({ mode, supported }) => {
    const { project } = await canonicalPreview(); browser.frameCallbacks = mode;
    const preview = await openIsolatedDocumentPreview({ project, jobId: `preview-capability-${mode}` });
    try {
      expect(browser.capabilityProbes).toBe(1);
      expect(preview.playbackAdapter).toMatchObject({ adapted: true, runtimeSupported: supported });
      if (supported) expect(preview.playback).toMatchObject({ version: 1 });
      else expect(preview.playback).toBeUndefined();
      expect(browser.seen.data.scenes.find(scene => scene.media?.kind === 'video').media.fps).toBe(24);
    } finally { await preview.page.close(); await rm(preview.scratchRoot, { recursive: true, force: true }); }
  });

  it('keeps the actual open path on exact fallback when host staging cannot measure video fps', async () => {
    const { project } = await canonicalPreview();
    await writeFile(join(PATHS.data, 'video-history.json'), JSON.stringify([{ id: 'vh-a', filename: 'clip-a.mp4', width: 1280, height: 720 }]));
    const preview = await openIsolatedDocumentPreview({ project, jobId: 'preview-unknown-fps' });
    try {
      expect(probeVideoGeometry).toHaveBeenCalled();
      expect(preview.playback).toBeUndefined();
      expect(preview.playbackAdapter).toMatchObject({ adapted: false, reason: 'unsupported-video-fps' });
      expect(browser.capabilityProbes).toBe(0);
      expect(browser.seen.data.scenes.find(scene => scene.media?.kind === 'video').media.fps).toBeNull();
    } finally { await preview.page.close(); await rm(preview.scratchRoot, { recursive: true, force: true }); }
  });

  it.each(['metrics failure', 'cancellation'])('closes its opened page before removing staged assets after %s', async failure => {
    const { project, plan } = await fixture();
    project.composition.document = { directory: plan.directory };
    const controller = new AbortController();
    const error = new Error(`Synthetic preview ${failure}`);
    browser.send = () => {
      if (failure === 'metrics failure') throw error;
      controller.abort(error);
      return {};
    };
    await expect(openIsolatedDocumentPreview({ project, jobId: 'preview-failure', signal: controller.signal })).rejects.toBe(error);
    expect(browser.closed).toEqual([{ directory: browser.seen.directory, assetsPresent: true }]);
    expect(await scratchEntries()).toEqual([]);
    expect(existsSync(join(PATHS.data, plan.directory, 'index.html'))).toBe(true);
  });

  it('hands the successful page and staging directory to its caller without closing them', async () => {
    const { project, plan } = await fixture();
    project.composition.document = { directory: plan.directory };
    const preview = await openIsolatedDocumentPreview({ project, jobId: 'preview-success' });
    try {
      expect(browser.closed).toEqual([]);
      expect(existsSync(preview.scratchRoot)).toBe(true);
      expect(preview).toMatchObject({ width: 1920, height: 1080, fps: 24, durationSec: 30 });
    } finally {
      await preview.page.close();
      await rm(preview.scratchRoot, { recursive: true, force: true });
    }
  });
});

describe('composition document staging', () => {
  it.each([
    { timing: { speedFps: 24, offsetFrames: 12 }, live: { rate: 2, leadSec: 0, startSec: 0.5 }, inSec: 0.25, outSec: 2, filter: 'setpts=(PTS-STARTPTS)/2,fps=24' },
    { timing: { speedFps: 24, offsetFrames: -6 }, live: { rate: 2, leadSec: 0.25, startSec: 0 }, inSec: 0, outSec: 2.25, filter: 'setpts=(PTS-STARTPTS)/2,tpad=start_mode=clone:start_duration=0.25,fps=24' },
    { timing: { offsetFrames: -6 }, live: { rate: 1, leadSec: 0.25, startSec: 0 }, inSec: 0, outSec: 4.25, filter: 'setpts=(PTS-STARTPTS)/1,tpad=start_mode=clone:start_duration=0.25,fps=24' },
  ])('stages shot timing $timing on the document output timebase', async ({ timing, live, inSec, outSec, filter }) => {
    const { project, plan } = await fixture();
    Object.assign(project.scenes[0], timing);
    // The live preview bridges original bytes, so it must retain source time.
    const raw = await resolveSceneMedia(project, { history: JSON.parse(await readFile(join(PATHS.data, 'video-history.json'), 'utf8')) });
    expect(raw.get('a')).toMatchObject({ ext: 'mp4', inSec: 0, outSec: 4, fps: 24 });
    expect(raw.get('a').rate).toBeUndefined();
    // The live preview applies speed/offset at seek time (engine.js) from this source-time timing.
    expect(raw.get('a').timing).toEqual(live);
    const controller = new AbortController();
    await expect(encodeDocumentComposition({ project, plan, jobId: 'job-timing', signal: controller.signal })).rejects.toThrow('stop after staging');
    expect(browser.seen.data.scenes[0].media).toMatchObject({ inSec, outSec, fps: 24 });
    expect(runFfmpegProcess).toHaveBeenCalledTimes(1);
    const call = runFfmpegProcess.mock.calls[0][0];
    expect(call.signal).toBe(controller.signal);
    expect(call.args[call.args.indexOf('-vf') + 1]).toBe(filter);
    expect(call.args).toContain('-an');
    expect(browser.seen.media['scene-a.mp4']).toBe('video-a');
    expect(await readFile(join(PATHS.videos, 'clip-a.mp4'), 'utf8')).toBe('video-a');
    expect(await scratchEntries()).toEqual([]);
  });

  it('combines a performance in-point with offset and speed, without changing untimed takes', async () => {
    const { project, plan } = await fixture();
    Object.assign(project.scenes[3], { speedFps: -12, offsetFrames: 12 });
    await expect(encode(project, plan, 'job-performance-timing')).rejects.toThrow('stop after staging');
    expect(browser.seen.data.scenes[3].media).toMatchObject({ inSec: 2, outSec: 7 });
    expect(browser.seen.data.scenes[0].media).toMatchObject({ inSec: 0, outSec: 4 });
  });

  it('keeps a performance in-point in the live preview timing and leaves untimed takes alone', async () => {
    const { project } = await fixture();
    Object.assign(project.scenes[3], { speedFps: -12, offsetFrames: 12 });
    const raw = await resolveSceneMedia(project, { history: JSON.parse(await readFile(join(PATHS.data, 'video-history.json'), 'utf8')) });
    expect(raw.get(project.scenes[3].sceneId)).toMatchObject({ inSec: 0.5, timing: { rate: 0.5, leadSec: 0, startSec: 1 } });
    expect(raw.get('a').timing).toBeUndefined();
  });

  it('gives the live preview timing for an offset-only shot', async () => {
    const { project } = await fixture();
    Object.assign(project.scenes[0], { offsetFrames: 12 });
    Object.assign(project.scenes[3], { offsetFrames: -6 });
    const raw = await resolveSceneMedia(project, { history: JSON.parse(await readFile(join(PATHS.data, 'video-history.json'), 'utf8')) });
    expect(raw.get('a').timing).toEqual({ rate: 1, leadSec: 0, startSec: 0.5 });
    expect(raw.get(project.scenes[3].sceneId).timing).toEqual({ rate: 1, leadSec: 0, startSec: 0.25 });
  });

  it('fails before opening the page and cleans scratch when shot retiming fails', async () => {
    const { project, plan } = await fixture();
    project.scenes[0].speedFps = 24;
    runFfmpegProcess.mockResolvedValueOnce({ ok: false, reason: 'synthetic retiming failure' });
    await expect(encode(project, plan, 'job-timing-failure')).rejects.toThrow('Shot timing failed: synthetic retiming failure');
    expect(browser.seen).toBeNull();
    expect(await scratchEntries()).toEqual([]);
  });

  it('preserves the document shutter sampling contract through the shared encoder', async () => {
    const { project, plan } = await fixture();
    browser.contract = { durationSec: 30, fps: 24, width: 1920, height: 1080, motionBlur: 4, layout: false };
    await expect(encode(project, plan, 'job-shutter')).rejects.toThrow('stop at encoder');
    expect(encodeComposition).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ motionBlur: 4 }), expect.any(String), expect.any(Object));
  });
  it('writes portos-mv.js with each scene\'s selected take (video first) and copies the files beside the page', async () => {
    const { project, plan } = await fixture();
    await expect(encode(project, plan, 'job-stage')).rejects.toThrow('stop after staging');
    const { data, media, song } = browser.seen;
    const byId = Object.fromEntries(data.scenes.map((s) => [s.sceneId, s]));
    expect(byId.a.media).toMatchObject({ kind: 'video', src: 'media/scene-a.mp4', inSec: 0, outSec: 4, fps: 24 });
    expect(byId.b.media).toMatchObject({ kind: 'image', src: 'media/scene-b.png' });
    expect(byId.b).toMatchObject({ visualLayer: 'still', stillMove: 'push', imageEffect: { effect: 'flash-develop', developSec: 6 } });
    expect(byId.a.imageEffect).toBeNull();
    expect(byId.c).toMatchObject({ imageEffect: null, media: null, visualLayer: 'card', cardText: 'Title' });
    expect(byId.d.media).toMatchObject({ kind: 'video', src: 'media/scene-d.mp4', inSec: 0.5, outSec: 3.5 });
    expect(data.render).toEqual({ width: 1920, height: 1080, fps: 24, frames: 720, durationSec: 30 });
    expect(data.song).toMatchObject({ durationSec: 30, beats: [0, 0.5], downbeats: [0] });
    expect(data.lyrics.map((l) => l.text)).toEqual(['first line']);
    expect(data.textCues.map((c) => c.emphasis)).toEqual(['hero']);
    expect(data.composition).toMatchObject({ mode: 'document', overlay: { enabled: true, ticker: ['a'] } });
    expect(media).toEqual({ 'scene-a.mp4': 'video-a', 'scene-b.png': 'image-b', 'scene-d.mp4': 'video-a' });
    expect(runFfmpegProcess).not.toHaveBeenCalled();
    expect(song).toMatchObject({ beats: [0, 0.5], downbeats: [0] });
    // The source document is untouched and the job folder is gone.
    expect(existsSync(join(PATHS.data, plan.directory, 'portos-mv.js'))).toBe(false);
    expect(await scratchEntries()).toEqual([]);
  });

  it('refuses a document that ships a file under a name PortOS writes at render time', async () => {
    const { project, plan } = await fixture({ shipped: { 'media/scene-a.mp4': 'mine' } });
    await expect(encode(project, plan, 'job-clash')).rejects.toMatchObject({ code: 'COMPOSITION_DOCUMENT_INVALID' });
    expect(browser.seen).toBeNull();
    expect(await readFile(join(PATHS.data, plan.directory, 'media/scene-a.mp4'), 'utf8')).toBe('mine');
    expect(await scratchEntries()).toEqual([]);
  });

  it('renders the project aspect only when the page is that aspect or declares it', async () => {
    const { project, plan } = await fixture();
    browser.contract = { durationSec: 10, fps: 24, width: 1280, height: 720, layout: false };
    const vertical = { ...project, treatment: { brief: { aspectRatio: '9:16' } } };
    await expect(encode(vertical, plan, 'job-aspect')).rejects.toMatchObject({ code: 'COMPOSITION_DOCUMENT_FORMAT' });
    browser.contract = { ...browser.contract, durationSec: 31 };
    await expect(encode(project, plan, 'job-long')).rejects.toMatchObject({ code: 'COMPOSITION_DOCUMENT_CONTRACT' });
    expect(await scratchEntries()).toEqual([]);
  });
});

// Uniquely prevents an imported timeline from failing with only a generic schema message.
it('explains fractional document frames before encoding without changing the imported duration', async () => {
  const { project, plan } = await fixture();
  browser.contract = { durationSec: 10.01, fps: 24, width: 1920, height: 1080 };
  await expect(encode(project, plan, 'job-fractional')).rejects.toMatchObject({
    code: 'COMPOSITION_DOCUMENT_FRAME_ALIGNMENT', status: 422,
    message: expect.stringContaining('240/24 (10s)'),
    context: { durationSec: 10.01, fps: 24, frames: 240.24 },
  });
  expect(browser.contract.durationSec).toBe(10.01);
  expect(await scratchEntries()).toEqual([]);
});


it('carries measured footage samples and explicit missing hooks from the staged render', async () => {
  const { project, plan } = await fixture();
  browser.contract = { durationSec: 30, fps: 24, width: 1920, height: 1080, layout: false };
  browser.visibility = { sceneId: 'a', visibleFraction: 0.2, hiddenFraction: 0.8, measuredFraction: 1 };
  encodeComposition.mockResolvedValueOnce({});
  const result = await encodeDocumentComposition({ project, plan, jobId: 'visibility', audioPath: 'synthetic.wav',
    outputPath: join(PATHS.videos, 'visibility.mp4'), windowStart: 1, windowEnd: 10, collectFootageVisibility: true });
  expect(result.footageVisibility).toHaveLength(6); // still/card shots excluded
  expect(result.footageVisibility.slice(0, 3)).toEqual(browser.sampleTimes.slice(0, 3).map(at => ({
    sceneId: 'a', atSec: Math.round((at - 1) * 1000) / 1000, status: 'measured', visibleFraction: 0.2, hiddenFraction: 0.8, measuredFraction: 1,
  })));
  expect(result.footageVisibility.slice(3)).toEqual(expect.arrayContaining([expect.objectContaining({ sceneId: 'd', status: 'unverified' })]));
  expect(browser.sampleTimes.every(at => at >= 1 && at < 10)).toBe(true);
  expect(await scratchEntries()).toEqual([]);
});

// Uniquely catches the render page opening without the film look the live preview showed.
it('installs the project film look in the render page before the document runs, and nothing when the look is neutral', async () => {
  const { project, plan } = await fixture();
  await expect(encode(project, plan, 'job-plain')).rejects.toThrow('stop after staging');
  expect(browser.seen.initScripts).toEqual([]);
  const graded = { ...project, filmLook: { preset: 'super8', grain: 0.6, halation: 0.4 } };
  await expect(encode(graded, plan, 'job-look')).rejects.toThrow('stop after staging');
  expect(browser.seen.initScripts).toHaveLength(1);
  expect(browser.seen.initScripts[0]).toContain('__portosFilmLook');
  expect(browser.seen.initScripts[0]).toContain('"grain":0.6');
  expect(await scratchEntries()).toEqual([]);
});

// Uniquely catches the final render dropping the opening title card the live preview shows.
it('installs the opening title card in the render page only while it is on and has text', async () => {
  const { project, plan } = await fixture();
  const titled = { ...project, titleCard: { enabled: true, title: 'Example Song', artist: 'Example Artist', year: '2026', startSec: 2, endSec: 8, fadeSec: 0.8, position: 'lower-left', font: 'display', size: 100, color: '#f3ead7', extra: '', quoteTitle: true } };
  await expect(encode(titled, plan, 'job-title')).rejects.toThrow('stop after staging');
  expect(browser.seen.initScripts).toHaveLength(1);
  expect(browser.seen.initScripts[0]).toContain('__portosTitleCard');
  expect(browser.seen.initScripts[0]).toContain('"title":"Example Song"');
  await expect(encode({ ...titled, titleCard: { ...titled.titleCard, enabled: false } }, plan, 'job-title-off')).rejects.toThrow('stop after staging');
  expect(browser.seen.initScripts).toEqual([]);
  expect(await scratchEntries()).toEqual([]);
});

// Uniquely prevents a vertical cut from silently rendering lyrics under the platform controls.
it('refuses a render whose lyric line cannot fit the social-safe band, naming its time, before any encode', async () => {
  const { project, plan } = await fixture();
  browser.contract = { durationSec: 30, fps: 24, width: 1920, height: 1080, layout: false };
  browser.lyricUnfit = [{ startSec: 12.3456, endSec: 14, text: 'a line far too long for the band' }];
  encodeComposition.mockClear();
  await expect(encode(project, plan, 'job-social-overflow')).rejects.toMatchObject({
    code: 'LYRIC_SOCIAL_SAFE_OVERFLOW', status: 422,
    message: expect.stringContaining('12.346s "a line far too long for the band"'),
  });
  expect(encodeComposition).not.toHaveBeenCalled();
  expect(await scratchEntries()).toEqual([]);
});

it('carries the lyric layout to the document: social by default, cinematic from the brief', async () => {
  const { project, plan } = await fixture();
  await expect(encode(project, plan, 'job-layout-default')).rejects.toThrow();
  expect(browser.seen.data.project.lyricLayout).toBe('social');
  const cinematic = { ...project, treatment: { brief: { lyricLayout: 'cinematic' } } };
  await expect(encode(cinematic, plan, 'job-layout-cinematic')).rejects.toThrow();
  expect(browser.seen.data.project.lyricLayout).toBe('cinematic');
});
