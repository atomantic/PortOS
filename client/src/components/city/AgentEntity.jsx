import { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { Sparkles } from '@react-three/drei';
import * as THREE from 'three';
import { AGENT_STATES } from '../cos/constants';
import {
  AGENT_MOTION,
  computeAgentOrbit,
  computeAgentTrailPoints,
  computeTrailColors,
  resolveTrailSamples,
} from '../../utils/cityAgentMotion';

const DEFAULT_COLOR = '#06b6d4';

export default function AgentEntity({ agent, position, index = 0, settings }) {
  const bodyRef = useRef();
  const trailRef = useRef();

  const state = agent.state || agent.status || 'coding';
  const color = AGENT_STATES[state]?.color || DEFAULT_COLOR;

  // Trail density follows the quality dial; 0 means "don't render a trail".
  const trailSamples = resolveTrailSamples(settings?.particleDensity ?? 1);

  // Static geometry sized to the sample count; positions stream in per frame,
  // the color ramp (head→tail fade) is baked once.
  const trailGeom = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    if (trailSamples > 0) {
      const c = new THREE.Color(color);
      geom.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(new Float32Array(trailSamples * 3), 3),
      );
      geom.setAttribute(
        'color',
        new THREE.Float32BufferAttribute(
          new Float32Array(computeTrailColors([c.r, c.g, c.b], trailSamples)),
          3,
        ),
      );
    }
    return geom;
  }, [color, trailSamples]);

  // Dispose the geometry's GPU buffers when it's replaced (color/quality change)
  // or on unmount — the imperative geometry isn't reclaimed automatically.
  useEffect(() => () => trailGeom.dispose(), [trailGeom]);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const p = computeAgentOrbit(t, { index });

    if (bodyRef.current) {
      bodyRef.current.position.set(p.x, p.y, p.z);
      bodyRef.current.rotation.y = t * 0.8 + index * Math.PI * 0.5;
      const material = bodyRef.current.children[0]?.material;
      if (material) material.emissiveIntensity = 0.5 + Math.sin(t * 3) * 0.3;
    }

    if (trailRef.current && trailSamples > 0) {
      const attr = trailRef.current.geometry.getAttribute('position');
      // Fill the geometry buffer in place — no per-frame allocation.
      computeAgentTrailPoints(t, { index }, trailSamples, AGENT_MOTION.trailSeconds, attr.array);
      attr.needsUpdate = true;
    }
  });

  // The group sits at the building anchor; the agent body orbits within it so
  // its motion trail samples in anchor-relative space.
  return (
    <group position={position}>
      {trailSamples > 0 && (
        <line ref={trailRef} geometry={trailGeom}>
          <lineBasicMaterial
            vertexColors
            transparent
            opacity={0.7}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </line>
      )}
      <group ref={bodyRef}>
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
    </group>
  );
}
