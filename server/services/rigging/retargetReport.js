/**
 * Character rigging — the measured gate on publishing a RETARGETED character.
 *
 * Phase 2 (`autoSkinReport.js`) refuses to publish a rig whose weights did not measure
 * up. This module is the same idea one step later: a retarget produces a file whether
 * or not anything in it moves, so "the exporter returned" is worth nothing as evidence.
 * What is worth something is a re-import that finds a NAMED clip of non-zero duration
 * on the exported armature, and measured joint displacement between sampled frames. A
 * file-only export — bytes on disk with no animation, or an animation that holds a
 * single pose — is the exact failure this gate exists to name.
 *
 * ## One report format, not two
 *
 * The retarget report is the Phase 2 report EXTENDED, not a second format: same
 * `report_version`, same `thresholds` echo-back, same `armature` and `round_trip`
 * subtrees, published through the same GLB-first/report-last pair contract. It adds
 * `skeleton`, `head_cleanup`, `clip`, and `motion`, and marks itself `kind: 'retarget'`
 * so a reader can tell which lane produced a pair without guessing from the filename.
 *
 * Everything here is PURE — a reducer over an already-measured report — so every branch
 * is unit-testable on a host with no Blender install.
 */

/**
 * Reports carry their lane so a consumer never infers it from a filename. The version
 * is NOT declared here: a retarget report rides the Phase 2 `AUTO_SKIN_REPORT_VERSION`
 * that `publishRigArtifacts` stamps, because there is one rigging report format.
 */
export const RETARGET_REPORT_KIND = 'retarget';

/**
 * The two head-zone cleanup modes, and why both exist.
 *
 * `diagnostic` measures the proposed cleanup and the cap it would run under, and
 * changes NOTHING. It is the default because the cleanup edits skin weights a
 * human never reviewed; a user gets the number first and opts into the edit second.
 *
 * `write` applies the same proposal, and may not exceed the cap.
 */
export const RETARGET_MODES = Object.freeze(['diagnostic', 'write']);
export const DEFAULT_RETARGET_MODE = 'diagnostic';

/**
 * The thresholds, and why each is where it is.
 *
 * `headCleanupFraction` — the hard cap on how much of the mesh the head-zone cleanup
 *   may re-bind, as a fraction of the mesh's vertices. Auto-skin's nearest-bone fill
 *   binds a stray head-zone vertex to whatever bone happens to be closest, which shows
 *   up as a scalp corner travelling with a shoulder. Fixing that touches the handful of
 *   vertices sitting above the neck; 2% is generous for a head-and-neck island on any
 *   humanoid mesh and far below the fraction a head actually occupies, so the pass is
 *   arithmetically incapable of re-binding a body.
 *
 * `minClipDuration` — below this, a "clip" is a single keyed pose with a rounding error
 *   for a duration. 50ms is shorter than any real animation and longer than the noise.
 *
 * `motionSampleCount` — frames sampled across the clip to prove movement. More than two
 *   because a clip whose first and last frames coincide (a loop) moves in between; eight
 *   is enough to catch that without making the check a second playback.
 *
 * `minMotionDistance` — the displacement, in the model's own units, that separates
 *   "animated" from "a pose plus float noise". Model space is normalized to roughly
 *   unit height by the decode lane, so 1e-4 is ~0.01% of a character's height.
 */
export const RETARGET_DEFAULTS = Object.freeze({
  headCleanupFraction: 0.02,
  minClipDuration: 0.05,
  motionSampleCount: 8,
  minMotionDistance: 1e-4,
});

/** Advanced-override bounds, mirrored by the route's Zod schema. */
export const RETARGET_LIMITS = Object.freeze({
  headCleanupFractionMin: 0,
  headCleanupFractionMax: 0.1,
});

/**
 * Why a retarget was refused. Codes are stable; the user-facing sentence is built by
 * `describeRetargetFailure` below so it can name the measured numbers.
 */
export const RETARGET_FAILURE_REASONS = Object.freeze({
  'report-malformed': 'The retarget worker did not report usable measurements',
  'thresholds-mismatch': 'The retarget worker used different thresholds than requested',
  'mode-mismatch': 'The retarget worker ran a different cleanup mode than requested',
  'skeleton-unrecognized': 'The clip does not use a skeleton convention this install understands',
  'skeleton-partial': 'The clip and the rigged character do not share a complete skeleton',
  'head-cleanup-over-cap': 'The head-zone cleanup would change more of the mesh than the cap allows',
  'diagnostic-mode-wrote': 'A diagnostic run changed skin weights, which it must never do',
  'round-trip-failed': 'The exported file did not survive a re-import check',
  'clip-unnamed': 'The exported file carries no named animation',
  'clip-zero-duration': 'The exported animation has no duration',
  'no-motion': 'The exported animation never moves',
});

const isCount = (value) => Number.isInteger(value) && value >= 0;
const isNonNegative = (value) => Number.isFinite(value) && value >= 0;
const isNamed = (value) => typeof value === 'string' && value.trim().length > 0;
const formatPercent = (fraction) => `${(Number(fraction) * 100).toFixed(1)}%`;

/**
 * The measurement subtree a gate decision needs, or `null` when the report cannot
 * supply it. Keeps "the worker emitted nonsense" as ONE branch rather than a scattering
 * of optional chaining through the decision below.
 */
function readMeasurements(report) {
  const skeleton = report?.skeleton;
  const cleanup = report?.head_cleanup;
  const motion = report?.motion;
  const roundTrip = report?.round_trip;
  if (!isCount(report?.vertices?.total)) return null;
  if (!isNamed(skeleton?.hint) || !Array.isArray(skeleton?.unmapped_bones) || !isCount(skeleton?.mapped_bones)) return null;
  if (!isNamed(cleanup?.mode) || !isCount(cleanup?.proposed_vertices) || !isCount(cleanup?.changed_vertices)) return null;
  if (!isCount(motion?.sampled_frames) || !isNonNegative(motion?.max_joint_translation)) return null;
  if (!roundTrip || typeof roundTrip !== 'object') return null;
  return { skeleton, cleanup, motion, roundTrip, totalVertices: report.vertices.total };
}

// A float threshold survives a JSON round trip through Python exactly, so an exact
// comparison is right here — a mismatch means the worker used a DIFFERENT number, not
// that it lost a bit of precision.
const thresholdsAgree = (reported, requested) => Boolean(reported)
  && reported.head_cleanup_fraction === requested.headCleanupFraction
  && reported.min_clip_duration === requested.minClipDuration
  && reported.motion_sample_count === requested.motionSampleCount
  && reported.min_motion_distance === requested.minMotionDistance;

/**
 * How many vertices the head-zone cleanup may re-bind. Derived HERE rather than read
 * from the report: the cap is the whole safety argument, so a worker that echoes a
 * roomier one must not be able to talk the orchestrator into honouring it.
 *
 * @param {number} totalVertices
 * @param {number} fraction
 * @returns {number}
 */
export const headCleanupCap = (totalVertices, fraction) => Math.floor(Math.max(0, totalVertices) * Math.max(0, fraction));

/**
 * Decide whether a reported retarget may be published. Pure.
 *
 * Order is the point:
 *  - a report we cannot read is never "fine", it is unreadable;
 *  - thresholds and mode are checked against what the CALLER asked for, so a worker
 *    cannot relax its own cap (or quietly upgrade a diagnostic run to a write) and have
 *    the orchestrator honour it;
 *  - the skeleton contract comes before anything measured on the export, because a
 *    partial mapping means whatever was exported is a partial retarget;
 *  - the cleanup cap comes before the motion proof: weights changed beyond the cap make
 *    the exported mesh the wrong mesh, and how well it moves is then beside the point;
 *  - the clip and motion assertions are last, and they are what separate a retarget from
 *    a file: a named clip, a non-zero duration, and measured displacement.
 *
 * @param {object} report The worker's report JSON (snake_case, as written to disk).
 * @param {{thresholds?: object, mode?: string}} [opts]
 * @returns {{ok: boolean, reason: string|null, metrics: object|null}}
 */
export function reduceRetargetGate(report, { thresholds = RETARGET_DEFAULTS, mode = DEFAULT_RETARGET_MODE } = {}) {
  const measured = readMeasurements(report);
  if (!measured) return { ok: false, reason: 'report-malformed', metrics: null };

  const capVertices = headCleanupCap(measured.totalVertices, thresholds.headCleanupFraction);
  const metrics = {
    totalVertices: measured.totalVertices,
    skeletonHint: measured.skeleton.hint,
    mappedBones: measured.skeleton.mapped_bones,
    unmappedBones: measured.skeleton.unmapped_bones,
    mode: measured.cleanup.mode,
    proposedCleanupVertices: measured.cleanup.proposed_vertices,
    changedCleanupVertices: measured.cleanup.changed_vertices,
    cleanupCapVertices: capVertices,
    cleanupOverCap: measured.cleanup.proposed_vertices > capVertices,
    exportedClipName: isNamed(measured.roundTrip.clip_name) ? measured.roundTrip.clip_name : null,
    exportedClipDuration: Number.isFinite(measured.roundTrip.clip_duration) ? measured.roundTrip.clip_duration : 0,
    sampledFrames: measured.motion.sampled_frames,
    maxJointTranslation: measured.motion.max_joint_translation,
    boneCount: isCount(report?.armature?.bone_count) ? report.armature.bone_count : 0,
    thresholds,
  };

  if (!thresholdsAgree(report?.thresholds, thresholds)) return { ok: false, reason: 'thresholds-mismatch', metrics };
  if (metrics.mode !== mode) return { ok: false, reason: 'mode-mismatch', metrics };
  if (metrics.skeletonHint === 'unknown') return { ok: false, reason: 'skeleton-unrecognized', metrics };
  if (metrics.unmappedBones.length > 0 || metrics.mappedBones === 0) {
    return { ok: false, reason: 'skeleton-partial', metrics };
  }
  if (mode === 'diagnostic' && metrics.changedCleanupVertices !== 0) {
    return { ok: false, reason: 'diagnostic-mode-wrote', metrics };
  }
  // Two shapes of the same refusal, and BOTH are needed. A correct worker refuses an
  // over-cap proposal before touching a weight and reports `changed: 0`, so gating only
  // on `changed` would let that run fall through to a generic "worker exited 2" and lose
  // the sentence naming the numbers. A worker that wrote past the cap anyway is the
  // defense-in-depth case.
  if (mode === 'write' && metrics.cleanupOverCap) return { ok: false, reason: 'head-cleanup-over-cap', metrics };
  if (metrics.changedCleanupVertices > capVertices) return { ok: false, reason: 'head-cleanup-over-cap', metrics };

  const { roundTrip } = measured;
  if (roundTrip.mesh !== true || roundTrip.armature !== true || roundTrip.armature_modifier !== true) {
    return { ok: false, reason: 'round-trip-failed', metrics };
  }
  if (!metrics.exportedClipName) return { ok: false, reason: 'clip-unnamed', metrics };
  if (metrics.exportedClipDuration < thresholds.minClipDuration) {
    return { ok: false, reason: 'clip-zero-duration', metrics };
  }
  if (metrics.sampledFrames < 2 || metrics.maxJointTranslation < thresholds.minMotionDistance) {
    return { ok: false, reason: 'no-motion', metrics };
  }
  return { ok: true, reason: null, metrics };
}

/**
 * The sentence a user sees when a retarget is refused. It names the measured number and
 * the threshold it missed, because "retarget failed" tells them nothing they can act on.
 *
 * @param {string} reason A key of `RETARGET_FAILURE_REASONS`.
 * @param {object|null} [metrics] The metrics from `reduceRetargetGate`.
 * @returns {string}
 */
export function describeRetargetFailure(reason, metrics = null) {
  const headline = Object.hasOwn(RETARGET_FAILURE_REASONS, reason ?? '')
    ? RETARGET_FAILURE_REASONS[reason]
    : 'The retarget failed for an unrecognized reason';
  if (!metrics) return `${headline}.`;
  switch (reason) {
    case 'skeleton-partial':
      return `${headline}: ${metrics.mappedBones} bones mapped and `
        + `${metrics.unmappedBones.length} did not (${metrics.unmappedBones.slice(0, 5).join(', ')}`
        + `${metrics.unmappedBones.length > 5 ? ', …' : ''}).`;
    case 'skeleton-unrecognized':
      return `${headline}: the character is rigged to an unrecognized convention, so no bone could be matched.`;
    case 'head-cleanup-over-cap':
      return `${headline}: it would re-bind ${metrics.proposedCleanupVertices} of ${metrics.totalVertices} `
        + `vertices, and the cap is ${metrics.cleanupCapVertices} `
        + `(${formatPercent(metrics.thresholds.headCleanupFraction)} of the mesh).`;
    case 'diagnostic-mode-wrote':
      return `${headline}: ${metrics.changedCleanupVertices} vertices were changed by a run that was only asked to measure.`;
    case 'clip-unnamed':
      return `${headline}: the re-imported GLB had no named animation to play.`;
    case 'clip-zero-duration':
      return `${headline}: the re-imported clip "${metrics.exportedClipName}" lasts `
        + `${metrics.exportedClipDuration.toFixed(3)}s, and anything under `
        + `${metrics.thresholds.minClipDuration}s is a single pose.`;
    case 'no-motion':
      return `${headline}: across ${metrics.sampledFrames} sampled frames no joint moved more than `
        + `${metrics.maxJointTranslation.toExponential(2)} units, and the minimum is `
        + `${metrics.thresholds.minMotionDistance.toExponential(2)}.`;
    case 'mode-mismatch':
      return `${headline}: it reported "${metrics.mode}".`;
    case 'thresholds-mismatch':
      return `${headline}: the report's thresholds do not match the requested `
        + `${formatPercent(metrics.thresholds.headCleanupFraction)} cleanup cap.`;
    default:
      return `${headline}.`;
  }
}

/**
 * The compact retarget summary stored on the model record and rendered by the client.
 * Kept separate from the full report (which stays on disk next to the GLB) so a record
 * read does not carry a bone list.
 *
 * `cleanupOverCap` rides along deliberately: it is the number a diagnostic run exists to
 * produce, and the reason a later write run would refuse.
 *
 * @param {object|null} metrics
 * @returns {object|null}
 */
export function summarizeRetarget(metrics) {
  if (!metrics) return null;
  return {
    clip: metrics.exportedClipName,
    clipDuration: metrics.exportedClipDuration,
    mode: metrics.mode,
    bones: metrics.boneCount,
    mappedBones: metrics.mappedBones,
    vertices: metrics.totalVertices,
    proposedCleanupVertices: metrics.proposedCleanupVertices,
    changedCleanupVertices: metrics.changedCleanupVertices,
    cleanupCapVertices: metrics.cleanupCapVertices,
    cleanupOverCap: metrics.cleanupOverCap,
    sampledFrames: metrics.sampledFrames,
    maxJointTranslation: metrics.maxJointTranslation,
  };
}

/**
 * Normalize caller-supplied advanced overrides against the defaults. Absent means "use
 * the default"; a present value is used as given (the route's Zod schema owns range
 * validation, so an out-of-range number never reaches here).
 *
 * @param {{headCleanupFraction?: number}} [overrides]
 * @returns {object} A frozen threshold set.
 */
export function resolveRetargetThresholds(overrides = {}) {
  return Object.freeze({
    ...RETARGET_DEFAULTS,
    ...(Number.isFinite(overrides.headCleanupFraction) ? { headCleanupFraction: overrides.headCleanupFraction } : {}),
  });
}

/** The threshold block the worker is asked to echo back, in its own snake_case. */
export const thresholdsForRetargetWorker = (thresholds) => ({
  head_cleanup_fraction: thresholds.headCleanupFraction,
  min_clip_duration: thresholds.minClipDuration,
  motion_sample_count: thresholds.motionSampleCount,
  min_motion_distance: thresholds.minMotionDistance,
});
