import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The three.js stack can't run in jsdom (no WebGL context), and none of it is
// under test here — this file covers the responsive chrome AROUND the canvas.
// The stub deliberately drops `children`: rendering the scene would mount
// <bufferGeometry>/<mesh> as unknown DOM elements, and the r3f refs they hand
// back are HTMLElements without the three.js geometry API.
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ frameloop }) => <div data-testid="graph-canvas" data-frameloop={frameloop} />,
  // GraphScene reads the live camera through this; it is never rendered here,
  // but the named import has to resolve.
  useThree: () => ({ camera: null, size: { width: 0, height: 0 } }),
}));
vi.mock('@react-three/drei', () => ({ OrbitControls: () => null }));

// Brain-type badges grade their category hex against the ACTIVE theme mode, so
// the mode has to be steerable per test. The real provider runs a settings
// fetch on mount, which this suite has no business exercising.
const { themeMode } = vi.hoisted(() => ({ themeMode: { current: 'night' } }));
vi.mock('../../ThemeContext', () => ({
  useThemeContext: () => ({ theme: { mode: themeMode.current } }),
}));

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
  getSong: vi.fn(),
}));

import * as api from '../../../services/api';
import { chipColors, parseColor } from '../../../lib/chipContrast';
import { BRAIN_TYPE_HEX } from '../constants';
import BrainGraph, { graphMotionSettings, recordBody } from './BrainGraph';

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

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  vi.clearAllMocks();
  api.getBrainGraph.mockResolvedValue(GRAPH);
  api.getBrainGraphSearchIndex.mockResolvedValue({ nodes: [] });
  api.getEmbeddingsStatus.mockResolvedValue({ missing: 0, total: 2 });
  // Selecting a node calls its per-type getter and chains `.then` on the
  // result — a bare vi.fn() returns undefined and throws, so give every getter
  // a resolved default and let individual tests override the one they assert.
  for (const getter of [
    api.getBrainPerson, api.getBrainProject, api.getBrainIdea, api.getBrainAdminItem,
    api.getBrainMemory, api.getBrainGoal, api.getBrainJournalEntry, api.getSong,
  ]) getter.mockResolvedValue(null);
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

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

  it('stops the canvas render loop and OrbitControls inertia when motion is reduced', () => {
    expect(graphMotionSettings(true)).toEqual({ frameloop: 'demand', enableDamping: false });
  });

  it('keeps animated rendering and controls for users without the preference', () => {
    expect(graphMotionSettings(false)).toEqual({ frameloop: 'always', enableDamping: true });
  });
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

  it('gates the auto-show on viewport height as well as width', async () => {
    await renderGraph();
    // A landscape phone is WIDER than `sm` but only ~390px tall, so a width-only
    // (`sm:`) gate force-showed the ~200px legend over a floored 240px canvas
    // while hiding the toggle — un-dismissable, in the exact case this targets.
    // `roomy-viewport` (index.css) is width AND height; a bare `sm:` regresses it.
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

  it('keeps the edge-colour key reachable — it appears nowhere else in the tab', async () => {
    await renderGraph();
    // The type colours are duplicated by the filter row, but similar/shared
    // tag/linked only exist here, so the mobile collapse must not drop them.
    for (const label of ['similar', 'shared tag', 'linked']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});

describe('type filters', () => {
  it('shows a keyboard focus ring and toggles with Space', async () => {
    const user = userEvent.setup();
    await renderGraph();

    const checkbox = screen.getByRole('checkbox', { name: 'Ideas' });
    const swatch = checkbox.nextElementSibling;

    expect(checkbox).toHaveClass('peer', 'sr-only');
    expect(swatch).toHaveClass(
      'peer-focus-visible:ring-2',
      'peer-focus-visible:ring-port-accent',
      'peer-focus-visible:ring-offset-1',
      'peer-focus-visible:ring-offset-port-bg',
    );
    expect(swatch.className).not.toMatch(/(^|\s)ring-/);

    expect(checkbox).toBeChecked();
    checkbox.focus();
    await user.keyboard(' ');
    expect(checkbox).not.toBeChecked();
  });
});

describe('detail panel', () => {
  // Tapping a node needs a WebGL raycast, so reach the panel the way a user on
  // a phone can: search → focus a node → tap one of its connections. That also
  // leaves focusId != selectedNode, which is when "Explore" actually renders.
  const selectConnectedNode = async (user) => {
    await user.type(screen.getByPlaceholderText(/search memories/i), 'Alpha');
    await user.click(await screen.findByRole('option', { name: /Alpha/i }));
    await act(async () => {});
    await user.click(await screen.findByRole('button', { name: /Beta/ }));
    await act(async () => {});
  };

  it('keeps "Explore connections" above the unbounded record body', async () => {
    const user = userEvent.setup();
    api.getBrainGraphSearchIndex.mockResolvedValue({
      nodes: [{ id: 'n1', label: 'Alpha', brainType: 'ideas' }],
    });
    // A journal/memory body is unclamped `whitespace-pre-wrap` — it can run for
    // screens, so the touch stand-in for double-click must precede it.
    api.getBrainGoal.mockResolvedValue({ content: 'long body '.repeat(400) });
    await renderGraph();
    await selectConnectedNode(user);

    const explore = screen.getByRole('button', { name: /explore connections/i });
    const body = screen.getByText(/long body/);
    // DOCUMENT_POSITION_FOLLOWING === the body comes after the button.
    expect(explore.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // `BRAIN_TYPE_HEX` is tuned for the near-black graph canvas, but this panel
  // follows the theme — `goals` #f97316 as verbatim text lands well under AA on
  // a day card. The AA math itself is `lib/chipContrast.test.js`'s job; what
  // this owns is that the badge is graded for the ACTIVE mode, not a fixed one.
  it.each(['day', 'night'])('grades the brain-type badge for the %s theme mode', async (mode) => {
    themeMode.current = mode;
    const user = userEvent.setup();
    api.getBrainGraphSearchIndex.mockResolvedValue({
      nodes: [{ id: 'n1', label: 'Alpha', brainType: 'ideas' }],
    });
    await renderGraph();
    await selectConnectedNode(user);

    // "Goals" also names a type-filter toggle in the header; only the detail
    // badge carries an inline ink.
    const badge = screen.getAllByText('Goals').find((el) => el.style.color);
    expect(badge, 'no brain-type badge carries a graded inline color').toBeDefined();
    const other = mode === 'day' ? 'night' : 'day';
    // parseColor on both sides: jsdom normalizes an inline `#rrggbb` to `rgb(…)`.
    expect(parseColor(badge.style.color))
      .toEqual(parseColor(chipColors(BRAIN_TYPE_HEX.goals, mode).color));
    expect(parseColor(badge.style.color))
      .not.toEqual(parseColor(chipColors(BRAIN_TYPE_HEX.goals, other).color));
    // The graded style is inline, so the badge must not also carry a theme
    // utility that `index.css` remaps with `!important`.
    expect(badge.className).not.toMatch(/(^|\s)(text-white|text-gray-\d00|border-port-border)(\s|$)/);
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

describe('recordBody (SongBook nodes, #4105)', () => {
  it('never returns a non-string field — a song\'s `content` is an object', () => {
    // Rendering `{ format, text }` into the panel throws "Objects are not valid
    // as a React child", so the chain must type-check every candidate rather
    // than `||` its way into the sheet body.
    const song = { title: 'Example Song', content: { format: 'chordpro', text: '[C]la' } };
    expect(recordBody(song)).toBe('');
    expect(recordBody({ ...song, artist: 'Placeholder Band' })).toBe('Placeholder Band');
    expect(recordBody({ ...song, artist: 'Placeholder Band', notes: 'Bridge needs work' }))
      .toBe('Placeholder Band');
  });

  it('still reads a string `content` (memories, journals) and prefers description', () => {
    expect(recordBody({ content: 'a good day' })).toBe('a good day');
    expect(recordBody({ description: 'goal blurb', notes: 'aside' })).toBe('goal blurb');
    expect(recordBody(null)).toBe('');
    expect(recordBody({})).toBe('');
  });
});
