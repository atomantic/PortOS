import { useMemo, useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { PIXEL_FONT_URL, cityDayMix, tintStructure } from './cityConstants';
import CityLabel from './CityLabel';
import { computeFederationHorizon, FEDERATION } from '../../utils/cityFederation';

// The sync link reaching inward from a peer toward the city. Solid + bright when
// the peer is actively syncing, dashed when the link is broken (offline / failing),
// faint when idle.
function FederationBridge({ from, color, broken, intensity }) {
  const lineRef = useRef();

  // `from` is the peer's ground position; the bridge stretches inward toward the
  // city center so it reads as a link reaching home.
  const geometry = useMemo(() => {
    const dir = new THREE.Vector3(-from[0], 0, -from[2]);
    if (dir.lengthSq() > 0) dir.normalize();
    const start = new THREE.Vector3(from[0] + dir.x * 1.5, 0.6, from[2] + dir.z * 1.5);
    const end = new THREE.Vector3(
      from[0] + dir.x * (1.5 + FEDERATION.bridgeReach),
      0.6,
      from[2] + dir.z * (1.5 + FEDERATION.bridgeReach),
    );
    return new THREE.BufferGeometry().setFromPoints([start, end]);
  }, [from]);

  // computeLineDistances lives on the Line OBJECT, not on BufferGeometry — calling it on the
  // geometry throws ("computeLineDistances is not a function") and crashes the whole canvas. The
  // dashed (broken) material needs per-vertex line distances, so compute them on the line ref
  // after it mounts / whenever the geometry or broken state changes.
  useEffect(() => {
    if (broken) lineRef.current?.computeLineDistances();
  }, [geometry, broken]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <line ref={lineRef} geometry={geometry}>
      {broken ? (
        <lineDashedMaterial color={color} transparent opacity={0.15 + intensity * 0.25} dashSize={1.1} gapSize={0.9} />
      ) : (
        <lineBasicMaterial color={color} transparent opacity={0.2 + intensity * 0.4} />
      )}
    </line>
  );
}

// A distant peer (or the void marker) rendered as a neon-trimmed silhouette.
function Monolith({ position, width, height, color, opacity, label, sublabel, online, animate, dayMix = 0 }) {
  const capRef = useRef();

  useFrame(({ clock }) => {
    if (!animate || !online || !capRef.current) return;
    const pulse = 0.6 + ((Math.sin(clock.getElapsedTime() * 1.2 + position[0]) + 1) / 2) * 0.6;
    capRef.current.material.emissiveIntensity = pulse;
  });

  return (
    <group position={position}>
      {/* Dark body with a faint neon glow scaled by reachability */}
      <mesh position={[0, height / 2, 0]}>
        <boxGeometry args={[width, height, width * 0.4]} />
        <meshStandardMaterial
          color={tintStructure('#0a0a18')}
          emissive={color}
          emissiveIntensity={opacity}
          transparent
          opacity={Math.min(0.9, 0.4 + opacity)}
          depthWrite={false}
        />
      </mesh>
      {/* Bright neon cap at the top edge */}
      <mesh ref={capRef} position={[0, height + 0.3, 0]}>
        <boxGeometry args={[width * 1.05, 0.6, width * 0.45]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={online ? 0.9 : 0.4} transparent opacity={Math.min(1, opacity + 0.4)} depthWrite={false} />
      </mesh>
      {label && (
        <CityLabel position={[0, height + 2.2, 0]} fontSize={1.6} color={color} dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={20}>
          {label}
        </CityLabel>
      )}
      {sublabel && (
        <CityLabel position={[0, height + 0.9, 0]} fontSize={1.0} color="#94a3b8" dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={20}>
          {sublabel}
        </CityLabel>
      )}
    </group>
  );
}

export default function CityFederationHorizon({ instances, settings }) {
  const { peers, voidMarker } = useMemo(
    () => computeFederationHorizon(instances?.peers),
    [instances],
  );

  // The horizon is a handful of distant static meshes, but honor the quality
  // dial: drop the gentle peer pulse on the lowest preset.
  const animate = (settings?.particleDensity ?? 1) >= 0.5;
  const dayMix = cityDayMix(settings);

  return (
    <group>
      {peers.map(peer => (
        <group key={peer.id}>
          <Monolith
            position={peer.position}
            width={peer.width}
            height={peer.height}
            color={peer.color}
            opacity={peer.opacity}
            label={peer.name}
            sublabel={peer.online ? 'LINKED' : peer.status.toUpperCase()}
            online={peer.online}
            animate={animate}
            dayMix={dayMix}
          />
          <FederationBridge from={peer.position} color={peer.color} broken={peer.bridge.broken} intensity={peer.bridge.intensity} />
        </group>
      ))}
      {/* Void machine — always present so the federation horizon never goes empty */}
      <Monolith
        position={voidMarker.position}
        width={voidMarker.width}
        height={voidMarker.height}
        color={voidMarker.color}
        opacity={voidMarker.opacity}
        label="VOID"
        sublabel="PRIMARY"
        online={false}
        animate={false}
        dayMix={dayMix}
      />
    </group>
  );
}
