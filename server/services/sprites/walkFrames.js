/**
 * Sprites — the single definition of "this run manifest's packaged frames are
 * valid" (issue #3001).
 *
 * Approve (walk.js#approveWalkDirectionImpl) and compile
 * (atlas.js#validateForCompile) both gate on the same artifact — the per-frame
 * PNGs a packaged walk manifest declares — but used to define validity twice,
 * with the more permissive approve gate running FIRST. So a direction could
 * freeze into the set that compile then rejected: the "unexplained failure much
 * later" the approve-time check exists to prevent, just narrowed rather than
 * closed. This helper makes the cheap approve check a strict PREFIX of the
 * expensive compile check — identical path resolution, with compile layering
 * byte-level and content checks on top.
 *
 * Every declared frame is re-anchored to record-relative (an imported manifest
 * names its frames against the SOURCE repo root) and resolved drift-tolerantly —
 * the run-layout twin resolution (paths.js#resolveDriftTolerantRel) the clip and
 * strip resolvers beside it already use. A frame whose path CANNOT be re-anchored
 * is a real fault counted in the declared total, never silently dropped (which is
 * how the old approve sweep could understate the count in its error message).
 *
 *   { bytes: false } (approve) — existence only. Returns `{ total, missing }`,
 *     never throwing; the caller turns a non-zero `missing` into its own
 *     RUN_FRAMES_MISSING error, reporting the true declared `total`.
 *   { bytes: true }  (compile) — existence PLUS per-frame sha256, content, and
 *     gait-phase/outputIndex ordering, reading each frame's bytes exactly once
 *     and returning them (read-once-verify-in-memory) as `{ total, missing: 0,
 *     frameBytes }` so the compiler composites the pixels it verified. Any
 *     missing / mis-ordered / tampered / degenerate frame throws a 422
 *     ATLAS_COMPILE_INVALID.
 */

import { readFile } from 'fs/promises';
import { ServerError } from '../../lib/errorHandler.js';
import {
  spriteDir, resolveSpriteAssetPath, toRecordRelativeAssetPath, resolveDriftTolerantRel,
} from './paths.js';
import { sha256Buffer } from './walkPostprocess.js';
import { WALK_TRACK, getAnimationTrack } from './animationTracks.js';
import { getEffectiveAnimationTracks } from './animationTrackStore.js';
import { trackColumnLabels } from './atlasGrid.js';
import { describeFrameStats, isDegenerateFrame } from '../../lib/imageFrameStats.js';

const compileFrameError = (message) =>
  new ServerError(message, { status: 422, code: 'ATLAS_COMPILE_INVALID' });

export async function verifyPackagedFrames(recordId, manifest, {
  bytes = false,
  track = manifest?.track || WALK_TRACK,
  // #3152 — an omitted `tracks` defaults to the EFFECTIVE table (compiled `walk` +
  // the user-defined store), not to `getAnimationTrack`'s compiled-only default:
  // `track` comes off a MANIFEST on disk, so it routinely names a stored row
  // (scanner/ambient/any user track), and letting it fall through to the compiled
  // table would throw "unknown animation track" while verifying a set that was
  // authored and approved perfectly well. Still an explicit parameter — callers
  // mid-compile pass the exact table they validated against.
  tracks = getEffectiveAnimationTracks(),
} = {}) {
  const dir = spriteDir(recordId);
  const frames = Array.isArray(manifest?.frames) ? manifest.frames : [];
  const total = frames.length;
  // Compile checks each frame's gait-phase against the set's phase labels. The
  // set's frame count is enforced identical across directions before this runs
  // (atlas.js), so labels derived from THIS manifest's length match the set's.
  const labels = bytes ? trackColumnLabels(getAnimationTrack(track, tracks).id, total) : null;
  const frameBytes = bytes ? [] : null;
  let missing = 0;

  for (let i = 0; i < total; i++) {
    const frame = frames[i];
    // Re-anchor drift-tolerantly, matching the clip/strip resolvers. A path that
    // cannot be re-anchored (rel === null) is a fault, counted in `total`.
    const rel = toRecordRelativeAssetPath(recordId, frame?.path);
    // per-frame verification is ordered (read-once, in gait-phase sequence)
    const found = rel ? await resolveDriftTolerantRel(dir, rel) : null;
    if (!found) {
      if (!bytes) { missing += 1; continue; }
      throw compileFrameError(`Direction ${manifest?.direction} frame ${i} image is missing on disk`);
    }
    if (!bytes) continue;
    // Compile-only: gait-phase/order, then read-once-verify-in-memory.
    if (frame.phase !== labels[i] || frame.outputIndex !== i) {
      throw compileFrameError(`Direction ${manifest?.direction} frame ${i} is out of gait-phase order`);
    }
    // see above; each frame read exactly once for verify-in-memory
    const buf = await readFile(resolveSpriteAssetPath(recordId, found));
    if (sha256Buffer(buf) !== frame.sha256) {
      throw compileFrameError(`Direction ${manifest?.direction} frame ${frame.phase} no longer matches its recorded sha256`);
    }
    frameBytes.push(buf);
  }

  if (bytes) {
    // Content probes are independent once every frame's hash and ordering have
    // passed. Measure them together, then report the first failing frame in
    // manifest order while preserving the read-once verification seam above.
    const stats = await Promise.all(frameBytes.map((buf) => describeFrameStats(buf)));
    const degenerateIndex = stats.findIndex(isDegenerateFrame);
    if (degenerateIndex >= 0) {
      const frame = frames[degenerateIndex];
      throw compileFrameError(
        `Direction ${manifest?.direction} frame ${degenerateIndex} (${frame.phase}) has no content — regenerate that frame and recompile`,
      );
    }
  }

  return { total, missing, frameBytes };
}
