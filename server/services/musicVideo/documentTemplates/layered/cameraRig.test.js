import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CAMERA_MOVEMENTS, CAMERA_MOVEMENT_VALUES } from '../../../../lib/cameraMovements.js';

// cameraRig.js is a classic browser script; load it the way a document does.
const rigSource = readFileSync(new URL('./cameraRig.js', import.meta.url), 'utf8');
const loadRig = () => {
  const context = {};
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(rigSource, context);
  return context.PORTOS_CAMERA_RIG;
};
const rig = loadRig();
const finite = (s) => [...s.position, ...s.target, ...s.up, s.fov, s.roll, s.blur, s.focusShift, s.timeScale, s.subjectFraction].every(Number.isFinite);

describe('camera rig paths', () => {
  it('has exactly one path per shared catalog id', () => {
    expect([...rig.ids].sort()).toEqual([...CAMERA_MOVEMENT_VALUES].sort());
    expect(rig.has('whip-pan')).toBe(true);
    expect(rig.has('teleport')).toBe(false);
  });

  it.each(CAMERA_MOVEMENTS.map((move) => [move.value, move]))('%s is finite at t = 0, 0.5, 1 and frames like the catalog', (id, move) => {
    for (const t of [0, 0.5, 1]) expect(finite(rig.sample(id, t))).toBe(true);
    expect(rig.sample(id, 0).framing).toBe(move.startFraming);
    expect(rig.sample(id, 1).framing).toBe(move.endFraming);
    for (const t of [0, 0.5, 1]) {
      const view = rig.flatView(id, t);
      expect([view.zoom, view.x, view.y, view.rotation, view.blur, view.timeScale].every(Number.isFinite)).toBe(true);
    }
  });

  it('agrees with the catalog on which moves are snap and fast', () => {
    for (const move of CAMERA_MOVEMENTS) {
      expect(rig.defaultSpeed(move.value) === 'snap').toBe(move.speed === 'snap');
      expect(rig.defaultSpeed(move.value) === 'fast').toBe(move.speed === 'fast');
    }
  });

  it('is deterministic', () => {
    expect(JSON.stringify(loadRig().sample('handheld', 0.37))).toBe(JSON.stringify(rig.sample('handheld', 0.37)));
  });

  it('lands a snap move on the beat and an on-beat move by the beat', () => {
    expect(rig.progress('whip-pan', 0.3, { beat: 0.5 })).toBe(0);
    expect(rig.progress('whip-pan', 0.7, { beat: 0.5 })).toBe(1);
    expect(rig.progress('whip-pan', 0.5, { beat: 0.5 })).toBeCloseTo(0.5, 5);
    expect(rig.progress('slow-dolly-in', 0.4, { beat: 0.4, onBeat: true })).toBe(1);
    expect(rig.progress('slow-dolly-in', 0.5, { amount: 0.5 })).toBeCloseTo(0.25, 5);
  });

  it('drives a three.js-shaped camera', () => {
    const vec = () => ({ set(x, y, z) { Object.assign(this, { x, y, z }); } });
    const camera = { position: vec(), up: vec(), fov: 0, rotation: { z: 0 }, lookAt(x, y, z) { this.looked = [x, y, z]; }, rotateZ(r) { this.rolled = r; }, updateProjectionMatrix() { this.updated = true; } };
    const state = rig.sample('dutch-roll', 1);
    rig.applyToCamera(camera, state);
    expect([camera.position.x, camera.position.y, camera.position.z]).toEqual(state.position);
    expect(camera.fov).toBe(state.fov);
    expect(camera.looked).toEqual(state.target);
    expect(camera.rolled).toBe(state.roll);
    expect(camera.updated).toBe(true);
  });

  it('keeps the gentle engine moves as rig entries', () => {
    for (const key of ['footage', 'hold', 'push', 'pull', 'drift-left', 'drift-right', 'rise', ...rig.GENTLE_CYCLE]) {
      expect(rig.has(rig.GENTLE[key].move)).toBe(true);
    }
  });
});

// The engine's cover transform, evaluated on its own like engine.overlay.test.js.
const engine = readFileSync(new URL('./engine.js', import.meta.url), 'utf8');
const cameraBlock = engine.slice(engine.indexOf('  const RIG = globalThis.PORTOS_CAMERA_RIG'), engine.indexOf('  // ---------- media'));
const W = 1920; const H = 1080;
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lerp = (a, b, k) => a + (b - a) * k;
const seg = (t, a, b) => (b > a ? clamp((t - a) / (b - a)) : (t >= b ? 1 : 0));
const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const engineCamera = (portosRig) => new Function('W', 'H', 'downs', 'beats', 'globalThis', 'lerp', 'easeInOut', 'seg',
  `${cameraBlock}\nreturn { cameraView, cameraSample, moveFor };`)(W, H, [2, 6], [1, 2, 3, 4, 5, 6], { PORTOS_CAMERA_RIG: portosRig }, lerp, easeInOut, seg);

// Every canvas corner must land inside the rotated, scaled, offset frame (a same-aspect source is the tightest case).
function coversCanvas(view) {
  const dw = W * view.scale; const dh = H * view.scale;
  const cx = W / 2 + view.x * W; const cy = H / 2 + view.y * H;
  const cos = Math.cos(-view.rotation); const sin = Math.sin(-view.rotation);
  return [[0, 0], [W, 0], [0, H], [W, H]].every(([px, py]) => {
    const dx = px - cx; const dy = py - cy;
    return Math.abs(dx * cos - dy * sin) <= dw / 2 + 1e-6 && Math.abs(dx * sin + dy * cos) <= dh / 2 + 1e-6;
  });
}

describe('layered engine camera', () => {
  const { cameraView, cameraSample, moveFor } = engineCamera(rig);
  const still = (extra = {}) => ({ index: 0, startSec: 0, endSec: 8, media: { kind: 'image' }, ...extra });

  it.each(CAMERA_MOVEMENT_VALUES)('a still planned as %s never shows a frame edge', (move) => {
    for (let k = 0; k <= 1.0001; k += 0.05) expect(coversCanvas(cameraView(still({ camera: { move } }), k))).toBe(true);
  });

  it('keeps the gentle defaults edge-free too', () => {
    for (const stillMove of ['hold', 'push', 'pan', undefined]) {
      for (let index = 0; index < 5; index++) {
        for (let k = 0; k <= 1.0001; k += 0.1) expect(coversCanvas(cameraView(still({ stillMove, index }), k))).toBe(true);
      }
    }
    for (let k = 0; k <= 1.0001; k += 0.1) expect(coversCanvas(cameraView(still({ media: { kind: 'video' }, camera: { move: 'whip-pan' } }), k))).toBe(true);
  });

  it('plays a still\'s planned move over its still Move, and lets footage keep its own camera', () => {
    expect(moveFor(still({ camera: { move: 'orbit-180', speed: 'fast' }, stillMove: 'hold' }))).toMatchObject({ move: 'orbit-180', speed: 'fast' });
    expect(moveFor(still({ stillMove: 'hold' }))).toBe(rig.GENTLE.hold);
    expect(moveFor(still({ media: { kind: 'video' }, camera: { move: 'whip-pan' } }))).toBe(rig.GENTLE.footage);
    expect(moveFor(still({ camera: { move: 'teleport' }, stillMove: 'push' }))).toBe(rig.GENTLE.push);
  });

  it('hands authored code the rig sample for a planned move', () => {
    const sample = cameraSample(still({ camera: { move: 'crash-zoom', onBeat: true } }), 4);
    expect(sample.move).toBe('crash-zoom');
    expect(finite(sample)).toBe(true);
    expect(cameraSample(still(), 4)).toBeNull();
  });

  it('falls back to a slow push when the document has no rig script', () => {
    const fallback = engineCamera(undefined);
    expect(fallback.cameraView(still({ camera: { move: 'whip-pan' } }), 0)).toEqual({ scale: 1.04, x: 0, y: 0, rotation: 0 });
    expect(fallback.cameraView(still(), 1).scale).toBeCloseTo(1.1, 6);
    expect(fallback.cameraSample(still({ camera: { move: 'whip-pan' } }), 1)).toBeNull();
  });
});
