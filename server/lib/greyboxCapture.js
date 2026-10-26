/** Camera and output contract shared by the interactive and headless viewer. */
export const DEFAULT_FOCAL_LENGTH_MM = 35;
const CAPTURE_LONG_EDGE = 1280;

export function aspectRatio(aspect) {
  const [w, h] = String(aspect).split(':').map(Number);
  return w > 0 && h > 0 ? w / h : 16 / 9;
}

// A 35mm-equivalent lens uses the full-frame sensor's 24mm height.
export const fovFromFocalLength = (mm) => (2 * Math.atan(12 / mm) * 180) / Math.PI;

export function greyboxCaptureSettings({ aspect = '16:9', focalLengthMm = DEFAULT_FOCAL_LENGTH_MM } = {}) {
  const ratio = aspectRatio(aspect);
  return {
    aspect: ratio,
    fov: fovFromFocalLength(focalLengthMm),
    width: ratio >= 1 ? CAPTURE_LONG_EDGE : Math.round(CAPTURE_LONG_EDGE * ratio),
    height: ratio >= 1 ? Math.round(CAPTURE_LONG_EDGE / ratio) : CAPTURE_LONG_EDGE,
  };
}
