import { afterAll, describe, expect, it, vi } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { narrativeFrameState } from '../../lib/musicVideoNarrativeEvents.js';
import { adaptStagedDocumentPreview } from './documentPreviewPlayback.js';
import { installLayeredPreviewPlayback } from './previewPlaybackRuntime.js';

const roots = [];
const templates = fileURLToPath(new URL('./documentTemplates/', import.meta.url));
const historicalFixtures = new URL('./fixtures/layered9581/', import.meta.url);
const historicalFiles = { 'engine.js': 'engine.txt', 'index.html': 'index.html.txt', 'lyricType.js': 'lyricType.txt' };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function staged() {
  const root = await mkdtemp(join(tmpdir(), 'preview-playback-contract-')); roots.push(root);
  await cp(join(templates, 'layered'), root, { recursive: true });
  await cp(join(templates, 'shared'), root, { recursive: true });
  await cp(new URL('../../lib/musicVideoImageEffects.js', import.meta.url), join(root, 'musicVideoImageEffects.js'));
  return root;
}
async function historicalStaged() {
  const root = await staged();
  for (const [name, fixture] of Object.entries(historicalFiles)) {
    await cp(new URL(fixture, historicalFixtures), join(root, name));
  }
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
});

describe('one historical starter graph', () => {
  it('preserves original source, exact seek and inert files while adapting only the owned copy', async () => {
    const root = await historicalStaged();
    const original = await readFile(join(root, 'engine.js'));
    const index = await readFile(join(root, 'index.html'));
    const lyric = await readFile(join(root, 'lyricType.js'));
    await writeFile(join(root, 'generated.js'), '/* Inert: the historical index never loads this file. */');
    const inert = await readFile(join(root, 'generated.js'));
    const effects = await readFile(join(root, 'musicVideoImageEffects.js'));
    expect(sha256(original)).toBe('9581bb2d190e62ea2eb6a709bc989b1f913c501236554cd0301379877dc8a5fc');
    const text = original.toString(), start = text.indexOf('    async seek(t,');
    const exact = text.slice(start, text.indexOf('\n    },', start) + '\n    },'.length);
    expect(sha256(exact)).toBe('c8ac135592ac2bf56736f227ef0cb6cc46d3cf68a37a2b1b775f265246cead34');
    expect(await adaptStagedDocumentPreview(root)).toMatchObject({ adapted: true, originalEngineSha256: sha256(original) });
    expect(await readFile(join(root, 'engine.js'), 'utf8')).toContain(exact);
    for (const [name, bytes] of [['index.html', index], ['lyricType.js', lyric], ['generated.js', inert], ['musicVideoImageEffects.js', effects]]) {
      expect(await readFile(join(root, name))).toEqual(bytes);
    }
    expect(await readFile(new URL('engine.txt', historicalFixtures))).toEqual(original);
  });

  it.each(['engine.js', 'index.html', 'cameraRig.js', 'lyricType.js', 'lyricType.css',
    'fonts/big-shoulders-stencil-display-900.woff2', 'fonts/ibm-plex-mono-400.woff2',
    'fonts/ibm-plex-mono-600.woff2', 'fonts/ibm-plex-sans-condensed-500.woff2',
    'fonts/ibm-plex-sans-condensed-700.woff2', 'fonts/archivo-variable.woff2', 'fonts/ibm-plex-mono-500.woff2'])(
    'declines a raw-byte change to active graph member %s before writing', async name => {
      const root = await historicalStaged();
      await writeFile(join(root, name), Buffer.concat([await readFile(join(root, name)), Buffer.from('\n')]));
      const original = await readFile(join(root, 'engine.js'));
      expect(await adaptStagedDocumentPreview(root)).toMatchObject({ adapted: false });
      expect(await readFile(join(root, 'engine.js'))).toEqual(original);
    },
  );

  it('declines mixed current lyrics, generated entrypoints, other old engines and missing assets', async () => {
    const root = await historicalStaged(), original = await readFile(join(root, 'engine.js'));
    await cp(join(templates, 'shared/lyricType.js'), join(root, 'lyricType.js'));
    expect(await adaptStagedDocumentPreview(root)).toMatchObject({ adapted: false, reason: 'custom-helper' });
    await cp(new URL('lyricType.txt', historicalFixtures), join(root, 'lyricType.js'));
    const index = await readFile(join(root, 'index.html'), 'utf8');
    await writeFile(join(root, 'index.html'), index.replace('<script src="engine.js">', '<script src="generated.js"></script><script src="engine.js">'));
    expect(await adaptStagedDocumentPreview(root)).toMatchObject({ adapted: false, reason: 'custom-entrypoint' });
    await writeFile(join(root, 'index.html'), index);
    await rm(join(root, 'fonts/archivo-variable.woff2'));
    expect(await adaptStagedDocumentPreview(root)).toMatchObject({ adapted: false, reason: 'missing-helper' });
    expect(await readFile(join(root, 'engine.js'))).toEqual(original);
    const other = await readFile(new URL('../../routes/fixtures/musicVideoLayeredEngine.txt', import.meta.url));
    await writeFile(join(root, 'engine.js'), other);
    expect(await adaptStagedDocumentPreview(root)).toMatchObject({ adapted: false, reason: 'unrecognized-engine' });
    expect(await readFile(join(root, 'engine.js'))).toEqual(other);
    await writeFile(join(root, 'engine.js'), original.toString().replace(/\n/g, '\r\n'));
    expect(await adaptStagedDocumentPreview(root)).toMatchObject({ adapted: false, reason: 'unrecognized-engine' });
  });

  it('draws actual historical lyrics and ignores image effects in both exact and cooperative frames', async () => {
    const root = await historicalStaged(), exactEngine = await readFile(join(root, 'engine.js'), 'utf8');
    expect(await adaptStagedDocumentPreview(root)).toMatchObject({ adapted: true });
    const camera = await readFile(join(root, 'cameraRig.js'), 'utf8');
    const lyrics = await readFile(join(root, 'lyricType.js'), 'utf8');
    const loaded = [];
    function runtime(engine) {
      const canvases = [];
      const makeCanvas = () => {
        const calls = [];
        const target = { calls, globalAlpha: 1, filter: 'none' };
        const context = new Proxy(target, { get(object, name) {
          if (name in object) return object[name];
          if (name === 'measureText') return text => ({ width: String(text).length * 10 });
          if (name === 'createImageData' || name === 'getImageData') return (a, b, w, h) => ({ data: new Uint8ClampedArray((w || a) * (h || b) * 4) });
          if (name === 'createLinearGradient' || name === 'createRadialGradient') return () => ({ addColorStop() {} });
          if (name === 'createPattern') return () => ({});
          return (...args) => calls.push({ name, args, font: object.font, filter: object.filter });
        } });
        const canvas = { width: 1920, height: 1080, context, getContext: () => context };
        target.canvas = canvas; canvases.push(canvas); return canvas;
      };
      const front = makeCanvas(), finish = [], titles = [];
      const data = { render: { width: 1920, height: 1080, fps: 24, durationSec: 5 }, composition: {},
        song: { beats: [0, 1, 2, 3, 4], sections: [{ id: 'verse', label: 'Verse', startSec: 0, endSec: 5 }],
          narrativeEvents: [{ kind: 'silence', startFrame: 48, endFrame: 72 }] },
        lyrics: [{ text: 'Old words', role: 'hook', startSec: 0.1, endSec: 3.5,
          words: [{ w: 'Old', startSec: 0.1, endSec: 0.5 }, { w: 'words', startSec: 0.5, endSec: 3.5 }] }],
        scenes: [{ sceneId: 'still', startSec: 0, endSec: 5, visualLayer: 'still',
          media: { kind: 'image', src: 'media/still.png' }, imageEffect: 'flash-develop', camera: { move: 'slow-dolly-in', speed: 1 } }] };
      const sandbox = { setTimeout, clearTimeout, performance: { now: () => 0 }, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
        Image: function Image() { this.naturalWidth = 640; this.naturalHeight = 360;
          Object.defineProperty(this, 'src', { set(value) { loaded.push(value); queueMicrotask(() => this.onload()); } }); },
        document: { getElementById: () => front, createElement: () => makeCanvas(), fonts: { load: () => Promise.resolve() } },
        PORTOS_MV: data, PORTOS_MV_EVENT_STATE: narrativeFrameState, postMessage() {},
        __portosFilmLook: { frame: t => finish.push(t), playback() {} }, __portosTitleCard: { draw: t => titles.push(t) } };
      sandbox.window = sandbox;
      runInNewContext(camera, sandbox);
      runInNewContext(`'use strict';\n${lyrics.replace(/^export /gm, '')}`, sandbox);
      runInNewContext(engine, sandbox);
      return { front, canvases, sandbox, finish, titles };
    }
    const control = runtime(exactEngine), adapted = runtime(await readFile(join(root, 'engine.js'), 'utf8'));
    const api = adapted.sandbox.portosComposition.previewPlayback;
    try {
      const summarize = canvas => canvas.context.calls.filter(call => ['fillText', 'strokeText', 'drawImage'].includes(call.name))
        .map(call => ({ ...call, args: call.args.map(arg => arg && typeof arg === 'object' ? 'drawable' : arg) }));
      for (const [index, t] of [0.25, 1.25, 2.6].entries()) {
        control.front.context.calls.length = 0;
        for (const canvas of adapted.canvases) canvas.context.calls.length = 0;
        await control.sandbox.portosComposition.seek(t);
        await api.prepare({ epoch: index + 1, t });
        const back = adapted.canvases.find(canvas => canvas.context.calls.some(call => call.name === 'reset'));
        expect(summarize(back)).toEqual(summarize(control.front));
        expect(back.context.calls.some(call => call.name === 'fillText' && /Old|words/i.test(call.args[0]))).toBe(true);
        expect(back.context.calls.filter(call => call.name === 'drawImage').every(call => call.filter === 'none')).toBe(true);
      }
      const line = adapted.sandbox.PORTOS_LYRIC_TYPE.createLyricType(adapted.sandbox.PORTOS_MV).lines[0];
      expect(line.zone).toBe('center');
      expect(adapted.finish.at(-1)).toBe(62);
      expect(adapted.titles.at(-1)).toBe(2.6);
      expect(loaded).toEqual(['media/still.png', 'media/still.png']);
      await api.pause({ epoch: 4 });
      adapted.front.context.calls.length = 0;
      await adapted.sandbox.portosComposition.seek(1.25);
      expect(adapted.front.context.calls.some(call => call.name === 'fillText')).toBe(true);
    } finally { await api.dispose(); }
  });
});

function player({ hold = false, quantized = false, inSec = 0, outSec = 5, cutAt = null, fps = 30, autoFirst = true } = {}) {
  let clock = 0, frame = null, time = 0, writes = 0, readyResolve, playResolve, autoFrame = false, frameId = 0, presented = 0, drawMs = 0;
  const callbacks = new Map();
  const frameWaiters = [];
  const events = [], paints = [], modes = [], sourceTimes = [], scenes = [{ startSec: 0, endSec: cutAt ?? 5, media: { kind: 'video', inSec, outSec, fps } },
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
    publish(songTime, t, _scene, _source, _state, valid) { if (drawMs) elapse(clock + drawMs); if (!valid()) return false; paints.push({ songTime, t }); return true; }, dispose() { video.pause(); } };
  const sandbox = { setTimeout, clearTimeout, __bridge: bridge, performance: { now: () => clock }, requestAnimationFrame: callback => { frame = callback; return 1; }, cancelAnimationFrame: () => { frame = null; },
    window: { postMessage: message => events.push(message) }, portosComposition: {} };
  runInNewContext(`(${installLayeredPreviewPlayback.toString()})(__bridge)`, sandbox);
  const elapse = (ms) => { const elapsed = (ms - clock) / 1000; if (!video.paused) time += elapsed * video.playbackRate; clock = ms; };
  return { api: sandbox.portosComposition.previewPlayback, video, events, paints, modes, sourceTimes, present,
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
