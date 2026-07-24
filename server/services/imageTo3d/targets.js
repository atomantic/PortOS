/**
 * Image-to-3D — pluggable target registry.
 *
 * Single source of truth for the selectable image→3D "processing targets"
 * (TRELLIS.2 today; other models later). Adding a target is a registration
 * here, not a rewrite of the dispatch/install/UI — mirroring the role
 * `imageGen/modes.js` plays for the 2D image backends.
 *
 * This module is intentionally dependency-light: the registry is a set of pure
 * descriptors, and the resolver functions are pure — they take the host's
 * capabilities as an injected argument rather than probing hardware themselves.
 * Only `detectHostCapabilities()` touches the real machine, so it's the one
 * impure boundary (mirroring `platform.js`'s "detect at the route boundary and
 * pass into pure services" contract). Runner/installer wiring for a target is
 * referenced by module path and lands in later phases (see issue #2951); keeping
 * those out of the import graph is what lets this stay a pure, no-side-effect
 * registry that boot and tests can import for free.
 */

import os from 'os';
import { isAppleSilicon } from '../../lib/platform.js';

/**
 * How a target's inference actually runs. A target declares exactly one lane;
 * the lane decides which hardware gate `unavailableReason` applies and (later)
 * which installer/runner the service dispatches to.
 */
export const EXECUTION_LANE = Object.freeze({
  LOCAL_MPS: 'local-mps', // PyTorch MPS on Apple Silicon (on-device, private)
  LOCAL_CUDA: 'local-cuda', // NVIDIA CUDA (Linux/CUDA peer or future hardware)
  HOSTED_API: 'hosted-api', // remote inference endpoint (no local hardware gate)
});

export const EXECUTION_LANES = Object.freeze(Object.values(EXECUTION_LANE));

/** The shape of the artifact a target produces. */
export const OUTPUT_KIND = Object.freeze({
  GLB_MESH: 'glb-mesh', // binary glTF mesh, optionally with PBR materials
});

export const OUTPUT_KINDS = Object.freeze(Object.values(OUTPUT_KIND));

/**
 * The registry. Each entry is a frozen, pure descriptor — no imported runners,
 * no side effects — so a new model is one object added here.
 *
 * `requires` states the hardware floor for the target's declared lane; the pure
 * resolvers below read it. `installerModule`/`runnerModule` are the module paths
 * later phases wire up (they are not imported here — see the file header).
 */
export const IMAGE_TO_3D_TARGETS = Object.freeze({
  trellis2: Object.freeze({
    id: 'trellis2',
    label: 'TRELLIS.2',
    description:
      'Microsoft TRELLIS.2 — single image to a PBR-textured GLB mesh, run on-device '
      + 'via the Apple Silicon (PyTorch MPS) port.',
    executionLane: EXECUTION_LANE.LOCAL_MPS,
    outputKind: OUTPUT_KIND.GLB_MESH,
    // Floor for the shipped local-MPS lane (the `trellis-mac` port): Apple
    // Silicon (M1+), 24 GB+ unified memory, ~15 GB weights on disk, Python 3.11+.
    requires: Object.freeze({
      appleSilicon: true,
      minUnifiedMemoryGb: 24,
      diskGb: 15,
      python: '3.11',
    }),
    upstream: 'https://github.com/microsoft/TRELLIS.2',
    // Community MPS port that makes the CUDA-only upstream run on Apple Silicon.
    port: 'https://github.com/shivampkumar/trellis-mac',
    weightsRepo: 'microsoft/TRELLIS.2-4B',
    // Wired in later phases (issue #2951); referenced by path, never imported here.
    installerModule: 'server/services/imageTo3d/trellis2Install.js',
    runnerModule: 'server/services/imageTo3d/trellis2.js',
  }),
});

/** Registry keys, for Zod enums and iteration. */
export const IMAGE_TO_3D_TARGET_IDS = Object.freeze(Object.keys(IMAGE_TO_3D_TARGETS));

/** The target selected when a request names none. */
export const DEFAULT_IMAGE_TO_3D_TARGET = 'trellis2';

/**
 * Look up a target descriptor by id.
 * @param {string} id
 * @returns {object|null} the frozen descriptor, or null when unknown.
 */
export function getTarget(id) {
  return (id && IMAGE_TO_3D_TARGETS[id]) || null;
}

/**
 * Why a target can't run on a host — or `null` when it can. Pure: the host's
 * capabilities are passed in, never probed here.
 *
 * @param {string|object} target target id or descriptor.
 * @param {{appleSilicon?: boolean, unifiedMemoryGb?: number, cuda?: boolean}} [caps]
 * @returns {string|null} a stable reason code, or null when available.
 */
export function unavailableReason(target, caps = {}) {
  const t = typeof target === 'string' ? getTarget(target) : target;
  if (!t) return 'unknown-target';
  const req = t.requires || {};
  if (t.executionLane === EXECUTION_LANE.LOCAL_MPS) {
    if (req.appleSilicon && !caps.appleSilicon) return 'requires-apple-silicon';
    if (req.minUnifiedMemoryGb && Number(caps.unifiedMemoryGb) < req.minUnifiedMemoryGb) {
      return 'insufficient-memory';
    }
  } else if (t.executionLane === EXECUTION_LANE.LOCAL_CUDA) {
    if (!caps.cuda) return 'requires-cuda';
  }
  // hosted-api has no local hardware requirement.
  return null;
}

/**
 * Is this target runnable on a host with the given capabilities? Pure.
 * @param {string|object} target
 * @param {object} [caps]
 * @returns {boolean}
 */
export function isTargetAvailable(target, caps = {}) {
  return unavailableReason(target, caps) === null;
}

/**
 * Resolve the effective target for a request. Pure — no fallback to a *different*
 * model is applied here (that's a caller policy); the requested/default target is
 * returned with an availability verdict so the caller can 400 or prompt-to-install.
 *
 * @param {string} [requestedId] the requested target id (falls back to defaultId).
 * @param {object} [caps] host capabilities (see `detectHostCapabilities`).
 * @param {{defaultId?: string}} [opts]
 * @returns {{targetId: string, target: object|null, available: boolean, reason: string|null}}
 */
export function resolveTarget(requestedId, caps = {}, { defaultId = DEFAULT_IMAGE_TO_3D_TARGET } = {}) {
  const targetId = requestedId || defaultId;
  const target = getTarget(targetId);
  if (!target) return { targetId, target: null, available: false, reason: 'unknown-target' };
  const reason = unavailableReason(target, caps);
  return { targetId, target, available: reason === null, reason };
}

/**
 * Every registered target annotated with its availability on a host — the shape
 * the API/UI consume to render a target selector with disabled/needs-install
 * states. Pure.
 * @param {object} [caps]
 * @returns {Array<object>}
 */
export function listTargets(caps = {}) {
  return IMAGE_TO_3D_TARGET_IDS.map((id) => {
    const target = IMAGE_TO_3D_TARGETS[id];
    const reason = unavailableReason(target, caps);
    return { ...target, available: reason === null, unavailableReason: reason };
  });
}

/**
 * The one impure boundary: read this machine's capabilities. Injectable so
 * routes/tests can supply deterministic values. `unifiedMemoryGb` is rounded to
 * the nearest whole GB (physical RAM reads a hair under the marketed size, so a
 * "24 GB" Mac rounds cleanly to 24 rather than tripping the floor at 23.98).
 *
 * @param {{appleSilicon?: boolean, totalMemBytes?: number, cuda?: boolean}} [overrides]
 * @returns {{appleSilicon: boolean, unifiedMemoryGb: number, cuda: boolean}}
 */
export function detectHostCapabilities({
  appleSilicon = isAppleSilicon(),
  totalMemBytes = os.totalmem(),
  cuda = false,
} = {}) {
  return {
    appleSilicon: Boolean(appleSilicon),
    unifiedMemoryGb: Math.round(Number(totalMemBytes) / 1024 ** 3),
    cuda: Boolean(cuda),
  };
}
