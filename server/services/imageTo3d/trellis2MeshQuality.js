/**
 * TRELLIS.2 (Apple Silicon / MPS) — mesh-quality knobs the upstream port hardcodes.
 * Pure selectors.
 *
 * `generate.py` clamps its bake mesh to 200000 faces, tuned for the 512 pipeline; on
 * `1024_cascade` (~22.7M faces) that discards 99.1% of the geometry. The clamp guarded a mtlbvh
 * traversal-stack bug already fixed in the installed dependency set.
 *
 * 1,000,000 is the exporter's own default and below every reported working size (mtlbvh clean
 * at 8.6M). Browser weight is the other limit: 1M faces lands the viewer near ~105 MB; larger
 * belongs in a separate high-detail export.
 */

/** The upstream `generate.py` clamp the runner asserts against. */
export const TRELLIS2_DECIMATION_UPSTREAM_CLAMP = 200000;

/** Baseline tier (the supported 24 GB floor). */
export const TRELLIS2_DECIMATION_BASELINE = 500000;

/** High-memory tier — `to_glb`'s own default. */
export const TRELLIS2_DECIMATION_HIGH = 1000000;

/**
 * Per-run override range; the ceiling is the largest published Apple-Silicon result.
 */
export const TRELLIS2_DECIMATION_MIN = 1;
export const TRELLIS2_DECIMATION_MAX = 8600000;

/**
 * Pick the viewer-GLB decimation target from unified memory. The threshold is passed in to
 * avoid a cycle into `trellis2.js`.
 *
 * @param {number} unifiedMemoryGb
 * @param {number} highTierMinGb the shared high-tier memory threshold
 * @returns {number}
 */
export function selectTrellis2DecimationTarget(unifiedMemoryGb, highTierMinGb) {
  return Number(unifiedMemoryGb) >= highTierMinGb
    ? TRELLIS2_DECIMATION_HIGH
    : TRELLIS2_DECIMATION_BASELINE;
}

/** Usable explicit decimation target (null/undefined = unset). */
export const isValidDecimationTarget = (value) => (
  Number.isInteger(value)
  && value >= TRELLIS2_DECIMATION_MIN
  && value <= TRELLIS2_DECIMATION_MAX
);

/**
 * Accepted glTF alpha modes, mirroring `o_voxel.postprocess.to_glb`. `'auto'` is the
 * exporter's heuristic: BLEND only when >1% of valid texels fall below the alpha threshold;
 * that floor is what `forceOpaqueGlbMaterials` (glbMaterials.js) defended against.
 */
export const TRELLIS2_ALPHA_MODES = ['OPAQUE', 'auto', 'BLEND', 'MASK'];

/**
 * Cap on the source mesh the normal-map bake builds its BVH over; above it the source is
 * decimated for the bake ONLY.
 */
export const TRELLIS2_NORMAL_SOURCE_FACE_CAP = 8000000;

/**
 * Emit the runner's PortOS-only flags, terminated by `--`. The separator is load-bearing:
 * what follows goes to upstream's argparse, which would reject these flags. `null`/`false`
 * omits a flag so the exporter default applies.
 *
 * Throws rather than clamping a bad `decimationTarget`: a clamped value would make the run
 * ledger record a target the subprocess never received.
 *
 * @param {{decimationTarget?: number|null, fillHoles?: boolean, remesh?: boolean,
 *          meshClusterRefineIterations?: number|null,
 *          meshClusterSmoothStrength?: number|null,
 *          alphaMode?: string|null, normalMap?: boolean,
 *          normalMapMaxSourceFaces?: number|null}} [opts]
 * @returns {string[]}
 */
export function trellis2MeshQualityArgs({
  decimationTarget = null,
  fillHoles = false,
  remesh = false,
  meshClusterRefineIterations = null,
  meshClusterSmoothStrength = null,
  alphaMode = null,
  normalMap = false,
  normalMapMaxSourceFaces = null,
} = {}) {
  if (decimationTarget !== null && !isValidDecimationTarget(decimationTarget)) {
    throw new Error(
      `trellis2MeshQualityArgs: decimationTarget must be an integer in `
      + `[${TRELLIS2_DECIMATION_MIN}, ${TRELLIS2_DECIMATION_MAX}]`,
    );
  }
  if (alphaMode !== null && !TRELLIS2_ALPHA_MODES.includes(alphaMode)) {
    throw new Error(
      `trellis2MeshQualityArgs: alphaMode must be one of ${TRELLIS2_ALPHA_MODES.join(', ')}`,
    );
  }
  return [
    ...(decimationTarget !== null ? ['--decimation-target', String(decimationTarget)] : []),
    ...(fillHoles ? ['--fill-holes'] : []),
    ...(remesh ? ['--remesh'] : []),
    ...(meshClusterRefineIterations !== null
      ? ['--mesh-cluster-refine-iterations', String(meshClusterRefineIterations)] : []),
    ...(meshClusterSmoothStrength !== null
      ? ['--mesh-cluster-smooth-strength', String(meshClusterSmoothStrength)] : []),
    ...(alphaMode !== null ? ['--alpha-mode', alphaMode] : []),
    ...(normalMap ? ['--normal-map'] : []),
    // Emitted independently of --normal-map so an explicit cap stays in the recorded argv.
    ...(normalMapMaxSourceFaces !== null
      ? ['--normal-map-max-source-faces', String(normalMapMaxSourceFaces)] : []),
    '--',
  ];
}
