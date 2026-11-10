import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { documentCameraCss, documentCameraView, documentSceneIndexes } from './musicVideoDocumentCamera.js';
import { documentHandheld } from './handheldCamera.js';
import { templateEffects } from './musicVideoTemplateEffects.js';

const layered = new URL('../services/musicVideo/documentTemplates/layered/', import.meta.url);
const W = 1920, H = 1080;

// Runs the shipped engine against recording canvases and returns the view it
// drew each scene's still with at song time `t`.
async function engineViews(scenes, song, times) {
  const calls = [];
  const makeCanvas = () => {
    const context = new Proxy({}, { get(_target, key) {
      if (key === 'createImageData' || key === 'getImageData') return (_x, _y, w, h) => ({ data: new Uint8ClampedArray((w || _x) * (h || _y) * 4) });
      if (key === 'measureText') return (text) => ({ width: String(text).length * 10 });
      if (key === 'createRadialGradient' || key === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (key === 'createPattern') return () => ({});
      return (...args) => { calls.push([key, ...args]); };
    } });
    return { width: W, height: H, getContext: () => context };
  };
  function TestImage() { this.naturalWidth = W; this.naturalHeight = H; }
  Object.defineProperty(TestImage.prototype, 'src', { set(value) { this.url = value; queueMicrotask(() => this.onload()); } });
  const front = makeCanvas();
  const sandbox = { setTimeout, clearTimeout, queueMicrotask, Image: TestImage, performance: { now: () => 0 },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    document: { getElementById: () => front, createElement: () => makeCanvas(), fonts: { load: () => Promise.resolve() } },
    PORTOS_MV: { render: { width: W, height: H, fps: 24, durationSec: 20 }, song, composition: {}, scenes },
    PORTOS_MV_EVENT_STATE: (_song, t) => ({ t, hold: false, activeEvents: [], reactiveGain: 0 }),
    PORTOS_LYRIC_TYPE: { createLyricType: () => ({ ready: Promise.resolve(), draw() {} }) }, postMessage() {} };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  runInNewContext(await readFile(new URL('cameraRig.js', layered), 'utf8'), sandbox);
  runInNewContext(await readFile(new URL('engine.js', layered), 'utf8'), sandbox);
  const views = [];
  for (const t of times) {
    calls.length = 0;
    await sandbox.portosComposition.seek(t);
    const at = calls.findIndex((call) => call[0] === 'drawImage' && call[1] instanceof TestImage);
    const [, , x, y, dw] = calls[at];
    // A rotated draw is centred on a translate + rotate; an unrotated one carries its own offset.
    const rotate = calls.slice(0, at).reverse().find((call) => call[0] === 'rotate' || call[0] === 'save');
    if (rotate?.[0] === 'rotate') {
      const translate = calls.slice(0, at).reverse().find((call) => call[0] === 'translate');
      views.push({ scale: dw / W, x: (translate[1] - W / 2) / W, y: (translate[2] - H / 2) / H, rotation: rotate[1] });
    } else views.push({ scale: dw / W, x: (x - (W - dw) / 2) / W, y: (y - (H - dw * H / W) / 2) / H, rotation: 0 });
  }
  return { views, rig: sandbox.PORTOS_CAMERA_RIG };
}

describe('document camera outside the engine', () => {
  // Uniquely catches the in-browser composition player moving a still differently from the document's own frame.
  it('matches the shipped engine for every kind of still move', async () => {
    const still = (sceneId, startSec, extra = {}) => ({ sceneId, startSec, endSec: startSec + 4, visualLayer: 'still', media: { kind: 'image', src: `${sceneId}.png` }, ...extra });
    const scenes = [
      still('hold', 0, { stillMove: 'hold' }),
      still('push', 4, { stillMove: 'push' }),
      still('pan-even', 8, { stillMove: 'pan' }),
      still('pan-odd', 12, { stillMove: 'pan' }),
      still('cycle', 16),
      still('planned', 20, { camera: { move: 'dutch-roll', speed: 'fast', onBeat: true } }),
    ];
    const song = { sections: [], beats: [0.5, 1, 20.4, 21.2, 22], downbeats: [1, 21.2] };
    const times = scenes.flatMap((scene) => [scene.startSec, scene.startSec + 1.3, scene.startSec + 3.9]);
    const { views, rig } = await engineViews(scenes, song, times);
    expect(rig.has('dutch-roll')).toBe(true);
    const indexes = documentSceneIndexes(scenes);
    times.forEach((t, i) => {
      const scene = scenes[Math.floor(i / 3)];
      const view = documentCameraView(rig, scene, t, { index: indexes.get(scene.sceneId), aspect: W / H, beats: song.beats, downbeats: song.downbeats });
      for (const key of ['scale', 'x', 'y', 'rotation']) expect(view[key], `${scene.sceneId} ${key} at ${t}`).toBeCloseTo(views[i][key], 6);
    });
    // The planned move really turns the frame, so the rotated draw path was compared too.
    expect(views.slice(15).some((view) => view.rotation !== 0)).toBe(true);
  });

  it('breathes footage with the rig\'s footage move and writes the view as a transform', async () => {
    const { rig } = await engineViews([], { sections: [] }, []);
    const scene = { sceneId: 'clip', startSec: 2, endSec: 6 };
    const start = documentCameraView(rig, scene, 2, { footage: true });
    const end = documentCameraView(rig, scene, 6, { footage: true });
    expect(start.scale).toBeCloseTo(rig.GENTLE.footage.base, 6);
    expect(end.scale).toBeGreaterThan(start.scale);
    expect(end.scale).toBeLessThan(1.12);
    expect(documentCameraCss({ scale: 1.05, x: 0.01, y: -0.02, rotation: 0 })).toBe('translate(1%, -2%) scale(1.05)');
    expect(documentCameraCss({ scale: 1.2, x: 0, y: 0, rotation: 0.1 })).toBe('translate(0%, 0%) rotate(0.1rad) scale(1.2)');
    expect(documentCameraCss(null)).toBe('none');
    expect(documentCameraView(null, scene, 2)).toBeNull();
  });
});

// The smooth native preview must honor video controls and a shot's override of them.
it('turns footage push and still motion off in the native player, and resolves shot overrides', async () => {
  const { rig } = await engineViews([], { sections: [] }, []);
  const scene = { sceneId: 'clip', startSec: 0, endSec: 4, stillMove: 'pan' };
  for (const footage of [true, false]) {
    for (const t of [0, 1, 3.9]) {
      const view = documentCameraView(rig, scene, t, { footage, templateEffects: { footagePush: 0, stillMotion: 0 } });
      for (const key of ['x', 'y', 'rotation']) expect(view[key]).toBeCloseTo(0, 8);
      expect(view.scale).toBe(1);
    }
  }
  const own = { ...scene, templateEffects: { footagePush: 0.5 } };
  expect(documentCameraView(rig, own, 3, { footage: true, templateEffects: { footagePush: 0 } }).scale).toBeGreaterThan(1);
});

// Uniquely catches the handheld operator moving the live preview differently from the rendered document.
it('matches the shipped engine for a handheld shot, on its own and over a planned move', async () => {
  const still = (sceneId, startSec, extra = {}) => ({ sceneId, startSec, endSec: startSec + 4, visualLayer: 'still', media: { kind: 'image', src: `${sceneId}.png` }, ...extra });
  const scenes = [
    still('walk', 0, { stillMove: 'hold', templateEffects: { handheld: 0.7, handheldSteps: 0.8 } }),
    still('steady-hands', 4, { templateEffects: { handheld: 0.3 } }),
    still('rolling', 8, { camera: { move: 'dutch-roll', speed: 'fast' }, templateEffects: { handheld: 1, handheldSteps: 1, stillMotion: 0.5 } }),
  ];
  // What documentRender writes for each scene.
  const engineScenes = scenes.map((scene) => ({ ...scene, handheld: documentHandheld(templateEffects({}, scene), scene.sceneId, W / H) }));
  const song = { sections: [], beats: [], downbeats: [] };
  const times = scenes.flatMap((scene) => [scene.startSec, scene.startSec + 0.7, scene.startSec + 2.35, scene.startSec + 3.9]);
  const { views, rig } = await engineViews(engineScenes, song, times);
  const indexes = documentSceneIndexes(scenes);
  times.forEach((t, i) => {
    const scene = scenes[Math.floor(i / 4)];
    const view = documentCameraView(rig, scene, t, { index: indexes.get(scene.sceneId), aspect: W / H });
    for (const key of ['scale', 'x', 'y', 'rotation']) expect(view[key], `${scene.sceneId} ${key} at ${t}`).toBeCloseTo(views[i][key], 6);
  });
  // The operator really moves the frame between samples of one shot.
  expect(new Set(views.slice(0, 4).map((view) => view.x.toFixed(5))).size).toBe(4);
  expect(views.slice(0, 4).every((view) => view.rotation !== 0)).toBe(true);
});
