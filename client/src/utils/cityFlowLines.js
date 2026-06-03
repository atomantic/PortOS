// Pure, deterministic helpers for CyberCity's inter-building "flow lines": which
// active buildings connect to each other, and how intense each stream is. The
// topology is derived from real operational state — a building is a flow source
// only when it's online, and a link runs "hot" when either endpoint has a
// running agent — rather than the previous random nearest-neighbor decoration.
// No three.js / React imports here so the topology can be unit-tested in
// isolation (mirrors the cityTimeline.js / cityAgentMotion.js helper pattern).

import { hashString } from './hashString';

export const FLOW = {
  maxNeighbors: 2, // connect each active building to up to N nearest active neighbors
  hotColor: '#22d3ee', // links touching a building with a running agent (work in flight)
  idleColor: '#3b82f6', // links between plain-online buildings (steady-state traffic)
  basePackets: 1, // packets travelling each direction on a steady link
  hotPackets: 2, // packets each direction when an endpoint has a running agent
  baseSpeed: 0.12, // packet speed on a steady link (fraction of the path per second)
  hotSpeedBonus: 0.06, // extra speed on a hot link — work-in-flight reads as faster traffic
};

// Build the flow-line connection set between ACTIVE downtown buildings.
//   positions  — Map<id, { x, z, district }> from the city layout
//   activeIds  — Set<id> of buildings that are online (flow sources/sinks)
//   agentIds   — Set<id> of buildings that currently have >=1 running agent
// Returns deterministic descriptors: { key, start:[x,y,z], end:[x,y,z], color,
// hot, packets, speed }. `hot`/color/packets/speed encode the link's intensity
// (color = type, packets+speed = volume) so the renderer stays presentation-only.
export function computeFlowConnections({ positions, activeIds, agentIds, maxNeighbors = FLOW.maxNeighbors } = {}) {
  if (!positions || !activeIds || activeIds.size < 2) return [];

  const entries = [];
  positions.forEach((pos, id) => {
    if (pos.district === 'downtown' && activeIds.has(id)) {
      entries.push({ id, x: pos.x, z: pos.z });
    }
  });
  if (entries.length < 2) return [];

  const conns = [];
  const seen = new Set();

  for (let i = 0; i < entries.length; i++) {
    const a = entries[i];
    const neighbors = [];
    for (let j = 0; j < entries.length; j++) {
      if (i === j) continue;
      const b = entries[j];
      const dist = (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
      neighbors.push({ id: b.id, x: b.x, z: b.z, dist });
    }
    neighbors.sort((m, n) => m.dist - n.dist);

    const take = Math.min(maxNeighbors, neighbors.length);
    for (let n = 0; n < take; n++) {
      const b = neighbors[n];
      const key = [a.id, b.id].sort().join('→');
      if (seen.has(key)) continue;
      seen.add(key);

      const hot = agentIds?.has(a.id) || agentIds?.has(b.id) || false;
      const variation = (hashString(key) % 100) / 100; // 0..1, deterministic per link
      conns.push({
        key,
        start: [a.x, 0.5, a.z],
        end: [b.x, 0.5, b.z],
        color: hot ? FLOW.hotColor : FLOW.idleColor,
        hot,
        packets: hot ? FLOW.hotPackets : FLOW.basePackets,
        speed: FLOW.baseSpeed + (hot ? FLOW.hotSpeedBonus : 0) + variation * 0.05,
      });
    }
  }

  return conns;
}
