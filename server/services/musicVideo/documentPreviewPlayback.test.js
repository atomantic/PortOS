import { afterAll, describe, expect, it, vi } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
vi.mock('./compositionDocument.js', () => ({ isUpgradableLayeredEngine: bytes => bytes.toString().startsWith('// older shipped engine') }));
import { adaptStagedDocumentPreview, shippedLayeredDocument } from './documentPreviewPlayback.js';
import { installLayeredPreviewPlayback } from './previewPlaybackRuntime.js';
import { imageEffectState, IMAGE_EFFECT_FOG_COLOR, photoSequenceIndex, photoSequenceLayers, scenePhotoSequence } from '../../lib/musicVideoImageEffects.js';

const roots = [];
const templates = fileURLToPath(new URL('./documentTemplates/', import.meta.url));
afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function staged() {
  const root = await mkdtemp(join(tmpdir(), 'preview-playback-contract-')); roots.push(root);
  await cp(join(templates, 'layered'), root, { recursive: true });
  await cp(join(templates, 'shared'), root, { recursive: true });
  await cp(new URL('../../lib/musicVideoImageEffects.js', import.meta.url), join(root, 'musicVideoImageEffects.js'));
  return root;
}

describe('recognized staged composition playback capability', () => {
  it('adapts only the disposable canonical copy, preserving the exact seek body and source template', async () => {
    const root = await staged(), sourcePath = join(templates, 'layered/engine.js');
    const original = await readFile(sourcePath, 'utf8'), index = await readFile(join(root, 'index.html'));
    const receipt = await adaptStagedDocumentPreview(root);
    expect(receipt).toMatchObject({ adapted: true, adapterVersion: 1, mediaTiming: 'staged-output-v1', fps: 30 });
    const adapted = await readFile(join(root, 'engine.js'), 'utf8');
    const exact = original.slice(original.indexOf('    async seek(t,'), original.lastIndexOf('\n})();'));
    expect(adapted).toContain(exact);
    expect(await readFile(sourcePath, 'utf8')).toBe(original);
    expect(await readFile(join(root, 'index.html'))).toEqual(index);
    expect(receipt.originalEngineSha256).not.toBe(receipt.stagedEngineSha256);
    // The serialized bridge is a valid script without loading a browser.
    expect(() => new Function(adapted)).not.toThrow();
  });

  it('preserves custom entrypoints/helpers and leaves every generated document on exact fallback', async () => {
    const custom = await staged();
    await writeFile(join(custom, 'cameraRig.js'), 'globalThis.custom = true;');
    const before = await readFile(join(custom, 'engine.js'));
    expect(await adaptStagedDocumentPreview(custom)).toMatchObject({ adapted: false, reason: 'custom-helper' });
    expect(await readFile(join(custom, 'engine.js'))).toEqual(before);
    const altered = await staged();
    await writeFile(join(altered, 'index.html'), '<script src="engine.js"></script><script>sideEffect()</script>');
    expect(await adaptStagedDocumentPreview(altered)).toMatchObject({ adapted: false, reason: 'custom-entrypoint' });
    const generated = await staged();
    const index = await readFile(join(generated, 'index.html'), 'utf8');
    await writeFile(join(generated, 'index.html'), index.replace('<script src="engine.js"></script>', '<script src="generated.js"></script>\n<script src="engine.js"></script>'));
    await writeFile(join(generated, 'generated.js'), 'window.PORTOS_MV_GENERATED = { sections: {} };');
    expect(await adaptStagedDocumentPreview(generated)).toMatchObject({ adapted: false, reason: 'generated-contract-not-admitted' });
  });

  // Uniquely catches authored or customized document code being cleared to play in the viewer's own browser.
  it('reports only the unmodified shipped template as shipped, without touching the document', async () => {
    const root = await staged();
    const before = await readFile(join(root, 'engine.js'));
    expect(await shippedLayeredDocument(root)).toEqual({ shipped: true });
    expect(await readFile(join(root, 'engine.js'))).toEqual(before);
    const custom = await staged();
    await writeFile(join(custom, 'cameraRig.js'), 'globalThis.custom = true;');
    expect(await shippedLayeredDocument(custom)).toEqual({ shipped: false, reason: 'custom-helper' });
    const generated = await staged();
    const index = await readFile(join(generated, 'index.html'), 'utf8');
    await writeFile(join(generated, 'index.html'), index.replace('<script src="engine.js"></script>', '<script src="generated.js"></script>\n<script src="engine.js"></script>'));
    expect(await shippedLayeredDocument(generated)).toEqual({ shipped: false, reason: 'generated-contract-not-admitted' });
    const older = await staged();
    await writeFile(join(older, 'engine.js'), '// older shipped engine\n');
    expect(await shippedLayeredDocument(older)).toEqual({ shipped: false, reason: 'unrecognized-engine', upgradable: true });
  });

  // Uniquely catches the player losing its one-tap way back to smooth playback for an older shipped engine.
  it('marks an older shipped engine as upgradable and a customized one as not', async () => {
    const older = await staged();
    await writeFile(join(older, 'engine.js'), '// older shipped engine\n');
    expect(await adaptStagedDocumentPreview(older)).toEqual({ adapted: false, reason: 'unrecognized-engine', upgradable: true });
    const custom = await staged();
    await writeFile(join(custom, 'engine.js'), '// my own engine\n');
    expect(await adaptStagedDocumentPreview(custom)).toEqual({ adapted: false, reason: 'unrecognized-engine' });
  });

  it('declines unknown or too-slow staged video cadence without rewriting its engine', async () => {
    const root = await staged(), original = await readFile(join(root, 'engine.js'));
    for (const fps of [null, 0, 10]) {
      expect(await adaptStagedDocumentPreview(root, { scenes: [{ media: { kind: 'video', fps } }] }))
        .toMatchObject({ adapted: false, reason: 'unsupported-video-fps' });
      expect(await readFile(join(root, 'engine.js'))).toEqual(original);
    }
    expect(await adaptStagedDocumentPreview(root, { scenes: [{ media: { kind: 'video', fps: 24 } }, { media: { kind: 'image', fps: null } }] }))
      .toMatchObject({ adapted: true });
  });

  it('runs the real staged engine with fail-atomic backbuffer publication and restores exact rendering after a failed draw', async () => {
    const root = await staged();
    const song = { sections: [{ id: 'intro', startSec: 0, endSec: 5 }] };
    expect(await adaptStagedDocumentPreview(root)).toMatchObject({ adapted: true });
    let failDraw = false;
    const canvases = [];
    const makeCanvas = () => {
      const calls = [];
      const context = new Proxy({ calls }, { get(target, key) {
        if (key in target) return target[key];
        if (key === 'createImageData' || key === 'getImageData') return (_x, _y, w, h) => ({ data: new Uint8ClampedArray((w || _x) * (h || _y) * 4) });
        if (key === 'measureText') return text => ({ width: String(text).length * 10 });
        if (key === 'createRadialGradient' || key === 'createLinearGradient') return () => ({ addColorStop() {} });
        if (key === 'createPattern') return () => ({});
        return (...args) => { if (key === 'fillRect' && failDraw) throw 1; calls.push([key, ...args]); };
      } });
      const canvas = { width: 1920, height: 1080, context, getContext: () => context };
      canvases.push(canvas); return canvas;
    };
    const front = makeCanvas(), events = [], finish = [], titles = [];
    const sandbox = { setTimeout, clearTimeout, performance: { now: () => 0 }, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
      document: { getElementById: () => front, createElement: () => makeCanvas(), fonts: { load: () => Promise.resolve() } },
      PORTOS_MV: { render: { width: 1920, height: 1080, fps: 24, durationSec: 5 }, song, composition: {},
        scenes: [{ sceneId: 'code', startSec: 0, endSec: 5, visualLayer: 'code' }] },
      PORTOS_MV_EVENT_STATE: () => ({ t: 0, hold: true, activeEvents: [], reactiveGain: 0 }),
      __portosFilmLook: { frame: t => finish.push(t), playback() {} }, __portosTitleCard: { draw: t => titles.push(t) },
      PORTOS_LYRIC_TYPE: { createLyricType: () => ({ ready: Promise.resolve(), draw() {} }) }, postMessage: message => events.push(message) };
    sandbox.window = sandbox;
    runInNewContext(await readFile(join(root, 'engine.js'), 'utf8'), sandbox);
    const composition = sandbox.portosComposition, api = composition.previewPlayback;
    await api.prepare({ epoch: 1, t: 0 });
    const copies = () => front.context.calls.filter(call => call[0] === 'drawImage').length;
    expect(copies()).toBe(1);
    failDraw = true;
    await expect(api.prepare({ epoch: 2, t: 0.5 })).rejects.toBe(1);
    failDraw = false;
    expect(copies()).toBe(1);
    await api.pause({ epoch: 3 });
    await composition.seek(0);
    expect(front.context.calls.some(call => call[0] === 'fillRect')).toBe(true);
    await api.prepare({ epoch: 3, t: 0.75 });
    expect(finish.at(-1)).toBe(18);
    expect(titles.at(-1)).toBe(0.75);
    expect(copies()).toBeGreaterThan(1);
    const backs = canvases.filter(canvas => canvas.context.calls.some(call => call[0] === 'reset'));
    expect(backs).toHaveLength(1);
    expect(backs[0].context.calls.filter(call => call[0] === 'reset')).toHaveLength(3);
    expect(events).toEqual([expect.objectContaining({ type: 'portos-mv:playback-error', epoch: 2 })]);
    await api.dispose();
  });

  it('changes to a preloaded end frame during cooperative playback on the rounded shot frame', async () => {
    const root = await staged();
    expect(await adaptStagedDocumentPreview(root)).toMatchObject({ adapted: true });
    let clock = 0, animation = null;
    const canvases = [];
    const makeCanvas = () => {
      const calls = [];
      const context = new Proxy({ calls }, { get(target, key) {
        if (key in target) return target[key];
        if (key === 'createImageData' || key === 'getImageData') return (_x, _y, w, h) => ({ data: new Uint8ClampedArray((w || _x) * (h || _y) * 4) });
        if (key === 'measureText') return text => ({ width: String(text).length * 10 });
        if (key === 'createRadialGradient' || key === 'createLinearGradient') return () => ({ addColorStop() {} });
        if (key === 'createPattern') return () => ({});
        return (...args) => { calls.push([key, ...args]); };
      } });
      const canvas = { width: 1920, height: 1080, context, getContext: () => context };
      canvases.push(canvas); return canvas;
    };
    const loaded = [];
    function TestImage() { this.naturalWidth = 1920; this.naturalHeight = 1080; }
    Object.defineProperty(TestImage.prototype, 'src', { set(value) { this.url = value; loaded.push(value); queueMicrotask(() => this.onload()); } });
    const front = makeCanvas();
    const sandbox = { setTimeout, clearTimeout, queueMicrotask, Image: TestImage, performance: { now: () => clock },
      requestAnimationFrame: callback => { animation = callback; return 1; }, cancelAnimationFrame: () => { animation = null; },
      document: { getElementById: () => front, createElement: () => makeCanvas(), fonts: { load: () => Promise.resolve() } },
      PORTOS_MV: { render: { width: 1920, height: 1080, fps: 24, durationSec: 2 }, song: { sections: [] }, composition: {},
        scenes: [{ sceneId: 'still', startSec: 0.26, endSec: 2, visualLayer: 'still', imageEffect: { effect: 'end-glitch', changeSec: 0.5 },
          media: { kind: 'image', src: 'start.png', end: { src: 'end.png' } } }] },
      PORTOS_MV_EVENT_STATE: (_song, t) => ({ t, hold: false, activeEvents: [], reactiveGain: 0 }),
      PORTOS_MV_IMAGE_EFFECTS: { imageEffectState, IMAGE_EFFECT_FOG_COLOR },
      PORTOS_LYRIC_TYPE: { createLyricType: () => ({ ready: Promise.resolve(), draw() {} }) }, postMessage() {} };
    sandbox.window = sandbox;
    runInNewContext(await readFile(join(root, 'engine.js'), 'utf8'), sandbox);
    const api = sandbox.portosComposition.previewPlayback;
    const before = 17 / 24;
    await api.prepare({ epoch: 1, t: before });
    await api.play({ epoch: 1, sequence: 1, t: before, workerTime: 0 });
    expect(loaded).toEqual(['start.png', 'end.png']);
    const drawn = () => canvases.flatMap(canvas => canvas.context.calls.filter(call => call[0] === 'drawImage' && call[1] instanceof TestImage).map(call => call[1].url));
    expect(drawn().at(-1)).toBe('start.png');
    clock = 1000 / 24;
    animation();
    expect(drawn().at(-1)).toBe('end.png');
    expect(loaded).toEqual(['start.png', 'end.png']);
    await api.dispose();
  });

  // Uniquely catches one photo-sequence shot dropping the whole document to exact seek (#15609).
  it.each([0, 3])('keeps a photo-sequence document live and swaps each photo in order at its step boundary (overlap %i)', async overlapFrames => {
    const root = await staged();
    const photos = ['p0.png', 'p1.png', 'p2.png'].map(src => ({ src }));
    const photoSequence = scenePhotoSequence({ visualLayer: 'still', startSec: 0, endSec: 2, photoSequence: { imageIds: ['a', 'b', 'c'], intervalFrames: 6, overlapFrames } }, { fps: 24 });
    const scenes = [{ sceneId: 'photos', startSec: 0, endSec: 2, visualLayer: 'still', photoSequence, media: { kind: 'image', src: 'p0.png', photos } }];
    expect(await adaptStagedDocumentPreview(root, { scenes })).toMatchObject({ adapted: true });
    let clock = 0, animation = null;
    const canvases = [], events = [];
    const makeCanvas = () => {
      const calls = [];
      const context = new Proxy({ calls }, { get(target, key) {
        if (key in target) return target[key];
        if (key === 'createImageData' || key === 'getImageData') return (_x, _y, w, h) => ({ data: new Uint8ClampedArray((w || _x) * (h || _y) * 4) });
        if (key === 'measureText') return text => ({ width: String(text).length * 10 });
        if (key === 'createRadialGradient' || key === 'createLinearGradient') return () => ({ addColorStop() {} });
        if (key === 'createPattern') return () => ({});
        return (...args) => { calls.push([key, ...args]); };
      } });
      const canvas = { width: 1920, height: 1080, context, getContext: () => context };
      canvases.push(canvas); return canvas;
    };
    const loaded = [];
    function TestImage() { this.naturalWidth = 1920; this.naturalHeight = 1080; }
    Object.defineProperty(TestImage.prototype, 'src', { set(value) { this.url = value; loaded.push(value); queueMicrotask(() => this.onload()); } });
    const front = makeCanvas();
    const sandbox = { setTimeout, clearTimeout, queueMicrotask, Image: TestImage, performance: { now: () => clock },
      requestAnimationFrame: callback => { animation = callback; return 1; }, cancelAnimationFrame: () => { animation = null; },
      document: { getElementById: () => front, createElement: () => makeCanvas(), fonts: { load: () => Promise.resolve() } },
      PORTOS_MV: { render: { width: 1920, height: 1080, fps: 24, durationSec: 2 }, song: { sections: [] }, composition: {}, scenes },
      PORTOS_MV_EVENT_STATE: (_song, t) => ({ t, hold: false, activeEvents: [], reactiveGain: 0 }),
      PORTOS_MV_IMAGE_EFFECTS: { imageEffectState, IMAGE_EFFECT_FOG_COLOR, photoSequenceIndex, photoSequenceLayers },
      PORTOS_LYRIC_TYPE: { createLyricType: () => ({ ready: Promise.resolve(), draw() {} }) }, postMessage: message => events.push(message) };
    sandbox.window = sandbox;
    runInNewContext(await readFile(join(root, 'engine.js'), 'utf8'), sandbox);
    const api = sandbox.portosComposition.previewPlayback;
    const presented = () => front.context.calls.filter(call => call[0] === 'drawImage').length;
    const shown = [];
    // Each publication copies the backbuffer once; record the photo it drew.
    const record = () => {
      const urls = canvases.flatMap(canvas => canvas.context.calls.filter(call => call[0] === 'drawImage' && call[1] instanceof TestImage).map(call => call[1].url));
      if (presented() > shown.length) shown.push(urls.at(-1));
    };
    await api.prepare({ epoch: 1, t: 0 });
    // Warming the next photos keeps a live step off a cold decode.
    expect(loaded).toEqual(expect.arrayContaining(['p0.png', 'p1.png', 'p2.png']));
    await api.play({ epoch: 1, sequence: 1, t: 0, workerTime: 0 });
    record();
    for (let frame = 1; frame <= 20; frame++) {
      clock = frame * 1000 / 24;
      animation();
      await new Promise(resolve => setTimeout(resolve, 0));
      record();
    }
    expect(events).toEqual([]);
    if (!overlapFrames) {
      // Frames 0-5 show p0, 6-11 p1, 12-17 p2, then the sequence wraps to p0.
      expect(shown).toHaveLength(21);
      expect(shown).toEqual([...Array(6).fill('p0.png'), ...Array(6).fill('p1.png'), ...Array(6).fill('p2.png'), ...Array(3).fill('p0.png')]);
    } else {
      // A stack recomposes when a photo arrives and again when the older one's overlap ends.
      const stack = canvases.find(canvas => canvas.context.calls.some(call => call[0] === 'drawImage' && call[1] instanceof TestImage));
      const groups = [];
      for (const call of stack.context.calls) {
        if (call[0] === 'fillRect') groups.push([]);
        else if (call[0] === 'drawImage' && call[1] instanceof TestImage) groups.at(-1).push(call[1].url);
      }
      expect(groups).toEqual([['p0.png'], ['p0.png', 'p1.png'], ['p1.png'], ['p1.png', 'p2.png'], ['p2.png'], ['p2.png', 'p0.png']]);
    }
    await api.dispose();
  });

  // Uniquely catches one wiped shot dropping the whole document to exact seek, or the
  // live wipe painting a different held/incoming frame than the exact seek (#15611).
  it('keeps a wiped document live and paints each wipe frame exactly as the exact seek does', async () => {
    const root = await staged();
    const wipe = { style: 'iris', frames: 6, cutFrame: 24, fromSceneId: 'out', color: null };
    const scenes = [
      { sceneId: 'out', startSec: 0, endSec: 1, visualLayer: 'still', media: { kind: 'image', src: 'out.png' } },
      { sceneId: 'in', startSec: 1, endSec: 2, visualLayer: 'still', wipe, media: { kind: 'image', src: 'in.png' } },
    ];
    expect(await adaptStagedDocumentPreview(root, { scenes })).toMatchObject({ adapted: true });
    let clock = 0, animation = null;
    // Each context tracks what its pixels last came from, through canvas copies,
    // including the drawn geometry so a camera difference cannot pass.
    const makeCanvas = () => {
      const target = { calls: [], content: null };
      const context = new Proxy(target, { get(_target, key) {
        if (key in target) return target[key];
        if (key === 'createImageData' || key === 'getImageData') return (_x, _y, w, h) => ({ data: new Uint8ClampedArray((w || _x) * (h || _y) * 4) });
        if (key === 'measureText') return text => ({ width: String(text).length * 10 });
        if (key === 'createRadialGradient' || key === 'createLinearGradient') return () => ({ addColorStop() {} });
        if (key === 'createPattern') return () => ({});
        return (...args) => {
          target.calls.push([key, ...args]);
          if (key !== 'drawImage') return;
          if (args[0] instanceof TestImage) target.content = [args[0].url, ...args.slice(1)].join(',');
          else if (args[0]?.context) target.content = args[0].context.content;
        };
      } });
      return { width: 1920, height: 1080, context, getContext: () => context };
    };
    function TestImage() { this.naturalWidth = 1920; this.naturalHeight = 1080; }
    Object.defineProperty(TestImage.prototype, 'src', { set(value) { this.url = value; queueMicrotask(() => this.onload()); } });
    const front = makeCanvas(), events = [], published = [];
    let wiped = [];
    const sandbox = { setTimeout, clearTimeout, queueMicrotask, Image: TestImage, performance: { now: () => clock },
      requestAnimationFrame: callback => { animation = callback; return 1; }, cancelAnimationFrame: () => { animation = null; },
      document: { getElementById: () => front, createElement: () => makeCanvas(), fonts: { load: () => Promise.resolve() } },
      PORTOS_MV: { render: { width: 1920, height: 1080, fps: 24, durationSec: 2 }, song: { sections: [] }, composition: {}, scenes },
      // Frame-quantized time, so both paths draw each frame at the same t.
      PORTOS_MV_EVENT_STATE: (_song, t) => ({ t: Math.floor(t * 24 + 1e-6) / 24, hold: false, activeEvents: [], reactiveGain: 0 }),
      __portosMusicVideoWipe: (_ctx, paint) => wiped.push({ index: paint.index, outgoing: paint.outgoing.context.content,
        incoming: paint.incoming.context.content, held: paint.outgoing }),
      __portosFilmLook: { frame: frame => published.push(frame), playback() {} },
      PORTOS_LYRIC_TYPE: { createLyricType: () => ({ ready: Promise.resolve(), draw() {} }) }, postMessage: message => events.push(message) };
    sandbox.window = sandbox;
    runInNewContext(await readFile(join(root, 'engine.js'), 'utf8'), sandbox);
    const composition = sandbox.portosComposition, api = composition.previewPlayback;
    for (let frame = 20; frame < 34; frame++) await composition.seek(frame / 24);
    const exact = wiped.map(({ held: _held, ...paint }) => paint);
    expect(exact.map(paint => paint.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(exact[0].outgoing).toMatch(/^out\.png,/);
    expect(exact[0].incoming).toMatch(/^in\.png,/);
    wiped = [];
    await api.prepare({ epoch: 1, t: 20 / 24 });
    await api.play({ epoch: 1, sequence: 1, t: 20 / 24, workerTime: 0 });
    for (let step = 1; step < 14; step++) {
      clock = step * 1000 / 24;
      animation();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    expect(events).toEqual([]);
    expect(wiped.map(({ held: _held, ...paint }) => paint)).toEqual(exact);
    // The held frame is prepared once for the wipe, not redrawn per frame.
    expect(new Set(wiped.map(paint => paint.held)).size).toBe(1);
    // Every song frame across the cut publishes once, in order.
    expect(published).toEqual(Array.from({ length: 14 }, (_, k) => 20 + k));
    await api.dispose();
  });
});

function player({ hold = false, quantized = false, inSec = 0, outSec = 5, cutAt = null, fps = 30, autoFirst = true, wipe = null } = {}) {
  let clock = 0, frame = null, time = 0, writes = 0, readyResolve, playResolve, autoFrame = false, frameId = 0, presented = 0, drawMs = 0;
  const callbacks = new Map();
  const frameWaiters = [];
  const events = [], paints = [], modes = [], sourceTimes = [], heldFor = [], scenes = [{ startSec: 0, endSec: cutAt ?? 5, media: { kind: 'video', inSec, outSec, fps } },
    { startSec: cutAt, endSec: 5, media: { kind: 'video', inSec: 0, outSec: 5, fps } }];
  const present = (metadata = {}, callback = callbacks.values().next().value) => callback?.(clock,
    { mediaTime: Math.floor(time * fps + 1e-6) / fps, presentedFrames: ++presented, ...metadata });
  const video = { duration: 5, paused: true, playbackRate: 1, readyState: 4, seeking: false,
    get currentTime() { return time; }, set currentTime(value) { time = value; writes++; },
    pause() { this.paused = true; }, play() { this.paused = false; autoFrame = true; return playResolve ? new Promise(resolve => { playResolve.resolve = resolve; playResolve.enter(); }) : Promise.resolve(); },
    requestVideoFrameCallback(callback) {
      const id = ++frameId;
      callbacks.set(id, (...args) => { callbacks.delete(id); callback(...args); });
      for (const resolve of frameWaiters.splice(0)) resolve();
      if (autoFirst && autoFrame) {
        autoFrame = false;
        Promise.resolve().then(() => { if (callbacks.has(id)) present({}, callbacks.get(id)); });
      }
      return id;
    },
    cancelVideoFrameCallback(id) { callbacks.delete(id); } };
  const bridge = { duration: 5, fps: 24, ready: Promise.resolve(), videos: () => [video], scene: t => cutAt !== null && t >= cutAt ? scenes[1] : scenes[0], needsSource: () => true, playback: on => modes.push(on),
    state: t => ({ t: hold && t >= 0.2 && t < 0.4 ? 0.2 : quantized ? Math.floor(t * 24) / 24 : t, hold: hold && t >= 0.2 && t < 0.4, activeEvents: [], reactiveGain: 0 }),
    async source(scene, t) {
      sourceTimes.push(t);
      if (readyResolve) await new Promise(resolve => { readyResolve.resolve = resolve; readyResolve.enter(); });
      video.currentTime = Math.min(Math.max(scene.media.inSec + t - scene.startSec, scene.media.inSec), scene.media.outSec - 0.5 / 30);
      return video;
    },
    publish(songTime, t, _scene, _source, _state, valid, layers) { if (drawMs) elapse(clock + drawMs); if (!valid()) return false; paints.push({ songTime, t, ...(wipe ? { layers } : {}) }); return true; }, dispose() { video.pause(); } };
  // A wipe window [from, to) on the first scene needs its held layer.
  const wiping = t => wipe && t >= wipe[0] && t < wipe[1];
  if (wipe) Object.assign(bridge, {
    async layers(scene, t) { if (!wiping(t)) return null; heldFor.push(t); return { scene }; },
    layersReady: (scene, t, layers) => !wiping(t) || layers?.scene === scene,
  });
  const sandbox = { setTimeout, clearTimeout, __bridge: bridge, performance: { now: () => clock }, requestAnimationFrame: callback => { frame = callback; return 1; }, cancelAnimationFrame: () => { frame = null; },
    window: { postMessage: message => events.push(message) }, portosComposition: {} };
  runInNewContext(`(${installLayeredPreviewPlayback.toString()})(__bridge)`, sandbox);
  const elapse = (ms) => { const elapsed = (ms - clock) / 1000; if (!video.paused) time += elapsed * video.playbackRate; clock = ms; };
  return { api: sandbox.portosComposition.previewPlayback, video, events, paints, modes, sourceTimes, heldFor, present,
    pendingCallback: () => callbacks.values().next().value,
    waitForFrame: () => callbacks.size ? Promise.resolve() : new Promise(resolve => frameWaiters.push(resolve)),
    get pendingCallbacks() { return callbacks.size; },
    get writes() { return writes; },
    elapse,
    drawCost(ms) { drawMs = ms; },
    async step(ms, { withVideo = true } = {}) { elapse(ms); const callback = frame; frame = null; callback?.(); if (withVideo && !video.paused) present(); await Promise.resolve(); },
    deferSource() {
      readyResolve = {};
      const entered = new Promise(resolve => { readyResolve.enter = resolve; });
      return { entered, release: () => { readyResolve.resolve?.(); readyResolve = null; } };
    },
    deferPlay() {
      playResolve = {};
      const entered = new Promise(resolve => { playResolve.enter = resolve; });
      return Object.assign(() => { playResolve.resolve?.(); playResolve = null; }, { entered });
    } };
}

describe('cooperative preview public runtime lifecycle', () => {
  // Uniquely catches a slow photo load publishing a step the clock already passed.
  it('skips a photo step that passed while loading and publishes the current one in order', async () => {
    let clock = 0, frame = null, gate = null;
    const paints = [], events = [], scene = { startSec: 0, endSec: 5, media: { kind: 'image' } };
    const step = t => Math.floor(t * 20 + 1e-9);
    const bridge = { duration: 5, fps: 24, ready: Promise.resolve(), videos: () => [], scene: () => scene, needsSource: () => true, playback() {},
      state: t => ({ t, hold: false, activeEvents: [], reactiveGain: 0 }),
      async source(_scene, t) { if (gate) await gate.promise; return { step: step(t) }; },
      sourceKey: (_scene, t) => String(step(t)),
      publish(songTime, _t, _scene, source, _state, valid) { if (!valid()) return false; paints.push({ songTime, step: source.step }); return true; },
      dispose() {} };
    const sandbox = { setTimeout, clearTimeout, __bridge: bridge, performance: { now: () => clock }, requestAnimationFrame: callback => { frame = callback; return 1; }, cancelAnimationFrame: () => { frame = null; },
      window: { postMessage: message => events.push(message) }, portosComposition: {} };
    runInNewContext(`(${installLayeredPreviewPlayback.toString()})(__bridge)`, sandbox);
    const api = sandbox.portosComposition.previewPlayback;
    const tick = (ms) => { clock = ms; const callback = frame; frame = null; callback?.(); };
    await api.prepare({ epoch: 1, t: 0 });
    await api.play({ epoch: 1, sequence: 1, t: 0, workerTime: 0 });
    tick(20); tick(40);
    expect(paints.map(paint => paint.step)).toEqual([0, 0, 0]);
    let release;
    gate = { promise: new Promise(resolve => { release = resolve; }) };
    tick(60); // Step 1 begins; its photo is slow to load.
    tick(80);
    clock = 110; // Step 2 begins before step 1's photo arrives.
    gate = null; release();
    await vi.waitFor(() => expect(paints.at(-1).step).toBe(2));
    expect(paints.map(paint => paint.step)).toEqual([0, 0, 0, 2]);
    expect(events).toEqual([]);
    tick(145); // The next 30 fps frame of step 2.
    tick(160); // Step 3 arrives.
    await vi.waitFor(() => expect(paints.map(paint => paint.step)).toEqual([0, 0, 0, 2, 2, 3]));
    await api.dispose();
  });

  it('publishes each fresh video callback independent of RAF/audio phase and never republishes video on RAF alone', async () => {
    const p = player();
    await p.api.prepare({ epoch: 1, t: 0 });
    await p.api.play({ epoch: 1, sequence: 1, t: 0, workerTime: 0 });
    const first = p.paints.length;
    await p.step(16, { withVideo: false }); await p.step(32, { withVideo: false });
    expect(p.paints).toHaveLength(first);
    for (const time of [35, 68, 101]) await p.step(time);
    expect(p.paints).toHaveLength(first + 3);
    expect(p.pendingCallbacks).toBe(1);
    await p.api.pause({ epoch: 2 });
    expect(p.pendingCallbacks).toBe(0);
  });

  // Uniquely catches a live video frame painting a wipe without its held layer (#15611).
  it('reloads once when a wipe needs its held layer, then publishes every video frame with it', async () => {
    const p = player({ wipe: [0.1, 0.2] });
    await p.api.prepare({ epoch: 1, t: 0 });
    await p.api.play({ epoch: 1, sequence: 1, t: 0, workerTime: 0 });
    for (let time = 33; time <= 330; time += 33) { await p.step(time); await new Promise(resolve => setTimeout(resolve, 0)); }
    expect(p.events).toEqual([]);
    expect(p.heldFor).toHaveLength(1);
    const during = p.paints.filter(paint => paint.t >= 0.1 && paint.t < 0.2);
    expect(during.length).toBeGreaterThan(1);
    expect(during.every(paint => paint.layers)).toBe(true);
    expect(p.paints.filter(paint => paint.t < 0.1).every(paint => !paint.layers)).toBe(true);
    expect(p.paints.some(paint => paint.t >= 0.2)).toBe(true);
    expect(p.paints.map(paint => paint.songTime)).toEqual(p.paints.map(paint => paint.songTime).sort((a, b) => a - b));
    await p.api.dispose();
  });

  it('caps a faster source by source-time bins while preserving native 24 fps and holds', async () => {
    const p = player({ fps: 60 });
    await p.api.prepare({ epoch: 1, t: 0 }); await p.api.play({ epoch: 1, sequence: 1, t: 0, workerTime: 0 });
    const first = p.paints.length;
    for (const time of [17, 34, 51, 68]) await p.step(time);
    expect(p.paints).toHaveLength(first + 2);
    await p.api.dispose();

    const held = player({ fps: 24, hold: true });
    await held.api.prepare({ epoch: 1, t: 0 }); await held.api.play({ epoch: 1, sequence: 1, t: 0, workerTime: 0 });
    const before = held.paints.length;
    await held.step(43); await held.step(85);
    expect(held.paints).toHaveLength(before + 2);
    const old = held.pendingCallback();
    await held.step(210);
    expect(held.video.paused).toBe(true);
    expect(held.pendingCallbacks).toBe(0);
    await held.step(250);
    await vi.waitFor(async () => {
      await held.step(300);
      expect(held.paints.at(-1).t).toBe(0.2);
      expect(held.paints.at(-1).songTime).toBeCloseTo(0.3);
    }, { timeout: 500, interval: 1 });
    expect(held.events).toHaveLength(0);
    await vi.waitFor(async () => {
      await held.step(410, { withVideo: false });
      expect(held.pendingCallbacks).toBe(1);
      expect(held.paints.at(-1).songTime).toBeCloseTo(0.41);
    }, { timeout: 500, interval: 1 });
    expect(held.video.paused).toBe(false);
    expect(held.sourceTimes.at(-1)).toBe(0.41);
    const afterHold = held.paints.length;
    held.present({ mediaTime: 0.1, presentedFrames: 0 }, old);
    expect(held.paints).toHaveLength(afterHold);
    expect(held.pendingCallbacks).toBe(1);
    await held.api.dispose();
  });

  it('requires a first qualified publication within its separate deadline and immediately settles cancellation', async () => {
    vi.useFakeTimers();
    try {
      const p = player({ autoFirst: false });
      await p.api.prepare({ epoch: 1, t: 0 });
      const playing = p.api.play({ epoch: 1, sequence: 1, t: 0, workerTime: 0 });
      await p.waitForFrame();
      expect(p.paints).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(await playing).toMatchObject({ status: 'resync-required' });
      expect(p.pendingCallbacks).toBe(0);
      expect(p.video.paused).toBe(true);
      expect(p.events).toHaveLength(1);
      await p.api.prepare({ epoch: 2, t: 0 });
      const second = p.api.play({ epoch: 2, sequence: 1, t: 0, workerTime: 0 });
      await p.waitForFrame();
      const late = p.pendingCallback();
      const paused = p.api.pause({ epoch: 3 });
      expect(await second).toMatchObject({ status: 'superseded' });
      await paused;
      const paints = p.paints.length;
      p.present({ mediaTime: 0, presentedFrames: 1 }, late);
      expect(p.paints).toHaveLength(paints);
      expect(p.pendingCallbacks).toBe(0);
      await p.api.prepare({ epoch: 3, t: 0 });
      const third = p.api.play({ epoch: 3, sequence: 1, t: 0, workerTime: 0 });
      await p.waitForFrame();
      const disposed = p.api.dispose();
      expect(await third).toMatchObject({ status: 'superseded' });
      await disposed;
      expect(p.pendingCallbacks).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('rejects stale metadata even when currentTime advances, and duplicate callbacks do not refresh silence', async () => {
    const p = player();
    await p.api.prepare({ epoch: 1, t: 0 }); await p.api.play({ epoch: 1, sequence: 1, t: 0, workerTime: 0 });
    const first = p.paints.length;
    await p.step(80, { withVideo: false });
    p.present({ mediaTime: 0, presentedFrames: 1 });
    expect(p.paints).toHaveLength(first);
    await p.step(101, { withVideo: false });
    expect(p.events).toEqual([expect.objectContaining({ type: 'portos-mv:playback-resync' })]);
    expect(p.video.paused).toBe(true);
    expect(p.pendingCallbacks).toBe(0);
    await p.api.dispose();

    const stale = player();
    await stale.api.prepare({ epoch: 1, t: 0 }); await stale.api.play({ epoch: 1, sequence: 1, t: 0, workerTime: 0 });
    await stale.step(90, { withVideo: false });
    stale.present({ mediaTime: 0.001, presentedFrames: 2 });
    await stale.step(180, { withVideo: false });
    stale.present({ mediaTime: 0.002, presentedFrames: 3 });
    expect(stale.events).toHaveLength(1); // currentTime is on target; decoded metadata is >100 ms old.
    expect(stale.video.paused).toBe(true);
    await stale.api.dispose();
  });

  it('rejects an expired first or steady callback even if fresh metadata arrives before delayed timers and RAF', async () => {
    vi.useFakeTimers();
    try {
      for (const autoFirst of [false, true]) {
        const p = player({ autoFirst });
        await p.api.prepare({ epoch: 1, t: 0 });
        const playing = p.api.play({ epoch: 1, sequence: 1, t: 0, workerTime: 0 });
        await p.waitForFrame();
        if (autoFirst) expect(await playing).toMatchObject({ status: 'playing' });
        const paints = p.paints.length;
        p.elapse(100); // No RAF or timer queue is flushed before this callback.
        p.present({ mediaTime: 0.1, presentedFrames: 2 });
        if (!autoFirst) expect(await playing).toMatchObject({ status: 'resync-required' });
        expect(p.paints).toHaveLength(paints);
        expect(p.events).toEqual([expect.objectContaining({ type: 'portos-mv:playback-resync' })]);
        expect(p.pendingCallbacks).toBe(0);
        expect(p.video.paused).toBe(true);
        await p.api.dispose();
      }
    } finally { vi.useRealTimers(); }
  });

  it('enforces anchor silence in a video callback before an overdue RAF can run', async () => {
    const p = player();
    await p.api.prepare({ epoch: 1, t: 0 }); await p.api.play({ epoch: 1, sequence: 1, t: 0, workerTime: 0 });
    for (let i = 1; i <= 29; i++) { p.elapse(i * 34); p.present(); }
    const paints = p.paints.length;
    expect(p.events).toHaveLength(0);
    p.elapse(1020); p.present(); // Fresh source and callback gap34ms, but no accepted audio anchor for>1s.
    expect(p.paints).toHaveLength(paints);
    expect(p.events).toEqual([expect.objectContaining({ type: 'portos-mv:playback-resync' })]);
    expect(p.pendingCallbacks).toBe(0);
    expect(p.video.paused).toBe(true);
    await p.api.dispose();
  });

  it('requests gated resync if RAF reaches another scene before the first qualified video publication', async () => {
    const p = player({ autoFirst: false, cutAt: 0.05 });
    await p.api.prepare({ epoch: 1, t: 0 });
    const playing = p.api.play({ epoch: 1, sequence: 1, t: 0, workerTime: 0 });
    await p.waitForFrame();
    await p.step(60, { withVideo: false });
    expect(await playing).toMatchObject({ status: 'resync-required' });
    expect(p.sourceTimes).toEqual([0, 0]); // No hidden second alignment under the pending play.
    expect(p.paints).toHaveLength(1);
    expect(p.pendingCallbacks).toBe(0);
    expect(p.video.paused).toBe(true);
    await p.api.dispose();
  });

  it('rejects invalid metadata and retired callbacks while resetting baselines only for a new scene owner', async () => {
    const p = player({ cutAt: 0.2, autoFirst: false });
    await p.api.prepare({ epoch: 1, t: 0 });
    const playing = p.api.play({ epoch: 1, sequence: 1, t: 0, workerTime: 0 });
    await p.waitForFrame(); p.present({ mediaTime: 0, presentedFrames: 100 }); await playing;
    const old = p.pendingCallback();
    await p.step(210, { withVideo: false }); await p.waitForFrame();
    p.present({ mediaTime: 0, presentedFrames: 1 });
    const paints = p.paints.length;
    p.present({ mediaTime: 0.2, presentedFrames: 101 }, old);
    expect(p.paints).toHaveLength(paints);
    expect(p.pendingCallbacks).toBe(1);
    p.present({ mediaTime: 0.001, presentedFrames: 0 });
    expect(p.events).toEqual([expect.objectContaining({ type: 'portos-mv:playback-resync' })]);
    expect(p.pendingCallbacks).toBe(0);
    await p.api.dispose();

    const missing = player({ autoFirst: false });
    await missing.api.prepare({ epoch: 1, t: 0 });
    const first = missing.api.play({ epoch: 1, sequence: 1, t: 0, workerTime: 0 });
    await missing.waitForFrame(); missing.present({ mediaTime: undefined });
    expect(await first).toMatchObject({ status: 'resync-required' });
    expect(missing.pendingCallbacks).toBe(0);
    expect(missing.video.paused).toBe(true);
    await missing.api.dispose();
  });

  it('does not report exact-safe pause when a superseded scene preparation times out', async () => {
    vi.useFakeTimers();
    try {
      const p = player({ hold: true });
      await p.api.prepare({ epoch: 1, t: 0 });
      await p.api.play({ epoch: 1, sequence: 1, t: 0, workerTime: 0 });
      const gate = p.deferSource();
      await p.step(210); await gate.entered;
      const paused = p.api.pause({ epoch: 2 });
      const rejected = expect(paused).rejects.toMatchObject({ code: 'PLAYBACK_FAILED' });
      await vi.advanceTimersByTimeAsync(3001); await rejected;
      expect(() => p.api.prepare({ epoch: 3, t: 0 })).toThrow('PLAYBACK_FAILED');
      expect(p.video.paused).toBe(true);
      gate.release(); await p.api.dispose();
      expect(p.events).toHaveLength(0); // Superseded epoch does not emit a false current-epoch event.
    } finally { vi.useRealTimers(); }
  });

  it('resynchronizes a stalled transition at100ms despite fresh anchors while retaining owned source retirement', async () => {
    vi.useFakeTimers();
    try {
      const p = player({ hold: true });
      await p.api.prepare({ epoch: 1, t: 0 }); await p.api.play({ epoch: 1, sequence: 1, t: 0, workerTime: 0 });
      const gate = p.deferSource(), paints = p.paints.length;
      await p.step(210); await gate.entered;
      p.elapse(260);
      expect(p.api.sync({ epoch: 1, sequence: 2, t: 0.26, workerTime: 260 })).toMatchObject({ status: 'accepted' });
      p.elapse(310);
      await vi.advanceTimersByTimeAsync(100); // No RAF or source completion is needed to stop stale output.
      expect(p.events).toEqual([expect.objectContaining({ type: 'portos-mv:playback-resync', epoch: 1, sequence: 2 })]);
      expect(p.video.paused).toBe(true);
      expect(p.pendingCallbacks).toBe(0);
      let retired = false;
      const paused = p.api.pause({ epoch: 2 }).then(result => { retired = true; return result; });
      await Promise.resolve(); expect(retired).toBe(false);
      gate.release(); expect(await paused).toMatchObject({ status: 'paused' });
      expect(p.paints).toHaveLength(paints);
      expect(await p.api.prepare({ epoch: 2, t: 0.4 })).toMatchObject({ status: 'prepared' });
      await p.api.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('starts the shared transition deadline when a video callback observes a new mapping before RAF', async () => {
    vi.useFakeTimers();
    try {
      const p = player({ cutAt: 0.2 });
      await p.api.prepare({ epoch: 1, t: 0 }); await p.api.play({ epoch: 1, sequence: 1, t: 0, workerTime: 0 });
      for (const time of [70, 140]) { p.elapse(time); p.present(); }
      const paints = p.paints.length;
      p.elapse(210); p.present(); // RAF never runs to adopt this mapping change.
      expect(p.video.paused).toBe(true);
      p.elapse(260);
      expect(p.api.sync({ epoch: 1, sequence: 2, t: 0.26, workerTime: 260 })).toMatchObject({ status: 'accepted' });
      p.elapse(310); await vi.advanceTimersByTimeAsync(100);
      expect(p.events).toEqual([expect.objectContaining({ type: 'portos-mv:playback-resync' })]);
      expect(p.paints).toHaveLength(paints);
      expect(p.sourceTimes).toEqual([0, 0]);
      expect(p.pendingCallbacks).toBe(0);
      await p.api.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('keeps the original transition deadline through a new video first-frame wait', async () => {
    const p = player({ cutAt: 0.2, autoFirst: false });
    await p.api.prepare({ epoch: 1, t: 0 });
    const playing = p.api.play({ epoch: 1, sequence: 1, t: 0, workerTime: 0 });
    await p.waitForFrame(); p.present({ mediaTime: 0, presentedFrames: 1 }); await playing;
    const gate = p.deferSource(), paints = p.paints.length;
    await p.step(210, { withVideo: false }); await gate.entered;
    p.elapse(290); gate.release(); await p.waitForFrame();
    p.elapse(310); p.present({ mediaTime: 0.1, presentedFrames: 2 }); // Fresh callback20ms after arm, but transition age100ms.
    expect(p.events).toEqual([expect.objectContaining({ type: 'portos-mv:playback-resync' })]);
    expect(p.paints).toHaveLength(paints);
    expect(p.pendingCallbacks).toBe(0);
    await p.api.pause({ epoch: 2 }); await p.api.dispose();
  });

  it('refuses a late static transition commit after backbuffer drawing crosses the freshness deadline', async () => {
    const p = player({ hold: true });
    await p.api.prepare({ epoch: 1, t: 0 }); await p.api.play({ epoch: 1, sequence: 1, t: 0, workerTime: 0 });
    const paints = p.paints.length;
    p.drawCost(100);
    await p.step(210, { withVideo: false });
    await vi.waitFor(() => expect(p.events).toEqual([expect.objectContaining({ type: 'portos-mv:playback-resync' })]));
    expect(p.paints).toHaveLength(paints);
    expect(p.video.paused).toBe(true);
    await p.api.pause({ epoch: 2 }); await p.api.dispose();
  });

  it('bounds an unsettled native play, poisons reuse, and pauses a late completion', async () => {
    vi.useFakeTimers();
    try {
      const p = player();
      await p.api.prepare({ epoch: 1, t: 0 });
      const finish = p.deferPlay();
      const playing = p.api.play({ epoch: 1, sequence: 1, t: 0, workerTime: 0 });
      await finish.entered;
      const rejected = expect(playing).rejects.toMatchObject({ code: 'PLAYBACK_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(1501); await rejected;
      expect(p.video.paused).toBe(true);
      expect(() => p.api.prepare({ epoch: 2, t: 0 })).toThrow('PLAYBACK_FAILED');
      finish(); await p.api.dispose();
      expect(p.video.paused).toBe(true);
      expect(p.events).toEqual([expect.objectContaining({ type: 'portos-mv:playback-error', epoch: 1 })]);
    } finally { vi.useRealTimers(); }
  });

  it('uses native forward playback without per-frame seeks, rejects old anchors, and stops when anchors disappear', async () => {
    const p = player();
    expect(await p.api.prepare({ epoch: 1, t: 0 })).toMatchObject({ status: 'prepared' });
    expect(await p.api.play({ epoch: 1, sequence: 1, t: 0, workerTime: 0 })).toMatchObject({ status: 'playing' });
    const initialWrites = p.writes;
    for (const time of [34, 68, 102, 136]) await p.step(time);
    expect(p.paints.length).toBeGreaterThanOrEqual(5);
    expect(p.writes).toBe(initialWrites);
    expect(p.modes).toEqual([false, true]);
    expect(p.api.sync({ epoch: 0, sequence: 999, t: 1, workerTime: 136 })).toMatchObject({ status: 'stale' });
    expect(p.api.sync({ epoch: 1, sequence: 2, t: 0.156, workerTime: 136 })).toMatchObject({ status: 'accepted' });
    expect(p.writes).toBe(initialWrites);
    await p.step(1137);
    expect(p.video.paused).toBe(true);
    expect(p.modes).toEqual([false, true, false]);
    expect(p.events).toEqual([expect.objectContaining({ type: 'portos-mv:playback-resync', epoch: 1, sequence: 2 })]);
    await p.step(1237); expect(p.events).toHaveLength(1);
  });

  it('retires late preparation/play before exact pause and permits the next client epoch', async () => {
    const p = player(), gate = p.deferSource();
    const preparing = p.api.prepare({ epoch: 2, t: 0.5 });
    // Wait on the actual source-entry handshake rather than guessed microtask counts.
    await gate.entered;
    const paused = p.api.pause({ epoch: 3 }); gate.release();
    expect(await preparing).toMatchObject({ status: 'superseded' });
    expect(await paused).toMatchObject({ status: 'paused' });
    expect(p.paints).toHaveLength(0);
    expect(await p.api.prepare({ epoch: 3, t: 0.75 })).toMatchObject({ status: 'prepared' });
    const finishPlay = p.deferPlay();
    const playing = p.api.play({ epoch: 3, sequence: 1, t: 0.75, workerTime: 0 });
    await finishPlay.entered;
    const stopped = p.api.pause({ epoch: 4 }); finishPlay();
    expect(await playing).toMatchObject({ status: 'superseded' }); await stopped;
    expect(p.video.paused).toBe(true);
    expect(p.modes).toEqual([false]); // A cancelled native play never re-enables motion.
    expect(await p.api.prepare({ epoch: 4, t: 1 })).toMatchObject({ status: 'prepared' });
    await p.api.dispose();
    expect(() => p.api.prepare({ epoch: 5, t: 1 })).toThrow('PLAYBACK_DISPOSED');
  });

  it('aligns the warm live source once to running audio, then starts a fresh clock at native rate', async () => {
    const p = player({ quantized: true, inSec: 1 });
    await p.api.prepare({ epoch: 1, t: 0 });
    const gate = p.deferSource();
    const playing = p.api.play({ epoch: 1, sequence: 1, t: 0.18, workerTime: 0 });
    await gate.entered; await p.step(25); gate.release();
    expect(await playing).toMatchObject({ status: 'playing', t: 0.205 });
    expect(p.sourceTimes).toEqual([0, 0.18]); // Source uses song time; drawing remains on its 24 fps grid.
    expect(p.video.currentTime).toBeCloseTo(1.18);
    expect(p.video.playbackRate).toBe(1);
    expect(p.api.sync({ epoch: 1, sequence: 2, t: 0.205, workerTime: 25 })).toMatchObject({ status: 'accepted', driftSec: 0 });
    const writes = p.writes;
    await p.step(59); await p.step(93);
    expect(p.writes).toBe(writes);
    expect(p.video.playbackRate).toBe(1);
    expect(p.paints.at(-1).songTime).toBeCloseTo(0.273);
    expect(p.paints.at(-1).t).toBe(0.25);
    await p.api.dispose();
  });

  it('rejects slow warm source work without publishing, starting media, or retrying the alignment', async () => {
    const p = player();
    await p.api.prepare({ epoch: 1, t: 0 });
    const gate = p.deferSource();
    const playing = p.api.play({ epoch: 1, sequence: 1, t: 0.18, workerTime: 0 });
    await gate.entered; await p.step(1000); gate.release();
    expect(await playing).toMatchObject({ status: 'resync-required' });
    expect(p.sourceTimes).toEqual([0, 0.18]);
    expect(p.paints).toHaveLength(1);
    expect(p.video.paused).toBe(true);
    expect(p.modes).toEqual([false]);
    expect(p.events).toEqual([expect.objectContaining({ type: 'portos-mv:playback-resync', epoch: 1 })]);
    await p.api.dispose();
  });

  it('requires the aligned scene and decoded media to remain usable through native play completion', async () => {
    const p = player({ cutAt: 0.25 });
    await p.api.prepare({ epoch: 1, t: 0 });
    const finish = p.deferPlay();
    const playing = p.api.play({ epoch: 1, sequence: 1, t: 0.24, workerTime: 0 });
    await finish.entered; await p.step(25); finish();
    expect(await playing).toMatchObject({ status: 'resync-required' });
    expect(p.sourceTimes).toEqual([0, 0.24]);
    expect(p.video.paused).toBe(true);
    expect(p.modes).toEqual([false]);
    expect(p.paints).toHaveLength(1);
    await p.api.dispose();

    const unavailable = player();
    await unavailable.api.prepare({ epoch: 1, t: 0 });
    unavailable.video.readyState = 1;
    expect(await unavailable.api.play({ epoch: 1, sequence: 1, t: 0.18, workerTime: 0 })).toMatchObject({ status: 'resync-required' });
    expect(unavailable.video.paused).toBe(true);
    await unavailable.api.dispose();
  });

  it('retires a canceled warm alignment before exact pause and preserves frozen narrative source time', async () => {
    const p = player({ hold: true, quantized: true });
    await p.api.prepare({ epoch: 1, t: 0 });
    const gate = p.deferSource();
    const playing = p.api.play({ epoch: 1, sequence: 1, t: 0.18, workerTime: 0 });
    await gate.entered;
    const paused = p.api.pause({ epoch: 2 }); gate.release();
    expect(await playing).toMatchObject({ status: 'superseded' });
    expect(await paused).toMatchObject({ status: 'paused' });
    expect(p.video.paused).toBe(true);
    expect(p.modes).toEqual([false]);
    await p.api.prepare({ epoch: 2, t: 0.25 });
    expect(await p.api.play({ epoch: 2, sequence: 1, t: 0.25, workerTime: 0 })).toMatchObject({ status: 'playing' });
    expect(p.sourceTimes.at(-1)).toBe(0.2);
    expect(p.video.paused).toBe(true);
    const writes = p.writes;
    await p.step(34); await p.step(68);
    expect(p.writes).toBe(writes);
    expect(p.paints.at(-1)).toMatchObject({ t: 0.2 });
    expect(p.paints.at(-1).songTime).toBeCloseTo(0.318);
    await p.api.dispose();
  });

  it('uses live song time at the staged output boundary even before the next drawing frame', async () => {
    const p = player({ quantized: true, outSec: 0.11 });
    await p.api.prepare({ epoch: 1, t: 0 });
    await p.api.play({ epoch: 1, sequence: 1, t: 0.085, workerTime: 0 });
    expect(p.video.paused).toBe(false);
    await p.step(10);
    expect(p.video.paused).toBe(true);
    expect(p.sourceTimes.at(-1)).toBeCloseTo(0.095);
    expect(p.video.currentTime).toBeCloseTo(0.11 - 0.5 / 30);
    await p.api.pause({ epoch: 2 });
    expect(p.events).toHaveLength(0);
    await p.api.dispose();
  });

  it('pauses native media for narrative holds and requires gated resync for a large audio mismatch', async () => {
    const p = player({ hold: true });
    await p.api.prepare({ epoch: 1, t: 0 }); await p.api.play({ epoch: 1, sequence: 1, t: 0, workerTime: 0 });
    await p.step(210); await Promise.resolve();
    expect(p.video.paused).toBe(true);
    const writes = p.writes;
    await p.step(250); await p.step(300);
    expect(p.writes).toBe(writes);
    expect(p.api.sync({ epoch: 1, sequence: 2, t: 1, workerTime: 300 })).toMatchObject({ status: 'resync-required' });
    expect(p.writes).toBe(writes);
    expect(p.video.paused).toBe(true);
  });
});
