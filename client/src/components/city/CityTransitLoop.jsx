import { useMemo, useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { cityDayMix, cityShowDetail, mixHex } from './cityConstants';
import { useCityPalette } from './CityPaletteContext';
import { TRANSIT } from '../../utils/cityPlan';

// The elevated transit loop from the master plan: a closed glowing track linking every
// quarter, with a few trams orbiting it — the city's "alive" motion layer. Native
// TubeGeometry along a closed CatmullRom curve (never drei <Line>); support pylons drop
// at each district stop. Trams hide on the low preset; the track itself is one mesh.

const TRAM_SIZE = [0.9, 0.5, 0.42];

export default function CityTransitLoop({ settings }) {
  const { accent, tintStructure } = useCityPalette();
  const dayMix = cityDayMix(settings);
  const showTrams = cityShowDetail(settings);

  const curve = useMemo(() => {
    const points = TRANSIT.stops.map((s) => new THREE.Vector3(...s.point));
    const c = new THREE.CatmullRomCurve3(points, true, 'centripetal');
    return c;
  }, []);

  const trackGeom = useMemo(() => new THREE.TubeGeometry(curve, 220, 0.1, 6, true), [curve]);
  useEffect(() => () => trackGeom.dispose(), [trackGeom]);

  const tramRefs = useRef([]);
  tramRefs.current = [];
  const lookAhead = useRef(new THREE.Vector3());

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime() * TRANSIT.tramSpeed;
    tramRefs.current.forEach((tram, i) => {
      if (!tram) return;
      const u = (t + i / TRANSIT.tramCount) % 1;
      curve.getPointAt(u, tram.position);
      curve.getPointAt((u + 0.005) % 1, lookAhead.current);
      tram.lookAt(lookAhead.current);
    });
  });

  const trackColor = mixHex(accent, '#8b9bb0', dayMix);
  const trackOpacity = 0.5 * (1 - dayMix) + 0.3 * dayMix;

  return (
    <group>
      <mesh geometry={trackGeom}>
        <meshBasicMaterial color={trackColor} transparent opacity={trackOpacity} toneMapped={false} />
      </mesh>

      {/* Support pylon + station halo at every stop */}
      {TRANSIT.stops.map((stop) => (
        <group key={stop.id} position={[stop.point[0], 0, stop.point[2]]}>
          <mesh position={[0, TRANSIT.y / 2, 0]}>
            <cylinderGeometry args={[0.12, 0.2, TRANSIT.y, 6]} />
            <meshStandardMaterial color={tintStructure('#121a2c')} roughness={0.7} metalness={0.4} />
          </mesh>
          <mesh position={[0, TRANSIT.y - 0.35, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.55, 0.05, 6, 20]} />
            <meshBasicMaterial color={trackColor} transparent opacity={trackOpacity + 0.15} toneMapped={false} />
          </mesh>
        </group>
      ))}

      {showTrams && Array.from({ length: TRANSIT.tramCount }, (_, i) => (
        <mesh key={i} ref={(el) => { if (el) tramRefs.current[i] = el; }}>
          <boxGeometry args={TRAM_SIZE} />
          <meshStandardMaterial
            color={tintStructure('#1a2440')}
            emissive={accent}
            emissiveIntensity={0.5 * (1 - dayMix) + 0.15 * dayMix}
            metalness={0.5}
            roughness={0.3}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  );
}
