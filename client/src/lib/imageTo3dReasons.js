/**
 * Client mirror of the image-to-3D unavailable-reason labels in `server/services/imageTo3d/targets.js`.
 *
 * The server returns stable kebab-case reason codes (`requires-cuda`, `cuda-probe-failed`, …) on every unavailable target; this is the label side the UI renders. The client can't import the server registry (capability probes pull in `os` / `child_process`),
 * so this is a hand-maintained mirror; `server/services/imageTo3d/unavailableReasons.parity.test.js` asserts drift and that the key set equals the codes `unavailableReason()` returns.
 */

export const UNAVAILABLE_REASONS = Object.freeze({
  'unknown-target': 'Unavailable',
  'requires-apple-silicon': 'Requires an Apple Silicon Mac',
  'insufficient-memory': 'Needs 24 GB+ of unified memory',
  'requires-cuda': 'Requires an NVIDIA CUDA GPU',
  // A Windows host WITH a qualifying card: upstream TRELLIS.2 builds CUDA extensions against a POSIX toolchain and is Linux-only, so name WSL2 (the blocker the user can act on).
  'requires-linux-host': 'Requires a Linux host (use WSL2 on Windows)',
  // Deliberately NO GB figure: CUDA targets no longer share one floor (`pixal3dCuda` runs from 12 GB); the per-target requirement travels on the descriptor (`requires.minVramGb`).
  'insufficient-vram': 'This NVIDIA GPU has too little VRAM',
  'cuda-probe-failed': 'Could not detect this host’s GPU',
});

/**
 * Is this target ready to render on this host? `installed` is TRI-STATE: `true` = local weights present, `false` = installable but not installed, `null` = no install concept (a hosted API lane), ready as soon as it is available.
 * Gating on plain `target.installed` truthiness silently reports a hosted target as not-ready. Shared so the `/3d` readiness summary and the Models → 3D badge can't disagree.
 */
export const isTargetReady = (target) => !!target && !!target.available && target.installed !== false;

export const UNAVAILABLE_REASON_FALLBACK = 'Unsupported on this host';

/**
 * User-facing label for a reason code; own-property lookup only, so an Object.prototype key name cannot render as a function.
 */
export function unavailableReasonLabel(reason, fallback = UNAVAILABLE_REASON_FALLBACK) {
  return Object.hasOwn(UNAVAILABLE_REASONS, reason ?? '') ? UNAVAILABLE_REASONS[reason] : fallback;
}
