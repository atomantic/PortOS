import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Sparkles } from '@react-three/drei';
import { AGENT_STATES } from '../cos/constants';

const DEFAULT_COLOR = '#06b6d4';

export default function AgentEntity({ agent, position, index = 0 }) {
  const meshRef = useRef();

  const state = agent.state || agent.status || 'coding';
  const color = AGENT_STATES[state]?.color || DEFAULT_COLOR;

  const offsetX = index * 1.0 - (index > 0 ? 0.5 : 0);
  const yBase = position[1];

  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    const t = clock.getElapsedTime();

    // Vertical bob
    meshRef.current.position.y = yBase + Math.sin(t * 1.5 + index) * 0.3;

    // Y rotation
    meshRef.current.rotation.y = t * 0.8 + index * Math.PI * 0.5;

    // Emissive pulse
    meshRef.current.children[0]?.material && (
      meshRef.current.children[0].material.emissiveIntensity = 0.5 + Math.sin(t * 3) * 0.3
    );
  });

  return (
    <group ref={meshRef} position={[position[0] + offsetX, yBase, position[2]]}>
      <mesh>
        <octahedronGeometry args={[0.3, 0]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.5}
          wireframe
          transparent
          opacity={0.8}
        />
      </mesh>
      <Sparkles
        count={15}
        scale={0.8}
        size={1}
        speed={0.5}
        color={color}
        opacity={0.6}
      />
    </group>
  );
}
