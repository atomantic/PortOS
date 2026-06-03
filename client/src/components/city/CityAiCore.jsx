import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import { PIXEL_FONT_URL } from './cityConstants';
import { computeAiCore } from '../../utils/cityAiCore';

// CyberCity's AI Core landmark (roadmap 2.1): a slender central spire above downtown from
// which all model activity radiates. The apex orb glows by the active model tier (cyan
// light → blue medium → violet heavy) and brightens with the number of in-flight calls;
// activity beams fan outward from the apex while AI work is happening, and a fast call
// still produces a brief flare. Idle, the core sits a dim slate. Driven by the live
// `ai:status` op count threaded through useCityData.
//
// `ai:status` carries no originating-building association, so beams radiate at fixed
// angles rather than targeting a specific building (see issue follow-up).
function Beam({ angle, length, apexY, color }) {
  const ref = useRef();
  const { position, rotation } = useMemo(() => {
    // A beam lies along +X then is rotated about Y to its angle; tilt slightly downward
    // so it reads as energy arcing out over the city rather than a flat ray.
    const tilt = -0.18;
    return {
      position: [Math.cos(angle) * (length / 2), apexY - Math.sin(-tilt) * (length / 2), Math.sin(angle) * (length / 2)],
      rotation: [0, -angle, tilt],
    };
  }, [angle, length, apexY]);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    // A pulse travels the beam: opacity breathes out of phase per angle so the beams
    // shimmer rather than blink in unison.
    const t = clock.getElapsedTime() * 3 + angle * 2;
    ref.current.material.opacity = 0.25 + ((Math.sin(t) + 1) / 2) * 0.5;
  });

  return (
    <mesh ref={ref} position={position} rotation={rotation}>
      <boxGeometry args={[length, 0.18, 0.18]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1} transparent opacity={0.4} toneMapped={false} depthWrite={false} />
    </mesh>
  );
}

export default function CityAiCore({ aiActivity, settings }) {
  const core = useMemo(
    () => computeAiCore(aiActivity?.ops, aiActivity?.lastStartTs ?? 0),
    [aiActivity],
  );
  const apexRef = useRef();

  const animate = (settings?.particleDensity ?? 1) >= 0.5;

  // Even angular spread for however many beams are active right now.
  const beams = useMemo(() => {
    const out = [];
    for (let i = 0; i < core.beamCount; i++) {
      out.push({ angle: (i / Math.max(core.beamCount, 1)) * Math.PI * 2, key: i });
    }
    return out;
  }, [core.beamCount]);

  useFrame(({ clock }) => {
    if (!animate || !apexRef.current) return;
    // Busy core pulses faster; a flare spikes it; idle breathes slowly.
    const speed = core.busy ? 2.4 : core.flaring ? 3.2 : 0.7;
    const pulse = 0.5 + ((Math.sin(clock.getElapsedTime() * speed) + 1) / 2) * 0.6;
    apexRef.current.material.emissiveIntensity = pulse * (core.intensity + 0.3);
  });

  const { position, height, apexY, color } = core;
  const beamLength = 16;

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
      {/* Activity beams fan out from the apex while AI work is in flight */}
      <group position={[0, apexY, 0]}>
        {beams.map(b => (
          <Beam key={b.key} angle={b.angle} length={beamLength} apexY={0} color={color} />
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
