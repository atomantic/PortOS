/**
 * FableLoom graph layout — pure helpers that place an episode's scene nodes on
 * the editor canvas and route its transition edges.
 *
 * Default positions come from BFS layering (columns = depth from the opening
 * scene, rows = order within a layer; unreachable nodes trail in extra
 * columns), then a barycenter pass reorders each layer toward its parents so
 * forward edges cross as little as possible. A node the author dragged carries
 * a persisted `pos` override that always wins. Layering here is a VIEW
 * concern, deliberately not a mirror of the server's `computeGraphLayers`
 * (which omits unreachable nodes — the canvas must show them so the author can
 * fix them); the server's analysis remains authoritative for
 * reachability/depth stats.
 *
 * Edge routing is direction-aware, because a branching narrative is a CYCLIC
 * graph: "go back to the cell" edges point left, and drawing those the same
 * right-edge → left-edge way as a forward edge sweeps a giant S across every
 * card between them. Backward (and same-column) edges instead drop into a
 * packed return lane below the card band, and every label is nudged out of its
 * neighbours' way — see `routeLoomEdges`.
 */

export const LOOM_NODE_W = 200;
export const LOOM_NODE_H = 112;
const COL_GAP = 96;
const ROW_GAP = 40;
const MARGIN = 24;
// Return lanes for backward edges: the first sits this far under the deepest
// card, each further lane LANE_GAP below it. Lanes are packed (see
// `assignLane`), so a graph with many short back-edges stays shallow.
const LANE_OFFSET = 32;
const LANE_GAP = 22;
const LANE_PAD = 10;
/** Longest intent text drawn on an edge before it is ellipsized. */
export const LOOM_EDGE_LABEL_MAX = 24;
// Label collision geometry. The canvas draws labels at 10px, whose average
// advance is ~5.2px — enough to bucket overlaps without measuring text.
const LABEL_CHAR_W = 5.2;
const LABEL_ROW_H = 12;
const LABEL_MAX_NUDGE_ROWS = 6;

const asArray = (v) => (Array.isArray(v) ? v : []);

/** BFS layers from the start node, ordered to reduce edge crossings. */
export function loomGraphLayers(episode) {
  const nodes = asArray(episode?.nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const layers = [];
  const seen = new Set();
  if (byId.has(episode?.startNodeId)) {
    let frontier = [episode.startNodeId];
    seen.add(episode.startNodeId);
    while (frontier.length) {
      layers.push(frontier);
      const next = [];
      for (const id of frontier) {
        for (const tr of asArray(byId.get(id)?.transitions)) {
          if (byId.has(tr?.targetNodeId) && !seen.has(tr.targetNodeId)) {
            seen.add(tr.targetNodeId);
            next.push(tr.targetNodeId);
          }
        }
      }
      frontier = next;
    }
  }
  // Unreachable nodes trail in chunked extra columns so they stay visible.
  const orphans = nodes.filter((n) => !seen.has(n.id)).map((n) => n.id);
  for (let i = 0; i < orphans.length; i += 4) {
    layers.push(orphans.slice(i, i + 4));
  }
  return orderLayersByBarycenter(layers, byId);
}

/**
 * Reorder each layer by the mean row of its parents in the layer before it
 * (the standard barycenter heuristic). Nodes with no parent in the previous
 * layer keep their BFS slot, and equal barycenters keep BFS order, so the
 * result is deterministic. One downward pass: enough to untangle the common
 * "two parents fan into shared children" shape without the cost (or the
 * position churn) of iterating to a fixed point.
 */
function orderLayersByBarycenter(layers, byId) {
  for (let col = 1; col < layers.length; col += 1) {
    const sums = new Map();
    for (const [row, parentId] of layers[col - 1].entries()) {
      for (const tr of asArray(byId.get(parentId)?.transitions)) {
        const entry = sums.get(tr?.targetNodeId) || { total: 0, count: 0 };
        entry.total += row;
        entry.count += 1;
        sums.set(tr?.targetNodeId, entry);
      }
    }
    layers[col] = layers[col]
      .map((id, row) => {
        const entry = sums.get(id);
        return { id, row, key: entry ? entry.total / entry.count : row };
      })
      .sort((a, b) => a.key - b.key || a.row - b.row)
      .map((e) => e.id);
  }
  return layers;
}

/**
 * Position every node and route every transition. Returns
 * `{ positions, edges, width, height }` — `positions` maps nodeId →
 * `{ x, y }` (top-left corners), `edges` carries a ready-to-draw path plus a
 * de-collided label anchor. Persisted `node.pos` overrides the computed slot;
 * the canvas size covers the cards AND the return lanes below them.
 */
export function layoutLoomGraph(episode) {
  const nodes = asArray(episode?.nodes);
  const posById = new Map(nodes.map((n) => [n.id, n.pos]));
  const layers = loomGraphLayers(episode);
  const positions = {};
  layers.forEach((layer, col) => {
    layer.forEach((id, row) => {
      const custom = posById.get(id);
      positions[id] = custom && Number.isFinite(custom.x) && Number.isFinite(custom.y)
        ? { x: custom.x, y: custom.y }
        : { x: MARGIN + col * (LOOM_NODE_W + COL_GAP), y: MARGIN + row * (LOOM_NODE_H + ROW_GAP) };
    });
  });
  let width = 0;
  let cardBottom = 0;
  for (const { x, y } of Object.values(positions)) {
    width = Math.max(width, x + LOOM_NODE_W + MARGIN);
    cardBottom = Math.max(cardBottom, y + LOOM_NODE_H);
  }
  const edges = routeLoomEdges(nodes, positions, cardBottom);
  let height = cardBottom + MARGIN;
  for (const edge of edges) {
    height = Math.max(height, edge.maxY + MARGIN);
  }
  return { positions, edges, width: Math.max(width, 400), height: Math.max(height, 240) };
}

/**
 * Lowest return lane whose horizontal runs don't overlap `[lo, hi]`, marking
 * it occupied. Packing keeps a graph full of short back-edges from stacking
 * one lane per edge (which would push the canvas hundreds of pixels deep)
 * while never letting two lane runs sit on top of each other.
 *
 * `laneEnds[i]` is the rightmost x lane `i` is occupied to. That single number
 * is enough because callers assign in left-to-right order of `lo`, so a lane
 * is free for this run exactly when its previous run ended before `lo`.
 */
function assignLane(laneEnds, lo, hi) {
  for (let i = 0; ; i += 1) {
    if (laneEnds[i] === undefined || laneEnds[i] < lo) {
      laneEnds[i] = hi;
      return i;
    }
  }
}

/**
 * Route every transition whose endpoints are both placed. Forward edges keep
 * the right → left cubic; self-edges loop off the right side; backward and
 * same-column edges dive under the cards into a packed return lane. Labels are
 * de-collided afterwards, across the whole edge set.
 */
export function routeLoomEdges(nodes, positions, cardBottom) {
  const routes = [];
  for (const node of asArray(nodes)) {
    const from = positions[node.id];
    if (!from) continue;
    for (const tr of asArray(node?.transitions)) {
      const to = positions[tr?.targetNodeId];
      if (!to) continue;
      const self = tr.targetNodeId === node.id;
      routes.push({
        id: tr.id,
        sourceId: node.id,
        targetId: tr.targetNodeId,
        intent: tr.intent || '',
        from,
        to,
        self,
        laneY: null,
      });
    }
  }

  // Lanes are packed left to right, so the sort has to come BEFORE assignment:
  // `assignLane` tracks only each lane's rightmost end, which is a correct
  // free/busy test only when runs arrive in increasing `lo`.
  const laneBase = cardBottom + LANE_OFFSET;
  const laneEnds = [];
  const runStart = (route) => Math.min(route.from.x, route.to.x) + LOOM_NODE_W / 2 - LANE_PAD;
  const returning = routes.filter((r) => !r.self && r.to.x <= r.from.x).sort((a, b) => runStart(a) - runStart(b));
  for (const route of returning) {
    const hi = Math.max(route.from.x, route.to.x) + LOOM_NODE_W / 2 + LANE_PAD;
    route.laneY = laneBase + assignLane(laneEnds, runStart(route), hi) * LANE_GAP;
  }

  return placeEdgeLabels(routes.map(({ id, sourceId, targetId, intent, from, to, self, laneY }) => ({
    id, sourceId, targetId, intent, ...loomEdgePath(from, to, { laneY, self }),
  })));
}

/**
 * Push overlapping labels down a row at a time until each clears the ones
 * already placed. Sorted by anchor so the result doesn't depend on transition
 * order, and capped so a hopelessly crowded cluster stops sliding down the
 * canvas rather than trailing off it.
 */
export function placeEdgeLabels(edges) {
  const placed = [];
  const halfWidth = (text) => (Math.min(text.length, LOOM_EDGE_LABEL_MAX) * LABEL_CHAR_W) / 2;
  for (const edge of [...edges].sort((a, b) => a.labelY - b.labelY || a.labelX - b.labelX)) {
    if (!edge.intent) continue;
    const half = halfWidth(edge.intent);
    let y = edge.labelY;
    for (let row = 0; row < LABEL_MAX_NUDGE_ROWS; row += 1) {
      const clash = placed.some((p) => Math.abs(p.y - y) < LABEL_ROW_H
        && Math.abs(p.x - edge.labelX) < p.half + half);
      if (!clash) break;
      y += LABEL_ROW_H;
    }
    edge.labelY = y;
    edge.maxY = Math.max(edge.maxY, y);
    placed.push({ x: edge.labelX, y, half });
  }
  return edges;
}

/**
 * Path between two placed nodes, plus the label anchor and the deepest y the
 * route reaches (so the canvas can size itself around a return lane).
 *
 * - forward (`to` is right of `from`): cubic from the right edge to the left edge.
 * - backward / same column: a U from the source's bottom edge down to
 *   `laneY` and back up into the target's bottom edge — it stays out of the
 *   card band instead of sweeping across it.
 * - self: a small loop off the right side.
 */
export function loomEdgePath(from, to, options = {}) {
  const { laneY = null, self = false } = options;
  if (self) {
    const x = from.x + LOOM_NODE_W;
    const y = from.y + LOOM_NODE_H / 2;
    return {
      d: `M ${x} ${y - 24} C ${x + 64} ${y - 44}, ${x + 64} ${y + 44}, ${x} ${y + 24}`,
      labelX: x + 46,
      labelY: y,
      maxY: from.y + LOOM_NODE_H,
    };
  }
  if (to.x > from.x) {
    const x1 = from.x + LOOM_NODE_W;
    const y1 = from.y + LOOM_NODE_H / 2;
    const x2 = to.x;
    const y2 = to.y + LOOM_NODE_H / 2;
    const dx = Math.max(48, (x2 - x1) / 2);
    return {
      d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
      labelX: (x1 + x2) / 2,
      labelY: (y1 + y2) / 2,
      maxY: Math.max(y1, y2),
    };
  }
  const x1 = from.x + LOOM_NODE_W / 2;
  const y1 = from.y + LOOM_NODE_H;
  const x2 = to.x + LOOM_NODE_W / 2;
  const y2 = to.y + LOOM_NODE_H;
  const lane = Number.isFinite(laneY) ? laneY : Math.max(y1, y2) + LANE_OFFSET;
  return {
    d: `M ${x1} ${y1} C ${x1} ${lane}, ${x2} ${lane}, ${x2} ${y2}`,
    labelX: (x1 + x2) / 2,
    // Bottom of the cubic at t=0.5, where the run is flattest.
    labelY: (y1 + y2 + 6 * lane) / 8,
    maxY: lane,
  };
}
