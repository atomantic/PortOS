/**
 * Positioning for the Universe Builder graph canvas: a 2D force simulation
 * plus the two anchored layouts (radial rings by kind, timeline lanes by first
 * appearance) and the viewport fit they share.
 *
 * Separate from `client/src/lib/graphSimulation.js`, which settles the Brain /
 * CoS graphs in 3D for a three.js scene with no anchors, no per-kind collision
 * radius and no screen fit — the two solve different problems and share no
 * parameters. Mutates the node objects in place (`x/y/vx/vy/tx/ty`), the way a
 * force simulation has to; callers own the array.
 */

import { GRAPH_KIND_ORDER, edgeDef, kindDef } from './universeGraphModel.js';

export const GRAPH_LAYOUTS = Object.freeze([
  { id: 'force', label: 'Force' },
  { id: 'radial', label: 'Radial' },
  { id: 'timeline', label: 'Timeline' },
]);

// Timeline lane geometry, in world units.
const TIMELINE_WIDTH = 1300;
const TIMELINE_LANE_HEIGHT = 62;
const TIMELINE_TOP = -310;
// Radial ring radii, indexed by `kindDef(kind).ring`.
const RADIAL_RINGS = [0, 230, 380, 520];

const REPULSION_FORCE = 2600;
const REPULSION_ANCHORED = 500;
// Characters carry a drawn label; give their collision radius room for it so
// two names never sit on top of each other at rest.
const COLLIDE_PAD = 14;
const COLLIDE_PAD_LABELLED = 46;
const DAMPING = 0.85;
const ALPHA_DECAY = 0.985;
const SETTLE_ITERATIONS = 320;
const SETTLE_ALPHA_MIN = 0.004;

export const radiusFor = (node, degree = 0) => kindDef(node.kind).radius + Math.min(9, degree * 0.45);

/**
 * Seed every node onto a phyllotaxis spiral — deterministic, so a reload puts
 * the same universe in the same starting shape instead of a new random one.
 */
export function seedPositions(nodes) {
  nodes.forEach((node, i) => {
    const angle = i * 2.39996;
    const radius = 40 + Math.sqrt(i) * 34;
    node.x = Math.cos(angle) * radius;
    node.y = Math.sin(angle) * radius;
    node.vx = 0;
    node.vy = 0;
    node.tx = null;
    node.ty = null;
  });
  return nodes;
}

/**
 * Assign anchor targets (`tx`/`ty`) for the two non-force layouts. No-op for
 * `force`, which clears them so the springs take over again.
 */
export function applyAnchors(nodes, layout, { totalIssues = 0 } = {}) {
  if (layout === 'force') {
    for (const node of nodes) { node.tx = null; node.ty = null; }
    return nodes;
  }
  if (layout === 'radial') {
    const rings = RADIAL_RINGS.map(() => []);
    for (const node of nodes) rings[kindDef(node.kind).ring].push(node);
    rings.forEach((ring, ri) => {
      ring.sort((a, b) => a.kind.localeCompare(b.kind) || (b.degree || 0) - (a.degree || 0));
      ring.forEach((node, i) => {
        if (ri === 0) {
          // The innermost ring is a disc, not a circle — a cast of 40 on one
          // circle of radius 0 would all land on the same point.
          const r = Math.sqrt(i / Math.max(1, ring.length)) * 130;
          const a = i * 2.39996;
          node.tx = Math.cos(a) * r;
          node.ty = Math.sin(a) * r;
        } else {
          const a = (i / ring.length) * Math.PI * 2 - Math.PI / 2;
          node.tx = Math.cos(a) * RADIAL_RINGS[ri];
          node.ty = Math.sin(a) * RADIAL_RINGS[ri];
        }
      });
    });
    return nodes;
  }
  // timeline: x by first appearance, y by kind lane, with a small fan-out so
  // entries introduced in the same issue don't stack into one dot.
  const span = Math.max(1, totalIssues);
  const perLane = new Map();
  for (const node of nodes) {
    const lane = GRAPH_KIND_ORDER.indexOf(node.kind);
    const key = `${lane}:${node.firstIssue || 0}`;
    const seen = perLane.get(key) || 0;
    perLane.set(key, seen + 1);
    node.tx = ((node.firstIssue || 0) / span) * TIMELINE_WIDTH - TIMELINE_WIDTH / 2
      + (node.kind === 'issue' ? 0 : (seen % 3) * 10);
    node.ty = lane * TIMELINE_LANE_HEIGHT + TIMELINE_TOP + (seen % 4) * 12 - 18;
  }
  return nodes;
}

export const timelineGeometry = Object.freeze({
  width: TIMELINE_WIDTH,
  laneHeight: TIMELINE_LANE_HEIGHT,
  top: TIMELINE_TOP,
});

/**
 * One simulation step. Returns the decayed alpha so the caller can drive the
 * loop (and stop it) without owning the constants.
 */
export function stepLayout(nodes, edges, {
  alpha = 1, layout = 'force', degree, dragId = null, aspect = 1,
} = {}) {
  const anchored = layout !== 'force';
  const repulsion = anchored ? REPULSION_ANCHORED : REPULSION_FORCE;
  const deg = (id) => (degree?.get(id) || 0);
  const radius = (node) => radiusFor(node, deg(node.id));

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const p = nodes[i];
      const q = nodes[j];
      let dx = q.x - p.x;
      let dy = q.y - p.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        // Perfectly coincident nodes have no direction to push along; nudge
        // them apart deterministically by index parity rather than randomly.
        dx = i % 2 ? 0.7 : -0.7;
        dy = j % 2 ? 0.7 : -0.7;
        d2 = 1;
      }
      const d = Math.sqrt(d2);
      const f = (repulsion / d2) * alpha;
      p.vx -= (dx / d) * f; p.vy -= (dy / d) * f;
      q.vx += (dx / d) * f; q.vy += (dy / d) * f;
      const pad = p.kind === 'character' && q.kind === 'character' ? COLLIDE_PAD_LABELLED : COLLIDE_PAD;
      const minD = radius(p) + radius(q) + pad;
      if (d < minD) {
        const push = (minD - d) * 0.5;
        p.x -= (dx / d) * push; p.y -= (dy / d) * push;
        q.x += (dx / d) * push; q.y += (dy / d) * push;
      }
    }
  }

  for (const edge of edges) {
    const group = edgeDef(edge.type).group;
    const ds = Math.max(1, deg(edge.source));
    const dt = Math.max(1, deg(edge.target));
    const rest = (group === 'relationship' ? 90 : group === 'imageref' ? 30 : 70)
      * (1 + 0.18 * Math.sqrt(ds + dt));
    const base = group === 'relationship' ? 0.02
      : group === 'imageref' ? 0.05
        : group === 'attachment' ? 0.012 : 0.004;
    const k = (anchored ? 0.003 : base) / Math.sqrt(Math.min(ds, dt));
    const dx = edge.targetNode.x - edge.sourceNode.x;
    const dy = edge.targetNode.y - edge.sourceNode.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - rest) * k * alpha;
    edge.sourceNode.vx += (dx / d) * f; edge.sourceNode.vy += (dy / d) * f;
    edge.targetNode.vx -= (dx / d) * f; edge.targetNode.vy -= (dy / d) * f;
  }

  for (const node of nodes) {
    if (dragId && node.id === dragId) { node.vx = 0; node.vy = 0; continue; }
    if (anchored && node.tx != null) {
      node.vx += (node.tx - node.x) * 0.06 * alpha;
      node.vy += (node.ty - node.y) * 0.06 * alpha;
    } else {
      node.vx -= node.x * 0.004 * alpha;
      node.vy -= node.y * 0.004 * aspect * alpha;
    }
    node.vx *= DAMPING; node.vy *= DAMPING;
    node.x += node.vx; node.y += node.vy;
  }
  return alpha * ALPHA_DECAY;
}

/**
 * Run the simulation to rest synchronously so the first paint shows a settled
 * graph rather than an expanding blob. Cheap enough at PortOS canon sizes
 * (hundreds of nodes); the animation loop takes over for later interactions.
 */
export function settleLayout(nodes, edges, options = {}) {
  let alpha = 1;
  for (let i = 0; i < SETTLE_ITERATIONS && alpha > SETTLE_ALPHA_MIN; i++) {
    alpha = stepLayout(nodes, edges, { ...options, alpha });
  }
  return nodes;
}

/**
 * Viewport transform that fits every node with padding. Returns the identity-ish
 * fallback when there is nothing to fit, so a caller can apply it unconditionally.
 */
export function computeFit(nodes, { width, height, layout = 'force', pad = 56 } = {}) {
  if (!nodes.length || !width || !height) return { k: 1, x: width / 2 || 0, y: height / 2 || 0 };
  const anchored = layout !== 'force';
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const node of nodes) {
    const px = anchored && node.tx != null ? node.tx : node.x;
    const py = anchored && node.ty != null ? node.ty : node.y;
    x0 = Math.min(x0, px); y0 = Math.min(y0, py);
    x1 = Math.max(x1, px); y1 = Math.max(y1, py);
  }
  if (layout === 'timeline') {
    // Leave room for the lane labels drawn to the left of the first column.
    x0 = Math.min(x0, -TIMELINE_WIDTH / 2 - 160);
    y0 = Math.min(y0, TIMELINE_TOP - 40);
  }
  const k = Math.min(
    6,
    (width - pad * 2) / Math.max(60, x1 - x0),
    (height - pad * 2) / Math.max(60, y1 - y0),
  );
  return { k, x: width / 2 - ((x0 + x1) / 2) * k, y: height / 2 - ((y0 + y1) / 2) * k };
}

export const toScreen = (view, x, y) => [x * view.k + view.x, y * view.k + view.y];
export const toWorld = (view, sx, sy) => [(sx - view.x) / view.k, (sy - view.y) / view.k];

/** Nearest node under a screen point, or null. */
export function hitTest(nodes, view, sx, sy, degree) {
  const [wx, wy] = toWorld(view, sx, sy);
  let best = null;
  let bestD2 = Infinity;
  for (const node of nodes) {
    const r = radiusFor(node, degree?.get(node.id) || 0) + 4 / view.k;
    const dx = node.x - wx;
    const dy = node.y - wy;
    const d2 = dx * dx + dy * dy;
    if (d2 < r * r && d2 < bestD2) { bestD2 = d2; best = node; }
  }
  return best;
}
