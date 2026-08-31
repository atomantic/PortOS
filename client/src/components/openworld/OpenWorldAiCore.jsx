import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { PIXEL_FONT_URL, openWorldDayMix, mixHex } from './openWorldConstants';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';
import OpenWorldLabel from './OpenWorldLabel';
import { computeAiCore, computeAiCoreBeams, AI_CORE } from '../../utils/openWorldAiCore';

// OpenWorld's AI Core landmark: a low kinetic seed at the center of The Port from
// which all model activity radiates. The suspended orb glows by the active model tier (cyan
// light → blue medium → violet heavy) and brightens with the number of in-flight calls;
// activity beams fan outward from the apex while AI work is happening, and a fast call
// still produces a brief flare. Idle, the core sits a dim slate. Driven by the live
// `ai:status` ops threaded through useOpenWorldData.
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

export default function OpenWorldAiCore({ aiActivity, positions, apps, settings }) {
  const { tintStructure } = useOpenWorldPalette();
  const core = useMemo(
    () => computeAiCore(aiActivity?.ops, aiActivity?.lastStartTs ?? 0),
    [aiActivity],
  );
  const apexRef = useRef();
  const apexGlowRef = useRef();
  const orbitRef = useRef();
  const petalRef = useRef();

  const animate = (settings?.particleDensity ?? 1) >= 0.5;
  const dayMix = openWorldDayMix(settings);
  const { position, apexY, color } = core;
  const orbColor = core.busy ? color : mixHex('#67e8f9', color, 0.28);
  const orbEmissive = (core.busy ? 0.85 : 0.48) + core.intensity * 0.45;
  const orbGlowOpacity = (0.14 + core.intensity * 0.08) * (1 - dayMix * 0.45);
  const baseColor = mixHex(tintStructure('#203b46'), '#8d9078', dayMix);
  const petalColor = mixHex(tintStructure('#365666'), '#b89a6c', dayMix);
  const ringColor = mixHex('#7dd3fc', orbColor, 0.5);

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
    if (orbitRef.current) {
      orbitRef.current.rotation.y = clock.getElapsedTime() * (core.busy ? 0.42 : 0.12);
      orbitRef.current.rotation.z = Math.sin(clock.getElapsedTime() * 0.18) * 0.08;
    }
    if (petalRef.current) {
      petalRef.current.rotation.y = -clock.getElapsedTime() * (core.busy ? 0.12 : 0.025);
    }
  });

  return (
    <group position={position}>
      {/* Terraced plaza: broad enough to be legible from orbit, low enough that it
          never hides the live app boroughs behind a decorative tower. */}
      <mesh position={[0, 0.12, 0]}>
        <cylinderGeometry args={[6.4, 6.8, 0.24, 12]} />
        <meshStandardMaterial color={baseColor} roughness={0.9} metalness={0.08} flatShading />
      </mesh>
      <mesh position={[0, 0.34, 0]}>
        <cylinderGeometry args={[4.8, 5.2, 0.3, 12]} />
        <meshStandardMaterial color={petalColor} roughness={0.78} metalness={0.16} flatShading />
      </mesh>
      <group ref={petalRef}>
        {Array.from({ length: 8 }, (_, index) => {
          const angle = (index / 8) * Math.PI * 2;
          return (
            <mesh
              key={`core-petal-${index}`}
              position={[Math.cos(angle) * 3.5, 0.68, Math.sin(angle) * 3.5]}
              rotation={[0, -angle, (index % 2 ? -1 : 1) * 0.08]}
            >
              <boxGeometry args={[3.6, 0.34, 1.05]} />
              <meshStandardMaterial
                color={petalColor}
                emissive={orbColor}
                emissiveIntensity={core.busy ? 0.24 : 0.06}
                roughness={0.72}
                metalness={0.22}
                flatShading
              />
            </mesh>
          );
        })}
      </group>
      <mesh position={[0, 2.7, 0]}>
        <cylinderGeometry args={[0.34, 0.78, 3.4, 6]} />
        <meshStandardMaterial color={baseColor} emissive={orbColor} emissiveIntensity={0.28} roughness={0.48} metalness={0.35} flatShading />
      </mesh>
      <group ref={orbitRef} position={[0, apexY, 0]}>
        <mesh rotation={[Math.PI / 2, 0.22, 0]}>
          <torusGeometry args={[2.55, 0.07, 6, 32]} />
          <meshBasicMaterial color={ringColor} transparent opacity={0.7} toneMapped={false} />
        </mesh>
        <mesh rotation={[0.42, Math.PI / 2, 0.4]}>
          <torusGeometry args={[2.1, 0.055, 6, 28]} />
          <meshBasicMaterial color={orbColor} transparent opacity={0.52} toneMapped={false} />
        </mesh>
        <mesh rotation={[-0.55, 0.18, Math.PI / 2]}>
          <torusGeometry args={[1.65, 0.045, 6, 24]} />
          <meshBasicMaterial color="#fff1c7" transparent opacity={0.42} toneMapped={false} />
        </mesh>
      </group>
      {/* Suspended seed — the live AI-activity indicator. */}
      <mesh ref={apexRef} position={[0, apexY, 0]}>
        <icosahedronGeometry args={[1.25, 1]} />
        <meshStandardMaterial color={orbColor} emissive={orbColor} emissiveIntensity={orbEmissive} roughness={0.28} metalness={0.15} toneMapped={false} />
      </mesh>
      <mesh ref={apexGlowRef} position={[0, apexY, 0]}>
        <sphereGeometry args={[1.62, 20, 12]} />
        <meshBasicMaterial
          color={orbColor}
          transparent
          opacity={orbGlowOpacity}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <pointLight position={[0, apexY, 0]} color={orbColor} intensity={0.55 + core.intensity * 0.65} distance={18} decay={2} />
      {/* Activity beams emanate from the apex while AI work is in flight */}
      <group position={[0, apexY, 0]}>
        {beams.map((b, i) => (
          b.targeted
            ? <TargetedBeam key={b.key} target={b.target} thickness={b.thickness} color={b.color} seed={i} />
            : <RadialBeam key={b.key} angle={b.angle} length={b.length} thickness={b.thickness} color={b.color} />
        ))}
      </group>
      {/* Label above the apex */}
      <OpenWorldLabel
        position={[0, apexY + 3.2, 0]}
        fontSize={0.72}
        color={orbColor}
        dayMix={dayMix}
        anchorX="center"
        anchorY="middle"
        font={PIXEL_FONT_URL}
        maxWidth={14}
        renderOrder={40}
        material-depthTest={false}
      >
        AI CORE
      </OpenWorldLabel>
      {core.busy && (
        <OpenWorldLabel
          position={[0, apexY + 2.45, 0]}
          fontSize={0.42}
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
        </OpenWorldLabel>
      )}
    </group>
  );
}
