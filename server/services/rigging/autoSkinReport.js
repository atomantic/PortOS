/**
 * Character rigging — the measured gate on publishing an auto-skinned mesh.
 *
 * The point of this lane is NOT that it calls Blender's automatic weighting. It is
 * that it treats "how much of this mesh actually ended up bound to a bone" as a
 * measured precondition for publication, the way `imageTo3d/sourceKeying.js` refuses
 * to key a background it cannot confidently identify. A neural image-to-3D decoder
 * emits a triangle soup with duplicated vertices; naive bone-heat weighting on that
 * mesh leaves chunks of geometry bound to nothing, and the user does not find out
 * until the character animates and a hand stays behind.
 *
 * Everything here is PURE — a reducer over an already-measured report — so every
 * branch is unit-testable against fixtures on a host with no Blender install. The
 * worker (`autoSkinWorker.py`) applies the same gate itself and exits non-zero rather
 * than exporting a mesh that fails it; this module re-runs the gate over what the
 * worker REPORTED before anything is published. That is deliberate defense in depth:
 * the worker's job is to not export, this module's job is to not publish, and a worker
 * that miscounts (or is replaced by an older copy) must not be able to talk the
 * orchestrator into publishing a broken rig.
 */

/** Report schema version. Bump when a key's meaning changes, not when one is added. */
export const AUTO_SKIN_REPORT_VERSION = 1;

/**
 * The thresholds, and why each is where it is.
 *
 * `weldDistance` — tight enough that only *coincident* vertices merge. A decoded mesh
 *   duplicates a vertex per incident triangle at bit-identical positions; 1e-6 in the
 *   mesh's own units collapses exactly those and cannot pull two genuinely distinct
 *   surface points together at any plausible model scale.
 *
 * `unweightedCeiling` — the number that makes this a gate rather than a hope. Bone-heat
 *   weighting either converges over a manifold or fails over a specific region; a
 *   converged solve leaves a few isolated vertices (interior pockets, degenerate
 *   slivers), never a percent of the mesh. 0.5% is comfortably above the former and an
 *   order of magnitude below "a hand did not get weighted" on any mesh worth rigging.
 *
 * `maxRemovedComponentFraction` / `maxComponentVertices` — the conservative pre-pass.
 *   Stray specks defeat heat weighting, so tiny disconnected islands are deleted first;
 *   but a threshold that can eat a limb is worse than the problem. A component must be
 *   both tiny in itself (<= 8 vertices) AND the combined removal must stay under 0.2%
 *   of the mesh, so the pre-pass is arithmetically incapable of removing a body part.
 */
export const AUTO_SKIN_DEFAULTS = Object.freeze({
  weldDistance: 1e-6,
  unweightedCeiling: 0.005,
  maxRemovedComponentFraction: 0.002,
  maxComponentVertices: 8,
});

/** Advanced-override bounds, mirrored by the route's Zod schema. */
export const AUTO_SKIN_LIMITS = Object.freeze({
  weldDistanceMin: 1e-9,
  weldDistanceMax: 1e-3,
  unweightedCeilingMin: 0,
  unweightedCeilingMax: 0.25,
});

/**
 * Why a rig was refused. Codes are stable; the user-facing sentence is built by
 * `describeAutoSkinFailure` below so it can name the measured numbers — a generic
 * "rigging failed" is exactly the outcome this feature exists to avoid.
 */
export const AUTO_SKIN_FAILURE_REASONS = Object.freeze({
  'report-malformed': 'The rigging worker did not report usable measurements',
  'thresholds-mismatch': 'The rigging worker used different thresholds than requested',
  'empty-mesh': 'The mesh had no vertices left to rig',
  'component-removal-over-ceiling': 'The cleanup pass removed too much of the mesh',
  'unweighted-over-ceiling': 'Automatic weighting left too much of the mesh unweighted',
  'fill-incomplete': 'The nearest-bone pass did not finish weighting the mesh',
  'no-armature': 'The rig produced no armature',
  'round-trip-failed': 'The exported file did not survive a re-import check',
});

const isCount = (value) => Number.isInteger(value) && value >= 0;
const isFraction = (value) => Number.isFinite(value) && value >= 0 && value <= 1;

// Percent with one decimal — the form every gate message quotes.
const formatPercent = (fraction) => `${(Number(fraction) * 100).toFixed(1)}%`;

/**
 * The measurement subtree a gate decision needs, or `null` when the report cannot
 * supply it. Pulled out so "the worker emitted nonsense" is one branch rather than a
 * scattering of optional chaining.
 */
function readMeasurements(report) {
  const vertices = report?.vertices;
  const removed = report?.removed_components;
  const heat = report?.weighting?.after_heat;
  const fill = report?.weighting?.after_fill;
  if (!isCount(vertices?.before_weld) || !isCount(vertices?.after_weld) || !isCount(vertices?.welded)) return null;
  if (!isCount(removed?.count) || !isCount(removed?.vertices) || !isFraction(removed?.fraction)) return null;
  if (!isCount(heat?.weighted) || !isCount(heat?.unweighted) || !isFraction(heat?.unweighted_fraction)) return null;
  if (!isCount(fill?.weighted) || !isCount(fill?.unweighted) || !isFraction(fill?.unweighted_fraction)) return null;
  if (!isCount(report?.weighting?.nearest_bone_completed)) return null;
  return { vertices, removed, heat, fill, nearestBoneCompleted: report.weighting.nearest_bone_completed };
}

// A float threshold survives a JSON round trip through Python exactly, so an exact
// comparison is right here — a mismatch means the worker used a DIFFERENT number, not
// that it lost a bit of precision.
const thresholdsAgree = (reported, requested) => Boolean(reported)
  && reported.weld_distance === requested.weldDistance
  && reported.unweighted_ceiling === requested.unweightedCeiling
  && reported.max_removed_component_fraction === requested.maxRemovedComponentFraction
  && reported.max_component_vertices === requested.maxComponentVertices;

/**
 * Decide whether a reported rig may be published. Pure.
 *
 * Order is the point:
 *  - a report we cannot read is never "fine", it is unreadable;
 *  - thresholds are checked against what the CALLER asked for, so a worker cannot
 *    relax its own gate and have the orchestrator honour the relaxed number;
 *  - the empty mesh is separated from the coverage gate, because 0 of 0 vertices
 *    unweighted is a fraction of 0 and would otherwise pass every check;
 *  - the pre-pass ceiling comes before the coverage gate: if cleanup ate geometry,
 *    the coverage number is measured against the wrong mesh and means nothing;
 *  - the post-fill assertion is last and absolute — after the nearest-bone completion
 *    there must be ZERO unweighted vertices, not "few".
 *
 * @param {object} report The worker's report JSON (snake_case, as written to disk).
 * @param {object} [thresholds] The thresholds the caller requested.
 * @returns {{ok: boolean, reason: string|null, metrics: object|null}}
 */
export function reduceAutoSkinGate(report, thresholds = AUTO_SKIN_DEFAULTS) {
  const measured = readMeasurements(report);
  if (!measured) return { ok: false, reason: 'report-malformed', metrics: null };

  const metrics = {
    verticesBeforeWeld: measured.vertices.before_weld,
    verticesAfterWeld: measured.vertices.after_weld,
    welded: measured.vertices.welded,
    removedComponents: measured.removed.count,
    removedComponentVertices: measured.removed.vertices,
    removedComponentFraction: measured.removed.fraction,
    unweightedAfterHeat: measured.heat.unweighted,
    unweightedFractionAfterHeat: measured.heat.unweighted_fraction,
    nearestBoneCompleted: measured.nearestBoneCompleted,
    unweightedAfterFill: measured.fill.unweighted,
    unweightedFractionAfterFill: measured.fill.unweighted_fraction,
    boneCount: Number.isInteger(report?.armature?.bone_count) ? report.armature.bone_count : 0,
    thresholds,
  };

  if (!thresholdsAgree(report?.thresholds, thresholds)) return { ok: false, reason: 'thresholds-mismatch', metrics };
  if (metrics.verticesAfterWeld === 0) return { ok: false, reason: 'empty-mesh', metrics };
  if (metrics.boneCount === 0) return { ok: false, reason: 'no-armature', metrics };
  if (metrics.removedComponentFraction > thresholds.maxRemovedComponentFraction) {
    return { ok: false, reason: 'component-removal-over-ceiling', metrics };
  }
  if (metrics.unweightedFractionAfterHeat > thresholds.unweightedCeiling) {
    return { ok: false, reason: 'unweighted-over-ceiling', metrics };
  }
  if (metrics.unweightedAfterFill !== 0) return { ok: false, reason: 'fill-incomplete', metrics };

  const roundTrip = report?.round_trip;
  if (roundTrip?.armature !== true || roundTrip?.armature_modifier !== true || roundTrip?.mesh !== true) {
    return { ok: false, reason: 'round-trip-failed', metrics };
  }
  return { ok: true, reason: null, metrics };
}

/**
 * The sentence a user sees when a rig is refused. It names the measured number and the
 * threshold it missed, because "rigging failed" tells them nothing they can act on.
 *
 * @param {string} reason A key of `AUTO_SKIN_FAILURE_REASONS`.
 * @param {object|null} [metrics] The metrics from `reduceAutoSkinGate`.
 * @returns {string}
 */
export function describeAutoSkinFailure(reason, metrics = null) {
  const headline = Object.hasOwn(AUTO_SKIN_FAILURE_REASONS, reason ?? '')
    ? AUTO_SKIN_FAILURE_REASONS[reason]
    : 'Rigging failed for an unrecognized reason';
  if (!metrics) return `${headline}.`;
  switch (reason) {
    case 'unweighted-over-ceiling':
      return `${headline}: automatic weighting left ${formatPercent(metrics.unweightedFractionAfterHeat)} of `
        + `${metrics.verticesAfterWeld} vertices unweighted, ceiling is `
        + `${formatPercent(metrics.thresholds.unweightedCeiling)}.`;
    case 'component-removal-over-ceiling':
      return `${headline}: the pre-pass removed ${metrics.removedComponentVertices} vertices across `
        + `${metrics.removedComponents} disconnected pieces (${formatPercent(metrics.removedComponentFraction)}), `
        + `ceiling is ${formatPercent(metrics.thresholds.maxRemovedComponentFraction)}.`;
    case 'fill-incomplete':
      return `${headline}: ${metrics.unweightedAfterFill} of ${metrics.verticesAfterWeld} vertices were still `
        + 'unweighted after the nearest-bone pass, which must leave none.';
    case 'empty-mesh':
      return `${headline}: ${metrics.verticesBeforeWeld} vertices went in and ${metrics.verticesAfterWeld} came out `
        + 'of the weld.';
    case 'no-armature':
      return `${headline}: the worker reported no bones, so nothing could be weighted.`;
    case 'thresholds-mismatch':
      return `${headline}: the report's thresholds do not match the requested `
        + `${formatPercent(metrics.thresholds.unweightedCeiling)} unweighted ceiling / `
        + `${metrics.thresholds.weldDistance} weld distance.`;
    default:
      return `${headline}.`;
  }
}

/**
 * The compact rig summary stored on the model record and rendered by the client. Kept
 * separate from the full report (which stays on disk next to the GLB) so a record read
 * does not carry a bone list.
 *
 * @param {object|null} metrics
 * @returns {object|null}
 */
export function summarizeAutoSkin(metrics) {
  if (!metrics) return null;
  return {
    vertices: metrics.verticesAfterWeld,
    welded: metrics.welded,
    bones: metrics.boneCount,
    unweightedFractionAfterHeat: metrics.unweightedFractionAfterHeat,
    nearestBoneCompleted: metrics.nearestBoneCompleted,
    unweightedCeiling: metrics.thresholds.unweightedCeiling,
  };
}

/**
 * Normalize caller-supplied advanced overrides against the defaults. Absent means
 * "use the default"; a present value is used as given (the route's Zod schema owns
 * range validation, so an out-of-range number never reaches here).
 *
 * @param {{weldDistance?: number, unweightedCeiling?: number}} [overrides]
 * @returns {object} A frozen threshold set.
 */
export function resolveAutoSkinThresholds(overrides = {}) {
  return Object.freeze({
    ...AUTO_SKIN_DEFAULTS,
    ...(Number.isFinite(overrides.weldDistance) ? { weldDistance: overrides.weldDistance } : {}),
    ...(Number.isFinite(overrides.unweightedCeiling) ? { unweightedCeiling: overrides.unweightedCeiling } : {}),
  });
}

/** The threshold block the worker is asked to echo back, in its own snake_case. */
export const thresholdsForWorker = (thresholds) => ({
  weld_distance: thresholds.weldDistance,
  unweighted_ceiling: thresholds.unweightedCeiling,
  max_removed_component_fraction: thresholds.maxRemovedComponentFraction,
  max_component_vertices: thresholds.maxComponentVertices,
});
