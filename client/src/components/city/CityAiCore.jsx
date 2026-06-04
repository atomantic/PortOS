import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { PIXEL_FONT_URL, cityDayMix, mixHex, tintStructure } from './cityConstants';
import CityLabel from './CityLabel';
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

function SpireLightRings({ height, color, dayMix }) {
  const rings = useMemo(() => {
    const count = Math.max(7, Math.floor(height / 1.6));
    return Array.from({ length: count }, (_, i) => {
      const ratio = (i + 1) / (count + 1);
      return {
        key: `ring-${i}`,
        y: ratio * height,
        radius: 1.4 + (0.5 - 1.4) * ratio + 0.04,
        opacity: (i === count - 1 ? 0.58 : 0.28 + (i % 3) * 0.08) * (1 - dayMix * 0.7),
      };
    });
  }, [dayMix, height]);

  return (
    <group>
      {rings.map((ring) => (
        <mesh key={ring.key} position={[0, ring.y, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[ring.radius, 0.025, 6, 8]} />
          <meshBasicMaterial color={mixHex('#f8fbff', color, 0.36)} transparent opacity={ring.opacity} toneMapped={false} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

export default function CityAiCore({ aiActivity, positions, apps, settings }) {
  const core = useMemo(
    () => computeAiCore(aiActivity?.ops, aiActivity?.lastStartTs ?? 0),
    [aiActivity],
  );
  const apexRef = useRef();
  const apexGlowRef = useRef();

  const animate = (settings?.particleDensity ?? 1) >= 0.5;
  const dayMix = cityDayMix(settings);
  const { position, height, apexY, color } = core;
  const orbColor = core.busy ? color : mixHex('#67e8f9', color, 0.28);
  const orbEmissive = (core.busy ? 0.85 : 0.48) + core.intensity * 0.45;
  const orbGlowOpacity = (0.14 + core.intensity * 0.08) * (1 - dayMix * 0.45);
  const nightSpireBase = mixHex(tintStructure('#2a416c'), color, 0.24);
  const daySpireBase = mixHex('#707988', color, 0.1);
  const spireBodyColor = mixHex(nightSpireBase, daySpireBase, dayMix);
  const spireEdgeOpacity = 0.24 + (1 - dayMix) * 0.28;
  const spireGlowColor = mixHex('#7dd3fc', orbColor, 0.5);

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
    apexRef.current.material.emissiveIntensity = orbEmissive + pulse * (core.busy ? 0.35 : 0.16);
    if (apexGlowRef.current) {
      apexGlowRef.current.material.opacity = orbGlowOpacity + pulse * 0.04;
      const scale = 1 + pulse * 0.04;
      apexGlowRef.current.scale.setScalar(scale);
    }
  });

  return (
    <group position={position}>
      {/* Slender spire body — tapered so it reads as a tower, not a column */}
      <mesh position={[0, height / 2, 0]}>
        <cylinderGeometry args={[0.5, 1.4, height, 8]} />
        <meshStandardMaterial
          color={spireBodyColor}
          emissive={spireGlowColor}
          emissiveIntensity={0.55 + core.intensity * 0.35}
          metalness={0.45}
          roughness={0.46}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[0, height / 2, 0]}>
        <cylinderGeometry args={[0.52, 1.43, height + 0.04, 8]} />
        <meshBasicMaterial
          color={color}
          wireframe
          transparent
          opacity={spireEdgeOpacity}
          toneMapped={false}
          depthWrite={false}
        />
      </mesh>
      <SpireLightRings height={height} color={color} dayMix={dayMix} />
      {/* Apex orb — the live AI-activity indicator */}
      <mesh ref={apexRef} position={[0, apexY, 0]}>
        <icosahedronGeometry args={[1.6, 1]} />
        <meshStandardMaterial color={orbColor} emissive={orbColor} emissiveIntensity={orbEmissive} roughness={0.28} metalness={0.15} toneMapped={false} />
      </mesh>
      <mesh ref={apexGlowRef} position={[0, apexY, 0]}>
        <sphereGeometry args={[1.95, 24, 16]} />
        <meshBasicMaterial
          color={orbColor}
          transparent
          opacity={orbGlowOpacity}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <pointLight position={[0, apexY, 0]} color={orbColor} intensity={0.85 + core.intensity * 0.8} distance={22} decay={2} />
      {/* Activity beams emanate from the apex while AI work is in flight */}
      <group position={[0, apexY, 0]}>
        {beams.map((b, i) => (
          b.targeted
            ? <TargetedBeam key={b.key} target={b.target} thickness={b.thickness} color={b.color} seed={i} />
            : <RadialBeam key={b.key} angle={b.angle} length={b.length} thickness={b.thickness} color={b.color} />
        ))}
      </group>
      {/* Label above the apex */}
      <CityLabel
        position={[0, apexY + 4.25, 0]}
        fontSize={1.15}
        color={orbColor}
        dayMix={dayMix}
        anchorX="center"
        anchorY="middle"
        font={PIXEL_FONT_URL}
        maxWidth={20}
        renderOrder={40}
        material-depthTest={false}
      >
        AI CORE
      </CityLabel>
      {core.busy && (
        <CityLabel
          position={[0, apexY + 3.15, 0]}
          fontSize={0.75}
          color="#94a3b8"
          dayMix={dayMix}
          anchorX="center"
          anchorY="middle"
          font={PIXEL_FONT_URL}
          maxWidth={20}
          renderOrder={40}
          material-depthTest={false}
        >
          {`${core.activeCount} ACTIVE`}
        </CityLabel>
      )}
    </group>
  );
}
