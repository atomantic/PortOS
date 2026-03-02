import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const BODY_COLOR = '#0c0c24';
const NEON_COLOR = '#06b6d4';
const VISOR_COLOR = '#06b6d4';
const EYE_COLOR = '#ff3366';

export default function PlayerAvatar({ isMoving, facingAngle }) {
  const groupRef = useRef();
  const leftArmRef = useRef();
  const rightArmRef = useRef();
  const leftLegRef = useRef();
  const rightLegRef = useRef();
  const walkPhaseRef = useRef(0);

  const torsoEdges = useMemo(() => {
    const geom = new THREE.BoxGeometry(0.3, 0.4, 0.2);
    return new THREE.EdgesGeometry(geom);
  }, []);

  useFrame((_, delta) => {
    if (!groupRef.current) return;

    // Facing direction
    groupRef.current.rotation.y = facingAngle;

    // Idle bob
    const t = performance.now() / 1000;
    const bob = Math.sin(t * 2) * 0.03;
    groupRef.current.position.y = bob;

    // Walk animation
    if (isMoving) {
      walkPhaseRef.current += delta * 12;
    } else {
      // Damp walk phase toward zero
      walkPhaseRef.current *= 0.85;
    }

    const swing = Math.sin(walkPhaseRef.current) * 0.6;

    if (leftArmRef.current) leftArmRef.current.rotation.x = swing;
    if (rightArmRef.current) rightArmRef.current.rotation.x = -swing;
    if (leftLegRef.current) leftLegRef.current.rotation.x = -swing;
    if (rightLegRef.current) rightLegRef.current.rotation.x = swing;
  });

  return (
    <group ref={groupRef}>
      {/* Head - wireframe icosahedron */}
      <group position={[0, 1.05, 0]}>
        <mesh>
          <icosahedronGeometry args={[0.12, 0]} />
          <meshBasicMaterial color={NEON_COLOR} wireframe transparent opacity={0.7} />
        </mesh>
        {/* Visor */}
        <mesh position={[0, 0, 0.08]}>
          <boxGeometry args={[0.18, 0.05, 0.04]} />
          <meshBasicMaterial color={VISOR_COLOR} transparent opacity={0.8} />
        </mesh>
        {/* Eyes */}
        <mesh position={[-0.04, 0, 0.11]}>
          <boxGeometry args={[0.03, 0.02, 0.01]} />
          <meshBasicMaterial color={EYE_COLOR} />
        </mesh>
        <mesh position={[0.04, 0, 0.11]}>
          <boxGeometry args={[0.03, 0.02, 0.01]} />
          <meshBasicMaterial color={EYE_COLOR} />
        </mesh>
      </group>

      {/* Torso */}
      <group position={[0, 0.75, 0]}>
        <mesh>
          <boxGeometry args={[0.3, 0.4, 0.2]} />
          <meshBasicMaterial color={BODY_COLOR} transparent opacity={0.9} />
        </mesh>
        {/* Neon wireframe edges */}
        <lineSegments geometry={torsoEdges}>
          <lineBasicMaterial color={NEON_COLOR} transparent opacity={0.8} />
        </lineSegments>
      </group>

      {/* Left arm - pivoted at shoulder */}
      <group position={[-0.22, 0.9, 0]}>
        <group ref={leftArmRef}>
          <mesh position={[0, -0.125, 0]}>
            <cylinderGeometry args={[0.04, 0.04, 0.25, 6]} />
            <meshBasicMaterial color={BODY_COLOR} transparent opacity={0.9} />
          </mesh>
        </group>
      </group>

      {/* Right arm - pivoted at shoulder */}
      <group position={[0.22, 0.9, 0]}>
        <group ref={rightArmRef}>
          <mesh position={[0, -0.125, 0]}>
            <cylinderGeometry args={[0.04, 0.04, 0.25, 6]} />
            <meshBasicMaterial color={BODY_COLOR} transparent opacity={0.9} />
          </mesh>
        </group>
      </group>

      {/* Left leg - pivoted at hip */}
      <group position={[-0.08, 0.55, 0]}>
        <group ref={leftLegRef}>
          <mesh position={[0, -0.15, 0]}>
            <cylinderGeometry args={[0.05, 0.05, 0.3, 6]} />
            <meshBasicMaterial color={BODY_COLOR} transparent opacity={0.9} />
          </mesh>
          {/* Foot */}
          <mesh position={[0, -0.32, 0.03]}>
            <boxGeometry args={[0.07, 0.04, 0.12]} />
            <meshBasicMaterial color={NEON_COLOR} transparent opacity={0.6} />
          </mesh>
        </group>
      </group>

      {/* Right leg - pivoted at hip */}
      <group position={[0.08, 0.55, 0]}>
        <group ref={rightLegRef}>
          <mesh position={[0, -0.15, 0]}>
            <cylinderGeometry args={[0.05, 0.05, 0.3, 6]} />
            <meshBasicMaterial color={BODY_COLOR} transparent opacity={0.9} />
          </mesh>
          {/* Foot */}
          <mesh position={[0, -0.32, 0.03]}>
            <boxGeometry args={[0.07, 0.04, 0.12]} />
            <meshBasicMaterial color={NEON_COLOR} transparent opacity={0.6} />
          </mesh>
        </group>
      </group>

      {/* Glow disc at feet */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <circleGeometry args={[0.4, 16]} />
        <meshBasicMaterial
          color={NEON_COLOR}
          transparent
          opacity={0.15}
          side={THREE.DoubleSide}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}
