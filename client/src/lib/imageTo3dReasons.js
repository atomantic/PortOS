/**
 * Client mirror of the image-to-3D unavailable-reason labels in
 * `server/services/imageTo3d/targets.js`. The server registry returns stable
 * kebab-case reason codes (`requires-cuda`, `cuda-probe-failed`, …) on every
 * target it reports as unavailable; this is the label side the UI renders.
 *
 * The client can't import the server registry (it pulls in `os` /
 * `child_process` through the capability probes), so this is a hand-maintained
 * mirror — drift is asserted by
 * `server/services/imageTo3d/unavailableReasons.parity.test.js`, which also
 * checks the key set still equals the codes `unavailableReason()` returns. If
 * you change one side, change the other.
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
  // Deliberately carries NO GB figure. It used to read "Needs a 24 GB+ NVIDIA GPU"
  // when every CUDA target shared that floor; `pixal3dCuda` runs from 12 GB, so a
  // single number here would be wrong for one lane or the other. The per-target
  // requirement travels to the client on the descriptor (`requires.minVramGb`) for a
  // UI that wants to name it.
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
