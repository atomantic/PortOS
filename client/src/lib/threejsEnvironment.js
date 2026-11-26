/**
 * Image-based lighting for the validated procedural sculpt spec (`server/lib/threejsModel.js`).
 *
 * `spec.lights` are punctual: they light a surface but give it nothing to REFLECT. Every reflective PBR channel (`metalness`, `transmission`, `clearcoat`, `iridescence`)
 * reads off an environment map, so a conductor renders near-black in a scene with none.
 *
 * Both presets use Three's own primitives and PMREMGenerator so rendering a local model works offline.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

// The R3F Canvas defaults match the shared profile's color space and tone mapping.
// The preview passes exposure separately because Canvas does not set it.
export {
  DEFAULT_THREEJS_ENVIRONMENT,
  THREEJS_ENVIRONMENT_PRESETS,
  THREEJS_RENDER_PROFILE,
  resolveThreejsEnvironment as resolveSculptEnvironment,
} from '../../../server/lib/threejsModelEnvironment.js';

// A three-panel softbox rig in a dark shell: a bright key, a broad soft fill opposite and a rim behind. Emissive panels rather than lights because PMREM prefilters what the scene
// RENDERS (a punctual light contributes almost nothing to the radiance map). The dark shell gives a conductor high-contrast highlights, which makes `metalness`/`clearcoat` legible.
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

/**
 * Release everything a preset scene allocated on the GPU. `node.dispose()` is
 * the one that matters for `RoomEnvironment`: it is built from `InstancedMesh`,
 * whose per-instance matrix buffer is uploaded separately from the geometry and
 * is not freed by disposing geometry and material alone.
 */
export function disposeSculptEnvironmentScene(scene) {
  scene?.traverse?.((node) => {
    node.geometry?.dispose?.();
    const material = node.material;
    if (Array.isArray(material)) material.forEach((entry) => entry?.dispose?.());
    else material?.dispose?.();
    node.dispose?.();
  });
}

/**
 * PMREM-prefilter a preset into the render target whose `.texture` is what `scene.environment` wants, or null for `none`. The source scene and generator are released here;
 * the CALLER owns the returned target and must `dispose()` it. The TARGET is returned, not the texture, because the framebuffer/depth attachment is only freed by
 * `WebGLRenderTarget.dispose()` (disposing the texture alone leaks them on every preset swap).
 *
 * @param {THREE.WebGLRenderer} renderer the live renderer (PMREM needs a GL context)
 * @param {string} preset one of `THREEJS_ENVIRONMENT_PRESETS`
 */
export function createSculptEnvironmentTarget(renderer, preset) {
  if (!renderer) return null;
  const scene = createSculptEnvironmentScene(preset);
  if (!scene) return null;
  const pmrem = new THREE.PMREMGenerator(renderer);
  // `finally`, not `catch`: a lost GL context still throws through to the
  // caller, but the generator's own targets and the source scene are released
  // either way instead of leaking on the failing path.
  try {
    return pmrem.fromScene(scene, 0.04);
  } finally {
    pmrem.dispose();
    disposeSculptEnvironmentScene(scene);
  }
}
