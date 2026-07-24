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
 * byte-level checks on top.
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
 *   { bytes: true }  (compile) — existence PLUS per-frame sha256 and
 *     gait-phase/outputIndex ordering, reading each frame's bytes exactly once
 *     and returning them (read-once-verify-in-memory) as `{ total, missing: 0,
 *     frameBytes }` so the compiler composites the pixels it verified. Any
 *     missing / mis-ordered / tampered frame throws a 422 ATLAS_COMPILE_INVALID.
 */

import { readFile } from 'fs/promises';
import { ServerError } from '../../lib/errorHandler.js';
import {
  spriteDir, resolveSpriteAssetPath, toRecordRelativeAssetPath, resolveDriftTolerantRel,
} from './paths.js';
import { sha256Buffer } from './walkPostprocess.js';
import { walkPhaseLabels } from './walkBounds.js';

const compileFrameError = (message) =>
  new ServerError(message, { status: 422, code: 'ATLAS_COMPILE_INVALID' });

export async function verifyPackagedFrames(recordId, manifest, { bytes = false } = {}) {
  const dir = spriteDir(recordId);
  const frames = Array.isArray(manifest?.frames) ? manifest.frames : [];
  const total = frames.length;
  // Compile checks each frame's gait-phase against the set's phase labels. The
  // set's frame count is enforced identical across directions before this runs
  // (atlas.js), so labels derived from THIS manifest's length match the set's.
  const labels = bytes ? walkPhaseLabels(total) : null;
  const frameBytes = bytes ? [] : null;
  let missing = 0;

  for (let i = 0; i < total; i++) {
    const frame = frames[i];
    // Re-anchor drift-tolerantly, matching the clip/strip resolvers. A path that
    // cannot be re-anchored (rel === null) is a fault, counted in `total`.
    const rel = toRecordRelativeAssetPath(recordId, frame?.path);
    // eslint-disable-next-line no-await-in-loop -- per-frame verification is ordered (read-once, in gait-phase sequence)
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
    // eslint-disable-next-line no-await-in-loop -- see above; each frame read exactly once for verify-in-memory
    const buf = await readFile(resolveSpriteAssetPath(recordId, found));
    if (sha256Buffer(buf) !== frame.sha256) {
      throw compileFrameError(`Direction ${manifest?.direction} frame ${frame.phase} no longer matches its recorded sha256`);
    }
    frameBytes.push(buf);
  }

  return { total, missing, frameBytes };
}
