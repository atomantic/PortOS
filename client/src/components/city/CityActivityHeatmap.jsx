import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { computeActivityHeatmap } from '../../utils/cityActivityHeatmap';

// CyberCity productivity-district activity heatmap (issue #817): a GitHub-style contribution
// grid laid out as a field of thin ground tiles framing the streak monument. Each tile is one
// day; its glow scales with that day's completed-task count relative to the busiest day in the
// window. Today's tile reads accent-blue. Active tiles breathe on the highest quality presets;
// the static glow keeps the field legible when the pulse is dropped. Data comes from the
// activity calendar (`GET /api/cos/productivity/calendar`). Mirrors CityProductivityDistrict.
export default function CityActivityHeatmap({ calendarData, settings }) {
  const heatmap = useMemo(() => computeActivityHeatmap(calendarData), [calendarData]);
  const groupRef = useRef();

  // Honor the quality dial: drop the per-tile shimmer on the lowest preset, keep the static
  // glow so the contribution field stays readable.
  const animate = (settings?.particleDensity ?? 1) >= 0.5;

  useFrame(({ clock }) => {
    if (!animate || !groupRef.current) return;
    // A gentle traveling wave across the field so active tiles shimmer like data flowing in.
    const t = clock.getElapsedTime();
    for (const tile of groupRef.current.children) {
      const base = tile.userData.baseIntensity;
      if (!base) continue;
      const phase = tile.userData.phase || 0;
      const wave = 0.85 + ((Math.sin(t * 1.4 + phase * 6.283) + 1) / 2) * 0.3;
      tile.material.emissiveIntensity = base * wave;
    }
  });

  if (!heatmap.present) return null;

  const { origin, tileSize, tileHeight, tiles } = heatmap;

  return (
    <group position={origin}>
      <group ref={groupRef}>
        {tiles.map((tile) => (
          <mesh
            key={tile.key}
            position={[tile.x, tileHeight / 2, tile.z]}
            userData={{ baseIntensity: tile.tasks > 0 ? tile.intensity : 0, phase: tile.phase }}
          >
            <boxGeometry args={[tileSize, tileHeight, tileSize]} />
            <meshStandardMaterial
              color={tile.color}
              emissive={tile.color}
              emissiveIntensity={tile.intensity}
              metalness={0.3}
              roughness={0.6}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>
    </group>
  );
}
