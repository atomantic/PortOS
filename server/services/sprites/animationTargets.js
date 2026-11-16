/**
 * Sprites — per-track animation targets (#2985).
 *
 * Every direction in ONE walk set must share a frame count and fps (the atlas is
 * a rectangular grid), so the target is resolved up front and enforced when each
 * render is QUEUED, not at compile time after the renders are spent.
 *
 * The target is **track-keyed**, never record-level; a scanner or ambient track
 * legitimately differs from the walk:
 *
 *   "animationTargets": { "walk": { "frameCount": 12, "fps": 10, "source": "set" } }
 *
 * An unrecognized sibling track key MUST round-trip untouched (`withTrackTarget`).
 * Packing tracks of differing lengths into one atlas is out of scope. Bounds come
 * per track from the registry (#3015). Dependency-free apart from the sharp-free
 * `animationTracks` registry so the native-dep-free validation graph can reach it.
 */

import { WALK_TRACK } from './animationTracks.js';
// #3152: resolve against the EFFECTIVE table (compiled `walk` + user-defined
// store). Still sharp-free: the store reaches only fs/path/crypto.
import { effectiveTrack } from './animationTrackStore.js';

// Re-exported for walk.js; the registry owns the value.
export { WALK_TRACK };

// Out-of-range values read as `null` (absent), never clamped.
const intInRange = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);
const readFrameCount = (row, v) => intInRange(v, row.minFrameCount, row.maxFrameCount);
const readFps = (row, v) => intInRange(v, row.minFps, row.maxFps);

/**
 * Resolve one track's pinned target from the precedence chain, newest authority
 * first; `source` names the winning rung:
 *
 *   'app'     — the bound app's `runtimeContract` (#2982); not overridable per render.
 *   'set'     — an explicit `animationTargets.<track>` the user pinned.
 *   'derived' — the first packaged direction's geometry (atlas.js's first-wins
 *               rule), auto-pinned with `source: 'derived'` so an inferred value
 *               never masquerades as a user choice.
 *   'default' — the track's `defaultFrameCount` / `defaultFps`.
 *
 * Out-of-range or non-integer values at any rung are ignored, not clamped (a
 * hand-edited record must not pin a value the packer would rewrite). Each knob
 * falls through independently; `source` is the highest rung supplying EITHER
 * knob, and `frameCountLocked` / `fpsLocked` say which the app fixed.
 *
 * `track` selects the persisted entry and the registry row (bounds, defaults,
 * `runtimeContract` field names). Absent ⇒ default track, unrecognized ⇒ throws
 * (`getAnimationTrack`).
 *
 * @param {object}   input
 * @param {string}   [input.track]            Track id from `animationTracks.js` (default 'walk').
 * @param {object}   [input.runtimeContract]  `publishBinding.runtimeContract`, if any.
 * @param {object}   [input.animationTargets] The selection record's block.
 * @param {Array<{direction?: string, frameCount?: number, fps?: number}>} [input.packagedCycles]
 *        Packaged directions in atlas order — first entry with a usable value wins.
 * @returns {{track: string, frameCount: number, fps: number, source: string,
 *            frameCountLocked: boolean, fpsLocked: boolean}}
 */
export function resolveAnimationTarget({
  track,
  runtimeContract = null,
  animationTargets = null,
  packagedCycles = [],
} = {}) {
  const row = effectiveTrack(track);

  // Read defensively: an absent contract just falls through.
  const appCount = readFrameCount(row, runtimeContract?.[row.contractFrameCountField]);
  const appFps = row.contractFpsField ? readFps(row, runtimeContract?.[row.contractFpsField]) : null;

  const pinned = animationTargets?.[row.id] || null;
  const setCount = readFrameCount(row, pinned?.frameCount);
  const setFps = readFps(row, pinned?.fps);

  const derivedCount = firstDefined(packagedCycles, (c) => readFrameCount(row, c?.frameCount));
  const derivedFps = firstDefined(packagedCycles, (c) => readFps(row, c?.fps));

  let source = 'default';
  if (derivedCount !== null || derivedFps !== null) source = 'derived';
  // Only an auto-pinned block carries `source: 'derived'`; anything else
  // (including legacy blocks) is a deliberate user pin.
  if (setCount !== null || setFps !== null) source = pinned?.source === 'derived' ? 'derived' : 'set';
  if (appCount !== null || appFps !== null) source = 'app';

  return {
    track: row.id,
    frameCount: appCount ?? setCount ?? derivedCount ?? row.defaultFrameCount,
    fps: appFps ?? setFps ?? derivedFps ?? row.defaultFps,
    source,
    frameCountLocked: appCount !== null,
    fpsLocked: appFps !== null,
  };
}

function firstDefined(list, read) {
  for (const item of list || []) {
    const value = read(item);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Merge one track's target into an `animationTargets` map WITHOUT disturbing
 * sibling tracks: a peer or later PortOS may have written a track this build
 * doesn't know, and a naive overwrite would drop it. The track being WRITTEN must
 * be known (#3015); an unrecognized write target throws.
 */
export function withTrackTarget(animationTargets, track, { frameCount, fps, source }) {
  const row = effectiveTrack(track);
  const existing = (animationTargets && typeof animationTargets === 'object' && !Array.isArray(animationTargets))
    ? animationTargets
    : {};
  return { ...existing, [row.id]: { frameCount, fps, source } };
}

/**
 * Packaged directions whose geometry disagrees with the resolved target (the set
 * compiles only when empty), reported per direction for UI badges. A cycle with
 * no usable geometry is not "drift". Range-checks against the TARGET's own track
 * (#3015), defaulting for a bare `{ frameCount, fps }`.
 */
export function targetDrift(target, packagedCycles = []) {
  const row = effectiveTrack(target?.track);
  return (packagedCycles || []).flatMap((cycle) => {
    const frameCount = readFrameCount(row, cycle?.frameCount);
    const fps = readFps(row, cycle?.fps);
    if (frameCount === null && fps === null) return [];
    const countDrifts = frameCount !== null && frameCount !== target.frameCount;
    const fpsDrifts = fps !== null && fps !== target.fps;
    if (!countDrifts && !fpsDrifts) return [];
    return [{
      direction: cycle.direction, frameCount, fps, frameCountDrifts: countDrifts, fpsDrifts,
    }];
  });
}

/** Human-readable provenance, shared by the 409 message and the UI label. */
export function describeTargetSource(target, appName = null) {
  switch (target.source) {
    case 'app': return `locked by ${appName || 'the bound app'}`;
    case 'set': return 'set target';
    case 'derived': return 'from the first approved direction';
    default: return 'default';
  }
}
