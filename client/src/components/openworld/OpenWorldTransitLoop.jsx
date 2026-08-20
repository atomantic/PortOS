import { useMemo, useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { openWorldDayMix, openWorldShowDetail, mixHex } from './openWorldConstants';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';
import { TRANSIT } from '../../utils/openWorldPlan';

// The elevated transit loop from the master plan: a closed glowing track linking every
// quarter, with a few trams orbiting it — the city's "alive" motion layer. Native
// TubeGeometry along a closed CatmullRom curve (never drei <Line>); support pylons drop
// at each district stop. Trams hide on the low preset; the track itself is one mesh.

const TRAM_SIZE = [0.9, 0.5, 0.42];

export default function OpenWorldTransitLoop({ settings }) {
  const { accent, tintStructure, lowPoly, surface } = useOpenWorldPalette();
  const dayMix = openWorldDayMix(settings);
  const showTrams = openWorldShowDetail(settings);

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

  const trackColor = lowPoly
    ? mixHex('#4e7c7f', '#e1c28d', dayMix)
    : mixHex(accent, '#8b9bb0', dayMix);
  const trackOpacity = lowPoly
    ? 0.46 * (1 - dayMix) + 0.62 * dayMix
    : 0.5 * (1 - dayMix) + 0.3 * dayMix;
  const pylonColor = lowPoly ? mixHex('#38545a', '#6d887c', dayMix) : tintStructure('#121a2c');

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
            <meshStandardMaterial {...surface} color={pylonColor} roughness={0.7} metalness={lowPoly ? 0 : 0.4} />
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
            {...surface}
            color={lowPoly ? mixHex('#d57b67', accent, 0.2) : tintStructure('#1a2440')}
            emissive={accent}
            emissiveIntensity={0.5 * (1 - dayMix) + 0.15 * dayMix}
            metalness={lowPoly ? 0.05 : 0.5}
            roughness={lowPoly ? 0.85 : 0.3}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  );
}
