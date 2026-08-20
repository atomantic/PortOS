/**
 * Image-based lighting for the validated procedural sculpt spec
 * (`server/lib/threejsModel.js`).
 *
 * `spec.lights` are punctual: they light a surface but give it nothing to
 * REFLECT. Every reflective PBR channel the material schema accepts —
 * `metalness`, `transmission`, `clearcoat`, `iridescence` — reads off an
 * environment map or reads off nothing at all, so a physically plausible
 * conductor renders near-black in a scene with none.
 *
 * Both presets are built here from three's own primitives and prefiltered
 * through `PMREMGenerator`. Deliberately NOT drei's `<Environment preset=…>`:
 * that fetches an HDR from a CDN, and rendering a local model must never make an
 * outbound request.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/**
 * Mirrors `THREEJS_ENVIRONMENT_PRESETS` in `server/lib/threejsModel.js`, which
 * is the authoring contract. `threejsEnvironment.test.js` asserts the two agree.
 */
export const THREEJS_ENVIRONMENT_PRESETS = ['none', 'neutral', 'studio'];

/** Mirrors `DEFAULT_THREEJS_ENVIRONMENT` — what a spec with no key was rendered with. */
export const DEFAULT_THREEJS_ENVIRONMENT = Object.freeze({ preset: 'none', intensity: 1 });

/**
 * Mirrors `THREEJS_RENDER_PROFILE`, the colour-management contract
 * `buildThreejsFactorySource()` stamps onto every export. The preview has to
 * actually render at these settings or the exported claim is false, and two
 * renders of the same spec stop being comparable.
 *
 * `outputColorSpace` and `toneMapping` are what react-three-fiber's `<Canvas>`
 * installs for `linear={false} flat={false}` (its defaults), so the preview
 * simply must not pass either flag; `toneMappingExposure` is the one it does not
 * touch, so the preview passes it through `gl`.
 */
export const THREEJS_RENDER_PROFILE = Object.freeze({
  outputColorSpace: 'srgb',
  toneMapping: 'ACESFilmic',
  toneMappingExposure: 1,
});

/**
 * The spec's environment, normalized. Client mirror of
 * `resolveThreejsEnvironment` — the preview is handed a bare spec, including
 * records stored before this block shipped, which read as `none` because that is
 * what they were authored against.
 */
export function resolveSculptEnvironment(spec) {
  const environment = spec?.environment;
  if (!environment || typeof environment !== 'object') return { ...DEFAULT_THREEJS_ENVIRONMENT };
  return {
    preset: THREEJS_ENVIRONMENT_PRESETS.includes(environment.preset)
      ? environment.preset
      : DEFAULT_THREEJS_ENVIRONMENT.preset,
    intensity: typeof environment.intensity === 'number' && Number.isFinite(environment.intensity)
      ? environment.intensity
      : DEFAULT_THREEJS_ENVIRONMENT.intensity,
  };
}

// A three-panel softbox rig in a dark shell: a bright key, a broad soft fill
// opposite it, and a rim behind the subject. Emissive panels rather than lights
// because PMREM prefilters what the scene RENDERS — a punctual light in the
// source scene contributes almost nothing to the resulting radiance map, while a
// panel becomes a reflection with a readable shape. The dark shell is the point
// of the preset: it gives a conductor high-contrast highlights and real dark
// regions, which is what makes `metalness` and `clearcoat` legible at all.
const STUDIO_PANELS = [
  { size: [7, 7], position: [5, 4, 5], intensity: 6 },
  { size: [9, 6], position: [-6, 2, 3], intensity: 1.8 },
  { size: [7, 5], position: [0, 3.5, -7], intensity: 3 },
  // Floor bounce, so the underside is not a void.
  { size: [12, 12], position: [0, -5, 0], intensity: 0.6 },
];

const STUDIO_SHELL_COLOR = 0x14171d;

function createStudioEnvironmentScene() {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(
    new THREE.BoxGeometry(32, 24, 32),
    new THREE.MeshBasicMaterial({ color: STUDIO_SHELL_COLOR, side: THREE.BackSide })
  ));
  for (const panel of STUDIO_PANELS) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(...panel.size),
      // Above 1 on purpose: the colour is a linear radiance value here, not a
      // display colour, and a softbox that only ever reaches white reflects as
      // flat grey on a smooth metal.
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide })
    );
    mesh.material.color.multiplyScalar(panel.intensity);
    mesh.position.set(...panel.position);
    mesh.lookAt(0, 0, 0);
    scene.add(mesh);
  }
  return scene;
}

/**
 * The source scene for a preset, or null for `none` (and for an unknown preset,
 * which a newer peer's spec can carry — an unrecognized name renders as no
 * environment rather than as a guess at which one was meant).
 * Caller owns disposal via `disposeSculptEnvironmentScene`.
 */
export function createSculptEnvironmentScene(preset) {
  if (preset === 'neutral') return new RoomEnvironment();
  if (preset === 'studio') return createStudioEnvironmentScene();
  return null;
}

/** Release every geometry and material a preset scene allocated. */
export function disposeSculptEnvironmentScene(scene) {
  scene?.traverse?.((node) => {
    node.geometry?.dispose?.();
    const material = node.material;
    if (Array.isArray(material)) material.forEach((entry) => entry?.dispose?.());
    else material?.dispose?.();
  });
}

/**
 * PMREM-prefilter a preset into the texture `scene.environment` wants, or null
 * for `none`. The source scene and the generator are both released here; the
 * CALLER owns the returned texture and must dispose it.
 *
 * @param {THREE.WebGLRenderer} renderer the live renderer (PMREM needs a GL context)
 * @param {string} preset one of `THREEJS_ENVIRONMENT_PRESETS`
 */
export function createSculptEnvironmentTexture(renderer, preset) {
  if (!renderer) return null;
  const scene = createSculptEnvironmentScene(preset);
  if (!scene) return null;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(scene, 0.04).texture;
  pmrem.dispose();
  disposeSculptEnvironmentScene(scene);
  return texture;
}
