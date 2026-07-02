import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

// Stub the training-log API so mount-time fetches (refreshTrainingStats) and
// round-completion writes (logTraining) never hit the network — mirrors the
// mocking convention used by PostDrillConfig.test.jsx / PostHistory.test.jsx.
vi.mock('../../../services/api', () => ({
  submitTrainingEntry: vi.fn(() => Promise.resolve({})),
  getTrainingStats: vi.fn(() => Promise.resolve({
    currentStreak: 3,
    byDrill: { 'morse:morse-copy': { practiceCount: 4, accuracy: 80, totalMs: 1000, daysActive: 2 } },
  })),
}));

import MorseTrainer, { MODES, MORSE_MODE_IDS, MORSE_TABLE, isNodeOnPath } from './MorseTrainer';
import { submitTrainingEntry, getTrainingStats } from '../../../services/api';

// Minimal Web Audio mock so CopyDrill's round flow (which calls ensureCtx →
// playMorse) can run in jsdom without a real AudioContext. No existing shared
// mock exists for this in the repo (each audio-consuming test file rolls its
// own) — mirrors that convention. `stop()` resolves playMorse's promise on
// the next tick, matching the real oscillator's `onended` callback shape.
class MockOscillator {
  constructor() { this.onended = null; this.frequency = { value: 0 }; }
  connect() { return this; }
  start() {}
  stop() { if (this.onended) setTimeout(() => this.onended(), 0); }
  disconnect() {}
}
class MockGainNode {
  constructor() {
    this.gain = { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} };
  }
  connect() { return this; }
  disconnect() {}
}
class MockAudioContext {
  constructor() { this.currentTime = 0; this.destination = {}; this.state = 'running'; }
  createOscillator() { return new MockOscillator(); }
  createGain() { return new MockGainNode(); }
  resume() {}
  close() {}
}

// Surfaces the live URL (path + search) so tests can assert the reference tab
// is encoded in the query string — the "URL is the source of truth" contract.
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}{loc.search}</div>;
}

function renderMorse(props = {}, { route = '/post/morse' } = {}) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route
          path="/post/morse"
          element={<><MorseTrainer {...props} /><LocationProbe /></>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MorseTrainer deep-linking', () => {
  beforeEach(() => {
    submitTrainingEntry.mockClear();
    getTrainingStats.mockClear();
  });

  it('exports the routed mode ids', () => {
    expect(MORSE_MODE_IDS).toEqual(['copy', 'head-copy', 'send']);
    expect(MODES.map((m) => m.id)).toEqual(MORSE_MODE_IDS);
  });

  it('shows the mode grid and routes on pick (mode=null)', () => {
    const onSelectMode = vi.fn();
    renderMorse({ mode: null, onSelectMode });
    // All three mode cards render as pickable entries.
    fireEvent.click(screen.getByText('Copy'));
    expect(onSelectMode).toHaveBeenCalledWith('copy');
    fireEvent.click(screen.getByText('Head Copy'));
    expect(onSelectMode).toHaveBeenCalledWith('head-copy');
    fireEvent.click(screen.getByText('Send'));
    expect(onSelectMode).toHaveBeenCalledWith('send');
  });

  it('defaults the reference tab to tree with no ?ref param', () => {
    renderMorse({ mode: null, onSelectMode: vi.fn() });
    // Tree view legend is unique to the tree reference.
    expect(screen.getByText('start')).toBeInTheDocument();
  });

  it('reads the reference tab from the ?ref search param', () => {
    renderMorse({ mode: null, onSelectMode: vi.fn() }, { route: '/post/morse?ref=length' });
    // Length view groups by symbol count.
    expect(screen.getByText('1 symbol')).toBeInTheDocument();
  });

  it('encodes the selected reference tab in the URL', () => {
    renderMorse({ mode: null, onSelectMode: vi.fn() });
    // Exact name — a loose /List/ also matches the "Listen to Morse" mode card.
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(screen.getByTestId('loc').textContent).toBe('/post/morse?ref=list');
  });

  it('drops the ?ref param when returning to the default tree tab', () => {
    renderMorse({ mode: null, onSelectMode: vi.fn() }, { route: '/post/morse?ref=list' });
    fireEvent.click(screen.getByRole('button', { name: 'Tree' }));
    expect(screen.getByTestId('loc').textContent).toBe('/post/morse');
  });
});

describe('MorseTrainer head-copy mode', () => {
  beforeEach(() => {
    submitTrainingEntry.mockClear();
    getTrainingStats.mockClear();
  });

  it('hides the reference cheat sheet and explains the audio-only rules', () => {
    renderMorse({ mode: 'head-copy', onSelectMode: vi.fn(), onExitMode: vi.fn() });
    // The Tree/Length/List reference tabs only render via ReferenceWidget,
    // which head-copy mode suppresses entirely.
    expect(screen.queryByRole('button', { name: 'Tree' })).not.toBeInTheDocument();
    expect(screen.getByText(/No code hints on the results screen/)).toBeInTheDocument();
  });

  it('keeps the reference widget visible in plain copy mode (unchanged behavior)', () => {
    renderMorse({ mode: 'copy', onSelectMode: vi.fn(), onExitMode: vi.fn() });
    expect(screen.getByRole('button', { name: 'Tree' })).toBeInTheDocument();
  });
});

describe('MorseTrainer training log integration', () => {
  beforeEach(() => {
    submitTrainingEntry.mockClear();
    getTrainingStats.mockClear();
  });

  it('fetches 30-day training stats on mount and renders the streak summary', async () => {
    const { container } = renderMorse({ mode: null, onSelectMode: vi.fn() });
    expect(getTrainingStats).toHaveBeenCalledWith(30);
    await waitFor(() => {
      expect(container.textContent).toContain('Training streak: 3d');
    });
    expect(container.textContent).toContain('Morse logged: 4');
    expect(container.textContent).toContain('80% avg');
  });

  it('logs a completed Head Copy round to the training log with the right payload shape', async () => {
    window.AudioContext = MockAudioContext;
    renderMorse({ mode: 'head-copy', onSelectMode: vi.fn(), onExitMode: vi.fn() });

    fireEvent.click(await screen.findByRole('button', { name: /Start Round/i }));

    // 10-question round (ROUND_SIZE): submit a deliberately wrong guess each
    // time so correctCount is deterministic (0), then advance past feedback.
    for (let i = 0; i < 10; i++) {
      const input = await screen.findByPlaceholderText('????');
      fireEvent.change(input, { target: { value: 'ZZZZZ' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      if (i < 9) {
        const nextButton = await screen.findByRole('button', { name: /Next/i });
        fireEvent.click(nextButton);
      }
    }

    await waitFor(() => {
      expect(submitTrainingEntry).toHaveBeenCalledWith(expect.objectContaining({
        module: 'morse',
        drillType: 'morse-head-copy',
        questionCount: 10,
        correctCount: 0,
      }));
    });
    delete window.AudioContext;
  });
});

describe('MorseTrainer Tree reference view', () => {
  it('renders a labeled, reachable node for all 41 characters', () => {
    const { container } = renderMorse({ mode: null, onSelectMode: vi.fn() });
    // Every node (including the root) carries its own morse code (or 'start'
    // for the root) as its `title` — the most reliable way to pick each tree
    // node out individually, since letter text alone can collide with other
    // on-screen content (e.g. mode-card labels).
    const chars = Object.keys(MORSE_TABLE);
    for (const ch of chars) {
      const code = MORSE_TABLE[ch];
      const node = container.querySelector(`[title="${code}"]`);
      expect(node, `expected a tree node for "${ch}" (${code})`).toBeTruthy();
      expect(node.textContent).toBe(ch);
    }
  });

  it('centers the start node roughly under "start", not pinned to one edge', () => {
    const { container } = renderMorse({ mode: null, onSelectMode: vi.fn() });
    const root = container.querySelector('[title="start"]');
    expect(root).toBeTruthy();
    expect(root.textContent).toBe('·');
    // Regression guard for the reported bug: the root previously rendered
    // displaced toward the DIT side. Its computed x-slot should sit near the
    // horizontal middle of the tree's total width, not near either edge.
    const treeContainer = root.closest('.relative.mx-auto');
    const totalWidth = parseFloat(treeContainer.style.width);
    const rootLeft = parseFloat(root.style.left);
    expect(rootLeft).toBeGreaterThan(totalWidth * 0.3);
    expect(rootLeft).toBeLessThan(totalWidth * 0.7);
  });
});

describe('isNodeOnPath (live keying highlight gate)', () => {
  // Root's placeholder char is '·' (truthy) and its code is '' — an idle/empty
  // currentPath must not make it read as "matched", or the reference tree lights
  // up the root before the user has keyed anything.
  const root = { char: '·', code: '' };
  const e = { char: 'E', code: '.' };
  const i = { char: 'I', code: '..' };
  const t = { char: 'T', code: '-' };

  it('does not match or highlight the root when currentPath is empty', () => {
    expect(isNodeOnPath(root, '')).toEqual({ matched: false, onPath: false });
  });

  it('matches a node whose code equals the current keyed path', () => {
    expect(isNodeOnPath(i, '..')).toEqual({ matched: true, onPath: false });
  });

  it('marks an ancestor of the current path as onPath but not matched', () => {
    // 'e' ('.') is a prefix of the in-progress path '..' but is not the
    // fully-keyed node itself.
    expect(isNodeOnPath(e, '..')).toEqual({ matched: false, onPath: true });
  });

  it('does not flag a node unrelated to the current path', () => {
    expect(isNodeOnPath(t, '..')).toEqual({ matched: false, onPath: false });
  });
});
