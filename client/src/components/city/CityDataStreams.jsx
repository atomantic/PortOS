import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CITY_COLORS } from './cityConstants';

// A single animated data packet traveling along a path
function DataPacket({ start, end, color, speed, offset, size = 0.08 }) {
  const meshRef = useRef();
  const trailRef = useRef();

  const direction = useMemo(() => {
    const dir = new THREE.Vector3(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
    return dir;
  }, [start, end]);

  const trailGeom = useMemo(() => {
    const curve = new THREE.LineCurve3(
      new THREE.Vector3(start[0], start[1], start[2]),
      new THREE.Vector3(end[0], end[1], end[2])
    );
    return new THREE.BufferGeometry().setFromPoints(curve.getPoints(20));
  }, [start, end]);

  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    const t = ((clock.getElapsedTime() * speed + offset) % 1.0);

    meshRef.current.position.set(
      start[0] + direction.x * t,
      start[1] + direction.y * t + Math.sin(t * Math.PI) * 0.5,
      start[2] + direction.z * t
    );

    // Pulse the packet
    const pulse = 0.6 + Math.sin(clock.getElapsedTime() * 8) * 0.4;
    meshRef.current.material.opacity = pulse * (t > 0.05 && t < 0.95 ? 1 : 0);

    // Trail opacity pulse
    if (trailRef.current) {
      trailRef.current.material.opacity = 0.08 + Math.sin(clock.getElapsedTime() * 2 + offset) * 0.04;
    }
  });

  return (
    <>
      {/* Faint connection line */}
      <line geometry={trailGeom} ref={trailRef}>
        <lineBasicMaterial color={color} transparent opacity={0.08} />
      </line>
      {/* Flying data packet */}
      <mesh ref={meshRef}>
        <sphereGeometry args={[size, 6, 6]} />
        <meshBasicMaterial color={color} transparent opacity={0.8} />
      </mesh>
    </>
  );
}

export default function CityDataStreams({ positions }) {
  // Build connections between nearby active buildings
  const connections = useMemo(() => {
    if (!positions || positions.size < 2) return [];

    const entries = [];
    positions.forEach((pos, id) => {
      if (pos.district === 'downtown') entries.push({ id, ...pos });
    });

    const conns = [];
    const colors = CITY_COLORS.neonAccents;

    // Connect each building to its nearest 1-2 neighbors
    for (let i = 0; i < entries.length; i++) {
      const a = entries[i];
      const distances = [];

      for (let j = 0; j < entries.length; j++) {
        if (i === j) continue;
        const b = entries[j];
        const dist = Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
        distances.push({ index: j, dist });
      }

      distances.sort((d1, d2) => d1.dist - d2.dist);
      const neighborCount = Math.min(1, distances.length);

      for (let n = 0; n < neighborCount; n++) {
        const b = entries[distances[n].index];
        // Avoid duplicate connections
        const key = [a.id, b.id].sort().join('-');
        if (!conns.find(c => c.key === key)) {
          conns.push({
            key,
            start: [a.x, 0.5, a.z],
            end: [b.x, 0.5, b.z],
            color: colors[(i + n) % colors.length],
          });
        }
      }
    }

    return conns;
  }, [positions]);

  if (connections.length === 0) return null;

  return (
    <group>
      {connections.map((conn) => (
        <group key={conn.key}>
          {/* Two packets going each direction at different speeds */}
          <DataPacket
            start={conn.start}
            end={conn.end}
            color={conn.color}
            speed={0.15 + Math.random() * 0.1}
            offset={0}
          />
          <DataPacket
            start={conn.end}
            end={conn.start}
            color={conn.color}
            speed={0.12 + Math.random() * 0.1}
            offset={0.5}
          />
        </group>
      ))}
    </group>
  );
}
