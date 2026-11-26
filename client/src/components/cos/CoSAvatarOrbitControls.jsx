import { OrbitControls } from '../../lib/threeHelpers/controls.jsx';

export default function CoSAvatarOrbitControls() {
  return (
    <OrbitControls
      enablePan={false}
      enableZoom={false}
      enableDamping
      dampingFactor={0.08}
      rotateSpeed={0.6}
      makeDefault
    />
  );
}
