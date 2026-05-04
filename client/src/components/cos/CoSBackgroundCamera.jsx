import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';

const COMPACT_FRAME_HEIGHT = 128 * 6 / 5;
const DESKTOP_FRAME_HEIGHT = 192 * 6 / 5;

export default function CoSBackgroundCamera({ enabled = false, x = 0, y = 0, z = 3.5 }) {
  const { camera, size } = useThree();

  useEffect(() => {
    if (!enabled) return;

    const oldFrameHeight = window.innerWidth >= 1024
      ? DESKTOP_FRAME_HEIGHT
      : COMPACT_FRAME_HEIGHT;
    const distanceScale = Math.max(1, size.height / oldFrameHeight);

    camera.position.set(x, y, z * distanceScale);
    camera.updateProjectionMatrix();
  }, [camera, enabled, size.height, x, y, z]);

  return null;
}
