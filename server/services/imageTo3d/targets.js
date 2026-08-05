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
 * pass into pure services" contract) — and the only async export here, because
 * sizing an NVIDIA card means shelling to `nvidia-smi`. A target's installer/runner is
 * wired separately, in `adapters.js` — keeping runner imports out of this file
 * is what lets it stay a pure, no-side-effect registry that boot and tests can
 * import for free (#3080).
 */

import os from 'os';
import { isAppleSilicon } from '../../lib/platform.js';
import { getCudaCapability } from '../../lib/cudaCapability.js';

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
 * resolvers below read it. A target's installer/runner is wired in `adapters.js`,
 * keyed by this registry's `id` (not imported here — see the file header).
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
    // Optional user-actionable prerequisites. The target descriptor is the source
    // for both the API/UI notice and runner auth guidance, so new targets do not
    // need their gated Hugging Face dependencies duplicated in either consumer.
    gatedRepos: Object.freeze([
      Object.freeze({
        label: 'facebook/dinov3-vitl16-pretrain-lvd1689m',
        url: 'https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m',
      }),
      Object.freeze({
        label: 'briaai/RMBG-2.0',
        url: 'https://huggingface.co/briaai/RMBG-2.0',
      }),
    ]),
  }),
  trellis2Cuda: Object.freeze({
    id: 'trellis2Cuda',
    label: 'TRELLIS.2 (CUDA)',
    description:
      'Microsoft TRELLIS.2 — single image to a PBR-textured GLB mesh, run on-device '
      + 'on an NVIDIA GPU via the upstream CUDA build.',
    executionLane: EXECUTION_LANE.LOCAL_CUDA,
    outputKind: OUTPUT_KIND.GLB_MESH,
    // Upstream's own stated floor: "An NVIDIA GPU with at least 24GB of memory is
    // necessary", CUDA 12.4, Python 3.8+, and "currently tested only on Linux".
    // `linuxHost` is therefore a real requirement, not conservatism — `setup.sh`
    // builds CUDA extensions (flash-attn, nvdiffrast, nvdiffrec, cumesh) from
    // source against a POSIX toolchain. A Windows box with a 24 GB card reaches
    // this lane through WSL2, where PortOS reports `linuxHost: true`.
    requires: Object.freeze({
      cuda: true,
      minVramGb: 24,
      linuxHost: true,
      diskGb: 15,
      python: '3.10',
    }),
    upstream: 'https://github.com/microsoft/TRELLIS.2',
    weightsRepo: 'microsoft/TRELLIS.2-4B',
    // The 4B model conditions on DINOv3, which is gated. Unlike the MPS port this
    // lane does not use RMBG-2.0 (upstream's own example feeds the image straight
    // to the pipeline), so it is deliberately absent here rather than copied over.
    gatedRepos: Object.freeze([
      Object.freeze({
        label: 'facebook/dinov3-vitl16-pretrain-lvd1689m',
        url: 'https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m',
      }),
    ]),
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
 * @param {{appleSilicon?: boolean, unifiedMemoryGb?: number, cuda?: boolean,
 *          cudaVramGb?: number|null, cudaProbe?: string, linuxHost?: boolean}} [caps]
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
    // Order matters: report the most fundamental unmet requirement first, so a Mac
    // is told it needs an NVIDIA GPU (true and final) rather than that it needs
    // Linux (true but beside the point), while a Windows box WITH a 24 GB card is
    // told the one thing it can actually act on.
    if (!caps.cuda) {
      // "The probe couldn't run" is not "there is no GPU" — never report absent
      // hardware we failed to look for (CLAUDE.md sentinel rule).
      return caps.cudaProbe === 'unknown' ? 'cuda-probe-failed' : 'requires-cuda';
    }
    if (req.linuxHost && !caps.linuxHost) return 'requires-linux-host';
    if (req.minVramGb) {
      // A card whose VRAM column didn't parse is a known GPU of unknown size; that
      // is a failed measurement, not a small card, so it must not read as
      // "insufficient" (which would tell the user to buy hardware they may own).
      if (!Number.isFinite(caps.cudaVramGb)) return 'cuda-probe-failed';
      if (caps.cudaVramGb < req.minVramGb) return 'insufficient-vram';
    }
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
 * Every reason code `unavailableReason` can return, mapped to the user-facing
 * label. This is the LABEL side the codes never had: the API/SSE surfaces and
 * the client both render from here rather than each re-declaring the set, so a
 * new code is a one-line addition next to the branch that returns it.
 *
 * MIRRORED verbatim to `client/src/lib/imageTo3dReasons.js`; the parity test
 * (`unavailableReasons.parity.test.js`) asserts the two never drift AND that
 * the key set still equals the codes `unavailableReason` actually returns — so
 * adding a code without a label fails CI instead of rendering as the generic
 * "Unsupported on this host" fallback.
 *
 * The GB figures restate the registry floors (`minUnifiedMemoryGb` /
 * `minVramGb`, both 24) as prose rather than interpolating them: the labels are
 * mirrored to the client, which has no registry to read, and both lanes would
 * have to move for the numbers to diverge.
 */
export const UNAVAILABLE_REASONS = Object.freeze({
  'unknown-target': 'Unavailable',
  'requires-apple-silicon': 'Requires an Apple Silicon Mac',
  'insufficient-memory': 'Needs 24 GB+ of unified memory',
  'requires-cuda': 'Requires an NVIDIA CUDA GPU',
  // Shown on a Windows host that HAS a qualifying card: upstream TRELLIS.2 builds
  // its CUDA extensions against a POSIX toolchain and is Linux-only, so WSL2 is the
  // supported route — name it, since this blocker is the one the user can act on.
  'requires-linux-host': 'Requires a Linux host (use WSL2 on Windows)',
  'insufficient-vram': 'Needs a 24 GB+ NVIDIA GPU',
  // The probe itself failed — say so rather than claiming the GPU isn't there.
  'cuda-probe-failed': 'Could not detect this host’s GPU',
});

/** Label for a reason code the map doesn't know (or a null/absent code). */
export const UNAVAILABLE_REASON_FALLBACK = 'Unsupported on this host';

/**
 * User-facing label for a reason code. Own-property lookup only, so a code that
 * happens to name an Object.prototype key can't render as a function/object.
 * @param {string|null} [reason]
 * @param {string} [fallback] label for an unknown/absent code.
 * @returns {string}
 */
export function unavailableReasonLabel(reason, fallback = UNAVAILABLE_REASON_FALLBACK) {
  return Object.hasOwn(UNAVAILABLE_REASONS, reason ?? '') ? UNAVAILABLE_REASONS[reason] : fallback;
}

/**
 * Reason codes meaning "this machine's hardware will never run that target" — as
 * opposed to a blocker the user can act on (install an OS in WSL2, fix a driver,
 * install the model). This is a property of the REASON, not of any one target, so it
 * is classified once here rather than restated per descriptor: every lane gets the
 * same treatment, and a new target inherits it without re-deriving the policy.
 *
 * `listTargets` omits a target blocked for one of these, so a Mac isn't shown a
 * permanently-red NVIDIA card and an NVIDIA box isn't shown a permanently-red Apple
 * Silicon one. Note `cuda-probe-failed` is deliberately NOT here — "we couldn't tell"
 * is worth surfacing, and it only ever arises on a host that does have a driver.
 */
export const UNFIXABLE_HARDWARE_REASONS = Object.freeze([
  'requires-apple-silicon',
  'requires-cuda',
  'insufficient-memory',
  'insufficient-vram',
]);

/**
 * Does this reason describe hardware the host simply doesn't have? Pure.
 * @param {string|null} reason
 * @returns {boolean}
 */
export function isUnfixableHardwareReason(reason) {
  return UNFIXABLE_HARDWARE_REASONS.includes(reason);
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
 *
 * A target blocked by hardware this host doesn't have is omitted entirely rather
 * than listed with a permanently-red badge (see `UNFIXABLE_HARDWARE_REASONS`);
 * every other blocker still renders, so a fixable one is never silently hidden.
 *
 * @param {object} [caps]
 * @returns {Array<object>}
 */
export function listTargets(caps = {}) {
  return IMAGE_TO_3D_TARGET_IDS
    .map((id) => {
      const target = IMAGE_TO_3D_TARGETS[id];
      const reason = unavailableReason(target, caps);
      return { ...target, available: reason === null, unavailableReason: reason };
    })
    .filter((t) => !isUnfixableHardwareReason(t.unavailableReason));
}

/**
 * The one impure boundary: read this machine's capabilities. Injectable so
 * routes/tests can supply deterministic values. `unifiedMemoryGb` is rounded to
 * the nearest whole GB (physical RAM reads a hair under the marketed size, so a
 * "24 GB" Mac rounds cleanly to 24 rather than tripping the floor at 23.98);
 * `cudaVramGb` is rounded the same way, for the same reason.
 *
 * **Async because CUDA detection is a subprocess.** Apple-Silicon and memory reads
 * are synchronous, but there is no way to size an NVIDIA card without shelling to
 * `nvidia-smi`. Rather than keep a second, sync-but-lying capability shape (which
 * would report `cuda: false` on a real CUDA box until some background warm-up
 * finished), this stays the single boundary and awaits the cached probe — cached,
 * so the per-request cost after the first call is nil. The pure resolvers above are
 * unaffected: they still take `caps` as a plain injected object.
 *
 * Pass an explicit `cuda` (and optionally `cudaVramGb`) to skip the probe entirely —
 * that is how tests and callers with pre-resolved capabilities stay deterministic.
 *
 * `cudaProbe` carries the probe's three-way status (`'available'` / `'absent'` /
 * `'unknown'`) so consumers can distinguish "this host has no NVIDIA GPU" from "we
 * could not find out" — `unavailableReason` uses exactly that to pick between
 * `requires-cuda` and `cuda-probe-failed`.
 *
 * @param {{appleSilicon?: boolean, totalMemBytes?: number, linuxHost?: boolean,
 *          cuda?: boolean, cudaVramGb?: number|null}} [overrides]
 * @returns {Promise<{appleSilicon: boolean, unifiedMemoryGb: number, linuxHost: boolean,
 *                    cuda: boolean, cudaVramGb: number|null,
 *                    cudaProbe: 'available'|'absent'|'unknown'}>}
 */
export async function detectHostCapabilities({
  appleSilicon = isAppleSilicon(),
  totalMemBytes = os.totalmem(),
  linuxHost = os.platform() === 'linux',
  cuda,
  cudaVramGb,
} = {}) {
  // Only probe when the caller didn't already state the answer.
  const probe = cuda === undefined ? await getCudaCapability() : null;
  const resolvedCuda = probe ? probe.status === 'available' : Boolean(cuda);
  return {
    appleSilicon: Boolean(appleSilicon),
    unifiedMemoryGb: Math.round(Number(totalMemBytes) / 1024 ** 3),
    // WSL2 reports linux, which is exactly right: that IS the supported way to run
    // the CUDA lane on a Windows machine.
    linuxHost: Boolean(linuxHost),
    cuda: resolvedCuda,
    cudaVramGb: cudaVramGb ?? (probe ? probe.maxVramGb : null),
    cudaProbe: probe ? probe.status : (resolvedCuda ? 'available' : 'absent'),
  };
}
