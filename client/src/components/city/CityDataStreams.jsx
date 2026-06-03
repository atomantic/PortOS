import { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { computeFlowConnections } from '../../utils/cityFlowLines';

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

  // Dispose the connection-line geometry's GPU buffers when the endpoints change
  // (topology shifts as buildings go on/offline) or on unmount.
  useEffect(() => () => trailGeom.dispose(), [trailGeom]);

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

export default function CityDataStreams({ positions, apps, agentMap }) {
  // Derive the real operational state the flow topology is built from: which
  // buildings are online (flow sources) and which currently have running agents
  // (hot links). The pure helper turns that into the connection set so this
  // component stays presentation-only.
  const connections = useMemo(() => {
    const activeIds = new Set(
      (apps || []).filter(a => !a.archived && a.overallStatus === 'online').map(a => a.id)
    );
    const agentIds = new Set();
    agentMap?.forEach((entry, id) => {
      if (entry?.agents?.length) agentIds.add(id);
    });
    return computeFlowConnections({ positions, activeIds, agentIds });
  }, [positions, apps, agentMap]);

  if (connections.length === 0) return null;

  return (
    <group>
      {connections.map((conn) => (
        <group key={conn.key}>
          {/* Packets travel both directions; a hotter link carries more of them. */}
          {Array.from({ length: conn.packets }).map((_, k) => (
            <DataPacket
              key={`fwd-${k}`}
              start={conn.start}
              end={conn.end}
              color={conn.color}
              speed={conn.speed}
              offset={k / conn.packets}
            />
          ))}
          {Array.from({ length: conn.packets }).map((_, k) => (
            <DataPacket
              key={`rev-${k}`}
              start={conn.end}
              end={conn.start}
              color={conn.color}
              speed={conn.speed}
              offset={k / conn.packets + 0.5}
            />
          ))}
        </group>
      ))}
    </group>
  );
}
