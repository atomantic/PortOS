// 3D force simulation parameters
const REPULSION = 500;
const SPRING_K = 0.008;
const SPRING_REST = 12;
const CENTER_GRAVITY = 0.02;
const DAMPING = 0.9;
const ALPHA_DECAY = 0.995;
const ALPHA_MIN = 0.001;

function tickSim(nodes, edges, alpha) {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const force = REPULSION / (dist * dist);
      const fx = (dx / dist) * force * alpha;
      const fy = (dy / dist) * force * alpha;
      const fz = (dz / dist) * force * alpha;
      a.vx -= fx; a.vy -= fy; a.vz -= fz;
      b.vx += fx; b.vy += fy; b.vz += fz;
    }
  }
  for (const e of edges) {
    const a = e.sourceNode, b = e.targetNode;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const disp = dist - SPRING_REST;
    const force = SPRING_K * disp * alpha;
    const fx = (dx / dist) * force, fy = (dy / dist) * force, fz = (dz / dist) * force;
    a.vx += fx; a.vy += fy; a.vz += fz;
    b.vx -= fx; b.vy -= fy; b.vz -= fz;
  }
  for (const n of nodes) {
    n.vx -= n.x * CENTER_GRAVITY * alpha;
    n.vy -= n.y * CENTER_GRAVITY * alpha;
    n.vz -= n.z * CENTER_GRAVITY * alpha;
    n.vx *= DAMPING; n.vy *= DAMPING; n.vz *= DAMPING;
    n.x += n.vx; n.y += n.vy; n.z += n.vz;
  }
}

const MAX_ITERATIONS = 300;
const LARGE_GRAPH_THRESHOLD = 200;

function settleSimulation(nodes, edges) {
  // Scale iterations down for large graphs to keep the main thread responsive
  const cap = nodes.length > LARGE_GRAPH_THRESHOLD
    ? Math.max(50, Math.round(MAX_ITERATIONS * (LARGE_GRAPH_THRESHOLD / nodes.length)))
    : MAX_ITERATIONS;
  let alpha = 1;
  let iter = 0;
  while (alpha > ALPHA_MIN && iter < cap) {
    tickSim(nodes, edges, alpha);
    alpha *= ALPHA_DECAY;
    iter++;
  }
}

export function buildGraph(rawNodes, rawEdges) {
  const simNodes = rawNodes.map((n, i) => ({
    ...n,
    x: (Math.random() - 0.5) * 60,
    y: (Math.random() - 0.5) * 60,
    z: (Math.random() - 0.5) * 60,
    vx: 0, vy: 0, vz: 0,
    index: i
  }));
  const idMap = new Map(simNodes.map(n => [n.id, n]));
  const simEdges = rawEdges
    .map(e => ({ ...e, sourceNode: idMap.get(e.source), targetNode: idMap.get(e.target) }))
    .filter(e => e.sourceNode && e.targetNode);
  settleSimulation(simNodes, simEdges);
  return { simNodes, simEdges, idMap };
}
