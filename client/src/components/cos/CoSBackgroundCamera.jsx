import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';

export const COMPACT_FRAME_HEIGHT = 128 * 6 / 5;
export const DESKTOP_FRAME_HEIGHT = 192 * 6 / 5;

// Compute the camera z-distance that keeps the avatar a constant apparent size
// as the full-bleed background frame grows past the original framed-tile size.
//
// Returns `null` when the measured canvas size is degenerate (zero / sub-pixel /
// pre-layout / hidden). In that case the caller MUST leave the camera where it
// is. A zero/tiny measurement otherwise collapses distanceScale to its floor of
// 1 and slams the camera to its closest (base z) position — i.e. zoomed all the
// way in — which OrbitControls then latches with no guaranteed correction. That
// was the "CoS avatar zooms way in overnight, reload fixes it" bug: transient
// 0-height reports (panel collapse/expand, EventLog mounting on the
// working-on-task transition, tab-occlusion ResizeObserver frames) each yanked
// the camera in.
export function computeCameraDistance(size, z) {
  const width = size?.width;
  const height = size?.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return null;
  }
  const oldFrameHeight = width >= 1024 ? DESKTOP_FRAME_HEIGHT : COMPACT_FRAME_HEIGHT;
  const distanceScale = Math.max(1, height / oldFrameHeight);
  return z * distanceScale;
}

export default function CoSBackgroundCamera({ enabled = false, x = 0, y = 0, z = 3.5 }) {
  const { camera, size } = useThree();

  useEffect(() => {
    if (!enabled) return;

    const distance = computeCameraDistance(size, z);
    // Degenerate measurement — keep the last good framing instead of zooming in.
    if (distance == null) return;

    camera.position.set(x, y, distance);
    camera.updateProjectionMatrix();
  }, [camera, enabled, size.height, size.width, x, y, z]);

  return null;
}
