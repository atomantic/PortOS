/**
 * FableLoom graph layout — pure helpers that place an episode's scene nodes on
 * the editor canvas and route its transition edges.
 *
 * Default positions come from BFS layering (depth from the opening scene, then
 * a barycenter pass so forward edges cross as little as possible). Unreachable
 * nodes trail in extra layers so the author can see them — this is a VIEW
 * concern, deliberately not a mirror of the server's `computeGraphLayers`
 * (which omits them; the server's analysis stays authoritative for
 * reachability/depth stats).
 *
 * A node the author dragged carries a persisted `pos` that wins on the
 * left-to-right desktop layout. Narrow viewports flip the flow top-to-bottom
 * and IGNORE `pos`: those coordinates are in the desktop space and would pile
 * cards off-screen. Touch on that layout taps to select; it does not drag.
 *
 * Edge routing is orthogonal (stub → lane → stub) with per-node port fanning,
 * because a branching narrative is a CYCLIC graph and drawing every edge as a
 * right-edge → left-edge cubic made parallel intents occupy the same curve.
 * Backward / same-layer edges drop into packed return lanes on the unused
 * side of the card band; skip-layer edges go around the other side so they
 * don't sweep through cards in between. Labels sit on the first stub, then
 * de-collide — see `routeLoomEdges`.
 */

export const LOOM_NODE_W = 200;
export const LOOM_NODE_H = 112;
/** Longest intent text drawn on an edge before it is ellipsized. */
export const LOOM_EDGE_LABEL_MAX = 24;
export const LOOM_ORIENTATION = Object.freeze({ LR: 'lr', TB: 'tb' });
/** Below this canvas width the graph stacks top-to-bottom. Matches the
 *  editor-rail `lg` breakpoint: beside the canvas we keep left-to-right
 *  (pan is fine); once the rail wraps under, a vertical scroll is the
 *  readable mobile/tablet layout. */
export const LOOM_STACK_WIDTH = 1024;

const MARGIN = 24;
// Gap along the reading direction: enough for a 24-char label plus a vertical
// (or horizontal, in tb) lane. Fan-out adds LANE_GAP per extra parallel edge.
const BASE_FLOW_GAP = 148;
const RANK_GAP = 48;
const LANE_OFFSET = 36;
const LANE_GAP = 18;
const LANE_PAD = 12;
const STUB = 20;
const PORT_INSET = 16;
const SIDE_GUTTER = 52;
const LABEL_CHAR_W = 5.2;
const LABEL_ROW_H = 12;
const LABEL_MAX_NUDGE_ROWS = 8;
const MIN_NODE_W = 168;

const asArray = (v) => (Array.isArray(v) ? v : []);
const isFinitePos = (pos) => pos && Number.isFinite(pos.x) && Number.isFinite(pos.y);

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
 * Pick a flow direction from the canvas width. Width 0 means "not measured
 * yet" and stays left-to-right so SSR/tests match the desktop path. Layer
 * count is accepted so callers can pass it without a signature fork; it
 * does not change the result — a wide desktop canvas pans a long episode,
 * it does not flip the author's left-to-right map.
 */
export function pickLoomOrientation(viewportWidth, _layerCount = 1) {
  if (!viewportWidth) return LOOM_ORIENTATION.LR;
  return viewportWidth < LOOM_STACK_WIDTH ? LOOM_ORIENTATION.TB : LOOM_ORIENTATION.LR;
}

function nodeMetrics(orientation, viewportWidth) {
  if (orientation === LOOM_ORIENTATION.TB && viewportWidth > 0) {
    const available = Math.max(MIN_NODE_W, viewportWidth - SIDE_GUTTER * 2 - MARGIN * 2);
    return { nodeW: Math.min(LOOM_NODE_W, available), nodeH: LOOM_NODE_H };
  }
  return { nodeW: LOOM_NODE_W, nodeH: LOOM_NODE_H };
}

function maxFanout(nodes) {
  let max = 1;
  const incoming = new Map();
  for (const node of asArray(nodes)) {
    const outs = asArray(node.transitions).length;
    if (outs > max) max = outs;
    for (const tr of asArray(node.transitions)) {
      incoming.set(tr?.targetNodeId, (incoming.get(tr?.targetNodeId) || 0) + 1);
    }
  }
  for (const count of incoming.values()) {
    if (count > max) max = count;
  }
  return max;
}

function flowGapFor(nodes) {
  return BASE_FLOW_GAP + Math.max(0, maxFanout(nodes) - 2) * LANE_GAP;
}

/**
 * Position every node and route every transition. Returns
 * `{ positions, edges, width, height, nodeW, nodeH, orientation }` —
 * `positions` maps nodeId → `{ x, y }` (top-left corners), `edges` carries a
 * ready-to-draw orthogonal path plus a de-collided label anchor. Persisted
 * `node.pos` overrides the computed slot on left-to-right layouts only.
 *
 * `options.orientation` pins flow direction (`lr`/`tb`). When omitted,
 * `pickLoomOrientation(viewportWidth)` decides. `viewportWidth` (the
 * canvas CSS width) still drives how many cards fit in a stacked layer
 * row — not the page breakpoint; the editor passes orientation from the
 * page so a laptop with the rail beside the canvas stays left-to-right.
 */
export function layoutLoomGraph(episode, options = {}) {
  const nodes = asArray(episode?.nodes);
  const layers = loomGraphLayers(episode);
  const orientation = options.orientation
    || pickLoomOrientation(options.viewportWidth, layers.length);
  const { nodeW, nodeH } = nodeMetrics(orientation, options.viewportWidth);
  const flowGap = flowGapFor(nodes);
  const posById = new Map(nodes.map((n) => [n.id, n.pos]));

  const place = (originX, originY) => placeNodes(layers, {
    originX,
    originY,
    nodeW,
    nodeH,
    orientation,
    viewportWidth: options.viewportWidth,
    flowGap,
    rankGap: RANK_GAP,
    posById,
  });
  const depthById = new Map();
  layers.forEach((layer, depth) => layer.forEach((id) => depthById.set(id, depth)));
  const routeFor = (pos) => {
    const band = cardBand(pos, nodeW, nodeH, orientation);
    return routeLoomEdges(nodes, pos, band.max, {
      orientation, nodeW, nodeH, bandMin: band.min, depthById,
    });
  };

  const baseX = MARGIN + (orientation === LOOM_ORIENTATION.TB ? SIDE_GUTTER : 0);
  let extraX = 0;
  let extraY = 0;
  let positions = place(baseX, MARGIN);
  let edges = routeFor(positions);

  // Skip/back lanes (and their labels) can run past the origin. Shift the
  // whole graph rather than clipping them — the SVG root clips at 0,0 and
  // the scroller can't recover a negative path. A second pass can still
  // leave a label hanging past x=0, so we inset until the routed extents
  // clear `MARGIN` or we hit the cap.
  for (let i = 0; i < 3; i += 1) {
    const overflow = edgeOverflow(edges, MARGIN);
    if (!overflow.dx && !overflow.dy) break;
    extraX += overflow.dx;
    extraY += overflow.dy;
    positions = place(baseX + extraX, MARGIN + extraY);
    edges = routeFor(positions);
  }

  let width = 0;
  let height = 0;
  for (const { x, y } of Object.values(positions)) {
    width = Math.max(width, x + nodeW + MARGIN);
    height = Math.max(height, y + nodeH + MARGIN);
  }
  for (const edge of edges) {
    width = Math.max(width, edge.maxX + MARGIN);
    height = Math.max(height, edge.maxY + MARGIN);
  }
  if (options.viewportWidth) {
    width = Math.max(width, options.viewportWidth);
  }
  return {
    positions,
    edges,
    width: Math.max(width, 400),
    height: Math.max(height, 240),
    nodeW,
    nodeH,
    orientation,
  };
}

function placeNodes(layers, {
  originX, originY, nodeW, nodeH, orientation, viewportWidth, flowGap, rankGap, posById,
}) {
  const positions = {};
  const isLR = orientation === LOOM_ORIENTATION.LR;
  if (isLR) {
    layers.forEach((layer, col) => {
      layer.forEach((id, row) => {
        const custom = posById.get(id);
        positions[id] = isFinitePos(custom)
          ? { x: custom.x, y: custom.y }
          : { x: originX + col * (nodeW + flowGap), y: originY + row * (nodeH + rankGap) };
      });
    });
    return positions;
  }
  // Top-to-bottom: wrap a layer onto as many cards as fit in the canvas so a
  // 4-way branch doesn't force horizontal pan on a phone.
  const inner = Math.max(nodeW, (viewportWidth || (nodeW + originX * 2)) - originX * 2);
  const perRow = Math.max(1, Math.floor((inner + rankGap) / (nodeW + rankGap)));
  let y = originY;
  for (const layer of layers) {
    for (let i = 0; i < layer.length; i += perRow) {
      const row = layer.slice(i, i + perRow);
      const rowW = row.length * nodeW + (row.length - 1) * rankGap;
      const startX = originX + Math.max(0, (inner - rowW) / 2);
      row.forEach((id, ci) => {
        positions[id] = { x: startX + ci * (nodeW + rankGap), y };
      });
      const lastInLayer = i + perRow >= layer.length;
      y += nodeH + (lastInLayer ? flowGap : rankGap);
    }
  }
  return positions;
}

function cardBand(positions, nodeW, nodeH, orientation) {
  let min = Infinity;
  let max = 0;
  for (const { x, y } of Object.values(positions)) {
    if (orientation === LOOM_ORIENTATION.LR) {
      min = Math.min(min, y);
      max = Math.max(max, y + nodeH);
    } else {
      min = Math.min(min, x);
      max = Math.max(max, x + nodeW);
    }
  }
  return { min: Number.isFinite(min) ? min : 0, max };
}

function edgeOverflow(edges, margin) {
  let minX = margin;
  let minY = margin;
  for (const edge of edges) {
    if (Number.isFinite(edge.minX)) minX = Math.min(minX, edge.minX);
    if (Number.isFinite(edge.minY)) minY = Math.min(minY, edge.minY);
  }
  return {
    dx: minX < margin ? margin - minX : 0,
    dy: minY < margin ? margin - minY : 0,
  };
}

/**
 * Lowest lane whose occupied range doesn't overlap `[lo, hi]`, marking it
 * occupied. Callers MUST assign in increasing `lo` — the tracker is only the
 * rightmost/bottommost end, which is a correct free/busy test in that order.
 */
function assignLane(laneEnds, lo, hi) {
  for (let i = 0; ; i += 1) {
    if (laneEnds[i] === undefined || laneEnds[i] < lo) {
      laneEnds[i] = hi;
      return i;
    }
  }
}

function fanPorts(count, start, end) {
  if (count <= 0) return [];
  if (count === 1) return [(start + end) / 2];
  const span = end - start;
  const step = span / (count + 1);
  return Array.from({ length: count }, (_, i) => start + step * (i + 1));
}

function cardsBetween(fromId, toId, positions, nodeW, nodeH, isLR) {
  const from = positions[fromId];
  const to = positions[toId];
  const a0 = isLR ? from.x + nodeW : from.y + nodeH;
  const b0 = isLR ? to.x : to.y;
  if (b0 <= a0) return false;
  return Object.entries(positions).some(([id, pos]) => {
    if (id === fromId || id === toId) return false;
    const mid = isLR ? pos.x + nodeW / 2 : pos.y + nodeH / 2;
    return mid > a0 && mid < b0;
  });
}

/**
 * Route every transition whose endpoints are both placed. Forward edges take
 * an orthogonal stub/lane/stub through the gap, with distinct ports so two
 * intents leaving the same scene don't occupy one curve. Self-edges loop off
 * the outgoing side; backward, same-layer, and skip-layer edges go around the
 * card band in packed lanes. Labels de-collide afterwards across the set.
 */
export function routeLoomEdges(nodes, positions, cardExtent, options = {}) {
  const orientation = options.orientation || LOOM_ORIENTATION.LR;
  const nodeW = options.nodeW || LOOM_NODE_W;
  const nodeH = options.nodeH || LOOM_NODE_H;
  const isLR = orientation === LOOM_ORIENTATION.LR;
  const bandMin = Number.isFinite(options.bandMin) ? options.bandMin : MARGIN;
  const depthById = options.depthById instanceof Map ? options.depthById : null;

  const routes = [];
  for (const node of asArray(nodes)) {
    const from = positions[node.id];
    if (!from) continue;
    for (const tr of asArray(node?.transitions)) {
      const to = positions[tr?.targetNodeId];
      if (!to) continue;
      const self = tr.targetNodeId === node.id;
      const fromD = depthById?.get(node.id);
      const toD = depthById?.get(tr.targetNodeId);
      const byDepth = Number.isInteger(fromD) && Number.isInteger(toD);
      // Depth is the source of truth for skip vs forward: a wrapped sibling
      // in the stacked layout sits between two cards in Y without being
      // between them in the story, and cardsBetween would send every other
      // edge around the gutter. Position is the fallback when a caller
      // (tests) didn't pass a layer map.
      const throughCard = cardsBetween(node.id, tr.targetNodeId, positions, nodeW, nodeH, isLR);
      const skip = !self && (byDepth
        ? toD > fromD + 1 || throughCard
        : throughCard);
      const back = !self && (byDepth
        ? toD <= fromD
        : (isLR ? to.x <= from.x : to.y <= from.y));
      routes.push({
        id: tr.id,
        sourceId: node.id,
        targetId: tr.targetNodeId,
        intent: tr.intent || '',
        from,
        to,
        self,
        skip,
        back,
        around: !self && (back || skip),
      });
    }
  }

  assignPorts(routes, nodeW, nodeH, isLR);
  assignAroundLanes(routes, cardExtent, bandMin, nodeW, nodeH, isLR);
  assignForwardLanes(routes, nodeW, nodeH, isLR);

  return placeEdgeLabels(routes.map((route) => ({
    id: route.id,
    sourceId: route.sourceId,
    targetId: route.targetId,
    intent: route.intent,
    ...loomEdgePath(route.from, route.to, {
      self: route.self,
      around: route.around,
      back: route.back,
      lane: route.lane,
      fromPort: route.fromPort,
      toPort: route.toPort,
      orientation,
      nodeW,
      nodeH,
    }),
  })));
}

function assignPorts(routes, nodeW, nodeH, isLR) {
  const groups = new Map();
  const key = (nodeId, side) => `${nodeId}:${side}`;
  const add = (nodeId, side, route, field) => {
    const k = key(nodeId, side);
    const list = groups.get(k) || [];
    list.push({ route, field });
    groups.set(k, list);
  };
  for (const route of routes) {
    if (route.self) continue;
    if (route.around) {
      const side = route.back ? 'back' : 'skip';
      add(route.sourceId, `${side}Out`, route, 'fromPort');
      add(route.targetId, `${side}In`, route, 'toPort');
    } else {
      add(route.sourceId, 'out', route, 'fromPort');
      add(route.targetId, 'in', route, 'toPort');
    }
  }
  for (const [k, list] of groups) {
    const side = k.split(':')[1];
    const around = side.startsWith('back') || side.startsWith('skip');
    // Sort by the OTHER endpoint's cross-axis so fanned stubs don't cross.
    list.sort((a, b) => {
      const aPos = a.field === 'fromPort' ? a.route.to : a.route.from;
      const bPos = b.field === 'fromPort' ? b.route.to : b.route.from;
      const aCross = isLR ? aPos.y : aPos.x;
      const bCross = isLR ? bPos.y : bPos.x;
      return aCross - bCross || String(a.route.id).localeCompare(String(b.route.id));
    });
    const nodePos = list[0].field === 'fromPort' ? list[0].route.from : list[0].route.to;
    let start;
    let end;
    if (around) {
      // Around-band edges leave/enter along the unused side of the card
      // (top/bottom in lr, left/right in tb) so they don't fight the forward ports.
      start = (isLR ? nodePos.x : nodePos.y) + PORT_INSET;
      end = (isLR ? nodePos.x + nodeW : nodePos.y + nodeH) - PORT_INSET;
    } else {
      start = (isLR ? nodePos.y : nodePos.x) + PORT_INSET;
      end = (isLR ? nodePos.y + nodeH : nodePos.x + nodeW) - PORT_INSET;
    }
    const ports = fanPorts(list.length, start, end);
    list.forEach((item, i) => {
      item.route[item.field] = ports[i];
    });
  }
}

function assignAroundLanes(routes, cardExtent, bandMin, nodeW, nodeH, isLR) {
  const around = routes.filter((r) => r.around).sort((a, b) => {
    const aLo = isLR
      ? Math.min(a.from.x, a.to.x) + nodeW / 2
      : Math.min(a.from.y, a.to.y) + nodeH / 2;
    const bLo = isLR
      ? Math.min(b.from.x, b.to.x) + nodeW / 2
      : Math.min(b.from.y, b.to.y) + nodeH / 2;
    return aLo - bLo;
  });
  const backEnds = [];
  const skipEnds = [];
  for (const route of around) {
    const lo = (isLR
      ? Math.min(route.from.x, route.to.x)
      : Math.min(route.from.y, route.to.y)) - LANE_PAD;
    const hi = (isLR
      ? Math.max(route.from.x + nodeW, route.to.x + nodeW)
      : Math.max(route.from.y + nodeH, route.to.y + nodeH)) + LANE_PAD;
    if (route.back) {
      route.lane = cardExtent + LANE_OFFSET + assignLane(backEnds, lo, hi) * LANE_GAP;
    } else {
      // Skip-layer: the other side of the band (above in lr, left in tb).
      route.lane = bandMin - LANE_OFFSET - assignLane(skipEnds, lo, hi) * LANE_GAP;
    }
  }
}

function assignForwardLanes(routes, nodeW, nodeH, isLR) {
  const forward = routes.filter((r) => !r.self && !r.around);
  const corridors = new Map();
  for (const route of forward) {
    const along0 = isLR ? route.from.x + nodeW : route.from.y + nodeH;
    const along1 = isLR ? route.to.x : route.to.y;
    const key = `${Math.round(along0 / 8)}:${Math.round(along1 / 8)}`;
    const list = corridors.get(key) || [];
    list.push(route);
    corridors.set(key, list);
  }
  for (const list of corridors.values()) {
    list.sort((a, b) => {
      const aLo = Math.min(a.fromPort, a.toPort);
      const bLo = Math.min(b.fromPort, b.toPort);
      return aLo - bLo || String(a.id).localeCompare(String(b.id));
    });
    const laneEnds = [];
    const along0 = isLR ? list[0].from.x + nodeW : list[0].from.y + nodeH;
    const along1 = isLR ? list[0].to.x : list[0].to.y;
    const gap = along1 - along0;
    for (const route of list) {
      const lo = Math.min(route.fromPort, route.toPort) - LANE_PAD;
      const hi = Math.max(route.fromPort, route.toPort) + LANE_PAD;
      route.laneIndex = assignLane(laneEnds, lo, hi);
    }
    const laneCount = laneEnds.length || 1;
    const usable = Math.max(STUB, gap - STUB * 2);
    const step = usable / (laneCount + 1);
    for (const route of list) {
      const raw = along0 + STUB + step * (route.laneIndex + 1);
      const fromAlong = isLR ? route.from.x + nodeW : route.from.y + nodeH;
      const toAlong = isLR ? route.to.x : route.to.y;
      const lo = Math.min(fromAlong, toAlong) + 8;
      const hi = Math.max(fromAlong, toAlong) - 8;
      route.lane = hi <= lo ? (fromAlong + toAlong) / 2 : Math.min(hi, Math.max(lo, raw));
    }
  }
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
    edge.maxX = Math.max(edge.maxX ?? 0, edge.labelX + half);
    edge.minY = Math.min(edge.minY ?? y, y - LABEL_ROW_H);
    edge.minX = Math.min(edge.minX ?? edge.labelX, edge.labelX - half);
    placed.push({ x: edge.labelX, y, half });
  }
  return edges;
}

/**
 * Path between two placed nodes, plus the label anchor and the extents the
 * route reaches (so the canvas can size itself around a return lane).
 *
 * - forward: orthogonal stub → packed lane → stub, ports already fanned.
 * - around (backward / same-layer / skip): U on the unused side of the band.
 * - self: a small loop off the outgoing side.
 */
export function loomEdgePath(from, to, options = {}) {
  const {
    lane = null,
    laneY = null,
    laneX = null,
    self = false,
    around = false,
    back = false,
    fromPort = null,
    toPort = null,
    orientation = LOOM_ORIENTATION.LR,
    nodeW = LOOM_NODE_W,
    nodeH = LOOM_NODE_H,
  } = options;
  const isLR = orientation === LOOM_ORIENTATION.LR;
  const resolvedLane = Number.isFinite(lane) ? lane
    : (Number.isFinite(laneY) ? laneY : laneX);
  const sameRank = isLR ? to.x === from.x : to.y === from.y;
  const goingBack = isLR ? to.x <= from.x : to.y <= from.y;

  if (self) {
    if (isLR) {
      const x = from.x + nodeW;
      const y = from.y + nodeH / 2;
      return {
        d: `M ${x} ${y - 24} C ${x + 64} ${y - 44}, ${x + 64} ${y + 44}, ${x} ${y + 24}`,
        labelX: x + 46,
        labelY: y,
        maxX: x + 64,
        maxY: from.y + nodeH,
        minX: from.x,
        minY: from.y,
      };
    }
    const x = from.x + nodeW / 2;
    const y = from.y + nodeH;
    return {
      d: `M ${x - 24} ${y} C ${x - 44} ${y + 64}, ${x + 44} ${y + 64}, ${x + 24} ${y}`,
      labelX: x,
      labelY: y + 46,
      maxX: from.x + nodeW,
      maxY: y + 64,
      minX: from.x,
      minY: from.y,
    };
  }

  if (around || goingBack || sameRank) {
    return aroundPath(from, to, {
      lane: resolvedLane, fromPort, toPort, isLR, nodeW, nodeH,
      // Skip-layer is `around && !back`; a same-column / backward edge
      // without the flag still uses the return side (existing tests pass
      // `{ laneY }` with no `around`).
      back: around ? back : true,
    });
  }

  return forwardPath(from, to, {
    lane: resolvedLane, fromPort, toPort, isLR, nodeW, nodeH,
  });
}

function aroundPath(from, to, { lane, fromPort, toPort, isLR, nodeW, nodeH, back }) {
  if (isLR) {
    const x1 = fromPort ?? from.x + nodeW / 2;
    const x2 = toPort ?? to.x + nodeW / 2;
    const y1 = back ? from.y + nodeH : from.y;
    const y2 = back ? to.y + nodeH : to.y;
    const laneY = Number.isFinite(lane) ? lane
      : (back ? Math.max(y1, y2) + LANE_OFFSET : Math.min(y1, y2) - LANE_OFFSET);
    return {
      d: `M ${x1} ${y1} V ${laneY} H ${x2} V ${y2}`,
      labelX: (x1 + x2) / 2,
      labelY: laneY + (back ? -6 : 14),
      maxX: Math.max(x1, x2, from.x + nodeW, to.x + nodeW),
      maxY: Math.max(y1, y2, laneY),
      minX: Math.min(x1, x2, from.x, to.x),
      minY: Math.min(from.y, to.y, laneY, y1, y2),
    };
  }
  const y1 = fromPort ?? from.y + nodeH / 2;
  const y2 = toPort ?? to.y + nodeH / 2;
  const x1 = back ? from.x + nodeW : from.x;
  const x2 = back ? to.x + nodeW : to.x;
  const laneX = Number.isFinite(lane) ? lane
    : (back ? Math.max(x1, x2) + LANE_OFFSET : Math.min(x1, x2) - LANE_OFFSET);
  return {
    d: `M ${x1} ${y1} H ${laneX} V ${y2} H ${x2}`,
    // Label sits on the card side of the lane so a left-gutter skip doesn't
    // paint past x=0 (the SVG clips there, and the overflow pass can't
    // recover a label that extends further left than the path).
    labelX: laneX + (back ? -8 : 8),
    labelY: (y1 + y2) / 2,
    maxX: Math.max(x1, x2, laneX, from.x + nodeW, to.x + nodeW),
    maxY: Math.max(y1, y2, from.y + nodeH, to.y + nodeH),
    minX: Math.min(from.x, to.x, laneX, x1, x2),
    minY: Math.min(y1, y2, from.y, to.y),
  };
}

function forwardPath(from, to, { lane, fromPort, toPort, isLR, nodeW, nodeH }) {
  if (isLR) {
    const x1 = from.x + nodeW;
    const y1 = fromPort ?? from.y + nodeH / 2;
    const x2 = to.x;
    const y2 = toPort ?? to.y + nodeH / 2;
    const laneX = Number.isFinite(lane) ? lane : (x1 + x2) / 2;
    const straight = Math.abs(y1 - y2) < 1;
    const d = straight
      ? `M ${x1} ${y1} H ${x2}`
      : `M ${x1} ${y1} H ${laneX} V ${y2} H ${x2}`;
    const firstH = Math.abs(laneX - x1);
    const labelOnStub = !straight && firstH >= 28;
    return {
      d,
      labelX: labelOnStub ? (x1 + laneX) / 2 : (x1 + x2) / 2,
      labelY: (labelOnStub ? y1 : (y1 + y2) / 2) - 6,
      maxX: Math.max(x1, x2, laneX),
      maxY: Math.max(y1, y2, from.y + nodeH, to.y + nodeH),
      minX: Math.min(from.x, to.x, laneX),
      minY: Math.min(y1, y2, from.y, to.y) - 8,
    };
  }
  const x1 = fromPort ?? from.x + nodeW / 2;
  const y1 = from.y + nodeH;
  const x2 = toPort ?? to.x + nodeW / 2;
  const y2 = to.y;
  const laneY = Number.isFinite(lane) ? lane : (y1 + y2) / 2;
  const straight = Math.abs(x1 - x2) < 1;
  const d = straight
    ? `M ${x1} ${y1} V ${y2}`
    : `M ${x1} ${y1} V ${laneY} H ${x2} V ${y2}`;
  return {
    d,
    labelX: straight ? x1 + 10 : (x1 + x2) / 2,
    labelY: straight ? (y1 + y2) / 2 : laneY - 6,
    maxX: Math.max(x1, x2, from.x + nodeW, to.x + nodeW),
    maxY: Math.max(y1, y2, laneY),
    minX: Math.min(x1, x2, from.x, to.x),
    minY: Math.min(from.y, to.y, laneY),
  };
}
