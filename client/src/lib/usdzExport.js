/**
 * USDZ (AR Quick Look) export helpers for the 3D viewer (#5756).
 *
 * `exportSceneToUsdz(scene, { maxTextureSize })` lazy-loads three's `USDZExporter` and serializes the
 * already-decoded scene, `countSceneTriangles(object3d)` measures a graph against `AR_TRIANGLE_BUDGET`, and `supportsArQuickLook()` feature-detects the `<a rel="ar">` handoff
 * (Safari on iOS/iPadOS only, never sniff the user agent). `AR_MAX_TEXTURE_SIZE` bounds the file: USDZ stores every texel raw.
 * The conversion runs in the BROWSER (the viewer already decoded the GLB; PortOS ships no USD toolchain). Pure and React-free: the calling panel owns the UI state.
 */

/**
 * Triangles above which an AR export is worth warning about. Not a hard refusal: AR Quick Look has no published limit, it degrades (long load, blank room) and the threshold depends on the device.
 * The GLB the exporter reads is already the DECIMATED mesh, so a record over budget had its Quality tier pushed high; say so and name the count rather than ship a file the phone chokes on.
 */
export const AR_TRIANGLE_BUDGET = 500_000;

/**
 * Texture edge the exporter downsamples to. USDZ has no Draco/meshopt equivalent (every vertex and texel is stored raw), so textures make an export unopenable on a phone;
 * 1024 is three's default and keeps a typical export in single-digit MB.
 */
export const AR_MAX_TEXTURE_SIZE = 1024;

/** Count the triangles a three.js object graph would render, reading the geometry (`index` vs position attribute) rather than assuming a `Mesh`-only tree. */
export function countSceneTriangles(object3d) {
  let triangles = 0;
  object3d?.traverse?.((child) => {
    const geometry = child.isMesh ? child.geometry : null;
    if (!geometry) return;
    const vertices = geometry.index ? geometry.index.count : (geometry.attributes?.position?.count ?? 0);
    triangles += Math.floor(vertices / 3);
  });
  return triangles;
}

/**
 * Whether THIS browser can hand a `.usdz` to AR Quick Look: feature-detected via `relList.supports('ar')`, not the user agent. Only Safari on iOS/iPadOS/visionOS implements the `rel="ar"` handoff;
 * every other browser (including Chrome on the same iPhone) must be offered a plain download.
 * The try/catch is load-bearing: `DOMTokenList.supports()` is SPECIFIED to throw `TypeError` for an attribute with no supported-tokens list (every engine without AR Quick Look, for `rel`),
 * and callers run this during render, so an uncaught throw would unmount the whole route.
 */
export function supportsArQuickLook() {
  if (typeof document === 'undefined') return false;
  const relList = document.createElement('a').relList;
  try {
    return Boolean(relList?.supports?.('ar'));
  } catch {
    return false;
  }
}

/**
 * Serialize a loaded scene to USDZ bytes. The exporter module is imported lazily (~35 KB plus a zip library, needed by this one action); `vite.chunkGroups.js` folds `three` into `vendor-three`,
 * so the deferral keeps it off other routes. The scene is the GLTF cache's object graph: read, never mutated or disposed.
 * @param {import('three').Object3D} scene
 * @param {{ maxTextureSize?: number }} [options]
 * @returns {Promise<ArrayBuffer>}
 */
export async function exportSceneToUsdz(scene, { maxTextureSize = AR_MAX_TEXTURE_SIZE } = {}) {
  if (!scene) throw new Error('The 3D model is still loading — try again in a moment.');
  const { USDZExporter } = await import('three/examples/jsm/exporters/USDZExporter.js');
  const exporter = new USDZExporter();
  return exporter.parseAsync(scene, {
    maxTextureSize,
    // Horizontal plane anchoring: these are objects, so AR Quick Look drops them on the floor/table, not a wall.
    ar: { anchoring: { type: 'plane' }, planeAnchoring: { alignment: 'horizontal' } },
  });
}
