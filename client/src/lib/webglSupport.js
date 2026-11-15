/**
 * Detect whether the browser can create a WebGL context.
 *
 * `isWebGLAvailable()` — memoized probe for a creatable WebGL/WebGL2 context. CoS 3D avatars (and
 * similar r3f mounts) call this before `<Canvas>` so headless Chrome / no-GPU displays degrade to a
 * hint instead of unhandled `WebGLRenderer` rejections.
 *
 * Used before mounting react-three-fiber `<Canvas>` so CoS 3D avatars (and
 * similar) degrade cleanly instead of throwing unhandled
 * `THREE.WebGLRenderer: Error creating WebGL context` rejections on headless
 * Chrome, remote desktops, or GPUs with WebGL disabled.
 *
 * Result is memoized for the page lifetime — context creation is not free,
 * and availability does not change mid-session in practice.
 */

let cached = null;

export function isWebGLAvailable() {
  if (cached !== null) return cached;
  if (typeof document === 'undefined') {
    cached = false;
    return cached;
  }
  try {
    const canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false }) ||
      canvas.getContext('webgl', { failIfMajorPerformanceCaveat: false }) ||
      canvas.getContext('experimental-webgl', { failIfMajorPerformanceCaveat: false });
    cached = !!gl;
    // Drop the context immediately so we don't hold a GPU slot just for the probe.
    if (gl && typeof gl.getExtension === 'function') {
      const lose = gl.getExtension('WEBGL_lose_context');
      lose?.loseContext?.();
    }
  } catch {
    cached = false;
  }
  return cached;
}

/** Test-only: clear the memo so cases can flip availability. */
export function __resetWebGLAvailableCache() {
  cached = null;
}
