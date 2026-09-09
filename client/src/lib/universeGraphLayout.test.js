import { describe, it, expect } from 'vitest';
import { indexGraph } from './universeGraphModel';
import {
  applyAnchors, computeFit, hitTest, radiusFor, seedPositions, settleLayout, toWorld,
} from './universeGraphLayout';

const nodes = (n, kind = 'character') => Array.from({ length: n }, (_, i) => ({
  id: `${kind}:${i}`, kind, name: `N${i}`, firstIssue: i % 3, degree: n - i,
}));

describe('seedPositions', () => {
  it('is deterministic, so the same universe opens in the same shape twice', () => {
    const a = seedPositions(nodes(6)).map((n) => [n.x, n.y]);
    const b = seedPositions(nodes(6)).map((n) => [n.x, n.y]);
    expect(a).toEqual(b);
  });

  it('gives every node a distinct starting point', () => {
    const seeded = seedPositions(nodes(20));
    expect(new Set(seeded.map((n) => `${n.x},${n.y}`)).size).toBe(20);
  });
});

describe('settleLayout', () => {
  it('separates two coincident nodes instead of leaving them stacked', () => {
    const a = { id: 'a', kind: 'character', name: 'A', x: 0, y: 0, vx: 0, vy: 0, tx: null, ty: null, firstIssue: 0 };
    const b = { id: 'b', kind: 'character', name: 'B', x: 0, y: 0, vx: 0, vy: 0, tx: null, ty: null, firstIssue: 0 };
    settleLayout([a, b], [], { degree: new Map([['a', 0], ['b', 0]]) });
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(radiusFor(a) + radiusFor(b));
    expect(Number.isFinite(a.x) && Number.isFinite(b.y)).toBe(true);
  });

  it('pulls a spring-linked pair in from a long start; an unlinked pair only drifts', () => {
    const pair = () => [
      { id: 'character:0', kind: 'character', name: 'A', x: -400, y: 0, vx: 0, vy: 0, tx: null, ty: null, firstIssue: 0 },
      { id: 'character:1', kind: 'character', name: 'B', x: 400, y: 0, vx: 0, vy: 0, tx: null, ty: null, firstIssue: 0 },
    ];
    const spread = (list) => Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y);

    const linked = pair();
    const index = indexGraph({
      nodes: linked,
      edges: [{ source: 'character:0', target: 'character:1', type: 'ally', directed: true }],
    });
    settleLayout(index.nodes, index.edges, { degree: index.degree });

    const loose = pair();
    settleLayout(loose, [], { degree: new Map(loose.map((n) => [n.id, 0])) });

    expect(spread(linked)).toBeLessThan(800);
    expect(spread(linked)).toBeLessThan(spread(loose));
  });
});

describe('applyAnchors', () => {
  it('clears anchors for the force layout so springs take over again', () => {
    const list = nodes(3);
    applyAnchors(list, 'radial');
    expect(list.every((n) => n.tx != null)).toBe(true);
    applyAnchors(list, 'force');
    expect(list.every((n) => n.tx === null && n.ty === null)).toBe(true);
  });

  it('lays timeline anchors out left to right by first appearance', () => {
    const list = [
      { id: 'a', kind: 'character', name: 'A', firstIssue: 0 },
      { id: 'b', kind: 'character', name: 'B', firstIssue: 5 },
      { id: 'c', kind: 'character', name: 'C', firstIssue: 10 },
    ];
    applyAnchors(list, 'timeline', { totalIssues: 10 });
    expect(list[0].tx).toBeLessThan(list[1].tx);
    expect(list[1].tx).toBeLessThan(list[2].tx);
  });

  it('separates kinds into their own timeline lanes', () => {
    const list = [
      { id: 'a', kind: 'character', name: 'A', firstIssue: 0 },
      { id: 'b', kind: 'place', name: 'B', firstIssue: 0 },
    ];
    applyAnchors(list, 'timeline', { totalIssues: 4 });
    expect(list[0].ty).not.toBe(list[1].ty);
  });

  it('survives totalIssues of 0 rather than dividing by zero', () => {
    const list = nodes(3);
    applyAnchors(list, 'timeline', { totalIssues: 0 });
    expect(list.every((n) => Number.isFinite(n.tx) && Number.isFinite(n.ty))).toBe(true);
  });
});

describe('computeFit', () => {
  it('centres the bounding box in the viewport', () => {
    const list = [
      { id: 'a', kind: 'character', name: 'A', x: -100, y: -100 },
      { id: 'b', kind: 'character', name: 'B', x: 100, y: 100 },
    ];
    const view = computeFit(list, { width: 800, height: 600 });
    expect(view.x).toBeCloseTo(400, 5);
    expect(view.y).toBeCloseTo(300, 5);
    expect(view.k).toBeGreaterThan(0);
  });

  it('returns a usable transform for an empty graph instead of Infinity', () => {
    const view = computeFit([], { width: 800, height: 600 });
    expect(Number.isFinite(view.k) && Number.isFinite(view.x)).toBe(true);
  });
});

describe('hitTest', () => {
  const view = { x: 100, y: 100, k: 2 };
  const list = [{ id: 'a', kind: 'character', name: 'A', x: 0, y: 0 }];
  const degree = new Map([['a', 0]]);

  it('picks the node under the cursor in screen space', () => {
    expect(hitTest(list, view, 100, 100, degree)).toBe(list[0]);
    expect(toWorld(view, 100, 100)).toEqual([0, 0]);
  });

  it('returns null on empty canvas', () => {
    expect(hitTest(list, view, 400, 400, degree)).toBeNull();
  });
});
