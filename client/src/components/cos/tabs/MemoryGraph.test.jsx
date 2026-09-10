import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The three.js stack can't run in jsdom (no WebGL context), and none of it is
// under test here — this file covers the responsive chrome AROUND the canvas.
// The stub deliberately drops `children` from the render: mounting the scene
// would create <bufferGeometry>/<mesh> as unknown DOM elements. It still
// *captures* the element so a test can reach GraphScene's callbacks (the only
// way to open the hover tooltip, or stand in for a screen-space pick, without
// a real raycast). Rendered as an actual <canvas> tag (not a <div>) so the
// wrapper's `isCanvasGesture` check — `e.target.tagName === 'CANVAS'` — passes
// for the touch-tap test below, matching what react-three-fiber really mounts.
let sceneElement = null;
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children, frameloop }) => {
    sceneElement = children;
    return <canvas data-testid="graph-canvas" data-frameloop={frameloop} />;
  },
}));
vi.mock('@react-three/drei', () => ({ OrbitControls: () => null }));

vi.mock('../../../services/api', () => ({
  getMemoryGraph: vi.fn(),
  getMemory: vi.fn(),
}));

import * as api from '../../../services/api';
import MemoryGraph, { memoryEdgeColor, memoryEdgeIntensity } from './MemoryGraph';

const GRAPH = {
  nodes: [
    { id: 'n1', type: 'fact', category: 'general', summary: 'first', importance: 0.5 },
    { id: 'n2', type: 'learning', category: 'general', summary: 'second', importance: 0.5 },
  ],
  edges: [{ source: 'n1', target: 'n2', type: 'linked', weight: 0.9 }],
};

const renderGraph = async () => {
  render(<MemoryGraph />);
  // Settle the mount-effect fetch inside act (see src/test/setup.js).
  await act(async () => {});
};

// Open the tooltip the way a hovered node does — GraphScene is never mounted,
// so call the handler the component handed it.
const hoverNode = async (node, point) => {
  await act(async () => { sceneElement.props.onHover(node, point); });
};

const originalInnerWidth = window.innerWidth;
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  vi.clearAllMocks();
  sceneElement = null;
  api.getMemoryGraph.mockResolvedValue(GRAPH);
  api.getMemory.mockResolvedValue(null);
});

afterEach(() => {
  window.innerWidth = originalInnerWidth;
  window.matchMedia = originalMatchMedia;
});

describe('canvas sizing', () => {
  it('sizes the canvas relative to the viewport, not a fixed pixel height', async () => {
    await renderGraph();
    const shell = screen.getByTestId('graph-canvas').parentElement;
    // The regression guarded here is the old `style={{ height: '500px' }}`,
    // which overflowed a landscape phone and left no room to scroll past a
    // canvas that swallows drags. The exact clamp values are free to be tuned,
    // so only assert it is viewport-relative.
    expect(shell.style.height).toBe('');
    expect(shell.className).toMatch(/h-\[clamp\([^\]]*vh[^\]]*\)\]/);
  });
});

// The legend sits over the canvas and blankets a phone-sized graph, so on a
// small viewport it hides behind a toggle. It must stay reachable — the edge
// colours appear nowhere else in this tab — rather than be dropped.
describe('legend disclosure', () => {
  it('starts collapsed and expands when the mobile toggle is pressed', async () => {
    const user = userEvent.setup();
    await renderGraph();

    const toggle = screen.getByRole('button', { name: /legend/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // `hidden` is the mobile-collapsed state — the panel stays in the DOM, and
    // `roomy-viewport:block` re-shows it on a roomy viewport regardless.
    expect(screen.getByTestId('graph-legend')).toHaveClass('hidden');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('graph-legend')).not.toHaveClass('hidden');
  });

  it('gates the auto-show on viewport height as well as width', async () => {
    await renderGraph();
    // A landscape phone is WIDER than `sm` but only ~390px tall, so a width-only
    // (`sm:`) gate force-shows the legend over a floored 240px canvas while
    // hiding the toggle — un-dismissable, in the exact case this targets.
    expect(screen.getByTestId('graph-legend')).toHaveClass('roomy-viewport:block');
    expect(screen.getByTestId('graph-legend')).not.toHaveClass('sm:block');
    expect(screen.getByRole('button', { name: /legend/i })).toHaveClass('roomy-viewport:hidden');
  });

  it('does not swallow the canvas drags underneath it', async () => {
    await renderGraph();
    // The legend's wrapper covers a corner of the canvas. It must not be
    // hit-testable, or it eats the orbit drags that pass through the panel —
    // pointer-events is inherited, so the wrapper carries the opt-out and only
    // the toggle opts back in.
    expect(screen.getByTestId('graph-legend').parentElement).toHaveClass('pointer-events-none');
    expect(screen.getByRole('button', { name: /legend/i })).toHaveClass('pointer-events-auto');
  });

  it('keeps the edge-colour key reachable when collapsed', async () => {
    await renderGraph();
    for (const label of ['linked', 'similar']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});

describe('hover tooltip placement', () => {
  const tooltipOf = (node) => node.closest('.fixed');

  it('clamps against the right edge of a narrow viewport', async () => {
    window.innerWidth = 375;
    await renderGraph();
    // Unclamped this was `left: x + 12` = 372px on a 375px-wide screen, which
    // pushed a ~320px tooltip almost entirely off-screen.
    await hoverNode(GRAPH.nodes[0], { x: 360, y: 200 });

    const tooltip = tooltipOf(screen.getByText('first'));
    // 375 - 320 (tooltip width) - 8 (gutter) = 47.
    expect(tooltip.style.left).toBe('47px');
    expect(tooltip.style.maxWidth).toBe('320px');
  });

  it('keeps the cursor offset when there is room, and floors the top edge', async () => {
    window.innerWidth = 1024;
    await renderGraph();
    await hoverNode(GRAPH.nodes[1], { x: 100, y: 4 });

    const tooltip = tooltipOf(screen.getByText('second'));
    expect(tooltip.style.left).toBe('112px');
    // `y - 12` would be -8, floating the tooltip above the window.
    expect(tooltip.style.top).toBe('8px');
  });

  it('is suppressed on a coarse pointer rather than flashing under a finger', async () => {
    await renderGraph();
    await hoverNode(GRAPH.nodes[0], { x: 100, y: 100 });
    expect(tooltipOf(screen.getByText('first'))).toHaveClass('pointer-coarse:hidden');
  });
});

// Ported from BrainGraph via the graph3d extraction (#6828) — before this,
// MemoryGraph never read the system preference at all, so the canvas always
// ran its render loop and OrbitControls kept inertia regardless.
describe('reduced motion', () => {
  it('reads the system preference and renders the canvas on demand', async () => {
    window.matchMedia = vi.fn(() => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {}
    }));

    await renderGraph();

    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    expect(screen.getByTestId('graph-canvas')).toHaveAttribute('data-frameloop', 'demand');
  });
});

// Ported from BrainGraph via the graph3d extraction (#6828) — before this,
// MemoryGraph had no touch-pick wiring at all: a finger tap never selected a
// node because the raw mesh raycast needs a hit on a ~10px sphere.
describe('touch tap-to-select', () => {
  it('selects the node the wrapper-owned screen-space pick resolves to', async () => {
    await renderGraph();
    const canvas = screen.getByTestId('graph-canvas');

    // GraphScene never mounts in this suite (see the Canvas mock above), so
    // its own pickRef effect (a real screen-space projection) never runs —
    // stand in for it exactly as the scene would, via the same ref MemoryGraph
    // handed it as a prop.
    sceneElement.props.pickRef.current = () => GRAPH.nodes[1];

    fireEvent.pointerDown(canvas, { pointerType: 'touch', isPrimary: true, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(canvas, { pointerType: 'touch', clientX: 52, clientY: 51 });
    await act(async () => {});

    expect(await screen.findByText('second')).toBeInTheDocument();
  });
});

// Each page's edge callbacks preserve its own pre-extraction render (see
// GraphEdges' `edgeColor`/`edgeIntensity` params) — MemoryGraph's flat
// blue-linked/gray-everything-else, weight-scaled for BOTH edge kinds, unlike
// BrainGraph's flat intensity for "linked" (BrainGraph.test.jsx).
describe('edge appearance (graph3d extraction)', () => {
  it('colors only linked edges blue; everything else gray', () => {
    expect(memoryEdgeColor({ type: 'linked' })).toBe('#3b82f6');
    expect(memoryEdgeColor({ type: 'similar' })).toBe('#6b7280');
  });

  it('scales both edge kinds by weight, unlike BrainGraph\'s flat linked intensity', () => {
    expect(memoryEdgeIntensity({ type: 'linked', weight: 0.5 }, false)).toBeCloseTo(0.3);
    expect(memoryEdgeIntensity({ type: 'similar', weight: 0.5 }, false)).toBeCloseTo(0.15);
    expect(memoryEdgeIntensity({ type: 'linked', weight: 1 }, true)).toBe(0.06);
  });
});
