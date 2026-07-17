import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The three.js stack can't run in jsdom (no WebGL context), and none of it is
// under test here — this file covers the responsive chrome AROUND the canvas.
// The stub deliberately drops `children`: rendering the scene would mount
// <bufferGeometry>/<mesh> as unknown DOM elements, and the r3f refs they hand
// back are HTMLElements without the three.js geometry API.
vi.mock('@react-three/fiber', () => ({
  Canvas: () => <div data-testid="graph-canvas" />,
}));
vi.mock('@react-three/drei', () => ({ OrbitControls: () => null }));

vi.mock('../../../services/api', () => ({
  getBrainGraph: vi.fn(),
  getBrainGraphSearchIndex: vi.fn(),
  getEmbeddingsStatus: vi.fn(),
  syncBrainData: vi.fn(),
  getBrainPerson: vi.fn(),
  getBrainProject: vi.fn(),
  getBrainIdea: vi.fn(),
  getBrainAdminItem: vi.fn(),
  getBrainMemory: vi.fn(),
  getBrainGoal: vi.fn(),
  getBrainJournalEntry: vi.fn(),
}));

import * as api from '../../../services/api';
import BrainGraph from './BrainGraph';

const GRAPH = {
  hasEmbeddings: true,
  nodes: [
    { id: 'n1', label: 'Alpha', brainType: 'ideas', importance: 0.5, summary: 'first' },
    { id: 'n2', label: 'Beta', brainType: 'goals', importance: 0.5, summary: 'second' },
  ],
  edges: [{ source: 'n1', target: 'n2', type: 'linked', weight: 0.9 }],
};

const renderGraph = async () => {
  render(<BrainGraph />);
  // Settle the mount-effect fetches inside act (see src/test/setup.js).
  await act(async () => {});
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getBrainGraph.mockResolvedValue(GRAPH);
  api.getBrainGraphSearchIndex.mockResolvedValue({ nodes: [] });
  api.getEmbeddingsStatus.mockResolvedValue({ missing: 0, total: 2 });
});

// The legend is ten rows tall and sits over the canvas, which blankets a
// phone-sized graph — so on mobile it hides behind a toggle. It must stay
// reachable (the edge colours appear nowhere else) rather than be dropped.
describe('legend disclosure', () => {
  it('starts collapsed and expands when the mobile toggle is pressed', async () => {
    const user = userEvent.setup();
    await renderGraph();

    const toggle = screen.getByRole('button', { name: /legend/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // `hidden` is the mobile-collapsed state — the panel stays in the DOM, and
    // `sm:block` re-shows it on desktop regardless of this flag.
    expect(screen.getByTestId('graph-legend')).toHaveClass('hidden');

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('graph-legend')).not.toHaveClass('hidden');
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

  it('keeps the edge-colour key reachable — it appears nowhere else in the tab', async () => {
    await renderGraph();
    // The type colours are duplicated by the filter row, but similar/shared
    // tag/linked only exist here, so the mobile collapse must not drop them.
    for (const label of ['similar', 'shared tag', 'linked']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});

describe('canvas sizing', () => {
  it('sizes the canvas relative to the viewport, not a fixed pixel height', async () => {
    await renderGraph();
    const shell = screen.getByTestId('graph-canvas').parentElement;
    // The regression guarded here is a fixed height (the old
    // `style={{ height: '500px' }}`), which overflowed a landscape phone and
    // left no room to scroll past a canvas that swallows drags. The exact
    // clamp values are free to be tuned, so only assert it's viewport-relative.
    expect(shell.style.height).toBe('');
    expect(shell.className).toMatch(/h-\[clamp\([^\]]*vh[^\]]*\)\]/);
  });
});
