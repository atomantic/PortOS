import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CITY_COLORS } from './cityConstants';

// Orbital ring line geometry
function OrbitalRing({ radius, tilt, color, opacity = 0.15, nightFactorRef }) {
  const points = useMemo(() => {
    const pts = [];
    const segments = 128;
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      pts.push(new THREE.Vector3(
        Math.cos(angle) * radius,
        0,
        Math.sin(angle) * radius
      ));
    }
    return pts;
  }, [radius]);

  const geometry = useMemo(() => new THREE.BufferGeometry().setFromPoints(points), [points]);
  const matRef = useRef();

  useFrame(() => {
    if (matRef.current) {
      matRef.current.opacity = opacity * nightFactorRef.current;
    }
  });

  return (
    <group rotation={[tilt, 0, 0]}>
      <line geometry={geometry}>
        <lineBasicMaterial ref={matRef} color={color} transparent opacity={opacity} />
      </line>
    </group>
  );
}

// Small moon/asteroid sphere
function Moon({ position, size = 0.4, color = '#64748b', nightFactorRef }) {
  const ref = useRef();

  useFrame(({ clock }) => {
    if (!ref.current) return;
    ref.current.rotation.y = clock.getElapsedTime() * 0.2;
    ref.current.material.opacity = nightFactorRef.current;
  });

  return (
    <mesh ref={ref} position={position}>
      <sphereGeometry args={[size, 12, 12]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.1}
        roughness={0.8}
        transparent
        opacity={1}
      />
    </mesh>
  );
}

export default function CityCelestial({ settings }) {
  const planetRef = useRef();
  const ringGroupRef = useRef();
  const ringMatRef = useRef();
  const nightFactorRef = useRef(1);

  const timeOfDay = settings?.timeOfDay ?? 'sunset';
  const preset = CITY_COLORS.timeOfDay[timeOfDay] ?? CITY_COLORS.timeOfDay.sunset;
  const targetDaylight = preset.daylightFactor ?? 0;

  useFrame(({ clock }, delta) => {
    const t = clock.getElapsedTime();
    const lf = Math.min(1, delta * 3);

    // Lerp night factor
    const targetNight = 1 - targetDaylight;
    nightFactorRef.current += (targetNight - nightFactorRef.current) * lf;
    const nf = nightFactorRef.current;

    if (planetRef.current) {
      planetRef.current.rotation.y = t * 0.05;
      planetRef.current.material.opacity = nf;
    }
    if (ringGroupRef.current) {
      ringGroupRef.current.rotation.y = t * 0.01;
    }
    if (ringMatRef.current) {
      ringMatRef.current.opacity = 0.2 * nf;
    }
  });

  return (
    <group position={[-25, 35, -40]}>
      {/* Planet */}
      <mesh ref={planetRef}>
        <sphereGeometry args={[3, 32, 32]} />
        <meshStandardMaterial
          color={CITY_COLORS.planet}
          emissive={CITY_COLORS.planet}
          emissiveIntensity={0.2}
          roughness={0.6}
          transparent
          opacity={1}
        />
      </mesh>

      {/* Planet ring */}
      <group ref={ringGroupRef} rotation={[0.4, 0.2, 0]}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[4.2, 5.5, 64]} />
          <meshBasicMaterial
            ref={ringMatRef}
            color={CITY_COLORS.planet}
            transparent
            opacity={0.2}
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>

      {/* Orbital paths */}
      <OrbitalRing radius={12} tilt={0.3} color={CITY_COLORS.orbit} opacity={0.1} nightFactorRef={nightFactorRef} />
      <OrbitalRing radius={18} tilt={0.5} color={CITY_COLORS.orbit} opacity={0.07} nightFactorRef={nightFactorRef} />

      {/* Moons */}
      <Moon position={[10, 2, -3]} size={0.5} color="#64748b" nightFactorRef={nightFactorRef} />
      <Moon position={[-14, -1, 8]} size={0.35} color="#475569" nightFactorRef={nightFactorRef} />
    </group>
  );
}
