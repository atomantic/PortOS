/**
 * USDZ (AR Quick Look) export helpers for the 3D viewer (#5756).
 *
 * The conversion runs in the BROWSER: by the time the user can ask for it, the
 * viewer has already parsed the GLB and decoded every texture, so three's
 * `USDZExporter` only has to re-serialize what is in memory. PortOS ships no USD
 * toolchain, and a server-side converter would have to redo all of that decode
 * work in Node to produce a file the page already holds.
 *
 * Pure and React-free on purpose — the panel that calls this owns the UI state.
 */

/**
 * Triangles above which an AR export is worth warning about.
 *
 * Not a hard refusal: AR Quick Look has no published limit, it degrades (long
 * load, then a blank room) rather than erroring, and the threshold depends on the
 * device. The viewer-grade GLB the exporter reads is already the DECIMATED mesh —
 * the million-face `model.obj` sidecar is never loaded here — so a record over
 * this budget is one whose Quality tier was pushed high, and the honest remedy is
 * to say so and name the count rather than to silently ship a file the user's
 * phone will choke on.
 */
export const AR_TRIANGLE_BUDGET = 500_000;

/**
 * Texture edge the exporter downsamples to.
 *
 * USDZ has no Draco/meshopt equivalent — every vertex and every texel is stored
 * raw — so textures, not geometry, are what make an export unopenable on a phone.
 * 1024 is three's own default and keeps a typical export in single-digit
 * megabytes.
 */
export const AR_MAX_TEXTURE_SIZE = 1024;

/**
 * Count the triangles a three.js object graph would render.
 *
 * Indexed and non-indexed geometry differ in where the count lives (`index` vs
 * the position attribute), and a `Points`/`Line` child has neither — so this reads
 * the geometry rather than assuming a `Mesh`-only tree.
 */
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
 * Whether THIS browser can hand a `.usdz` to AR Quick Look.
 *
 * Feature-detected via `relList.supports('ar')` rather than sniffed from the user
 * agent: only Safari on iOS/iPadOS/visionOS implements the `rel="ar"` handoff, and
 * every other browser — including Chrome on the very same iPhone — must be offered
 * a plain download instead. Labelling a desktop button "View in AR" when nothing
 * will happen is the failure mode this exists to prevent.
 *
 * The try/catch is load-bearing, not defensive habit: `DOMTokenList.supports()` is
 * SPECIFIED to throw `TypeError` when the attribute has no supported-tokens list,
 * which is what every engine without AR Quick Look does for `rel`. Callers run this
 * during render, so an uncaught throw here unmounts the whole route rather than
 * hiding one button.
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
 * Serialize a loaded scene to USDZ bytes.
 *
 * The exporter module is imported lazily: it is ~35 KB plus its zip library, and
 * nothing outside this one action needs it. `vite.chunkGroups.js` folds all of
 * `three` into the `vendor-three` chunk, which the 3D page already loads for the
 * viewer — so the deferral keeps this off every other route rather than splitting
 * it out of that chunk. Note the scene handed in is the drei cache's own object
 * graph — it is read, never mutated or disposed.
 *
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
    // Horizontal plane anchoring: these models are objects, so AR Quick Look
    // should drop them on the floor/table rather than a wall.
    ar: { anchoring: { type: 'plane' }, planeAnchoring: { alignment: 'horizontal' } },
  });
}
