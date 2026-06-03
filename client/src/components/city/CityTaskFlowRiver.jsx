import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { computeTaskQueue } from '../../utils/cityTaskQueue';
import { computeTaskFlowRiver, recentCalendarThroughput } from '../../utils/cityTaskFlowRiver';

// CyberCity task-flow river (issue #817): an animated channel running from the task-queue
// warehouse to the productivity district, tying queued work to completed throughput. The
// channel WIDTH tracks the live backlog (more pending/in-progress/blocked work → broader) and
// the flow SPEED tracks recent throughput / queue drain. Flow nodes travel warehouse→monument
// along the channel; they animate only on the higher quality presets, while the channel bed
// itself stays drawn so the link between the two districts is always legible. Mirrors
// CityProductivityDistrict / CityTaskQueue.
export default function CityTaskFlowRiver({ cosTasks, productivityData, calendarData, settings }) {
  const river = useMemo(() => {
    const queue = computeTaskQueue(cosTasks);
    // Recent throughput drives the current speed. Prefer today's completed count from the
    // quick-summary (the freshest "draining now" signal); fall back to a bounded last-7-days
    // total from the calendar so the river still flows before today's count is meaningful.
    // Using the calendar's full 12-week total would pin the river at max speed forever, so we
    // deliberately window it. Optional chaining tolerates missing/non-object payloads, and
    // computeTaskFlowRiver reads a non-number as zero.
    const todayCompleted = productivityData?.today?.completed;
    const throughput = typeof todayCompleted === 'number'
      ? todayCompleted
      : recentCalendarThroughput(calendarData, 7);
    return computeTaskFlowRiver(queue, throughput);
  }, [cosTasks, productivityData, calendarData]);

  const nodesRef = useRef();

  // Honor the quality dial: drop the traveling flow nodes on the lowest preset; the channel
  // bed remains so the districts stay visually linked.
  const animate = (settings?.particleDensity ?? 1) >= 0.5;

  useFrame(({ clock }) => {
    if (!animate || !nodesRef.current || !river.flowing) return;
    const t = clock.getElapsedTime();
    const half = river.length / 2;
    for (const node of nodesRef.current.children) {
      const phase = node.userData.phase || 0;
      // Flow runs warehouse(-half) → monument(+half) along the channel's local +x. Wrap with
      // a fractional cycle so nodes stream continuously; speed scales with throughput.
      const frac = (phase + t * river.speed * 0.12) % 1;
      node.position.x = -half + frac * river.length;
    }
  });

  const { center, angle, length, width, color, particles } = river;

  return (
    // Center the channel between the two districts and rotate it to align local +x with the
    // warehouse→monument axis. A slight lift keeps the bed from z-fighting the ground plane.
    <group position={[center[0], 0.06, center[2]]} rotation={[0, angle, 0]}>
      {/* Channel bed — a flat ribbon laid on the ground along the district axis */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[length, width]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.12 + river.speedLevel * 0.18}
          transparent
          opacity={0.32}
          metalness={0.2}
          roughness={0.7}
          toneMapped={false}
        />
      </mesh>

      {/* Traveling flow nodes — only when there's a live current to depict; on the lowest
          preset (animation off) or an idle/not-draining channel the bed alone stays drawn so
          static glowing boxes never imply movement that isn't happening. */}
      {animate && river.flowing && (
      <group ref={nodesRef}>
        {particles.map((p) => (
          <mesh
            key={p.index}
            position={[-length / 2 + p.phase * length, 0.18, 0]}
            userData={{ phase: p.phase }}
          >
            <boxGeometry args={[width * 0.5, 0.22, Math.min(width * 0.7, 1.4)]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={0.6 + river.speedLevel * 0.6}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>
      )}
    </group>
  );
}
