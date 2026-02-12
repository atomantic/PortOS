import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CITY_COLORS } from './cityConstants';

// A single flying hover vehicle
function HoverVehicle({ path, color, speed, offset, altitude }) {
  const groupRef = useRef();
  const lightRef = useRef();
  const bodyRef = useRef();

  const pathLength = useMemo(() => {
    let len = 0;
    for (let i = 1; i < path.length; i++) {
      len += Math.sqrt(
        (path[i][0] - path[i-1][0]) ** 2 +
        (path[i][2] - path[i-1][2]) ** 2
      );
    }
    return len;
  }, [path]);

  useFrame(({ clock }) => {
    if (!groupRef.current || path.length < 2) return;
    const t = ((clock.getElapsedTime() * speed + offset) % 1.0);

    // Interpolate along path
    const totalT = t * (path.length - 1);
    const segIdx = Math.min(Math.floor(totalT), path.length - 2);
    const segT = totalT - segIdx;

    const ax = path[segIdx][0];
    const az = path[segIdx][2];
    const bx = path[segIdx + 1][0];
    const bz = path[segIdx + 1][2];

    const x = ax + (bx - ax) * segT;
    const z = az + (bz - az) * segT;
    const y = altitude + Math.sin(t * Math.PI * 2) * 0.15;

    groupRef.current.position.set(x, y, z);

    // Face direction of travel
    const angle = Math.atan2(bz - az, bx - ax);
    groupRef.current.rotation.y = -angle;

    // Tail light flicker
    if (lightRef.current) {
      lightRef.current.intensity = 0.3 + Math.sin(clock.getElapsedTime() * 12 + offset * 10) * 0.15;
    }

    // Subtle tilt into turns
    if (bodyRef.current) {
      const tilt = Math.sin(t * Math.PI * 4) * 0.1;
      bodyRef.current.rotation.z = tilt;
    }
  });

  return (
    <group ref={groupRef}>
      <group ref={bodyRef}>
        {/* Vehicle body - elongated box */}
        <mesh>
          <boxGeometry args={[0.4, 0.08, 0.15]} />
          <meshBasicMaterial color={color} transparent opacity={0.6} />
        </mesh>
        {/* Cockpit windshield */}
        <mesh position={[0.12, 0.05, 0]}>
          <boxGeometry args={[0.12, 0.04, 0.12]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.3} />
        </mesh>
        {/* Engine glow at rear */}
        <mesh position={[-0.22, 0, 0]}>
          <sphereGeometry args={[0.04, 6, 6]} />
          <meshBasicMaterial color={color} transparent opacity={0.9} />
        </mesh>
        {/* Tail light */}
        <pointLight ref={lightRef} position={[-0.22, 0, 0]} color={color} intensity={0.3} distance={3} decay={2} />
      </group>
    </group>
  );
}

export default function CityTraffic({ positions }) {
  // Generate traffic lanes based on building layout
  const vehicles = useMemo(() => {
    if (!positions || positions.size < 2) return [];

    const entries = [];
    positions.forEach((pos) => {
      if (pos.district === 'downtown') entries.push(pos);
    });

    if (entries.length < 2) return [];

    // Find bounding box of downtown
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    entries.forEach(p => {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    });

    const pad = 3;
    const colors = CITY_COLORS.neonAccents;
    const result = [];

    // Create traffic lanes around the perimeter
    const perimeter = [
      [minX - pad, 0, minZ - pad],
      [maxX + pad, 0, minZ - pad],
      [maxX + pad, 0, maxZ + pad],
      [minX - pad, 0, maxZ + pad],
      [minX - pad, 0, minZ - pad],
    ];

    // Perimeter vehicles (3-5 hover cars circling the downtown)
    const vehicleCount = Math.min(5, Math.max(3, entries.length));
    for (let i = 0; i < vehicleCount; i++) {
      result.push({
        id: `perim-${i}`,
        path: perimeter,
        color: colors[i % colors.length],
        speed: 0.04 + i * 0.008,
        offset: i / vehicleCount,
        altitude: 1.5 + i * 0.6,
      });
    }

    // Cross-city lanes (a few vehicles going through the center)
    if (entries.length >= 3) {
      // Horizontal lane
      result.push({
        id: 'cross-h',
        path: [
          [minX - pad - 5, 0, 0],
          [maxX + pad + 5, 0, 0],
        ],
        color: colors[5 % colors.length],
        speed: 0.06,
        offset: 0.3,
        altitude: 3.0,
      });
      // Diagonal lane
      result.push({
        id: 'cross-d',
        path: [
          [minX - pad - 3, 0, maxZ + pad + 3],
          [maxX + pad + 3, 0, minZ - pad - 3],
        ],
        color: colors[6 % colors.length],
        speed: 0.05,
        offset: 0.7,
        altitude: 4.0,
      });
    }

    return result;
  }, [positions]);

  if (vehicles.length === 0) return null;

  return (
    <group>
      {vehicles.map(v => (
        <HoverVehicle
          key={v.id}
          path={v.path}
          color={v.color}
          speed={v.speed}
          offset={v.offset}
          altitude={v.altitude}
        />
      ))}
    </group>
  );
}
