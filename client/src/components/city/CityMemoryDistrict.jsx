import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text, Line } from '@react-three/drei';
import { PIXEL_FONT_URL } from './cityConstants';
import { computeMemoryDistrict, MEMORY_DISTRICT } from '../../utils/cityMemoryDistrict';

// CyberCity's memory / knowledge district (roadmap 3.2): the user's long-term memory graph
// crystallizes into a quiet northwest quarter. Each memory *category* is a cluster of glowing
// octahedral crystals — taller and brighter the more (and more important) the memories — and
// edges that connect different categories arc between clusters as light bridges. A central
// "well" glows with the brain-inbox backlog: brighter and pulsing when captures are waiting to
// be classified, calm when the inbox is clear. Mirrors CityGoalMonuments / CityBackupVault:
// pure helper does all topology, this component only renders + animates.

// One category's crystal cluster: a small ring of octahedra of varying height around the
// cluster center, plus a category label. The tallest crystal carries the cluster's breathing
// glow (one per-frame ref mutation per cluster).
function CrystalCluster({ cluster, glowRef, isGlow }) {
  const { position, color, height, crystals, label, count, isOverflow } = cluster;
  // Arrange the crystals in a tight ring; the count is already capped in the helper.
  const ring = useMemo(() => {
    const out = [];
    for (let i = 0; i < crystals; i++) {
      const a = (i / crystals) * Math.PI * 2;
      const r = crystals === 1 ? 0 : MEMORY_DISTRICT.crystalSpacing;
      // Deterministic per-crystal height falloff so the cluster reads as a faceted shard pile.
      const h = height * (0.55 + 0.45 * Math.abs(Math.cos(a * 1.7 + i)));
      out.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, h, tallest: false });
    }
    if (out.length) {
      // Tag the tallest so the breathing glow lands on a stable crystal.
      let max = 0;
      out.forEach((c, i) => { if (c.h > out[max].h) max = i; });
      out[max].tallest = true;
    }
    return out;
  }, [crystals, height]);

  return (
    <group position={position}>
      {ring.map((c, i) => (
        <mesh
          key={i}
          ref={isGlow && c.tallest ? glowRef : undefined}
          position={[c.x, c.h / 2 + 0.3, c.z]}
        >
          {/* Octahedron reads as a crystal shard */}
          <octahedronGeometry args={[0.5 + c.h * 0.12, 0]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={isOverflow ? 0.4 : 0.7}
            metalness={0.3}
            roughness={0.15}
            transparent
            opacity={isOverflow ? 0.55 : 0.9}
            toneMapped={false}
          />
        </mesh>
      ))}
      <Text position={[0, height + 1.3, 0]} fontSize={0.6} color={color} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={9}>
        {label}
      </Text>
      <Text position={[0, height + 0.7, 0]} fontSize={0.42} color="#94a3b8" anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={9}>
        {count}
      </Text>
    </group>
  );
}

export default function CityMemoryDistrict({ memoryGraph, inboxDepth = 0, settings }) {
  const district = useMemo(() => computeMemoryDistrict(memoryGraph), [memoryGraph]);
  const glowRef = useRef();
  const wellRef = useRef();

  const animate = (settings?.particleDensity ?? 1) >= 0.5;

  // The brightest (most important) cluster carries the breathing glow.
  const glowCategory = useMemo(() => {
    let best = null;
    for (const c of district.clusters) {
      if (!c.isOverflow && (!best || c.importance > best.importance)) best = c;
    }
    return best?.category ?? null;
  }, [district.clusters]);

  // Inbox well: glows brighter and pulses faster the deeper the unclassified backlog.
  const inboxActive = inboxDepth > 0;
  const wellColor = inboxActive ? '#06b6d4' : '#1e3a5f';

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (animate && glowRef.current) {
      const pulse = (Math.sin(t * 1.4) + 1) / 2;
      glowRef.current.material.emissiveIntensity = 0.7 + pulse * 0.6;
    }
    if (wellRef.current) {
      const base = inboxActive ? 0.6 + Math.min(inboxDepth, 10) * 0.06 : 0.25;
      const speed = inboxActive ? 2.5 + Math.min(inboxDepth, 10) * 0.2 : 0.7;
      const pulse = animate ? (Math.sin(t * speed) + 1) / 2 : 0.5;
      wellRef.current.material.emissiveIntensity = base + pulse * (inboxActive ? 0.7 : 0.15);
    }
  });

  if (district.empty) return null;

  const { base, clusters, bridges, totalMemories } = district;

  return (
    <group>
      {clusters.map((cluster) => (
        <CrystalCluster
          key={cluster.category}
          cluster={cluster}
          glowRef={glowRef}
          isGlow={cluster.category === glowCategory}
        />
      ))}

      {/* Light bridges between connected categories — thicker/brighter the stronger the link */}
      {bridges.map((bridge, i) => {
        const from = [bridge.fromPos[0], MEMORY_DISTRICT.bridgeY, bridge.fromPos[2]];
        const to = [bridge.toPos[0], MEMORY_DISTRICT.bridgeY, bridge.toPos[2]];
        // Arc the midpoint up so bridges read as light arcs, not flat lines.
        const mid = [(from[0] + to[0]) / 2, MEMORY_DISTRICT.bridgeY + 2 + Math.min(bridge.weight, 6) * 0.3, (from[2] + to[2]) / 2];
        return (
          <Line
            key={i}
            points={[from, mid, to]}
            color="#67e8f9"
            lineWidth={Math.min(1 + bridge.weight * 0.5, 4)}
            transparent
            opacity={Math.min(0.25 + bridge.weight * 0.12, 0.8)}
          />
        );
      })}

      {/* Brain-inbox well at the district center: a glowing ring whose intensity tracks backlog */}
      <group position={base}>
        <mesh ref={wellRef} position={[0, 0.1, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.4, 2.4, 32]} />
          <meshStandardMaterial color={wellColor} emissive={wellColor} emissiveIntensity={0.4} side={2} toneMapped={false} transparent opacity={0.85} />
        </mesh>
        {inboxActive && (
          <Text position={[0, 1.2, 0]} fontSize={0.5} color="#06b6d4" anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={9}>
            {`${inboxDepth} TO SORT`}
          </Text>
        )}
      </group>

      {/* District title */}
      <Text position={[base[0], 14, base[2] - 3]} fontSize={1.3} color="#8b5cf6" anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={30}>
        MEMORY
      </Text>
      <Text position={[base[0], 13, base[2] - 3]} fontSize={0.75} color="#94a3b8" anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={30}>
        {`${totalMemories} MEMORIES`}
      </Text>
    </group>
  );
}
