import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import MorseTrainer, { MODES, MORSE_MODE_IDS } from './MorseTrainer';

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
  it('exports the routed mode ids', () => {
    expect(MORSE_MODE_IDS).toEqual(['copy', 'send']);
    expect(MODES.map((m) => m.id)).toEqual(MORSE_MODE_IDS);
  });

  it('shows the mode grid and routes on pick (mode=null)', () => {
    const onSelectMode = vi.fn();
    renderMorse({ mode: null, onSelectMode });
    // Both mode cards render as pickable entries.
    fireEvent.click(screen.getByText('Copy'));
    expect(onSelectMode).toHaveBeenCalledWith('copy');
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
