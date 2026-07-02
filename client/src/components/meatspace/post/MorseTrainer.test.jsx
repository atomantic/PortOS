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

import MorseTrainer, { MODES, MORSE_MODE_IDS } from './MorseTrainer';
import { submitTrainingEntry, getTrainingStats } from '../../../services/api';

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
});
