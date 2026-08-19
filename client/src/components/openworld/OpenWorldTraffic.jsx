import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { computeDistrictBounds } from '../../utils/openWorldMiniMap';
import { mixHex } from './openWorldConstants';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';

// A single ambient vehicle. Vibes keeps traffic on the road; cyber keeps the original hover lanes.
function HoverVehicle({ path, color, speed, offset, altitude, lowPoly, surface }) {
  const groupRef = useRef();
  const lightRef = useRef();
  const bodyRef = useRef();

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
    const y = lowPoly
      ? 0.02 + Math.sin(t * Math.PI * 2) * 0.025
      : altitude + Math.sin(t * Math.PI * 2) * 0.15;

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
        {/* Vehicle body — grounded in Vibes, airborne in the cyber style. */}
        <mesh position={lowPoly ? [0, 0.3, 0] : [0, 0, 0]}>
          <boxGeometry args={lowPoly ? [0.72, 0.24, 0.34] : [0.4, 0.08, 0.15]} />
          {lowPoly ? (
            <meshStandardMaterial {...surface} color={mixHex(color, '#f2c28e', 0.28)} roughness={0.74} metalness={0.08} />
          ) : (
            <meshBasicMaterial color={color} transparent opacity={0.6} />
          )}
        </mesh>
        {/* Cockpit windshield */}
        <mesh position={[lowPoly ? 0.1 : 0.12, lowPoly ? 0.48 : 0.05, 0]}>
          <boxGeometry args={lowPoly ? [0.3, 0.13, 0.25] : [0.12, 0.04, 0.12]} />
          {lowPoly ? (
            <meshStandardMaterial {...surface} color="#27384a" roughness={0.28} metalness={0.24} />
          ) : (
            <meshBasicMaterial color="#ffffff" transparent opacity={0.3} />
          )}
        </mesh>
        {lowPoly && (
          <>
            <mesh position={[-0.38, 0.34, 0]}>
              <boxGeometry args={[0.035, 0.08, 0.22]} />
              <meshBasicMaterial color="#ef6b61" toneMapped={false} />
            </mesh>
            {[-1, 1].map((side) => (
              <mesh key={`headlight-${side}`} position={[0.38, 0.32, side * 0.1]}>
                <boxGeometry args={[0.035, 0.07, 0.07]} />
                <meshBasicMaterial color="#fff1c9" toneMapped={false} />
              </mesh>
            ))}
            {[-1, 1].map((side) => (
              <group key={`wheel-${side}`} position={[0, 0.15, side * 0.2]}>
                <mesh rotation={[Math.PI / 2, 0, 0]}>
                  <cylinderGeometry args={[0.13, 0.13, 0.08, 10]} />
                  <meshStandardMaterial color="#1b2633" roughness={0.9} metalness={0.05} />
                </mesh>
              </group>
            ))}
          </>
        )}
        {/* Engine glow at rear — cyber traffic keeps its luminous signature. */}
        {!lowPoly && (
          <>
            <mesh position={[-0.22, 0, 0]}>
              <sphereGeometry args={[0.04, 6, 6]} />
              <meshBasicMaterial color={color} transparent opacity={0.9} />
            </mesh>
            <pointLight ref={lightRef} position={[-0.22, 0, 0]} color={color} intensity={0.3} distance={3} decay={2} />
          </>
        )}
      </group>
    </group>
  );
}

export default function OpenWorldTraffic({ positions }) {
  const { neonAccents, lowPoly, surface } = useOpenWorldPalette();
  // Generate traffic lanes based on building layout
  const vehicles = useMemo(() => {
    if (!positions || positions.size < 2) return [];

    const bounds = computeDistrictBounds(positions, 'downtown', { minCount: 2 });
    if (!bounds) return [];
    const { minX, maxX, minZ, maxZ } = bounds;

    const pad = 3;
    const colors = neonAccents;
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
    const downtownCount = [...positions.values()].filter((pos) => pos.district === 'downtown').length;
    const vehicleCount = Math.min(5, Math.max(3, downtownCount));
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
    if (downtownCount >= 3) {
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
  }, [positions, neonAccents]);

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
          lowPoly={lowPoly}
          surface={surface}
        />
      ))}
    </group>
  );
}
