import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

// GraphScene renders raw react-three-fiber primitives (<mesh>, <ambientLight>,
// ...) that only make sense inside a real WebGL canvas — this test DOM has
// none. The graph carries no nodes/edges, so nothing tries to raycast or
// mount a mesh, and the one child GraphScene always renders (GraphEdges) is
// mocked to a call-counting spy: it doubles as "did GraphScene's function
// body run again", which is exactly what `memo` gates.
const graphEdgesSpy = vi.hoisted(() => vi.fn(() => null));
vi.mock('./GraphEdges', () => ({ default: graphEdgesSpy }));
vi.mock('@react-three/fiber', () => ({
  useThree: () => ({ camera: {}, size: { width: 100, height: 100 } }),
}));
const orbitControlsSpy = vi.hoisted(() => vi.fn(() => null));
vi.mock('@react-three/drei', () => ({ OrbitControls: orbitControlsSpy }));

import GraphScene, { graphMotionSettings } from './GraphScene';

const EMPTY_GRAPH = { simNodes: [], simEdges: [], idMap: new Map() };

const baseProps = {
  graph: EMPTY_GRAPH,
  selectedId: null,
  adjacentIds: null,
  nodeColor: () => '#ffffff',
  edgeColor: () => '#ffffff',
  edgeIntensity: () => 1,
  onSelect: () => {},
  onHover: () => {},
  pickRef: { current: null },
  touchGestureRef: { current: false },
  reducedMotion: false
};

describe('GraphScene memoization (#4116)', () => {
  it('does not re-render when every prop stays referentially identical', () => {
    const { rerender } = render(<GraphScene {...baseProps} />);
    expect(graphEdgesSpy).toHaveBeenCalledTimes(1);

    // Same underlying `baseProps` object spread again — exactly what the
    // owning page's hover-tracking `onPointerMove` does on every mouse move.
    rerender(<GraphScene {...baseProps} />);
    expect(graphEdgesSpy).toHaveBeenCalledTimes(1);
  });

  it('re-renders when a prop actually changes', () => {
    const { rerender } = render(<GraphScene {...baseProps} />);
    expect(graphEdgesSpy).toHaveBeenCalledTimes(1);

    rerender(<GraphScene {...baseProps} selectedId="n1" />);
    expect(graphEdgesSpy).toHaveBeenCalledTimes(2);
  });
});

describe('reduced motion', () => {
  it('keeps OrbitControls inertia by default', () => {
    render(<GraphScene {...baseProps} />);
    expect(orbitControlsSpy.mock.calls.at(-1)[0].enableDamping).toBe(true);
  });

  it('stops OrbitControls inertia when the user prefers reduced motion', () => {
    render(<GraphScene {...baseProps} reducedMotion />);
    expect(orbitControlsSpy.mock.calls.at(-1)[0].enableDamping).toBe(false);
  });
});

describe('graphMotionSettings', () => {
  it('stops the canvas render loop and OrbitControls inertia when motion is reduced', () => {
    expect(graphMotionSettings(true)).toEqual({ frameloop: 'demand', enableDamping: false });
  });

  it('keeps animated rendering and controls for users without the preference', () => {
    expect(graphMotionSettings(false)).toEqual({ frameloop: 'always', enableDamping: true });
  });
});
