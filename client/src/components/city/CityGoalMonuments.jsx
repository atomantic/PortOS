import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text, Line } from '@react-three/drei';
import { PIXEL_FONT_URL } from './cityConstants';
import { computeGoalMonuments, computeGoalForest, MONUMENTS, FOREST } from '../../utils/cityGoalMonuments';

// CyberCity's goal monuments (roadmap 2.7): each life goal is a structure in a
// northeast monument district. Active goals are construction sites — a built base topped
// by a translucent scaffold cage whose fill tracks progress. Completed goals are polished,
// fully-built monuments that shimmer. Stalled (active-but-quiet) and abandoned goals read
// dim. When a goal carries milestones, the tower is segmented into ordered floors so a
// partially-built monument shows WHICH milestones are done (solid floor = complete,
// translucent scaffold rung = pending). When goals form a parent→child hierarchy, the
// district switches to a goal-tree layout: each root goal is a central spire with its
// children clustered in a ring and a link drawn up to the parent apex. Mirrors
// CityBackupVault / CityHealthTower.

// Render the body of a monument: either milestone floors (when the goal has milestones)
// or the plain built/scaffold split. `shimmerRef`/`isShimmer` wires the completed-monument
// pulse onto whichever mesh carries the topmost built portion.
function MonumentBody({ monument, shimmerRef, isShimmer }) {
  const { height, width, color, opacity, intensity, built, completeness, segments } = monument;

  // Milestone floors: one box per milestone, solid+emissive when done, wireframe scaffold
  // when pending. The top floor carries the shimmer — shimmer is only ever assigned to a
  // completed (built) monument, so all its floors render solid and the topmost is the apex.
  if (segments && segments.length > 0) {
    return (
      <>
        {segments.map((seg, i) => {
          const doneFloor = seg.done || built;
          const floorH = Math.max(0.15, seg.segHeight * 0.86); // gap between floors
          const carriesShimmer = isShimmer && i === segments.length - 1;
          return (
            <mesh
              key={seg.id}
              ref={carriesShimmer ? shimmerRef : undefined}
              position={[0, 0.4 + seg.cy, 0]}
            >
              <boxGeometry args={doneFloor ? [width, floorH, width] : [width * 1.05, floorH, width * 1.05]} />
              <meshStandardMaterial
                color={doneFloor ? (built ? '#0d1a12' : '#0c1424') : color}
                emissive={color}
                emissiveIntensity={doneFloor ? intensity : intensity * 0.45}
                metalness={doneFloor ? (built ? 0.7 : 0.4) : 0.2}
                roughness={doneFloor ? (built ? 0.35 : 0.6) : 0.8}
                wireframe={!doneFloor}
                transparent={opacity < 1 || !doneFloor}
                opacity={doneFloor ? opacity : opacity * 0.55}
                toneMapped={false}
              />
            </mesh>
          );
        })}
      </>
    );
  }

  // No milestones: original built-base + scaffold-cap split.
  const builtHeight = Math.max(0.4, height * (built ? 1 : completeness));
  const scaffoldHeight = Math.max(0, height - builtHeight);
  return (
    <>
      <mesh ref={isShimmer ? shimmerRef : undefined} position={[0, 0.4 + builtHeight / 2, 0]}>
        <boxGeometry args={[width, builtHeight, width]} />
        <meshStandardMaterial
          color={built ? '#0d1a12' : '#0c1424'}
          emissive={color}
          emissiveIntensity={intensity}
          metalness={built ? 0.7 : 0.4}
          roughness={built ? 0.35 : 0.6}
          transparent={opacity < 1}
          opacity={opacity}
          toneMapped={false}
        />
      </mesh>
      {scaffoldHeight > 0.3 && (
        <mesh position={[0, 0.4 + builtHeight + scaffoldHeight / 2, 0]}>
          <boxGeometry args={[width * 1.05, scaffoldHeight, width * 1.05]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={intensity * 0.5} wireframe transparent opacity={opacity * 0.6} toneMapped={false} />
        </mesh>
      )}
    </>
  );
}

function Monument({ monument, shimmerRef, isShimmer }) {
  const { height, width, color, opacity, intensity, position, milestoneTotal, milestoneDone, isSpire } = monument;

  return (
    <group position={position}>
      {/* Plinth */}
      <mesh position={[0, 0.2, 0]}>
        <boxGeometry args={[width * 1.4, 0.4, width * 1.4]} />
        <meshStandardMaterial color="#0a0e16" emissive={color} emissiveIntensity={0.1 * intensity + 0.04} metalness={0.6} roughness={0.5} />
      </mesh>

      <MonumentBody monument={monument} shimmerRef={shimmerRef} isShimmer={isShimmer} />

      {/* Title + progress label above the structure */}
      <Text position={[0, height + 1.4, 0]} fontSize={isSpire ? 0.85 : 0.7} color={color} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={9} fillOpacity={opacity}>
        {monument.title}
      </Text>
      <Text position={[0, height + 0.7, 0]} fontSize={0.55} color="#94a3b8" anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={9} fillOpacity={opacity}>
        {monument.built ? 'COMPLETE' : milestoneTotal > 0 ? `${milestoneDone}/${milestoneTotal} STEPS` : `${Math.round(monument.progress)}%`}
      </Text>
    </group>
  );
}

// Goal-tree hierarchy: root spires + child rings + apex links. Used when goals form a
// parent→child structure; otherwise the flat row renders instead. The layout shows two
// visible levels; a child's deeper sub-tree is summarized by a "+N UNDER" badge and roots
// past the cap fold into a "+N MORE GOALS" marker, so nothing is silently dropped.
function GoalForest({ forest, shimmerRef, shimmerId }) {
  return (
    <group>
      {forest.clusters.map((cluster) => (
        <group key={cluster.spire.id}>
          <Monument monument={cluster.spire} shimmerRef={shimmerRef} isShimmer={cluster.spire.id === shimmerId} />
          {cluster.children.map((child) => (
            <group key={child.id}>
              <Monument monument={child} shimmerRef={shimmerRef} isShimmer={child.id === shimmerId} />
              {child.descendantCount > 0 && (
                <Text position={[child.position[0], child.height + 1.9, child.position[2]]} fontSize={0.42} color="#64748b" anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={9}>
                  {`+${child.descendantCount} UNDER`}
                </Text>
              )}
            </group>
          ))}
          {cluster.links.map((link) => (
            <Line
              key={link.childId}
              points={[link.from, link.to]}
              color={cluster.spire.color}
              lineWidth={1.5}
              transparent
              opacity={0.4}
            />
          ))}
          {cluster.childOverflow > 0 && (
            <Text position={[cluster.spire.position[0], cluster.spire.height + 2.1, cluster.spire.position[2]]} fontSize={0.5} color="#94a3b8" anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={9}>
              {`+${cluster.childOverflow} SUB-GOALS`}
            </Text>
          )}
        </group>
      ))}

      {/* Root overflow — top-level goal trees past the cap, mirroring the flat row's marker */}
      {forest.rootOverflow > 0 && forest.clusters.length > 0 && (
        <Text
          position={[
            forest.clusters[forest.clusters.length - 1].spire.position[0] + FOREST.clusterSpacing / 2,
            MONUMENTS.minHeight + 2,
            forest.base[2],
          ]}
          fontSize={0.6}
          color="#94a3b8"
          anchorX="center"
          anchorY="middle"
          font={PIXEL_FONT_URL}
          maxWidth={12}
        >
          {`+${forest.rootOverflow} MORE GOALS`}
        </Text>
      )}
    </group>
  );
}

export default function CityGoalMonuments({ goals, settings }) {
  // The API returns `{ goals: [...] }`; accept either the wrapper or a bare array.
  const list = Array.isArray(goals) ? goals : goals?.goals;
  const district = useMemo(() => computeGoalMonuments(list), [list]);
  const forest = useMemo(() => computeGoalForest(list), [list]);
  const shimmerRef = useRef();

  // Render the hierarchy view when goals actually form a parent→child tree; otherwise the
  // flat row. This keeps a flat goal set looking exactly as before while opting trees into
  // the spire layout automatically.
  const useForest = forest.hasHierarchy;

  // Honor the quality dial: drop the completed-monument shimmer on the lowest preset,
  // but keep the static glow so each goal's status stays legible.
  const animate = (settings?.particleDensity ?? 1) >= 0.5;

  // Pick the first completed monument to carry the shimmer (one per-frame ref mutation).
  // In forest mode, scan spires then children; in row mode, scan the row.
  const shimmer = useMemo(() => {
    if (useForest) {
      for (const cluster of forest.clusters) {
        if (cluster.spire.built) return { id: cluster.spire.id, intensity: cluster.spire.intensity };
        const child = cluster.children.find((c) => c.built);
        if (child) return { id: child.id, intensity: child.intensity };
      }
      return null;
    }
    const m = district.monuments.find((x) => x.built);
    return m ? { id: m.id, intensity: m.intensity } : null;
  }, [useForest, forest.clusters, district.monuments]);

  useFrame(({ clock }) => {
    if (!shimmerRef.current || !shimmer) return;
    if (!animate) {
      // Quality dial dropped below the pulse threshold (or the shimmer target changed):
      // settle the mesh back to its static base glow so it can't freeze mid-pulse at an
      // elevated emissive intensity.
      shimmerRef.current.material.emissiveIntensity = shimmer.intensity;
      return;
    }
    const pulse = (Math.sin(clock.getElapsedTime() * 1.6) + 1) / 2; // 0..1
    shimmerRef.current.material.emissiveIntensity = shimmer.intensity + pulse * 0.5;
  });

  if (!district.hasData) return null;

  const { base, monuments, overflow, total, completedCount } = district;

  return (
    <group>
      {useForest ? (
        <GoalForest forest={forest} shimmerRef={shimmerRef} shimmerId={shimmer?.id} />
      ) : (
        <>
          {monuments.map((monument) => (
            <Monument
              key={monument.id}
              monument={monument}
              shimmerRef={shimmerRef}
              isShimmer={monument.id === shimmer?.id}
            />
          ))}

          {/* Overflow marker — "+N MORE" past the end of the row */}
          {overflow && (
            <group position={overflow.position}>
              <mesh position={[0, MONUMENTS.minHeight / 2, 0]}>
                <boxGeometry args={[MONUMENTS.baseWidth, MONUMENTS.minHeight, MONUMENTS.baseWidth]} />
                <meshStandardMaterial color="#0c1424" emissive="#64748b" emissiveIntensity={0.2} metalness={0.5} roughness={0.6} />
              </mesh>
              <Text position={[0, MONUMENTS.minHeight + 1, 0]} fontSize={0.6} color="#94a3b8" anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={9}>
                {`+${overflow.count} MORE`}
              </Text>
            </group>
          )}
        </>
      )}

      {/* District title behind the row */}
      <Text position={[base[0], 16, base[2] - 3]} fontSize={1.4} color="#22c55e" anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={30}>
        GOALS
      </Text>
      <Text position={[base[0], 15, base[2] - 3]} fontSize={0.8} color="#94a3b8" anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={30}>
        {`${completedCount}/${total} ACHIEVED`}
      </Text>
    </group>
  );
}
