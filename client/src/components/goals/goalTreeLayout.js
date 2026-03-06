// Tiered radial layout: lifetime/north-star goals at center, shorter horizons in outer rings
// Sub-goals cluster near their parents

// Deterministic pseudo-random based on goal id (seeded hash)
function seededRandom(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(31, h) + seed.charCodeAt(i) | 0;
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 13), 0x45d9f3b);
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
  };
}

const HORIZON_RING = {
  'lifetime': 0,
  '20-year': 1,
  '10-year': 2,
  '5-year': 3,
  '3-year': 4,
  '1-year': 5
};

const RING_RADIUS = 8;
const Y_SPREAD = 4;

export function layoutGoalNodes(flatGoals) {
  if (!flatGoals?.length) return { nodes: [], edges: [] };

  const goalMap = new Map(flatGoals.map(g => [g.id, g]));

  // Group by ring tier
  const rings = {};
  for (const goal of flatGoals) {
    const ring = HORIZON_RING[goal.horizon] ?? 3;
    if (!rings[ring]) rings[ring] = [];
    rings[ring].push(goal);
  }

  const positioned = new Map();

  // Position nodes ring by ring (sorted so parents at inner rings are positioned first)
  for (const [ringStr, goals] of Object.entries(rings).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const ring = Number(ringStr);
    const radius = ring * RING_RADIUS;
    const count = goals.length;

    goals.forEach((goal, i) => {
      const rng = seededRandom(goal.id);
      const angle = (2 * Math.PI * i) / Math.max(count, 1);
      // If goal has parent that's already positioned, cluster near it
      const parent = goal.parentId ? positioned.get(goal.parentId) : null;
      let x, y, z;

      if (parent && radius > 0) {
        // Offset relative to parent position with a local radius
        const localRadius = RING_RADIUS;
        const parentAngle = Math.atan2(parent.z, parent.x);
        const spread = Math.PI / (count + 2);
        const childAngle = parentAngle + (i - count / 2) * spread;
        x = parent.x + Math.cos(childAngle) * localRadius;
        z = parent.z + Math.sin(childAngle) * localRadius;
        y = parent.y + (rng() - 0.5) * Y_SPREAD;
      } else if (radius === 0) {
        // Center ring - small spread
        x = (rng() - 0.5) * 3;
        z = (rng() - 0.5) * 3;
        y = (rng() - 0.5) * Y_SPREAD;
      } else {
        x = Math.cos(angle) * radius;
        z = Math.sin(angle) * radius;
        y = (rng() - 0.5) * Y_SPREAD;
      }

      positioned.set(goal.id, {
        ...goal,
        x, y, z,
        vx: 0, vy: 0, vz: 0
      });
    });
  }

  const nodes = Array.from(positioned.values());

  // Build edges: parent-child (solid) and tag-based cross-links (dotted)
  const edges = [];

  // Parent-child edges
  for (const goal of flatGoals) {
    if (goal.parentId && positioned.has(goal.parentId)) {
      edges.push({
        source: goal.parentId,
        target: goal.id,
        type: 'parent',
        sourceNode: positioned.get(goal.parentId),
        targetNode: positioned.get(goal.id)
      });
    }
  }

  // Tag cross-link edges (goals sharing tags)
  const tagMap = {};
  for (const goal of flatGoals) {
    for (const tag of (goal.tags || [])) {
      if (!tagMap[tag]) tagMap[tag] = [];
      tagMap[tag].push(goal.id);
    }
  }
  // Star topology: connect each goal to the first goal in the tag group (hub)
  const seenTagEdges = new Set();
  for (const ids of Object.values(tagMap)) {
    if (ids.length < 2) continue;
    const hub = ids[0];
    for (let i = 1; i < ids.length; i++) {
      const spoke = ids[i];
      const key = [hub, spoke].sort().join(':');
      if (seenTagEdges.has(key)) continue;
      seenTagEdges.add(key);
      // Don't add tag edge if parent-child edge already exists
      const a = goalMap.get(hub), b = goalMap.get(spoke);
      if (a?.parentId === spoke || b?.parentId === hub) continue;
      if (positioned.has(hub) && positioned.has(spoke)) {
        edges.push({
          source: hub,
          target: spoke,
          type: 'tag',
          sourceNode: positioned.get(hub),
          targetNode: positioned.get(spoke)
        });
      }
    }
  }

  return { nodes, edges, idMap: positioned };
}
