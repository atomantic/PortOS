import { describe, it, expect } from 'vitest';
import {
  layoutLoomGraph, loomEdgePath, loomGraphLayers, placeEdgeLabels, routeLoomEdges,
  LOOM_NODE_H, LOOM_NODE_W,
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
    // a → x, b → y discovered as [y, x]: barycenter pulls x above y to match
    // the parent order, which is the crossing-free arrangement.
    const layers = loomGraphLayers({
      startNodeId: 'root',
      nodes: [
        { id: 'root', transitions: [tr('t1', 'a'), tr('t2', 'b')] },
        { id: 'a', transitions: [tr('t3', 'x')] },
        { id: 'b', transitions: [tr('t4', 'y')] },
        { id: 'y', transitions: [] },
        { id: 'x', transitions: [] },
      ],
    });
    expect(layers[1]).toEqual(['a', 'b']);
    expect(layers[2]).toEqual(['x', 'y']);
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
});

describe('loomEdgePath', () => {
  it('produces a cubic path from right edge to left edge with a label midpoint', () => {
    const { d, labelX, labelY } = loomEdgePath({ x: 0, y: 0 }, { x: 300, y: 100 });
    expect(d.startsWith(`M ${LOOM_NODE_W} `)).toBe(true);
    expect(d).toContain('C ');
    expect(labelX).toBe((LOOM_NODE_W + 300) / 2);
    expect(labelY).toBeGreaterThan(0);
  });

  it('sends a same-column edge under the cards rather than across them', () => {
    const { d, maxY } = loomEdgePath({ x: 300, y: 0 }, { x: 300, y: 300 }, { laneY: 500 });
    expect(d.startsWith(`M ${300 + LOOM_NODE_W / 2} ${LOOM_NODE_H}`)).toBe(true);
    expect(maxY).toBe(500);
  });
});
