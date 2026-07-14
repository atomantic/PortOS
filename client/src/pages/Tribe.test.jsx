import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

vi.mock('../services/api', () => ({
  getTribePeople: vi.fn(() => Promise.resolve({ people: [] })),
}));

vi.mock('../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

import Tribe from './Tribe';
import * as api from '../services/api';

// Surfaces the current URL (path + search) so tests can assert deep-link state.
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

const renderAt = (entry) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Tribe />
      <LocationProbe />
    </MemoryRouter>
  );

describe('Tribe deep-linkable tabs', () => {
  beforeEach(() => {
    api.getTribePeople.mockClear();
    // localStorage is used for the legacy-import path; keep it empty.
    window.localStorage.clear();
  });

  it('opens the tab named in the URL (?tab=focus)', async () => {
    renderAt('/tribe?tab=focus');
    // FocusPanel is the only tab that renders the "Energy Mix" panel.
    expect(await screen.findByText('Energy Mix')).toBeTruthy();
  });

  it('falls back to the default Circle tab for an unknown tab value', async () => {
    renderAt('/tribe?tab=bogus');
    // The Circle tab owns the "Search relationships" filter input.
    expect(await screen.findByPlaceholderText('Search relationships')).toBeTruthy();
  });

  it('writes the active tab to the URL when a tab is selected', async () => {
    renderAt('/tribe');
    await screen.findByPlaceholderText('Search relationships');
    fireEvent.click(screen.getByRole('tab', { name: /Focus/i }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/tribe?tab=focus')
    );
  });

  it('omits the default tab from the URL when returning to Circle', async () => {
    renderAt('/tribe?tab=focus');
    await screen.findByText('Energy Mix');
    fireEvent.click(screen.getByRole('tab', { name: /Circle/i }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/tribe')
    );
  });

  it('preserves a non-default tab when the Add action fires a functional update', async () => {
    // "Add" calls startNewRelationship, which uses a functional setActiveTab
    // updater that keeps the current tab unless it is focus/map. On Care it must
    // resolve against the fresh URL and stay on care — not fall back to circle.
    renderAt('/tribe?tab=care');
    await screen.findByRole('button', { name: 'Add' });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/tribe?tab=care')
    );
  });
});
