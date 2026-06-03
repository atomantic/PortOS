import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import { PIXEL_FONT_URL } from './cityConstants';
import { computeAiCore, computeAiCoreBeams, AI_CORE } from '../../utils/cityAiCore';

// CyberCity's AI Core landmark (roadmap 2.1): a slender central spire above downtown from
// which all model activity radiates. The apex orb glows by the active model tier (cyan
// light → blue medium → violet heavy) and brightens with the number of in-flight calls;
// activity beams fan outward from the apex while AI work is happening, and a fast call
// still produces a brief flare. Idle, the core sits a dim slate. Driven by the live
// `ai:status` ops threaded through useCityData.
//
// When a call originates from a managed app or CoS-agent workspace (its `ai:status` event
// carries `appId` / `workspacePath`), its beam aims at that building's world position and
// thickens with the call's tokens/sec; ops with no building association keep the generic
// radial fan-out (roadmap 2.1, issue follow-up).

// A radial beam: lies along +X from the apex, rotated about Y to its angle, tilted slightly
// down so it reads as energy arcing out over the city.
function RadialBeam({ angle, length, thickness, color }) {
  const ref = useRef();
  const { position, rotation } = useMemo(() => {
    const tilt = -0.18;
    return {
      position: [Math.cos(angle) * (length / 2), -Math.sin(-tilt) * (length / 2), Math.sin(angle) * (length / 2)],
      rotation: [0, -angle, tilt],
    };
  }, [angle, length]);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    // A pulse travels the beam: opacity breathes out of phase per angle so beams shimmer.
    const t = clock.getElapsedTime() * 3 + angle * 2;
    ref.current.material.opacity = 0.25 + ((Math.sin(t) + 1) / 2) * 0.5;
  });

  return (
    <mesh ref={ref} position={position} rotation={rotation}>
      <boxGeometry args={[length, thickness, thickness]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1} transparent opacity={0.4} toneMapped={false} depthWrite={false} />
    </mesh>
  );
}

// A targeted beam: spans from the apex (group origin) to a building, given the apex-local
// `target` vector. Orientation aligns the box's local +X axis with the apex→building
// direction so a single box stretches cleanly along the line.
function TargetedBeam({ target, thickness, color, seed }) {
  const ref = useRef();
  const { position, quaternion, length } = useMemo(() => {
    const vec = new THREE.Vector3(target[0], target[1], target[2]);
    const len = Math.max(vec.length(), 0.01);
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(1, 0, 0),
      vec.clone().normalize(),
    );
    return { position: vec.multiplyScalar(0.5).toArray(), quaternion: q, length: len };
  }, [target]);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime() * 3 + seed * 2;
    ref.current.material.opacity = 0.3 + ((Math.sin(t) + 1) / 2) * 0.55;
  });

  return (
    <mesh ref={ref} position={position} quaternion={quaternion}>
      <boxGeometry args={[length, thickness, thickness]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1} transparent opacity={0.45} toneMapped={false} depthWrite={false} />
    </mesh>
  );
}

export default function CityAiCore({ aiActivity, positions, apps, settings }) {
  const core = useMemo(
    () => computeAiCore(aiActivity?.ops, aiActivity?.lastStartTs ?? 0),
    [aiActivity],
  );
  const apexRef = useRef();

  const animate = (settings?.particleDensity ?? 1) >= 0.5;
  const { position, height, apexY, color } = core;

  // Per-op beams: targeted at the originating building when known, radial otherwise.
  // While flaring with no live op (a fast call that already cleared) keep one radial pulse.
  const beams = useMemo(() => {
    const computed = computeAiCoreBeams(aiActivity?.ops, positions, apps, apexY, color);
    if (computed.length === 0 && core.flaring) {
      return [{ key: 'flare', targeted: false, angle: 0, length: AI_CORE.radialLength, thickness: AI_CORE.beamThicknessBase, color }];
    }
    return computed;
  }, [aiActivity, positions, apps, apexY, color, core.flaring]);

  useFrame(({ clock }) => {
    if (!animate || !apexRef.current) return;
    // Busy core pulses faster; a flare spikes it; idle breathes slowly.
    const speed = core.busy ? 2.4 : core.flaring ? 3.2 : 0.7;
    const pulse = 0.5 + ((Math.sin(clock.getElapsedTime() * speed) + 1) / 2) * 0.6;
    apexRef.current.material.emissiveIntensity = pulse * (core.intensity + 0.3);
  });

  return (
    <group position={position}>
      {/* Slender spire body — tapered so it reads as a tower, not a column */}
      <mesh position={[0, height / 2, 0]}>
        <cylinderGeometry args={[0.5, 1.4, height, 8]} />
        <meshStandardMaterial color="#0a0f1c" emissive={color} emissiveIntensity={0.1 + core.intensity * 0.15} metalness={0.7} roughness={0.4} />
      </mesh>
      {/* Apex orb — the live AI-activity indicator */}
      <mesh ref={apexRef} position={[0, apexY, 0]}>
        <icosahedronGeometry args={[1.6, 1]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={core.intensity} toneMapped={false} />
      </mesh>
      {/* Activity beams emanate from the apex while AI work is in flight */}
      <group position={[0, apexY, 0]}>
        {beams.map((b, i) => (
          b.targeted
            ? <TargetedBeam key={b.key} target={b.target} thickness={b.thickness} color={b.color} seed={i} />
            : <RadialBeam key={b.key} angle={b.angle} length={b.length} thickness={b.thickness} color={b.color} />
        ))}
      </group>
      {/* Label above the apex */}
      <Text position={[0, apexY + 2.6, 0]} fontSize={1.4} color={color} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={20}>
        AI CORE
      </Text>
      {core.busy && (
        <Text position={[0, apexY + 1.5, 0]} fontSize={0.85} color="#94a3b8" anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={20}>
          {`${core.activeCount} ACTIVE`}
        </Text>
      )}
    </group>
  );
}
