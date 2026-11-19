/**
 * Image-to-3D — pluggable target registry: the source of truth for selectable image→3D "processing targets".
 * Adding a target is a registration here, not a rewrite of dispatch/install/UI (cf. `imageGen/modes.js`).
 *
 * Dependency-light: descriptors are pure and the resolvers take host capabilities as an injected argument.
 * `detectHostCapabilities()` is the one impure (and async, since sizing an NVIDIA card shells to `nvidia-smi`)
 * boundary. A target's installer/runner is wired in `adapters.js`; keeping runner imports out of this file lets
 * boot and tests import the registry for free.
 */

import os from 'os';
import { isAppleSilicon } from '../../lib/platform.js';
import { getCudaCapability } from '../../lib/cudaCapability.js';

/**
 * How a target's inference runs. A target declares exactly one lane; the lane decides which hardware gate
 * `unavailableReason` applies and which installer/runner the service dispatches to.
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
 * The registry. Each entry is a frozen, pure descriptor (no imported runners), so a new model is one object here.
 *
 * `requires` states the hardware floor for the target's lane; the pure resolvers below read it. Runners are wired
 * in `adapters.js`, keyed by `id`.
 *
 * Beyond `id`/`label`/`description`/`executionLane`/`outputKind`/`requires`, a descriptor carries:
 *  - `installNotes` — prose for the shared install modal. **Required for a target with an install step**, since
 *    the modal has no per-target copy; `registry.test.js` enforces it.
 *  - `installBlockedReason` — why Install and Repair are unavailable. Existing runtimes can still render if they
 *    meet the host requirements.
 *  - `gatedRepos` — Hugging Face repos whose terms the user must accept; omit for ungated weights.
 *  - `supportsRenderOptions` — per-run knobs the runner does NOT honor, e.g. `{ steps: false }`; absent means all
 *    are honored. Stops the UI offering a dead control and the run ledger recording a value never received.
 *  - `upstream` / `port` / `weightsRepo` — links surfaced on the target card.
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
    // Silicon (M1+), 24 GB+ unified memory, ~15 GB weights on disk, Python 3.13.
    requires: Object.freeze({
      appleSilicon: true,
      minUnifiedMemoryGb: 24,
      diskGb: 15,
      python: '3.13',
    }),
    // Maps the shared abstract detail tiers onto this port's `--pipeline-type` values. `auto` is absent on purpose:
        // the runner derives it from unified memory.
        //
        // The 512 tier is genuinely fast (upstream benchmark ~3m20s on an M4 Pro vs 13–20 minutes for 1024_cascade on a
        // 64 GB M5 Max), so it is worth exposing as a preview tier even where memory qualifies for max.
    detailTiers: Object.freeze({
      fast: '512',
      balanced: '1024',
      max: '1024_cascade',
    }),
    upstream: 'https://github.com/microsoft/TRELLIS.2',
    // Community MPS port that makes the CUDA-only upstream run on Apple Silicon.
    port: 'https://github.com/shivampkumar/trellis-mac',
    weightsRepo: 'microsoft/TRELLIS.2-4B',
    installNotes:
      'Requires macOS 26+, full Xcode 26+ with the Metal Toolchain, and Python 3.13. '
      + 'Installs the verified Torch 2.15 / Metal profile; Repair rebuilds the private '
      + 'environment and retains downloaded models.',
    // Optional user-actionable prerequisites; the single source for both the API/UI notice and runner auth guidance.
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
  pixal3dMps: Object.freeze({
    id: 'pixal3dMps',
    label: 'Pixal3D (Apple Silicon)',
    description:
      'TencentARC Pixal3D — pixel-aligned single image to a textured GLB mesh, run '
      + 'locally through the community Apple Silicon MPS/Metal port.',
    executionLane: EXECUTION_LANE.LOCAL_MPS,
    outputKind: OUTPUT_KIND.GLB_MESH,
    // Same conservative 24 GB floor as the TRELLIS.2 MPS lane; the 1024 cascade is the safe PortOS default.
    requires: Object.freeze({
      appleSilicon: true,
      minUnifiedMemoryGb: 24,
      diskGb: 40,
      python: '3.13',
    }),
    // Starts at the 1024 cascade. The 1536 cascade is not exposed through the shared detail control: it can take
        // roughly an hour on a high-memory Mac, and the shared labels describe TRELLIS.2's different tier vocabulary.
    supportsRenderOptions: Object.freeze({ detail: false, alphaMode: false, normalMap: false }),
    upstream: 'https://github.com/TencentARC/Pixal3D',
    port: 'https://github.com/pawel-mazurkiewicz/Pixal3D-mac',
    weightsRepo: 'TencentARC/Pixal3D',
    installNotes:
      'Cloning the Apple Silicon Pixal3D port and creating its isolated Python 3.13 '
      + 'environment, then compiling the vendored Metal mesh, sparse-GEMM, rasterizer, '
      + 'BVH and neighborhood-attention packages. The first render downloads the model '
      + 'weights from Hugging Face; budget roughly 40 GB of disk and several minutes per '
      + '1024-cascade render.',
    // Public mirrors for the DINOv3 and MoGe dependencies; a token is still passed for rate-limit headroom but no
        // terms need accepting.
  }),
  trellis2Cuda: Object.freeze({
    id: 'trellis2Cuda',
    label: 'TRELLIS.2 (CUDA)',
    description:
      'Microsoft TRELLIS.2 — single image to a PBR-textured GLB mesh, run on-device '
      + 'on an NVIDIA GPU via the upstream CUDA build.',
    executionLane: EXECUTION_LANE.LOCAL_CUDA,
    outputKind: OUTPUT_KIND.GLB_MESH,
    // Upstream's stated floor: NVIDIA GPU with 24GB+, CUDA 12.4, Python 3.8+, tested only on Linux. `linuxHost` is a
        // real requirement: `setup.sh` builds CUDA extensions from source against a POSIX toolchain. A Windows box with
        // a 24 GB card reaches this lane through WSL2, where PortOS reports `linuxHost: true`.
    requires: Object.freeze({
      cuda: true,
      minVramGb: 24,
      linuxHost: true,
      diskGb: 15,
      python: '3.11',
    }),
    // Upstream's CUDA entrypoint takes no pipeline-type override and the runner emits no alpha-mode flag, so both
        // controls are declared unsupported.
    supportsRenderOptions: Object.freeze({ detail: false, alphaMode: false, normalMap: false }),
    upstream: 'https://github.com/microsoft/TRELLIS.2',
    weightsRepo: 'microsoft/TRELLIS.2-4B',
    installNotes: 'The locked Linux x86_64 profile requires CUDA toolkit 12.6.3 (nvcc 12.6.85), GCC 11.3, '
      + 'compute capability 8.6 and 24 GiB VRAM. Other existing CUDA environments can still render.',
    // Same two gated repos as the MPS port: `TRELLIS.2-4B`'s `pipeline.json` names `briaai/RMBG-2.0` as its
        // `rembg_model` and the pipeline defaults `preprocess_image=True`, so the raw image gets RMBG-matted. Omitting
        // the repo would leave a user who hasn't accepted its terms at a 401 with nothing naming it.
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
  pixal3dCuda: Object.freeze({
    id: 'pixal3dCuda',
    label: 'Pixal3D (CUDA)',
    description:
      'TencentARC Pixal3D — pixel-aligned single image to a PBR-textured GLB mesh, run '
      + 'on-device on an NVIDIA GPU. Built on the TRELLIS.2 backbone, with higher '
      + 'geometry fidelity at a longer render time.',
    executionLane: EXECUTION_LANE.LOCAL_CUDA,
    outputKind: OUTPUT_KIND.GLB_MESH,
    // The floor is DELIBERATELY lower than the TRELLIS.2 CUDA lane's 24 GB: upstream's low-VRAM mode loads one
        // pipeline stage at a time (~10-12 GB peak at 1024). Full-quality 1536 wants ~36 GB, but that is a QUALITY tier
        // the runner picks from actual VRAM (`selectPixal3dRenderBudget`), not an availability gate. `diskGb` covers
        // ~24 GB of weights plus its own TRELLIS.2 checkout and conda env.
    requires: Object.freeze({
      cuda: true,
      minVramGb: 12,
      linuxHost: true,
      diskGb: 40,
      python: '3.11',
    }),
    upstream: 'https://github.com/TencentARC/Pixal3D',
    weightsRepo: 'TencentARC/Pixal3D',
    // Upstream's `inference.py` has no per-phase step override, so the runner drops `steps`; declared so the UI
        // disables Quality and the run entry records `steps: null`.
        // `detail: false` despite 1024/1536 resolutions: the tier is chosen from actual VRAM by
        // `selectPixal3dRenderBudget`, and a caller override could hand a 12 GB card a configuration that OOMs. Exposing
        // it needs a VRAM-safety story first.
        // `alphaMode: false` because its runner emits no such flag.
    supportsRenderOptions: Object.freeze({ steps: false, detail: false, alphaMode: false, normalMap: false }),
    installNotes: 'Native Linux x86_64 only; CUDA 12.6.3 (nvcc 12.6.85), GCC 11.3, compute capability 8.6 and 12 GiB VRAM. NATTEN build failure uses lower-detail DINO interpolation.',
    // No `gatedRepos` (verified): DINOv3 loads from the ungated `camenduru/dinov3-vitl16-pretrain-lvd1689m` mirror
        // and MoGe from `Ruicheng/moge-2-vitl`. A Hugging Face token still helps download rate limits, so the adapter
        // still resolves one.
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
    // Order matters: report the most fundamental unmet requirement first, so a Mac is told it needs an NVIDIA GPU
        // rather than Linux, while a Windows box WITH a 24 GB card is told the one thing it can act on.
    if (!caps.cuda) {
      // "The probe couldn't run" is not "there is no GPU" — never report absent
      // hardware we failed to look for (AGENTS.md sentinel rule).
      return caps.cudaProbe === 'unknown' ? 'cuda-probe-failed' : 'requires-cuda';
    }
    if (req.linuxHost && !caps.linuxHost) return 'requires-linux-host';
    if (req.minVramGb) {
      // A VRAM column that didn't parse is a failed measurement, not a small card, so it must not read as
            // "insufficient" (which would tell the user to buy hardware they may own).
      if (!Number.isFinite(caps.cudaVramGb)) return 'cuda-probe-failed';
      if (caps.cudaVramGb < req.minVramGb) return 'insufficient-vram';
    }
  }
  // hosted-api has no local hardware requirement.
  return null;
}

/**
 * Which per-run render options a target's runner does NOT honor, or null when it honors all of them. Pure. Read by
 * the record route (a detail view has a record, not the target list) so it can disable a control the runner would
 * ignore, and by `beginRender` so the run ledger records what the subprocess actually received.
 * @param {string} targetId
 * @returns {object|null}
 */
export function renderOptionSupportFor(targetId) {
  return getTarget(targetId)?.supportsRenderOptions || null;
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

// The code → label map is the browser-safe leaf `lib/imageTo3dReasons.js` (the client re-exports it too); API/SSE surfaces read it through here.
export { unavailableReasonLabel } from '../../lib/imageTo3dReasons.js';

/**
 * Reason codes meaning "this machine's hardware will never run that target", as opposed to a blocker the user can
 * act on. A property of the REASON, classified once here so every lane and new target inherits the policy.
 *
 * `listTargets` omits a target blocked for one of these, so a Mac isn't shown a permanently-red NVIDIA card.
 * `cuda-probe-failed` is deliberately NOT here: "we couldn't tell" is worth surfacing and only arises on a host
 * that has a driver.
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
 * Resolve the effective target for a request. Pure; no fallback to a *different* model (a caller policy). The
 * requested/default target is returned with an availability verdict so the caller can 400 or prompt-to-install.
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
 * Every registered target annotated with its availability on a host, for the API/UI target selector. Pure.
 *
 * A target blocked by hardware this host doesn't have is omitted (see `UNFIXABLE_HARDWARE_REASONS`); every other
 * blocker still renders, so a fixable one is never hidden.
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
 * The one impure boundary: read this machine's capabilities. Injectable so routes/tests can supply deterministic
 * values. `unifiedMemoryGb` is rounded to whole GB (physical RAM reads a hair under the marketed size, so a "24 GB"
 * Mac must not trip the floor at 23.98); `cudaVramGb` is rounded the same way.
 *
 * **Async because CUDA detection is a subprocess** (`nvidia-smi` is the only way to size an NVIDIA card). Awaiting
 * the cached probe keeps this the single boundary rather than a sync shape that reports `cuda: false` on a real
 * CUDA box until a warm-up finishes. The pure resolvers still take `caps` as a plain object.
 *
 * Pass an explicit `cuda` (and optionally `cudaVramGb`) to skip the probe.
 *
 * `cudaProbe` carries the three-way status (`'available'` / `'absent'` / `'unknown'`) so `unavailableReason` can
 * pick between `requires-cuda` and `cuda-probe-failed`.
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
