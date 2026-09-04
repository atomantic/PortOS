// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  layoutLoomGraph, loomEdgePath, loomGraphLayers, pickLoomOrientation, placeEdgeLabels, routeLoomEdges,
  LOOM_NODE_H, LOOM_NODE_W, LOOM_ORIENTATION, LOOM_STACK_WIDTH,
} from './loomLayout.js';

const tr = (id, targetNodeId) => ({ id, targetNodeId, intent: 'go' });

const episode = () => ({
  id: 'ep-1',
  startNodeId: 'n1',
  nodes: [
    { id: 'n1', transitions: [tr('t1', 'n2'), tr('t2', 'n3')] },
    { id: 'n2', transitions: [tr('t3', 'n4')] },
    { id: 'n3', isEnding: true, transitions: [] },
    { id: 'n4', isEnding: true, transitions: [] },
  ],
});

describe('loomGraphLayers', () => {
  it('layers by BFS depth and trails unreachable nodes', () => {
    const ep = episode();
    ep.nodes.push({ id: 'orphan', transitions: [] });
    const layers = loomGraphLayers(ep);
    expect(layers[0]).toEqual(['n1']);
    expect(layers[1]).toEqual(['n2', 'n3']);
    expect(layers[2]).toEqual(['n4']);
    expect(layers[3]).toEqual(['orphan']);
  });

  it('returns only orphan chunks when there is no valid start', () => {
    const layers = loomGraphLayers({ startNodeId: 'gone', nodes: [{ id: 'a' }, { id: 'b' }] });
    expect(layers).toEqual([['a', 'b']]);
  });

  it('reorders a layer toward its parents so forward edges stop crossing', () => {
    // `p` (row 0) reaches a and b; `r` (row 2) and `s` (row 3) also reach a.
    // BFS discovers [a, b] because p's transitions come first — but a's mean
    // parent row is (0+2+3)/3 = 1.67 against b's 0, so the crossing-free order
    // is [b, a]. A plain BFS layering CANNOT produce that, which is what makes
    // this fixture a real test of the barycenter pass rather than of BFS.
    const layers = loomGraphLayers({
      startNodeId: 'root',
      nodes: [
        { id: 'root', transitions: [tr('t1', 'p'), tr('t2', 'q'), tr('t3', 'r'), tr('t4', 's')] },
        { id: 'p', transitions: [tr('t5', 'a'), tr('t6', 'b')] },
        { id: 'q', transitions: [] },
        { id: 'r', transitions: [tr('t7', 'a')] },
        { id: 's', transitions: [tr('t8', 'a')] },
        { id: 'a', transitions: [] },
        { id: 'b', transitions: [] },
      ],
    });
    expect(layers[1]).toEqual(['p', 'q', 'r', 's']);
    expect(layers[2]).toEqual(['b', 'a']);
  });
});

describe('layoutLoomGraph', () => {
  it('assigns columns by depth and lets persisted pos win', () => {
    const ep = episode();
    ep.nodes[3].pos = { x: 999, y: 5 };
    const { positions, width, height } = layoutLoomGraph(ep);
    expect(positions.n1.x).toBeLessThan(positions.n2.x);
    expect(positions.n2.x).toBe(positions.n3.x);
    expect(positions.n4).toEqual({ x: 999, y: 5 });
    expect(width).toBeGreaterThanOrEqual(999 + LOOM_NODE_W);
    expect(height).toBeGreaterThan(0);
  });

  it('handles an empty episode without NaN extents', () => {
    const { positions, edges, width, height } = layoutLoomGraph({ nodes: [] });
    expect(positions).toEqual({});
    expect(edges).toEqual([]);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  it('routes an edge per transition and grows the canvas to cover return lanes', () => {
    const ep = episode();
    // A loop back to the opening scene — the shape the old right-to-left
    // routing swept across every card in between.
    ep.nodes[1].transitions.push(tr('t9', 'n1'));
    const { edges, height, positions } = layoutLoomGraph(ep);
    expect(edges.map((e) => e.id)).toEqual(['t1', 't2', 't3', 't9']);
    const back = edges.find((e) => e.id === 't9');
    // Leaves and enters through the BOTTOM edges, dipping below both cards.
    expect(back.d.startsWith(`M ${positions.n2.x + LOOM_NODE_W / 2} ${positions.n2.y + LOOM_NODE_H}`)).toBe(true);
    expect(back.maxY).toBeGreaterThan(positions.n1.y + LOOM_NODE_H);
    expect(height).toBeGreaterThan(back.maxY);
  });

  it('grows the canvas past a self-loop and its label, not just the cards', () => {
    const ep = episode();
    ep.nodes[3].transitions = [{ id: 't-self', targetNodeId: 'n4', intent: 'wait here quietly for now' }];
    const { edges, width, positions } = layoutLoomGraph(ep);
    const loop = edges.find((e) => e.id === 't-self');
    // The SVG root clips at `width` — the scrolling wrapper can't recover what
    // the viewport cut, so the extent has to include the bow AND the label.
    expect(loop.maxX).toBeGreaterThan(positions.n4.x + LOOM_NODE_W);
    expect(width).toBeGreaterThan(loop.maxX);
    expect(width).toBeGreaterThan(loop.labelX);
  });

  it('drops a transition whose target no longer exists', () => {
    const ep = episode();
    ep.nodes[1].transitions.push(tr('t-dangling', 'gone'));
    const { edges } = layoutLoomGraph(ep);
    expect(edges.some((e) => e.id === 't-dangling')).toBe(false);
  });
});

describe('routeLoomEdges', () => {
  it('packs non-overlapping back edges into the same lane', () => {
    const positions = {
      a: { x: 0, y: 0 }, b: { x: 300, y: 0 }, c: { x: 900, y: 0 }, d: { x: 1200, y: 0 },
    };
    const nodes = [
      { id: 'b', transitions: [{ id: 'e1', targetNodeId: 'a', intent: '' }] },
      { id: 'd', transitions: [{ id: 'e2', targetNodeId: 'c', intent: '' }] },
      // Spans both of the runs above, so it cannot share their lane.
      { id: 'd2', transitions: [{ id: 'e3', targetNodeId: 'a', intent: '' }] },
    ];
    positions.d2 = { x: 1200, y: 0 };
    const [e1, e2, e3] = routeLoomEdges(nodes, positions, LOOM_NODE_H);
    expect(e2.maxY).toBe(e1.maxY);
    expect(e3.maxY).toBeGreaterThan(e1.maxY);
  });

  it('packs the same way whichever order the transitions were authored in', () => {
    const positions = { a: { x: 0, y: 0 }, b: { x: 300, y: 0 }, c: { x: 900, y: 0 }, d: { x: 1200, y: 0 } };
    const near = { id: 'b', transitions: [{ id: 'e1', targetNodeId: 'a', intent: '' }] };
    const far = { id: 'd', transitions: [{ id: 'e2', targetNodeId: 'c', intent: '' }] };
    const depths = (nodes) => Object.fromEntries(
      routeLoomEdges(nodes, positions, LOOM_NODE_H).map((e) => [e.id, e.maxY]),
    );
    expect(depths([near, far])).toEqual(depths([far, near]));
  });

  it('loops a self-transition off the right side instead of routing under', () => {
    const positions = { a: { x: 0, y: 0 } };
    const [edge] = routeLoomEdges(
      [{ id: 'a', transitions: [{ id: 'e1', targetNodeId: 'a', intent: 'wait' }] }],
      positions,
      LOOM_NODE_H,
    );
    expect(edge.labelX).toBeGreaterThan(LOOM_NODE_W);
    expect(edge.maxY).toBe(LOOM_NODE_H);
  });
});

describe('placeEdgeLabels', () => {
  it('nudges overlapping labels apart and leaves separated ones alone', () => {
    const edges = [
      { intent: 'take the left hallway', labelX: 100, labelY: 50, maxY: 50 },
      { intent: 'take the right hallway', labelX: 100, labelY: 50, maxY: 50 },
      { intent: 'far away', labelX: 900, labelY: 50, maxY: 50 },
    ];
    const [a, b, c] = placeEdgeLabels(edges);
    expect(a.labelY).toBe(50);
    expect(b.labelY).toBeGreaterThan(a.labelY);
    expect(c.labelY).toBe(50);
    // The nudge has to grow the routed extent too, or the label lands under
    // the canvas floor and clips.
    expect(b.maxY).toBe(b.labelY);
  });

  it('ignores unlabeled edges', () => {
    const edges = [
      { intent: '', labelX: 100, labelY: 50, maxY: 50 },
      { intent: 'labeled', labelX: 100, labelY: 50, maxY: 50 },
    ];
    const [blank, labeled] = placeEdgeLabels(edges);
    expect(blank.labelY).toBe(50);
    expect(labeled.labelY).toBe(50);
  });

  it('moves a label clear of a card when its full text does not fit in the gap', () => {
    const edges = [{ intent: 'take the long hallway', labelX: 100, labelY: 60, maxY: 60 }];
    placeEdgeLabels(edges, {
      obstacles: [{ x: 0, y: 0, width: 200, height: 112 }],
    });
    expect(edges[0].labelY).toBeGreaterThan(112);
    expect(edges[0].maxY).toBe(edges[0].labelY);
  });

  it('prefers the first clear row below a card', () => {
    const edges = [{ intent: 'take the long hallway', labelX: 100, labelY: 60, maxY: 60 }];
    placeEdgeLabels(edges, {
      obstacles: [{ x: 0, y: 0, width: 200, height: 55 }],
    });
    expect(edges[0].labelY).toBe(72);
  });
});

describe('pickLoomOrientation', () => {
  it('stays left-to-right when the canvas has not been measured', () => {
    expect(pickLoomOrientation(0, 5)).toBe(LOOM_ORIENTATION.LR);
  });

  it('stacks top-to-bottom on a narrow canvas even for a short graph', () => {
    expect(pickLoomOrientation(LOOM_STACK_WIDTH - 1, 2)).toBe(LOOM_ORIENTATION.TB);
  });

  it('stacks when the editor rail has wrapped under the canvas', () => {
    expect(pickLoomOrientation(800, 8)).toBe(LOOM_ORIENTATION.TB);
  });

  it('keeps a short graph left-to-right on a wide canvas', () => {
    expect(pickLoomOrientation(1400, 3)).toBe(LOOM_ORIENTATION.LR);
  });
});

describe('explicit orientation', () => {
  it('stays left-to-right when the page pins lr even if the canvas is narrow', () => {
    const { orientation, positions } = layoutLoomGraph(episode(), {
      viewportWidth: 800,
      orientation: LOOM_ORIENTATION.LR,
    });
    expect(orientation).toBe(LOOM_ORIENTATION.LR);
    expect(positions.n1.x).toBeLessThan(positions.n2.x);
  });
});

describe('loomEdgePath', () => {
  it('produces an orthogonal path from right edge to left edge', () => {
    const { d, labelX, labelY } = loomEdgePath({ x: 0, y: 0 }, { x: 300, y: 100 });
    expect(d.startsWith(`M ${LOOM_NODE_W} `)).toBe(true);
    expect(d).toMatch(/[HV]/);
    expect(d).not.toContain('C ');
    expect(labelX).toBeGreaterThan(LOOM_NODE_W);
    expect(labelY).toBeGreaterThan(0);
  });

  it('sends a same-column edge under the cards rather than across them', () => {
    const { d, maxY } = loomEdgePath({ x: 300, y: 0 }, { x: 300, y: 300 }, { laneY: 500 });
    expect(d.startsWith(`M ${300 + LOOM_NODE_W / 2} ${LOOM_NODE_H}`)).toBe(true);
    expect(maxY).toBe(500);
  });
});

const pathStart = (d) => {
  const match = /^M\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(d);
  return { x: Number(match[1]), y: Number(match[2]) };
};

describe('port fanning and skip routing', () => {
  it('fans two outgoing intents off distinct ports so they do not share a curve', () => {
    const { edges, positions } = layoutLoomGraph({
      startNodeId: 'n1',
      nodes: [
        { id: 'n1', transitions: [tr('t1', 'n2'), tr('t2', 'n3')] },
        { id: 'n2', transitions: [] },
        { id: 'n3', transitions: [] },
      ],
    });
    const a = pathStart(edges.find((e) => e.id === 't1').d);
    const b = pathStart(edges.find((e) => e.id === 't2').d);
    expect(a.x).toBe(positions.n1.x + LOOM_NODE_W);
    expect(b.x).toBe(positions.n1.x + LOOM_NODE_W);
    expect(a.y).not.toBe(b.y);
    expect(new Set(edges.map((e) => e.d)).size).toBe(edges.length);
  });

  it('routes a skip-layer edge around the card band instead of through the middle column', () => {
    const ep = {
      startNodeId: 'n1',
      nodes: [
        { id: 'n1', transitions: [tr('t-adj', 'n2'), tr('t-skip', 'n3')] },
        { id: 'n2', transitions: [tr('t2', 'n3')] },
        { id: 'n3', isEnding: true, transitions: [] },
      ],
    };
    const { edges, positions } = layoutLoomGraph(ep);
    const skip = edges.find((e) => e.id === 't-skip');
    const mid = positions.n2;
    // The skip run sits above the intervening card, not through its interior,
    // and the canvas origin still contains it (the SVG clips at 0,0).
    expect(skip.minY).toBeLessThan(mid.y);
    expect(skip.minY).toBeGreaterThanOrEqual(0);
    expect(skip.d).toContain('V ');
    expect(skip.d).toContain('H ');
  });

  it('stacks layers top-to-bottom on a narrow viewport and ignores desktop pos', () => {
    const ep = episode();
    ep.nodes[0].pos = { x: 900, y: 10 };
    const { positions, orientation, width, edges } = layoutLoomGraph(ep, { viewportWidth: 390 });
    expect(orientation).toBe(LOOM_ORIENTATION.TB);
    expect(positions.n1.y).toBeLessThan(positions.n2.y);
    expect(positions.n1.x).toBeLessThan(400);
    expect(width).toBeGreaterThanOrEqual(390);
    for (const edge of edges) {
      expect(edge.minX).toBeGreaterThanOrEqual(0);
      expect(edge.minY).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps a diamond of forward edges on unique orthogonal paths', () => {
    const { edges } = layoutLoomGraph({
      startNodeId: 'a',
      nodes: [
        { id: 'a', transitions: [tr('t1', 'b'), tr('t2', 'c')] },
        { id: 'b', transitions: [tr('t3', 'd')] },
        { id: 'c', transitions: [tr('t4', 'd')] },
        { id: 'd', isEnding: true, transitions: [] },
      ],
    });
    expect(new Set(edges.map((e) => e.d)).size).toBe(4);
    const labels = edges.map((e) => `${e.labelX},${e.labelY}`);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
