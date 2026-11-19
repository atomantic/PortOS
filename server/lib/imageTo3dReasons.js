/**
 * Image-to-3D unavailable-reason codes mapped to their user-facing labels (`unavailableReasonLabel`).
 *
 * ONE definition: `server/services/imageTo3d/targets.js` re-exports the label lookup for API/SSE surfaces and `client/src/lib/imageTo3dReasons.js` re-exports it for the browser. The codes are SERVER vocabulary (what `unavailableReason()` returns); `targets.test.js` pins that this key set equals the returned codes. No imports, so the browser bundle can load it (the registry's capability probes pull in `os` / `child_process`).
 */

/**
 * Every reason code `unavailableReason` can return, mapped to its user-facing label.
 *
 * Labels are prose (the client has no registry). **Only mention a GB figure when every target that can produce the
 * code shares it.** `insufficient-memory` names 24 GB because one MPS target produces it; `insufficient-vram` names
 * none because CUDA floors diverge (24 GB TRELLIS.2, 12 GB Pixal3D). The per-target figure travels on the
 * descriptor (`requires.minVramGb`).
 */
export const UNAVAILABLE_REASONS = Object.freeze({
  'unknown-target': 'Unavailable',
  'requires-apple-silicon': 'Requires an Apple Silicon Mac',
  'insufficient-memory': 'Needs 24 GB+ of unified memory',
  'requires-cuda': 'Requires an NVIDIA CUDA GPU',
  // Shown on a Windows host that HAS a qualifying card: upstream TRELLIS.2 builds CUDA extensions against a POSIX
  // toolchain, so WSL2 is the supported route and this is the blocker the user can act on.
  // Caveat this per-CODE label cannot express: Pixal3D has a known NAF-upsampler driver fault under WSL2, surfaced
  // at render time via `PIXAL3D_CUDA_NAF_DEVICE_NOT_READY` whose help text names native Linux.
  'requires-linux-host': 'Requires a Linux host (use WSL2 on Windows)',
  // Deliberately NO GB figure: `pixal3dCuda` runs from 12 GB while TRELLIS.2 needs 24, so one number would be wrong
  // for a lane. The per-target requirement travels on the descriptor (`requires.minVramGb`).
  'insufficient-vram': 'This NVIDIA GPU has too little VRAM',
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
