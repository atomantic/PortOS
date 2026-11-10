import { templateEffects } from './musicVideoTemplateEffects.js';
import { applyDocumentHandheld, documentHandheld } from './handheldCamera.js';

/**
 * The layered document template's camera for one scene, computed outside the
 * engine so the in-browser composition player can move a clip or still the way
 * the document draws it.
 *
 * This repeats `moveFor`, `beatIn` and `cameraView` from
 * `server/services/musicVideo/documentTemplates/layered/engine.js`. The engine
 * is a shipped, hash-recognized file that documents carry a copy of, so it
 * cannot import this module. `musicVideoDocumentCamera.test.js` runs the real
 * engine and fails when the two disagree.
 *
 * `rig` is `globalThis.PORTOS_CAMERA_RIG` (documentTemplates/layered/cameraRig.js).
 * Browser-safe.
 */

/** Scenes as the engine numbers them: timed, in song order. Returns `sceneId -> index`. */
export function documentSceneIndexes(scenes) {
  const timed = (scenes || [])
    .filter((scene) => scene?.sceneId && Number.isFinite(scene.startSec) && Number.isFinite(scene.endSec) && scene.endSec > scene.startSec)
    .slice()
    .sort((a, b) => a.startSec - b.startSec);
  return new Map(timed.map((scene, index) => [scene.sceneId, index]));
}

// Generated footage already carries its own camera move, so it only breathes.
function moveFor(rig, scene, { footage, index }) {
  if (footage) return rig.GENTLE.footage;
  const camera = scene.camera;
  if (camera?.move && rig.has(camera.move)) {
    return { move: camera.move, amount: rig.STILL_AMOUNT, base: 1.04, speed: camera.speed, onBeat: camera.onBeat === true };
  }
  if (scene.stillMove === 'hold') return rig.GENTLE.hold;
  if (scene.stillMove === 'push') return rig.GENTLE.push;
  if (scene.stillMove === 'pan') return rig.GENTLE[index % 2 ? 'drift-right' : 'drift-left'];
  return rig.GENTLE[rig.GENTLE_CYCLE[index % rig.GENTLE_CYCLE.length]];
}

// The scene's first downbeat (else beat) as normalized shot time, for snap and on-beat moves.
function beatIn(scene, beats, downbeats) {
  const span = scene.endSec - scene.startSec;
  const inside = (b) => b >= scene.startSec && b < scene.endSec;
  const hit = (downbeats || []).find(inside) ?? (beats || []).find(inside);
  return hit == null || !(span > 0) ? null : (hit - scene.startSec) / span;
}

/**
 * The cover transform at song time `t`: `{ scale, x, y, rotation }`, with `scale`
 * over the cover fit, `x`/`y` in frame widths/heights and `rotation` in radians.
 * `footage` is whether the document plays a clip for the scene; `index` is its
 * place from `documentSceneIndexes`. Null without a rig.
 */
export function documentCameraView(rig, scene, t, { footage = false, index = 0, aspect = 16 / 9, beats = [], downbeats = [], templateEffects: videoEffects = null } = {}) {
  if (!rig || !scene) return null;
  const span = scene.endSec - scene.startSec;
  const k = span > 0 ? Math.max(0, Math.min(1, (t - scene.startSec) / span)) : (t >= scene.endSec ? 1 : 0);
  const effects = templateEffects({ templateEffects: videoEffects }, scene);
  // A handheld operator (template additions handheld/handheldSteps) moves on top of the camera move, on shot time.
  const handheld = (view) => applyDocumentHandheld(view, documentHandheld(effects, scene.sceneId, aspect), t - scene.startSec, aspect);
  // Keep the shot's planned camera independent of the template's default motion.
  const planned = !footage && scene.camera?.move && rig.has(scene.camera.move);
  const strength = planned ? 1 : footage ? effects.footagePush : effects.stillMotion;
  if (strength === 0) return handheld({ scale: 1, x: 0, y: 0, rotation: 0 });
  const original = moveFor(rig, scene, { footage, index });
  const move = strength === 1 ? original : { ...original, amount: original.amount * strength, base: 1 + (original.base - 1) * strength };
  const options = { amount: move.amount, speed: move.speed, onBeat: move.onBeat, beat: beatIn(scene, beats, downbeats), aspect };
  const view = rig.flatView(move.move, k, options);
  const lowest = Math.min(1, rig.flatView(move.move, 0, options).zoom, rig.flatView(move.move, 1, options).zoom);
  // The smallest scale whose rotated, offset frame still holds every corner.
  const c = Math.abs(Math.cos(view.rotation));
  const s = Math.abs(Math.sin(view.rotation));
  const sx = 1 + 2 * Math.abs(view.x);
  const sy = 1 + 2 * Math.abs(view.y);
  const cover = Math.max(sx * c + sy * s / aspect, sy * c + sx * s * aspect);
  return handheld({ scale: Math.max((move.base * view.zoom) / lowest, cover), x: view.x, y: view.y, rotation: view.rotation });
}

/** A view as the CSS transform of an element that already cover-fits the frame. */
export function documentCameraCss(view) {
  if (!view) return 'none';
  const n = (value) => Number(value.toFixed(6));
  const turn = view.rotation ? ` rotate(${n(view.rotation)}rad)` : '';
  return `translate(${n(view.x * 100)}%, ${n(view.y * 100)}%)${turn} scale(${n(view.scale)})`;
}
