// Creative approval behavior is covered through production review routes and orchestration.
vi.mock('./productionReview.js', async (load) => ({ ...await load(), assertProductionApproval: vi.fn() }));
import { afterAll, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { bindAuthoredPreviewPlayback } from './authoredPreviewPlayback.js';
import { titleCardRuntimeSource } from '../../lib/musicVideoTitleCard.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy, ownTestBodies } from '../../lib/mockPathsDataRoot.js';

// Fail-fast cancellation stops Vitest waiting, not an authoring body's I/O: drain
// owned bodies before the lazy data root is removed (#12254).
const { it, drain } = ownTestBodies(vitestIt);

const h = vi.hoisted(() => ({ calls: 0, prompt: '', response: '', onSubmit: null, onPrepare: null, provider: { id: 'stub-provider' }, args: null }));
vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-document-author-'),
}));
vi.mock('../promptRunner.js', () => ({
  assertProvider: () => {},
  resolveProviderAndModel: async () => ({ provider: h.provider, selectedModel: 'fixture-model' }),
  runPromptThroughProvider: async ({ prompt, beforeExecute, ...args }) => {
    h.args = args;
    await h.onPrepare?.();
    if (beforeExecute) await beforeExecute({ provider: { id: 'stub-provider' }, model: 'fixture-model' });
    h.calls += 1; h.prompt = prompt;
    if (h.onSubmit) await h.onSubmit();
    return { text: h.response };
  },
}));

const { PATHS } = await import('../../lib/paths.js');
const projects = await import('./projects.js');
const { importDocumentTemplate } = await import('./compositionDocument.js');
const { generateMixedMediaDocument, regenerateMixedMediaSection, reviseMixedMediaEvents, readMixedMediaCandidate, acceptMixedMediaDocument } = await import('./documentGeneration.js');

const source = (color) => `function render(ctx, env) { ctx.fillStyle = '${color}'; ctx.fillRect(0, 0, env.width, env.height); }`;
const response = (colors) => JSON.stringify({ sections: Object.entries(colors).map(([id, color]) => ({ id, source: source(color) })) });
const manifestAt = async (document) => JSON.parse(await readFile(join(PATHS.data, document.directory, 'manifest.json'), 'utf8'));

afterAll(async () => {
  try { await drain(); } finally { cleanupTempDataRoots(); }
});
beforeEach(() => { h.provider = { id: 'stub-provider' }; h.args = null; h.onSubmit = null; h.onPrepare = null; h.calls = 0; h.prompt = ''; h.response = response({ intro: '#112233', still: '#445566', clip: '#778899' }); });

async function fixture() {
  await mkdir(PATHS.images, { recursive: true });
  await mkdir(PATHS.videos, { recursive: true });
  await writeFile(join(PATHS.images, 'still.png'), 'selected still');
  await writeFile(join(PATHS.videos, 'clip.webm'), 'selected clip');
  await writeFile(join(PATHS.data, 'video-history.json'), JSON.stringify([{ id: 'vh-clip', filename: 'clip.webm', numFrames: 240, fps: 24, width: 640, height: 360 }]));
  const created = await projects.createProject({ name: 'Example Song' });
  await projects.mutateProjectRecord(created.id, (current) => ({ project: {
    ...current,
    audioAnalysis: { durationSec: 30, beats: [0, 10, 20], downbeats: [0, 10, 20], features: { brightness: [0.2] }, sections: [
      { id: 'intro', label: 'Intro', startSec: 0, endSec: 10 },
      { id: 'still', label: 'Verse', startSec: 10, endSec: 20 },
      { id: 'clip', label: 'Hook', startSec: 20, endSec: 30 },
    ] },
    lyricCues: [{ id: 'l1', text: 'Example words', startSec: 19.8, endSec: 21, words: [{ w: 'Example', startSec: 20 }] }],
    visualSpec: { palette: ['#112233', '#ffffff', '#ff7700'], cameraRules: 'Low angle' },
    productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 },
    treatment: { revision: 1, brief: { premise: 'A paper kite crosses the city', graphicLanguage: 'Ink and cut paper' }, arc: { motifs: [{ name: 'Kite', evolution: 'Fold to flight' }] }, shotDirections: [
      { sceneId: 's-intro', medium: 'procedural', mediumRationale: 'Open with graphics' },
      { sceneId: 's-still', medium: 'still', mediumRationale: 'Hold the selected image' },
      { sceneId: 's-clip', medium: 'existing-footage', mediumRationale: 'Use the selected take', framing: 'Tight', transitionIn: 'Hard cut' },
    ] },
    scenes: [
      { sceneId: 's-intro', order: 0, startSec: 0, endSec: 10 },
      { sceneId: 's-still', order: 1, startSec: 10, endSec: 20, referenceImageId: 'still.png' },
      { sceneId: 's-clip', order: 2, startSec: 20, endSec: 30, shotMode: 'performance', videoHistoryId: 'vh-clip', takes: [
        { kind: 'video', assetId: 'vh-clip', shotInstruction: { shotMode: 'performance', edit: { inSec: 1, outSec: 8 } } },
      ] },
    ],
  } }));
  return created.id;
}

// Execute the actual newly staged candidate (or its preserved raw reference)
// without a browser. The context deliberately models persistent font/path state.
async function candidateRuntime(document, { reference = false, fontGate = Promise.resolve(), titleFontGate = null } = {}) {
  const traces = [], copies = [], events = [], finishing = [], overlays = [];
  let clock = 0, slow = false;
  const makeCanvas = () => {
    const stack = [], path = [];
    const ctx = { font: '10px sans-serif',
      save() { stack.push(this.font); }, restore() { this.font = stack.pop(); },
      beginPath() { path.length = 0; }, lineTo(...point) { path.push(point); },
      fillText(text) { if (text === 'authored') { traces.push({ font: this.font, path: path.slice() }); if (slow) clock += 100; } },
      stroke() {}, drawImage(...args) { copies.push(args); },
      createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
      createLinearGradient() { return { addColorStop() {} }; }, createRadialGradient() { return { addColorStop() {} }; },
      createPattern() { return {}; }, measureText(text) { return { width: String(text).length * 10 }; },
    };
    const context = new Proxy(ctx, { get(target, key) { return key in target ? target[key] : () => {}; } });
    let width = 1920, height = 1080;
    const reset = () => { ctx.font = '10px sans-serif'; path.length = 0; stack.length = 0; };
    return { get width() { return width; }, set width(value) { width = value; reset(); },
      get height() { return height; }, set height(value) { height = value; reset(); },
      dataset: {}, style: {}, setAttribute() {}, getContext: () => context };
  };
  const front = makeCanvas();
  const sandbox = { setTimeout, clearTimeout, performance: { now: () => clock }, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    innerWidth: 1920, innerHeight: 1080,
    document: { body: { appendChild(node) { node.isConnected = true; overlays.push(node); } }, getElementById: () => front, createElement: () => makeCanvas(),
      fonts: { load: font => titleFontGate && font.includes('MV Title') ? titleFontGate : fontGate } },
    PORTOS_MV: { render: { width: 1920, height: 1080, fps: 24, durationSec: 30 }, song: {}, composition: {},
      scenes: [{ sceneId: 'code', startSec: 0, endSec: 30, visualLayer: 'code' }] },
    PORTOS_MV_EVENT_STATE: (_song, t) => ({ t, frame: Math.floor(t * 24), hold: false, activeEvents: [], reactiveGain: 0 }),
    PORTOS_LYRIC_TYPE: { createLyricType: () => ({ ready: Promise.resolve(), draw(ctx, t) { ctx.font = `lyric-${t}`; } }) },
    __portosFilmLook: { frame: t => finishing.push(['look', t]), playback() {} },
    __portosTitleCard: { draw: t => finishing.push(['title', t]) }, postMessage: event => events.push(event),
  };
  sandbox.window = sandbox;
  const context = createContext(sandbox);
  const root = join(PATHS.data, document.directory);
  if (titleFontGate) {
    delete sandbox.__portosTitleCard;
    runInContext(titleCardRuntimeSource({ title: 'Real delayed title', font: 'oswald', startSec: 0, endSec: 4 }), context);
  }
  runInContext(await readFile(join(root, 'generated.js'), 'utf8'), context);
  runInContext(await readFile(join(root, reference ? 'engine-reference.js' : 'engine.js'), 'utf8'), context);
  return { api: sandbox.portosComposition.previewPlayback, composition: sandbox.portosComposition, traces, copies, events, finishing, overlays,
    page: { evaluate: source => runInContext(source, context) }, slow: () => { slow = true; } };
}

async function threeCandidate(source) {
  const created = await projects.createProject({ name: 'Synthetic spatial song', mediaMode: 'code-only' });
  await projects.mutateProjectRecord(created.id, current => ({ project: { ...current,
    audioAnalysis: { durationSec: 1, beats: [], downbeats: [], sections: [{ id: 'world', startSec: 0, endSec: 1 }] },
    composition: { mode: 'document', authoringRenderer: 'three' },
  } }));
  h.response = JSON.stringify({ sections: [{ id: 'world', source: source || `function render(ctx, env) {
    ctx.scene.userData.t = env.t;
    ctx.text.fillText(JSON.stringify({ t: env.t, localT: env.localT, frame: env.frame, width: env.width, height: env.height }), 1, 2);
  }` }] });
  return (await generateMixedMediaDocument(created.id)).document;
}

// Run the staged module's real scene/post logic; only the GPU and DOM are doubles.
async function threeRuntime(document, { reference = false, fontGate = Promise.resolve(), titleGate = Promise.resolve(), failDrawAt = null, lyricOverlayEnabled = true } = {}) {
  const THREE = await import('three');
  const traces = [], copies = [], renders = [], finishing = [], events = [], resources = [], overlap = [], words = [];
  let clock = 0, slow = false, rendererDisposed = false;
  const makeCanvas = name => {
    const context = { reset() {}, save() {}, restore() {}, strokeText() {},
      fillText(label) { if (label.startsWith('{')) { traces.push(JSON.parse(label)); if (slow) clock += 100; } else words.push(label); },
      drawImage(back) { if (name !== 'back') copies.push([name, back.width, back.height]); },
    };
    return { width: 0, height: 0, getContext: () => context };
  };
  const world = makeCanvas('world'), type = makeCanvas('type');
  function WebGLRenderer({ canvas }) {
    let target = null;
    return { shadowMap: {}, setPixelRatio() {},
      setSize(w, h) { canvas.width = w; canvas.height = h; },
      getContext: () => ({ getExtension: () => null, getParameter: () => 'software' }),
      initRenderTarget() {}, setRenderTarget(next) { target = next; }, clear() {},
      render(scene) {
        overlap.push(resources.filter(item => !item.materialDisposed).length);
        scene.traverse(object => {
          if (!object.isMesh || !object.material || target) return;
          const item = { materialDisposed: false, geometryDisposed: false };
          object.material.addEventListener('dispose', () => { item.materialDisposed = true; });
          object.geometry.addEventListener('dispose', () => { item.geometryDisposed = true; });
          resources.push(item);
        });
        if (failDrawAt !== null && scene.userData.t === failDrawAt) throw new Error('Synthetic drawing failure');
        renders.push([scene.userData.t ?? null, target ? [target.width, target.height] : null]);
      },
      dispose() { rendererDisposed = true; },
    };
  }
  const sandbox = { THREE: { ...THREE, WebGLRenderer }, GeometryTHREE: THREE, setTimeout, clearTimeout,
    performance: { now: () => clock }, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    document: { getElementById: id => id === 'world' ? world : type, createElement: () => makeCanvas('back'), fonts: { load: () => fontGate } },
    PORTOS_MV: { render: { width: 1920, height: 1080, fps: 24, durationSec: 1 }, song: {}, composition: { lyricOverlayEnabled },
      lyrics: [{ text: 'Example lyric', startSec: 0, endSec: 1 }] },
    PORTOS_MV_EVENT_STATE: (_song, t) => ({ t: t >= 0.2 && t < 0.4 ? 0.2 : Math.floor(t * 24) / 24,
      hold: t >= 0.2 && t < 0.4, activeEvents: [], reactiveGain: 0 }),
    __portosFilmLook: { frame: t => finishing.push(['look', t]), playback() {} },
    __portosTitleCard: { ready: () => titleGate, draw: t => finishing.push(['title', t]) },
    postMessage: event => events.push(event),
  };
  sandbox.window = sandbox;
  const context = createContext(sandbox), root = join(PATHS.data, document.directory);
  const kit = (await readFile(join(root, 'toonWorld.js'), 'utf8'))
    .replace("import * as GeometryTHREE from './vendor/three.module.js';", '').replaceAll('export ', '');
  runInContext(`${kit}\nglobalThis.toonWorld = { createInkPass, inkShader };`, context);
  runInContext(await readFile(join(root, 'generated.js'), 'utf8'), context);
  const source = (await readFile(join(root, reference ? 'engine-reference.js' : 'engine.js'), 'utf8'))
    .replace("import * as toonWorld from './toonWorld.js';", '').replaceAll('export function ', 'function ');
  runInContext(`${source}\nmount(THREE);`, context);
  return { words, composition: sandbox.portosComposition, api: sandbox.portosComposition.previewPlayback, traces, copies, renders, finishing, events, resources, overlap,
    page: { evaluate: source => runInContext(source, context) }, slow: () => { slow = true; }, disposed: () => rendererDisposed };
}

describe('treatment-driven mixed-media document authoring', () => {
  it('reads an older candidate manifest with overlays disabled so it can be revised', async () => {
    const document = await threeCandidate();
    const id = document.directory.split('/')[1];
    await projects.mutateProjectRecord(id, current => ({ project: { ...current, lyricOverlayEnabled: false } }));
    await writeFile(join(PATHS.data, document.directory, 'engine.js'), 'function drawWords() { /* legacy lyric pass */ }');
    const calls = h.calls;
    const candidate = await readMixedMediaCandidate(id);
    expect(candidate.sections).toHaveLength(1);
    expect(candidate.source.directory).toBe(document.directory);
    expect(h.calls).toBe(calls);
  });

  it('keeps authored Three text while hiding the spatial host lyric pass', async () => {
    const document = await threeCandidate();
    const shown = await threeRuntime(document);
    const hidden = await threeRuntime(document, { lyricOverlayEnabled: false });
    await shown.composition.seek(0.5);
    await hidden.composition.seek(0.5);
    expect(shown.words).toContain('Example lyric');
    expect(hidden.words).toEqual([]);
    expect(hidden.traces).toEqual(shown.traces);
  });

  it('packages Three through the complete-frame producer without changing exact subframe or hold rendering', async () => {
    const document = await threeCandidate(), root = join(PATHS.data, document.directory);
    expect(JSON.parse(await readFile(join(root, 'preview-playback.json'), 'utf8'))).toEqual({ version: 1, contract: 'portos-complete-frame-v1' });
    expect(await readFile(join(root, 'engine-reference.js'))).toEqual(await readFile(new URL('./documentTemplates/spatial/engine.js', import.meta.url)));
    const native = await threeRuntime(document), reference = await threeRuntime(document, { reference: true });
    try {
      expect(await bindAuthoredPreviewPlayback(native.page)).toMatchObject({ supported: true, fps: 30 });
      for (const t of [0.03125, 0.3, 0.5, 0.03125]) {
        await native.composition.seek(t); await reference.composition.seek(t);
      }
      expect(native.traces.map(trace => trace.t)).toEqual([0.03125, 0.2, 0.5, 0.03125]);
      expect(native.traces).toEqual(reference.traces);
      expect(native.renders).toEqual(reference.renders);
      native.composition.layout({ width: 1080, height: 1920 }); reference.composition.layout({ width: 1080, height: 1920 });
      await native.composition.seek(0.51); await reference.composition.seek(0.51);
      expect(native.traces).toEqual(reference.traces);
      expect(native.copies.slice(-2)).toEqual([['world', 1080, 1920], ['type', 1080, 1920]]);
      await expect(native.api.prepare({ epoch: 1, sequence: 1, t: 0.51 })).resolves.toEqual({ epoch: 1, sequence: 1, status: 'prepared', t: 0.51 });
      const copies = native.copies.length, finishing = native.finishing.length;
      native.slow();
      await expect(native.api.prepare({ epoch: 2, sequence: 2, t: 0.7 })).rejects.toThrow('frame freshness');
      expect(native.copies).toHaveLength(copies);
      expect(native.finishing).toHaveLength(finishing);
    } finally { await native.api.dispose(); }
    expect(native.disposed()).toBe(true);
  });

  it('keeps shader material ownership across fresh worlds and releases it on drawing failure or disposal', async () => {
    const document = await threeCandidate(`function render(ctx, env) {
      ctx.scene.userData.t = env.t;
      ctx.scene.add(new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(), new ctx.THREE.MeshBasicMaterial()));
    }`);
    const runtime = await threeRuntime(document, { failDrawAt: 0.5 });
    try {
      await runtime.composition.seek(0);
      expect(runtime.resources).toEqual([{ materialDisposed: false, geometryDisposed: true }]);
      await runtime.composition.seek(0.1);
      expect(runtime.overlap).toEqual([0, 1]);
      expect(runtime.resources).toEqual([{ materialDisposed: true, geometryDisposed: true }, { materialDisposed: false, geometryDisposed: true }]);
      const copies = runtime.copies.length;
      await expect(runtime.composition.seek(0.5)).rejects.toThrow('Synthetic drawing failure');
      expect(runtime.copies).toHaveLength(copies);
      expect(runtime.resources.every(item => item.materialDisposed && item.geometryDisposed)).toBe(true);
      await runtime.composition.seek(0.75);
      expect(runtime.resources.at(-1).materialDisposed).toBe(false);
    } finally { await runtime.api.dispose(); }
    expect(runtime.resources.every(item => item.materialDisposed && item.geometryDisposed)).toBe(true);
    expect(runtime.disposed()).toBe(true);
  });

  it('awaits Three and title fonts without publishing a canceled exact frame', async () => {
    const document = await threeCandidate();
    const font = Promise.withResolvers(), title = Promise.withResolvers();
    const runtime = await threeRuntime(document, { fontGate: font.promise, titleGate: title.promise });
    let exact, paused;
    try {
      exact = runtime.composition.seek(0.03125);
      await new Promise(resolve => setImmediate(resolve));
      expect(runtime.copies).toEqual([]);
      font.resolve();
      await new Promise(resolve => setImmediate(resolve));
      expect(runtime.copies).toEqual([]);
      paused = runtime.api.pause({ epoch: 1, t: 0 });
      title.resolve();
      await Promise.all([exact, paused]);
      expect(runtime.copies).toEqual([]);
      expect(runtime.finishing).toEqual([]);
      await runtime.api.prepare({ epoch: 2, sequence: 1, t: 0.51 });
      expect(runtime.copies).toEqual([['world', 1920, 1080], ['type', 1920, 1080]]);
    } finally {
      font.resolve(); title.resolve();
      await Promise.allSettled([exact, paused]);
      await runtime.api.dispose();
    }
  });

  it('packages an actual complete-frame producer for new Canvas candidates and preserves raw renderer state/reference', async () => {
    const id = await fixture();
    const drawing = 'function render(ctx, env) { ctx.fillText("authored", 1, 2); ctx.lineTo(env.frame, 3); ctx.stroke(); }';
    h.response = JSON.stringify({ sections: ['intro', 'still', 'clip'].map(id => ({ id, source: drawing })) });
    const { document } = await generateMixedMediaDocument(id);
    const root = join(PATHS.data, document.directory);
    expect(JSON.parse(await readFile(join(root, 'preview-playback.json'), 'utf8'))).toEqual({ version: 1, contract: 'portos-complete-frame-v1' });
    expect(await readFile(join(root, 'engine-reference.js'))).toEqual(await readFile(new URL('./documentTemplates/layered/engine.js', import.meta.url)));
    expect(await readFile(join(root, 'generated.js'), 'utf8')).toContain(drawing);
    const native = await candidateRuntime(document), reference = await candidateRuntime(document, { reference: true });
    expect(await bindAuthoredPreviewPlayback(native.page)).toMatchObject({ supported: true, fps: 30 });
    for (const t of [0.75, 1.5, 0.75, 2, 0.75]) {
      await native.composition.seek(t); await reference.composition.seek(t);
    }
    expect(native.traces.length, JSON.stringify((await manifestAt(document)).song.sections)).toBeGreaterThan(0);
    expect(native.traces).toEqual(reference.traces);
    expect(native.traces.at(-1).font).toBe('lyric-2');
    for (const [width, height] of [[1920, 1080], [1080, 1920], [1920, 1080]]) {
      native.composition.layout({ width, height }); reference.composition.layout({ width, height });
      await native.composition.seek(0.75); await reference.composition.seek(0.75);
      expect(native.traces).toEqual(reference.traces);
    }
    await reference.composition.seek(0.5);
    expect(await native.api.prepare({ epoch: 1, sequence: 7, t: 0.5 })).toEqual({ epoch: 1, sequence: 7, status: 'prepared', t: 0.5 });
    expect(native.traces).toEqual(reference.traces);
    const copies = native.copies.length, finishing = native.finishing.length;
    native.slow();
    await expect(native.api.prepare({ epoch: 2, sequence: 8, t: 0.75 })).rejects.toThrow('frame freshness');
    expect(native.copies).toHaveLength(copies);
    expect(native.finishing).toHaveLength(finishing);
    expect(native.events.at(-1)).toMatchObject({ type: 'portos-mv:playback-error', epoch: 2 });
    await native.api.dispose();
  });

  it('awaits real title readiness for first exact capture and cooperative preparation', async () => {
    const id = await fixture();
    const { document } = await generateMixedMediaDocument(id);
    for (const cooperative of [false, true]) {
      let release;
      const titleFontGate = new Promise(resolve => { release = resolve; });
      const runtime = await candidateRuntime(document, { titleFontGate });
      let finished = false;
      const capture = (cooperative ? runtime.api.prepare({ epoch: 1, sequence: 1, t: 1 }) : runtime.composition.seek(1))
        .then(() => { finished = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(finished).toBe(false);
      expect(runtime.copies).toEqual([]);
      release();
      await capture;
      expect(runtime.copies.length).toBeGreaterThan(0);
      await runtime.api.dispose();
    }
  });

  it('cancels the real title font wait before visible exact work on pause or disposal', async () => {
    const id = await fixture();
    const { document } = await generateMixedMediaDocument(id);
    for (const method of ['pause', 'dispose']) {
      let release;
      const titleFontGate = new Promise(resolve => { release = resolve; });
      const runtime = await candidateRuntime(document, { titleFontGate });
      const exact = runtime.composition.seek(1);
      await new Promise(resolve => setImmediate(resolve));
      const stopping = runtime.api[method]({ epoch: 2 });
      expect(runtime.copies).toEqual([]);
      expect(runtime.overlays).toEqual([]);
      release();
      await Promise.all([exact, stopping]);
      expect(runtime.copies).toEqual([]);
      expect(runtime.overlays).toEqual([]);
      if (method !== 'dispose') await runtime.api.dispose();
    }
  });

  it('waits for host readiness, retires pending preparation, and rejects explicit async drawing before publication', async () => {
    const id = await fixture();
    let release;
    const fontGate = new Promise(resolve => { release = resolve; });
    const { document } = await generateMixedMediaDocument(id);
    const pending = await candidateRuntime(document, { fontGate });
    const preparation = pending.api.prepare({ epoch: 1, sequence: 1, t: 0.5 }).catch(error => error);
    await Promise.resolve();
    expect(pending.copies).toEqual([]);
    const pausing = pending.api.pause({ epoch: 2 });
    release();
    expect(await preparation).toMatchObject({ message: 'Generated preparation superseded' });
    expect(await pausing).toEqual({ epoch: 2, status: 'paused' });
    expect(pending.copies).toEqual([]);
    await pending.api.dispose();

    let rejectFonts;
    const failingFonts = new Promise((_resolve, reject) => { rejectFonts = reject; });
    const failed = await candidateRuntime(document, { fontGate: failingFonts });
    const failedPreparation = failed.api.prepare({ epoch: 1, sequence: 1, t: 0.5 });
    const failure = expect(failedPreparation).rejects.toThrow('Packaged fonts unavailable');
    rejectFonts(new Error('Packaged fonts unavailable'));
    await failure;
    expect(failed.copies).toEqual([]);
    expect(failed.events.at(-1)).toMatchObject({ type: 'portos-mv:playback-error', epoch: 1 });
    await failed.api.dispose();

    h.response = JSON.stringify({ sections: ['intro', 'still', 'clip'].map(id => ({ id, source: 'function render(ctx, env) { return Promise.resolve(); }' })) });
    const asynchronous = await candidateRuntime((await generateMixedMediaDocument(id)).document);
    await expect(asynchronous.api.prepare({ epoch: 1, sequence: 1, t: 0.5 })).rejects.toThrow('synchronously');
    expect(asynchronous.copies).toEqual([]);
    expect(asynchronous.finishing).toEqual([]);
    expect(asynchronous.events.at(-1)).toMatchObject({ type: 'portos-mv:playback-error' });
    await asynchronous.api.dispose();
  });

  it('runs authoring on the pinned provider with its effort, and drops effort for a provider that has none (#9545)', async () => {
    const id = await fixture();
    h.provider = { id: 'stub-provider', type: 'cli', command: 'claude' };
    await generateMixedMediaDocument(id, { providerId: 'stub-provider', effort: 'high' });
    expect(h.args).toMatchObject({ provider: { id: 'stub-provider' }, model: 'fixture-model', effort: 'high', source: 'music-video-document' });

    h.provider = { id: 'stub-provider', type: 'api' };
    await generateMixedMediaDocument(id, { providerId: 'stub-provider', effort: 'high' });
    expect(h.args).not.toHaveProperty('effort');
  });

  it('splits an oversized whole-song prompt into bounded batches on a local provider only (#10515)', async () => {
    const id = await fixture();
    h.provider = { id: 'stub-provider', type: 'api' };
    await generateMixedMediaDocument(id, { providerId: 'stub-provider' });
    const whole = h.prompt.length;
    expect(h.calls).toBe(1);

    // A hosted provider keeps the single whole-song request, whatever its size.
    h.calls = 0;
    await generateMixedMediaDocument(id, { providerId: 'stub-provider', promptBudgetChars: whole - 1 });
    expect(h.calls).toBe(1);

    h.provider = { id: 'ollama', type: 'api' };
    h.calls = 0;
    const sizes = [];
    h.onSubmit = async () => { sizes.push(h.prompt.length); };
    const { document } = await generateMixedMediaDocument(id, { providerId: 'ollama', promptBudgetChars: whole - 1 });
    expect(h.calls).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThan(whole);
    const manifest = await manifestAt(document);
    expect(manifest.sections.map((s) => s.id)).toEqual(['intro', 'still', 'clip']);
    expect(manifest.sections.every((s) => s.source.includes('function render'))).toBe(true);

    h.calls = 0;
    await generateMixedMediaDocument(id, { providerId: 'ollama', promptBudgetChars: whole });
    expect(h.calls).toBe(1);

    await expect(generateMixedMediaDocument(id, { providerId: 'ollama', promptBudgetChars: 1 }))
      .rejects.toMatchObject({ code: 'COMPOSITION_PROMPT_TOO_LARGE', message: expect.stringMatching(/\d+ characters/) });
  });

  it('scopes each local batch to the scenes and storyboard shots its sections cover', async () => {
    const id = await fixture();
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, productionReview: { ...current.productionReview, draft: {
      ...(current.productionReview?.draft || {}),
      storyboard: ['s-intro', 's-still', 's-clip'].map((sceneId) => ({ sceneId, lyricCueIds: [], action: `choreography for ${sceneId}`, staging: '', camera: '', transition: '' })),
    } } } }));
    h.provider = { id: 'ollama', type: 'api' };
    const prompts = [];
    h.onSubmit = async () => { prompts.push(h.prompt); };
    await generateMixedMediaDocument(id, { providerId: 'ollama' });
    const whole = prompts[0];
    expect(whole).toContain('choreography for s-clip');

    prompts.length = 0;
    // A budget that only fits one section per request.
    await generateMixedMediaDocument(id, { providerId: 'ollama', promptBudgetChars: whole.length - 200 });
    const intro = prompts.find((prompt) => prompt.includes('"id":"intro"'));
    expect(intro).toContain('choreography for s-intro');
    expect(intro).not.toContain('choreography for s-clip');
    expect(intro).not.toContain('"sceneId":"s-clip"');
  });

  it('re-authors a section a local batch dropped on its own, and fails only when the retry misses it too', async () => {
    const id = await fixture();
    h.provider = { id: 'ollama', type: 'api' };
    await generateMixedMediaDocument(id, { providerId: 'ollama' });
    const budget = h.prompt.length - 1;
    const all = response({ intro: '#112233', still: '#445566', clip: '#778899' });
    const sectionsAsked = (prompt) => ['intro', 'still', 'clip'].filter((s) => prompt.includes(`"id":"${s}"`));
    // A multi-section batch comes back without its last section; a single-section ask succeeds.
    h.onSubmit = async () => {
      const asked = sectionsAsked(h.prompt);
      h.response = asked.length > 1 ? response(Object.fromEntries(asked.slice(0, -1).map((s) => [s, '#010203']))) : all;
    };
    h.calls = 0;
    const { document } = await generateMixedMediaDocument(id, { providerId: 'ollama', promptBudgetChars: budget });
    const manifest = await manifestAt(document);
    expect(manifest.sections.map((s) => s.id)).toEqual(['intro', 'still', 'clip']);
    expect(manifest.sections.every((s) => s.source.includes('function render'))).toBe(true);
    expect(h.calls).toBeGreaterThan(2);

    // A returned section that fails its source check is retried on its own too.
    h.onSubmit = async () => {
      const asked = sectionsAsked(h.prompt);
      h.response = asked.length > 1
        ? JSON.stringify({ sections: asked.map((s, i) => ({ id: s, source: i === asked.length - 1 ? 'function render(ctx, env) { ctx.fillRect(Math.random(), 0, 1, 1); }' : source('#010203') })) })
        : all;
    };
    const retried = await manifestAt((await generateMixedMediaDocument(id, { providerId: 'ollama', promptBudgetChars: budget })).document);
    expect(retried.sections.every((s) => !s.source.includes('Math.random'))).toBe(true);

    // The retry missing it too is a hard failure naming the count.
    h.onSubmit = async () => { h.response = response({ intro: '#010203' }); };
    await expect(generateMixedMediaDocument(id, { providerId: 'ollama', promptBudgetChars: budget }))
      .rejects.toMatchObject({ code: 'MISSING_SECTION_SOURCE' });
  });

  it('retries a rejected section once on its own, telling the model why', async () => {
    const id = await fixture();
    const random = 'function render(ctx, env) { ctx.fillRect(Math.random(), 0, 1, 1); }';
    const retries = [];
    h.onSubmit = async () => {
      if (h.prompt.includes('was rejected')) {
        retries.push(h.prompt);
        h.response = response({ intro: '#123456' });
      } else {
        h.response = JSON.stringify({ sections: [{ id: 'intro', source: random }, { id: 'still', source: source('#445566') }, { id: 'clip', source: source('#778899') }] });
      }
    };
    const { document } = await generateMixedMediaDocument(id, { providerId: 'stub-provider' });
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatch(/section "intro" was rejected: .*non-deterministic/i);
    const manifest = await manifestAt(document);
    expect(manifest.sections.find((s) => s.id === 'intro').source).toContain('#123456');
  });

  it('retries an answer with no usable section once as a whole, then fails without a call per section', async () => {
    const id = await fixture();
    h.calls = 0;
    h.onSubmit = async () => { h.response = 'I cannot help with that.'; };
    await expect(generateMixedMediaDocument(id, { providerId: 'stub-provider' })).rejects.toMatchObject({ code: 'MISSING_SECTION_SOURCE' });
    expect(h.calls).toBe(2);
    expect(h.prompt).toContain('contained no usable section functions');
  });

  it('resumes a failed later local batch from durable sections after a module restart (#10528)', async () => {
    const id = await fixture();
    await generateMixedMediaDocument(id, { providerId: 'stub-provider' });
    const budget = h.prompt.length - 200;
    h.provider = { id: 'ollama', type: 'api' };
    const asked = [];
    h.onSubmit = async () => {
      asked.push(['intro', 'still', 'clip'].filter((section) => h.prompt.includes(`"id":"${section}"`)));
      if (asked.length === 2) throw new Error('Later batch failed');
      h.response = response(Object.fromEntries(asked.at(-1).map((section) => [section, '#010203'])));
    };
    await expect(generateMixedMediaDocument(id, { providerId: 'ollama', promptBudgetChars: budget })).rejects.toThrow('Later batch failed');
    const finished = asked[0];
    const checkpoint = JSON.parse(await readFile(join(PATHS.data, 'cache', 'music-video-authoring', `${id}.json`), 'utf8'));
    expect(checkpoint.sections.map((section) => section.id)).toEqual(finished);
    // Matching metadata never bypasses the normal deterministic-source admission.
    await writeFile(join(PATHS.data, 'cache', 'music-video-authoring', `${id}.json`), JSON.stringify({ ...checkpoint,
      sections: [{ ...checkpoint.sections[0], source: 'function render(ctx, env) { ctx.fillRect(Math.random(), 0, 1, 1); }' }],
    }));
    const callsBeforeCorruption = h.calls;
    await expect(generateMixedMediaDocument(id, { providerId: 'ollama', promptBudgetChars: budget })).rejects.toMatchObject({ code: 'NONDETERMINISTIC_SECTION' });
    expect(h.calls).toBe(callsBeforeCorruption);
    await writeFile(join(PATHS.data, 'cache', 'music-video-authoring', `${id}.json`), JSON.stringify(checkpoint));
    vi.resetModules();
    const resumedAuthor = (await import('./documentGeneration.js')).generateMixedMediaDocument;
    asked.length = 0;
    h.onSubmit = async () => {
      asked.push(['intro', 'still', 'clip'].filter((section) => h.prompt.includes(`"id":"${section}"`)));
      h.response = response(Object.fromEntries(asked.at(-1).map((section) => [section, '#aabbcc'])));
    };
    const { document } = await resumedAuthor(id, { providerId: 'ollama', promptBudgetChars: budget });
    expect(asked.flat()).toEqual(['intro', 'still', 'clip'].filter((section) => !finished.includes(section)));
    const manifest = await manifestAt(document);
    expect(manifest.sections.filter((section) => finished.includes(section.id)).map((section) => section.source))
      .toEqual(finished.map(() => source('#010203')));
    await expect(readFile(join(PATHS.data, 'cache', 'music-video-authoring', `${id}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  for (const change of ['treatment', 'media', 'storyboard']) {
    it(`discards staged local sections after a ${change} basis edit (#10528)`, async () => {
      const id = await fixture();
      await generateMixedMediaDocument(id, { providerId: 'stub-provider' });
      const budget = h.prompt.length - 200;
      h.provider = { id: 'ollama', type: 'api' };
      let calls = 0;
      h.onSubmit = async () => {
        if (++calls === 2) throw new Error('Later batch failed');
        h.response = response({ intro: '#010203', still: '#010203', clip: '#010203' });
      };
      await expect(generateMixedMediaDocument(id, { providerId: 'ollama', promptBudgetChars: budget })).rejects.toThrow('Later batch failed');
      await projects.mutateProjectRecord(id, (current) => ({ project: {
        ...current,
        ...(change === 'treatment' ? { treatment: { ...current.treatment, revision: 2 } } : {}),
        ...(change === 'media' ? { scenes: current.scenes.map((scene) => scene.sceneId === 's-clip' ? { ...scene, takes: [{ ...scene.takes[0], shotInstruction: { shotMode: 'performance', edit: { inSec: 2, outSec: 8 } } }] } : scene) } : {}),
        ...(change === 'storyboard' ? { productionReview: { draft: { storyboard: [{ sceneId: 's-intro', action: 'Revised movement' }] } } } : {}),
      } }));
      const asked = [];
      h.onSubmit = async () => {
        asked.push(...['intro', 'still', 'clip'].filter((section) => h.prompt.includes(`"id":"${section}"`)));
        h.response = response({ intro: '#aabbcc', still: '#aabbcc', clip: '#aabbcc' });
      };
      const { document } = await generateMixedMediaDocument(id, { providerId: 'ollama', promptBudgetChars: budget });
      expect(asked).toEqual(['intro', 'still', 'clip']);
      expect((await manifestAt(document)).sections.map((section) => section.source)).toEqual(['intro', 'still', 'clip'].map(() => source('#aabbcc')));
    });
  }

  it('rechecks the production reservation when all local sections were staged before publication failed', async () => {
    const id = await fixture();
    await generateMixedMediaDocument(id, { providerId: 'stub-provider' });
    const budget = h.prompt.length - 200;
    h.provider = { id: 'ollama', type: 'api' };
    let active = true;
    h.onSubmit = async () => { if (h.prompt.includes('"id":"clip"')) active = false; };
    const verifyCurrent = () => { if (!active) throw Object.assign(new Error('Production closed'), { code: 'PRODUCTION_STEP_CLOSED' }); };
    await expect(generateMixedMediaDocument(id, { providerId: 'ollama', promptBudgetChars: budget, verifyCurrent })).rejects.toMatchObject({ code: 'PRODUCTION_STEP_CLOSED' });
    active = true; h.onSubmit = null; h.calls = 0;
    const beforeSubmit = vi.fn();
    await generateMixedMediaDocument(id, { providerId: 'ollama', promptBudgetChars: budget, verifyCurrent, beforeSubmit });
    expect(h.calls).toBe(0);
    expect(beforeSubmit).toHaveBeenCalledWith(expect.objectContaining({ provider: { id: 'ollama', type: 'api' }, model: 'fixture-model' }));
  });

  it('names the prompt size when authoring times out with no output (#10515)', async () => {
    const id = await fixture();
    h.onSubmit = async () => { throw new Error('API execution timed out after 600000ms with no stream progress'); };
    await expect(generateMixedMediaDocument(id)).rejects.toThrow(/prompt was \d+ characters/);
  });

  it('accepts a legacy generated manifest and upgrades it through an event-only revision', async () => {
    const id = await fixture();
    const first = (await generateMixedMediaDocument(id)).document;
    const legacy = await manifestAt(first);
    legacy.basis = legacy.structuralBasis;
    delete legacy.structuralBasis;
    delete legacy.song.narrativeEvents;
    delete legacy.song.reactiveSections;
    await writeFile(join(PATHS.data, first.directory, 'manifest.json'), JSON.stringify(legacy));
    expect((await readMixedMediaCandidate(id)).stale).toBe(false);
    await acceptMixedMediaDocument(id, first.directory);
    const current = await projects.getProject(id);
    await projects.updateProject(id, { composition: { ...current.composition, narrativeEvents: [{ id: 'new', name: 'Reveal', kind: 'reveal',
      anchor: { kind: 'time', atSec: 1 }, durationSec: 1, narrativeFunction: 'Introduce the kite', mediumRationale: 'Exact graphic' }] } });
    h.response = response({ intro: '#00ff00' });
    const updated = (await reviseMixedMediaEvents(id, { expectedDraft: first.directory })).document;
    expect((await manifestAt(updated)).structuralBasis).toBe(legacy.basis);
    expect((await projects.getProject(id)).scenes).toEqual(current.scenes);
  });

  it('resolves onset/word events and revises only their old/new sections while retaining accepted takes', async () => {
    const id = await fixture();
    const event = { id: 'reveal', name: 'Kite opens', kind: 'reveal', anchor: { kind: 'onset', band: 'low', index: 0 }, durationSec: 1,
      narrativeFunction: 'Reveal flight', mediumRationale: 'Precise cut-paper graphic', text: 'FLIGHT' };
    await projects.updateProject(id, { composition: { mode: 'document', narrativeEvents: [event], reactiveSections: [{ sectionId: 'intro', gain: 1, maxGain: 0.2 }] } });
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, audioAnalysis: { ...current.audioAnalysis,
      features: { envelopes: { fps: 1, rms: [1], low: [1], mid: [0], high: [0] }, onsets: { low: [0.51], mid: [], high: [] } },
    } } }));
    const first = (await generateMixedMediaDocument(id)).document;
    const before = await manifestAt(first);
    expect(before.song.narrativeEvents[0]).toMatchObject({ startFrame: 13, endFrame: 37, sectionId: 'intro' });
    expect(h.prompt).toContain('Precise cut-paper graphic');
    expect(h.prompt).toContain('env.reactiveGain');
    await acceptMixedMediaDocument(id, first.directory);
    const original = await projects.getProject(id);
    await projects.updateProject(id, { composition: { ...original.composition, narrativeEvents: [{ ...event, anchor: { kind: 'word', cueId: 'l1', wordIndex: 0 } }] } });
    expect((await readMixedMediaCandidate(id)).eventRevisionAvailable).toBe(true);
    h.response = response({ intro: '#aa0000', clip: '#00aa00' });
    const second = (await reviseMixedMediaEvents(id, { expectedDraft: first.directory })).document;
    const after = await manifestAt(second);
    expect(after.changedSectionIds).toEqual(['intro', 'clip']);
    expect(after.song.narrativeEvents[0]).toMatchObject({ startFrame: 480, endFrame: 504 });
    expect(after.sections.find((section) => section.id === 'still').source).toBe(before.sections.find((section) => section.id === 'still').source);
    expect((await projects.getProject(id)).scenes).toEqual(original.scenes);
    expect((await projects.getProject(id)).composition.document.directory).toBe(first.directory);
    await acceptMixedMediaDocument(id, second.directory);
    await expect(reviseMixedMediaEvents(id, { expectedDraft: second.directory })).rejects.toMatchObject({ code: 'NO_EVENT_CHANGES' });
    expect(h.calls).toBe(2); // document code only, no media generation
    const comparisons = (await readMixedMediaCandidate(id)).comparisons;
    expect(comparisons.find((entry) => entry.sectionId === 'intro').before[0].startFrame).toBe(13);
    expect(comparisons.find((entry) => entry.sectionId === 'clip').after[0].startFrame).toBe(480);
  });

  it('fails unresolved anchors before spending and refuses publication across a concurrent event edit', async () => {
    const id = await fixture();
    const event = { id: 'hold', name: 'Pause', kind: 'silence', anchor: { kind: 'onset', band: 'mid', index: 8 }, durationSec: 1,
      narrativeFunction: 'Let the image breathe', mediumRationale: 'Hold existing media' };
    await projects.updateProject(id, { composition: { mode: 'document', narrativeEvents: [event] } });
    await expect(generateMixedMediaDocument(id)).rejects.toMatchObject({ code: 'NARRATIVE_EVENT_UNRESOLVED' });
    expect(h.calls).toBe(0);
    await projects.updateProject(id, { composition: { mode: 'document', narrativeEvents: [{ ...event, anchor: { kind: 'time', atSec: 1 } }] } });
    const first = (await generateMixedMediaDocument(id)).document;
    h.onSubmit = async () => {
      const current = await projects.getProject(id);
      await projects.updateProject(id, { composition: { ...current.composition, narrativeEvents: [{ ...event, anchor: { kind: 'time', atSec: 2 } }] } });
    };
    await expect(regenerateMixedMediaSection(id, 'intro', { expectedDraft: first.directory })).rejects.toMatchObject({ code: 'COMPOSITION_DRAFT_STALE' });
    expect((await projects.getProject(id)).composition.documentDraft.directory).toBe(first.directory);
    await expect(acceptMixedMediaDocument(id, first.directory)).rejects.toMatchObject({ code: 'COMPOSITION_DRAFT_STALE' });
  });

  it('preflights selected media before a provider call and stages a reviewable 30-second document', async () => {
    const id = await fixture();
    const original = await projects.getProject(id);
    await writeFile(join(PATHS.images, 'missing.png'), 'synthetic still');
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, scenes: current.scenes.map((s) => s.sceneId === 's-still' ? { ...s, referenceImageId: 'missing.png' } : s) } }));
    await unlink(join(PATHS.images, 'missing.png')); // model a legacy selection whose file was removed
    await expect(generateMixedMediaDocument(id)).rejects.toMatchObject({ code: 'COMPOSITION_MEDIA_MISSING' });
    expect(h.calls).toBe(0);
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, scenes: original.scenes } }));
    const active = (await importDocumentTemplate(id)).document;
    const { document: candidate } = await generateMixedMediaDocument(id, { providerId: 'stub-provider', model: 'fixture-model' });
    const project = await projects.getProject(id);
    expect(project.composition.document.directory).toBe(active.directory);
    expect(project.composition.documentDraft.directory).toBe(candidate.directory);
    const manifest = await manifestAt(candidate);
    expect(manifest.song.durationSec).toBe(30);
    expect(manifest.scenes.map((s) => [s.visualLayer, s.assetId])).toEqual([
      ['card', null], ['still', 'still.png'], ['footage', 'vh-clip'],
    ]);
    expect(manifest.scenes[2].inSec).toBe(1);
    expect(h.prompt).toContain('A paper kite crosses the city');
    expect(h.prompt).toContain('Fold to flight');
    expect(h.prompt).toContain('brightness');
    expect(h.prompt).toContain('still.png');
    expect(h.prompt).toContain('vh-clip');
    expect(h.calls).toBe(1); // no image or video provider
    expect(await readFile(join(PATHS.data, candidate.directory, 'generated.js'), 'utf8')).toContain('function render(ctx, env)');
  });

  it('carries a film style grammar in the shared style contract, reuses it for Regenerate section, and goes stale when it changes', async () => {
    const id = await fixture();
    await generateMixedMediaDocument(id);
    expect(h.prompt).not.toContain('FILM STYLE GRAMMAR');
    const plain = await projects.getProject(id);
    await projects.updateProject(id, { composition: { ...plain.composition, styleGrammarId: 'risograph-two-ink' } });
    const first = (await generateMixedMediaDocument(id)).document;
    expect(h.prompt).toContain('FILM STYLE GRAMMAR');
    expect(h.prompt).toContain('## Film style grammar: ');
    const manifest = await manifestAt(first);
    expect(manifest.sharedStyle.styleGrammarId).toBe('risograph-two-ink');
    expect(manifest.sharedStyle.styleLines.join('\n')).toContain('Camera vocabulary:');
    h.response = response({ still: '#00ff00' });
    await regenerateMixedMediaSection(id, 'still', { expectedDraft: first.directory });
    expect(h.prompt).toContain('## Film style grammar: ');
    const current = await projects.getProject(id);
    await projects.updateProject(id, { composition: { ...current.composition, styleGrammarId: 'blueprint-draft' } });
    expect((await readMixedMediaCandidate(id)).stale).toBe(true);
    await expect(acceptMixedMediaDocument(id, current.composition.documentDraft.directory)).rejects.toMatchObject({ code: 'COMPOSITION_DRAFT_STALE' });
  });

  it('revises one section, preserves the other functions, and refuses a stale acceptance', async () => {
    const id = await fixture();
    const motionLanguage = 'Energy: playful. 0–10s unfold on downbeats; 20–30s expand the chorus gesture.';
    await projects.mutateProjectRecord(id, current => ({ project: { ...current, productionReview: { draft: {
      motionLanguage, implementationPlan: 'Hinged paper rig and analytic camera arc.',
      storyboard: ['s-intro', 's-still', 's-clip'].map((sceneId) => ({ sceneId, action: `choreography for ${sceneId}` })),
    } } } }));
    const first = (await generateMixedMediaDocument(id)).document;
    expect(h.prompt).toContain(motionLanguage);
    for (const sceneId of ['s-intro', 's-still', 's-clip']) expect(h.prompt).toContain(`choreography for ${sceneId}`);
    const before = await manifestAt(first);
    h.response = response({ still: '#00ff00' });
    const second = (await regenerateMixedMediaSection(id, 'still', { expectedDraft: first.directory })).document;
    const after = await manifestAt(second);
    expect(h.prompt).toContain(motionLanguage);
    expect(h.prompt).toContain('Hinged paper rig and analytic camera arc.');
    expect(h.prompt).toContain('choreography for s-still');
    expect(h.prompt).toContain('"sceneId":"s-still"');
    for (const sceneId of ['s-intro', 's-clip']) {
      expect(h.prompt).not.toContain(`choreography for ${sceneId}`);
      expect(h.prompt).not.toContain(`"sceneId":"${sceneId}"`);
    }
    expect(after.sections.map((s) => s.source)).toEqual([before.sections[0].source, source('#00ff00'), before.sections[2].source]);
    await expect(regenerateMixedMediaSection(id, 'still', { expectedDraft: first.directory })).rejects.toMatchObject({ code: 'COMPOSITION_DRAFT_STALE' });
    await projects.mutateProjectRecord(id, (current) => ({ project: {
      ...current, scenes: current.scenes.map((scene) => scene.sceneId === 's-clip'
        ? { ...scene, takes: [{ ...scene.takes[0], shotInstruction: { shotMode: 'performance', edit: { inSec: 2, outSec: 8 } } }] }
        : scene),
    } }));
    await expect(acceptMixedMediaDocument(id, second.directory)).rejects.toMatchObject({ code: 'COMPOSITION_DRAFT_STALE' });
    expect((await projects.getProject(id)).composition.documentDraft.directory).toBe(second.directory);
  });

  it('refuses a candidate after the uploaded master song changes without changing its analysis shape', async () => {
    const id = await fixture();
    const candidate = (await generateMixedMediaDocument(id)).document;
    await projects.mutateProjectRecord(id, (current) => ({ project: {
      ...current, uploadedAudioFilename: 'replacement-master.wav',
    } }));
    await expect(acceptMixedMediaDocument(id, candidate.directory)).rejects.toMatchObject({ code: 'COMPOSITION_DRAFT_STALE' });
  });
});


it('checks production authorization before provider submission and again before candidate publication/acceptance', async () => {
  const id = await fixture();
  const blocked = () => { throw Object.assign(new Error('Production canceled'), { code: 'PRODUCTION_STEP_CLOSED' }); };
  await expect(generateMixedMediaDocument(id, { beforeSubmit: blocked })).rejects.toMatchObject({ code: 'PRODUCTION_STEP_CLOSED' });
  expect(h.calls).toBe(0);
  let active = true;
  h.onSubmit = () => { active = false; };
  await expect(generateMixedMediaDocument(id, { verifyCurrent: () => { if (!active) blocked(); } })).rejects.toMatchObject({ code: 'PRODUCTION_STEP_CLOSED' });
  expect(h.calls).toBe(1);
  expect((await projects.getProject(id)).composition?.documentDraft).toBeUndefined();
  h.onSubmit = null; h.onPrepare = null;
  const staged = (await generateMixedMediaDocument(id)).document;
  await expect(acceptMixedMediaDocument(id, staged.directory, { verifyCurrent: blocked })).rejects.toMatchObject({ code: 'PRODUCTION_STEP_CLOSED' });
  expect((await projects.getProject(id)).composition.documentDraft.directory).toBe(staged.directory);
});

it('hands the approved procedural definitions and rules to the document author, and nothing from an unapproved check-in', async () => {
  const id = await fixture();
  const castAndSets = (status) => ({ status, direction: {
    medium: 'procedural',
    protagonist: { name: 'Kite', description: 'a paper kite', movement: 'sways on the downbeat' },
    world: { camera: 'locked wide, slow push' },
    definitions: { characters: [{ id: 'kite', name: 'Kite', renderer: 'svg', palette: [], parts: [{ id: 'sail', shape: 'polygon', points: [[100, 20], [160, 100], [100, 180], [40, 100]], fill: '#ff7700' }], expressions: [], poses: [], motion: [] }] },
  } });
  await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, castAndSets: castAndSets('review') } }));
  await generateMixedMediaDocument(id);
  expect(h.prompt).not.toContain('APPROVED CAST & SETS');

  await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, castAndSets: castAndSets('approved') } }));
  await generateMixedMediaDocument(id);
  expect(h.prompt).toContain('APPROVED CAST & SETS DEFINITIONS AND RULES');
  expect(h.prompt).toContain('camera: locked wide, slow push');
  expect(h.prompt).toContain('movement: sways on the downbeat');
  expect(h.prompt).toContain('"shape":"polygon"');
});


it('refuses a changed production draft after provider preparation and before paid authoring', async () => {
  const id = await fixture();
  h.onPrepare = () => projects.mutateProjectRecord(id, project => ({ project: { ...project,
    productionReview: { draft: { motionLanguage: 'Revised choreography' } },
  } }));
  await expect(generateMixedMediaDocument(id)).rejects.toMatchObject({ code: 'COMPOSITION_DRAFT_STALE' });
  expect(h.calls).toBe(0);
});

it('refuses ambient Three.js random helpers and their aliases while allowing deterministic local helpers', async () => {
  const created = await projects.createProject({ name: 'Example deterministic world', mediaMode: 'code-only' });
  await projects.mutateProjectRecord(created.id, current => ({ project: { ...current,
    audioAnalysis: { durationSec: 1, beats: [], downbeats: [], sections: [{ id: 'world', startSec: 0, endSec: 1 }] },
    composition: { mode: 'document', authoringRenderer: 'three' },
  } }));
  // Library helpers hide the ambient RNG from the existing Math.random guard;
  // namespace aliases and destructured calls must not bypass admission either.
  const bodies = [
    'ctx.THREE.MathUtils.randFloat(0, 1)',
    'ctx.THREE.MathUtils.randInt(0, 10)',
    'ctx.THREE.MathUtils.randFloatSpread(10)',
    'ctx.THREE.MathUtils.seededRandom()',
    'ctx.THREE.MathUtils.generateUUID()',
    'const { THREE } = ctx; const utils = THREE.MathUtils; utils["randFloat"](0, 1)',
    'const { MathUtils: { seededRandom: sample } } = ctx.THREE; sample()',
    'let utils; utils = ctx.THREE.MathUtils; const { randInt: sample } = utils; sample(0, 10)',
  ];
  for (const body of bodies) {
    h.response = JSON.stringify({ sections: [{ id: 'world', source: `function render(ctx, env) { ${body}; }` }] });
    await expect(generateMixedMediaDocument(created.id), body).rejects.toMatchObject({ code: 'NONDETERMINISTIC_SECTION' });
    expect((await projects.getProject(created.id)).composition.documentDraft).toBeUndefined();
  }
  h.response = JSON.stringify({ sections: [{ id: 'world', source: `function render(ctx, env) {
    const local = { randFloat: (seed) => (Math.sin(seed * 123.45) + 1) / 2 };
    const { THREE } = ctx;
    ctx.scene.background = new THREE.Color(local.randFloat(env.frame), 0.5, 0.2);
  }` }] });
  const candidate = await generateMixedMediaDocument(created.id);
  expect((await manifestAt(candidate.document)).renderer).toBe('three');
  expect(JSON.parse(await readFile(join(PATHS.data, candidate.document.directory, 'preview-playback.json'), 'utf8'))).toEqual({ version: 1, contract: 'portos-complete-frame-v1' });
});

describe('revision and checkpoint admission', () => {
  const checkpointPath = (id) => join(PATHS.data, 'cache', 'music-video-authoring', `${id}.json`);
  // Leaves a checkpoint whose basis matches the next identical local run.
  async function failedLocalRun(id) {
    await generateMixedMediaDocument(id, { providerId: 'stub-provider' });
    const budget = h.prompt.length - 200;
    h.provider = { id: 'ollama', type: 'api' };
    let calls = 0;
    h.onSubmit = async () => {
      if (++calls === 2) throw new Error('Later batch failed');
      h.response = response({ intro: '#010203', still: '#010203', clip: '#010203' });
    };
    await expect(generateMixedMediaDocument(id, { providerId: 'ollama', promptBudgetChars: budget })).rejects.toThrow('Later batch failed');
    h.onSubmit = null;
    h.calls = 0;
    return { budget, checkpoint: JSON.parse(await readFile(checkpointPath(id), 'utf8')) };
  }

  it('refuses a section the candidate does not have before any provider call', async () => {
    const id = await fixture();
    const first = (await generateMixedMediaDocument(id)).document;
    h.calls = 0;
    await expect(regenerateMixedMediaSection(id, 'missing', { expectedDraft: first.directory })).rejects.toMatchObject({ code: 'SECTION_NOT_FOUND', status: 404 });
    expect(h.calls).toBe(0);
  });

  it('refuses a section regenerate once the approved plan no longer matches the candidate', async () => {
    const id = await fixture();
    const first = (await generateMixedMediaDocument(id)).document;
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, treatment: { ...current.treatment, revision: 2 } } }));
    h.calls = 0;
    await expect(regenerateMixedMediaSection(id, 'still', { expectedDraft: first.directory })).rejects.toMatchObject({ code: 'COMPOSITION_DRAFT_STALE', message: expect.stringContaining('treatment or selected media') });
    expect(h.calls).toBe(0);
  });

  it('refuses a section regenerate after the active document under the candidate changed', async () => {
    const id = await fixture();
    const first = (await generateMixedMediaDocument(id)).document;
    await importDocumentTemplate(id);
    expect((await projects.getProject(id)).composition.documentDraft.directory).toBe(first.directory);
    h.calls = 0;
    await expect(regenerateMixedMediaSection(id, 'still', { expectedDraft: first.directory })).rejects.toMatchObject({ code: 'COMPOSITION_DRAFT_STALE', message: expect.stringContaining('selected document changed') });
    expect(h.calls).toBe(0);
  });

  it('reuses the candidate shared style contract when regenerating a section', async () => {
    const id = await fixture();
    const first = (await generateMixedMediaDocument(id)).document;
    const manifest = await manifestAt(first);
    manifest.sharedStyle = { ...manifest.sharedStyle, styleLines: ['Synthetic retained style line'] };
    await writeFile(join(PATHS.data, first.directory, 'manifest.json'), JSON.stringify(manifest));
    h.response = response({ still: '#00ff00' });
    const second = (await regenerateMixedMediaSection(id, 'still', { expectedDraft: first.directory })).document;
    expect(h.prompt).toContain('Synthetic retained style line');
    expect((await manifestAt(second)).sharedStyle.styleLines).toEqual(['Synthetic retained style line']);
  });

  it('keeps the accepted song and accumulates changed sections across revisions of one candidate', async () => {
    const id = await fixture();
    const accepted = (await generateMixedMediaDocument(id)).document;
    await acceptMixedMediaDocument(id, accepted.directory);
    const acceptedSong = (await manifestAt(accepted)).song;
    const current = await projects.getProject(id);
    await projects.updateProject(id, { composition: { ...current.composition, narrativeEvents: [{ id: 'reveal', name: 'Reveal', kind: 'reveal',
      anchor: { kind: 'time', atSec: 1 }, durationSec: 1, narrativeFunction: 'Introduce the kite', mediumRationale: 'Exact graphic' }] } });
    h.response = response({ intro: '#00ff00' });
    const revised = (await reviseMixedMediaEvents(id, { expectedDraft: accepted.directory })).document;
    const revisedManifest = await manifestAt(revised);
    expect(revisedManifest.changedSectionIds).toEqual(['intro']);
    expect(revisedManifest.beforeSong).toEqual(acceptedSong);
    h.response = response({ clip: '#0000ff' });
    const third = await manifestAt((await regenerateMixedMediaSection(id, 'clip', { expectedDraft: revised.directory })).document);
    expect(third.changedSectionIds).toEqual(['intro', 'clip']);
    expect(third.beforeSong).toEqual(acceptedSong);
    expect(third.beforeSong).not.toEqual(third.song);
  });

  for (const [label, write] of [
    ['unreadable', (id) => writeFile(checkpointPath(id), '{ not json')],
    ['unsupported-version', (id, checkpoint) => writeFile(checkpointPath(id), JSON.stringify({ ...checkpoint, version: 2 }))],
    ['malformed', (id, checkpoint) => writeFile(checkpointPath(id), JSON.stringify({ ...checkpoint, sections: 'intro' }))],
    ['providerless', (id, checkpoint) => writeFile(checkpointPath(id), JSON.stringify({ ...checkpoint, run: null }))],
  ]) {
    it(`refuses an ${label} local authoring checkpoint before any provider call`, async () => {
      const id = await fixture();
      const { budget, checkpoint } = await failedLocalRun(id);
      await write(id, checkpoint);
      await expect(generateMixedMediaDocument(id, { providerId: 'ollama', promptBudgetChars: budget })).rejects.toMatchObject({ code: 'COMPOSITION_CHECKPOINT_INVALID' });
      expect(h.calls).toBe(0);
    });
  }

  it('ignores checkpoint sections the requested song does not have', async () => {
    const id = await fixture();
    const { budget, checkpoint } = await failedLocalRun(id);
    await writeFile(checkpointPath(id), JSON.stringify({ ...checkpoint,
      sections: [...checkpoint.sections, { id: 'retired', source: 'function render(ctx) { ctx.fillRect(Math.random(), 0, 1, 1); }' }],
    }));
    h.response = response({ intro: '#aabbcc', still: '#aabbcc', clip: '#aabbcc' });
    const { document } = await generateMixedMediaDocument(id, { providerId: 'ollama', promptBudgetChars: budget });
    expect((await manifestAt(document)).sections.map((section) => section.id)).toEqual(['intro', 'still', 'clip']);
  });
});
