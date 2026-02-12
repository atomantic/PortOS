import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CITY_COLORS, BUILDING_PARAMS } from './cityConstants';

// Animated road with flowing light pulses
function RoadSegment({ start, end, color, offset = 0 }) {
  const lineRef = useRef();
  const pulseRef = useRef();

  const length = useMemo(() => {
    return Math.sqrt((end[0] - start[0]) ** 2 + (end[2] - start[2]) ** 2);
  }, [start, end]);

  const midX = (start[0] + end[0]) / 2;
  const midZ = (start[2] + end[2]) / 2;
  const angle = Math.atan2(end[2] - start[2], end[0] - start[0]);

  useFrame(({ clock }) => {
    if (!pulseRef.current) return;
    const t = ((clock.getElapsedTime() * 0.3 + offset) % 1.0);

    // Animate pulse position along the road
    pulseRef.current.position.set(
      start[0] + (end[0] - start[0]) * t,
      0.03,
      start[2] + (end[2] - start[2]) * t
    );

    pulseRef.current.material.opacity = 0.3 + Math.sin(t * Math.PI) * 0.4;
  });

  return (
    <group>
      {/* Road surface - dark strip */}
      <mesh
        position={[midX, 0.005, midZ]}
        rotation={[-Math.PI / 2, 0, angle]}
      >
        <planeGeometry args={[length, 0.6]} />
        <meshBasicMaterial color="#0a0a1a" transparent opacity={0.6} side={THREE.DoubleSide} />
      </mesh>

      {/* Road edge lines */}
      <mesh
        position={[midX, 0.01, midZ + Math.cos(angle) * 0.3]}
        rotation={[-Math.PI / 2, 0, angle]}
      >
        <planeGeometry args={[length, 0.02]} />
        <meshBasicMaterial color={color} transparent opacity={0.3} side={THREE.DoubleSide} />
      </mesh>
      <mesh
        position={[midX, 0.01, midZ - Math.cos(angle) * 0.3]}
        rotation={[-Math.PI / 2, 0, angle]}
      >
        <planeGeometry args={[length, 0.02]} />
        <meshBasicMaterial color={color} transparent opacity={0.3} side={THREE.DoubleSide} />
      </mesh>

      {/* Animated light pulse traveling along road */}
      <mesh ref={pulseRef} rotation={[-Math.PI / 2, 0, angle]}>
        <circleGeometry args={[0.12, 8]} />
        <meshBasicMaterial color={color} transparent opacity={0.5} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

export default function CityRoads({ positions }) {
  const roads = useMemo(() => {
    if (!positions || positions.size < 2) return [];

    const entries = [];
    positions.forEach((pos) => {
      if (pos.district === 'downtown') entries.push(pos);
    });

    if (entries.length < 2) return [];

    const result = [];
    const spacing = BUILDING_PARAMS.spacing;
    const roadOffset = BUILDING_PARAMS.width / 2 + 0.5;

    // Find unique rows and columns
    const rows = [...new Set(entries.map(e => Math.round(e.z * 10) / 10))].sort((a, b) => a - b);
    const cols = [...new Set(entries.map(e => Math.round(e.x * 10) / 10))].sort((a, b) => a - b);

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    entries.forEach(p => {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    });

    const pad = spacing / 2 + 1.5;

    // Horizontal roads between rows
    rows.forEach((z, i) => {
      result.push({
        id: `h-${i}`,
        start: [minX - pad, 0, z + roadOffset],
        end: [maxX + pad, 0, z + roadOffset],
        color: CITY_COLORS.neonAccents[i % CITY_COLORS.neonAccents.length],
        offset: i * 0.3,
      });
    });

    // Vertical roads between columns
    cols.forEach((x, i) => {
      result.push({
        id: `v-${i}`,
        start: [x + roadOffset, 0, minZ - pad],
        end: [x + roadOffset, 0, maxZ + pad],
        color: CITY_COLORS.neonAccents[(i + 3) % CITY_COLORS.neonAccents.length],
        offset: i * 0.25,
      });
    });

    return result;
  }, [positions]);

  if (roads.length === 0) return null;

  return (
    <group>
      {roads.map(road => (
        <RoadSegment
          key={road.id}
          start={road.start}
          end={road.end}
          color={road.color}
          offset={road.offset}
        />
      ))}
    </group>
  );
}
