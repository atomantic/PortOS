import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { PIXEL_FONT_URL, openWorldDayMix } from './openWorldConstants';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';
import OpenWorldLabel from './OpenWorldLabel';
import { computeTaskQueue, TASK_QUEUE } from '../../utils/openWorldTaskQueue';

// OpenWorld's CoS task-queue silhouette (roadmap 2.2): a warehouse east of downtown with
// a stack of crates whose height tracks the depth of the Chief-of-Staff task backlog.
// Crates pile up as tasks queue and clear as they complete; the warehouse roof light
// glows green while an agent is working a task and amber when a task is blocked. An
// overflow cap keeps a runaway backlog from scraping the sky — a marker crate signals
// "more waiting" instead.
function Crate({ y, size, color, topGlow }) {
  return (
    <mesh position={[0, y, 0]}>
      <boxGeometry args={[size, size, size]} />
      <meshStandardMaterial
        color="#13202e"
        emissive={color}
        emissiveIntensity={topGlow ? 0.5 : 0.18}
        metalness={0.3}
        roughness={0.7}
      />
    </mesh>
  );
}

export default function OpenWorldTaskQueue({ cosTasks, settings }) {
  const { tintStructure } = useOpenWorldPalette();
  const queue = useMemo(() => computeTaskQueue(cosTasks), [cosTasks]);
  const roofRef = useRef();

  // Honor the quality dial: drop the roof-light pulse on the lowest preset, but keep the
  // static glow so the queue state stays legible.
  const animate = (settings?.particleDensity ?? 1) >= 0.5;
  const dayMix = openWorldDayMix(settings);

  useFrame(({ clock }) => {
    if (!animate || !roofRef.current) return;
    // Blocked queues throb urgently; an active queue breathes; idle/queued sits calm.
    const speed = queue.hasBlocked ? 2.6 : queue.active ? 1.4 : 0.6;
    const base = queue.state === 'idle' ? 0.25 : 0.6;
    roofRef.current.material.emissiveIntensity = base + ((Math.sin(clock.getElapsedTime() * speed) + 1) / 2) * 0.6;
  });

  const { position, color, crates, overflow, pending, inProgress, blocked } = queue;
  const { crateSize, warehouseWidth } = TASK_QUEUE;
  // Where the overflow marker (and label) sits: just above the visible crate stack.
  const stackTop = crates.length ? crates[crates.length - 1].y + crateSize : crateSize;

  const sublabel = blocked > 0
    ? `${blocked} BLOCKED · ${pending} QUEUED`
    : inProgress > 0
      ? `${inProgress} ACTIVE · ${pending} QUEUED`
      : pending > 0
        ? `${pending} QUEUED`
        : 'IDLE';

  return (
    <group position={position}>
      {/* Queueworks is an open hexagonal maker dais, not another opaque warehouse. */}
      <mesh position={[0, 0.32, 0]}>
        <cylinderGeometry args={[warehouseWidth * 0.62, warehouseWidth * 0.76, 0.64, 8]} />
        <meshStandardMaterial color={tintStructure('#27373c')} emissive={color} emissiveIntensity={0.16} metalness={0.12} roughness={0.84} flatShading />
      </mesh>
      {/* Roof light bar — the live queue-state indicator */}
      <mesh ref={roofRef} position={[0, 0.7, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[warehouseWidth * 0.44, 0.12, 8, 8]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.6} toneMapped={false} />
      </mesh>

      {/* Crate stack rises from the dock roof; height ∝ pending backlog */}
      <group position={[0, 0.8, 0]}>
        {crates.map((crate, i) => (
          <Crate
            key={crate.index}
            y={crate.y}
            size={crateSize}
            color={color}
            topGlow={i === crates.length - 1}
          />
        ))}
        {/* Overflow marker — a half-height capstone meaning "more waiting than shown" */}
        {overflow && (
          <mesh position={[0, stackTop + crateSize * 0.4, 0]}>
            <boxGeometry args={[crateSize * 0.6, crateSize * 0.5, crateSize * 0.6]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.7} toneMapped={false} />
          </mesh>
        )}

        {/* Label + count sublabel above the stack */}
        <OpenWorldLabel position={[0, stackTop + crateSize * (overflow ? 1.05 : 0.78), 0]} fontSize={0.58} color={color} dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={20}>
          QUEUEWORKS
        </OpenWorldLabel>
        <OpenWorldLabel position={[0, stackTop + crateSize * (overflow ? 0.62 : 0.32), 0]} fontSize={0.36} color="#94a3b8" dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={20}>
          {sublabel}
        </OpenWorldLabel>
      </group>
    </group>
  );
}
