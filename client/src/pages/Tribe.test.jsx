import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';

vi.mock('../services/api', () => ({
  getTribePeople: vi.fn(() => Promise.resolve({ people: [] })),
  // OutreachQueue (care tab) fetches unanswered threads on mount (#2158).
  getTribeOutreach: vi.fn(() => Promise.resolve({ threads: [] })),
  createTribeTouchpoint: vi.fn(),
}));

vi.mock('../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

import Tribe from './Tribe';
import * as api from '../services/api';

afterEach(() => {
  vi.useRealTimers();
});

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

const isoDaysAgo = (days) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
};

// Obviously-fake people covering each cadence state.
const PEOPLE = [
  { id: 'p1', name: 'Example Person', ring: 'tribe', cadenceDays: 45, lastContact: isoDaysAgo(200) }, // overdue
  { id: 'p2', name: 'Sample Neighbor', ring: 'core', cadenceDays: 21, lastContact: isoDaysAgo(18) }, // soon (3d left)
  { id: 'p3', name: 'Placeholder Pal', ring: 'tribe', cadenceDays: 45, lastContact: isoDaysAgo(1) }, // steady
];

describe('Tribe deep-linkable tabs', () => {
  beforeEach(() => {
    api.getTribePeople.mockClear();
    api.getTribePeople.mockResolvedValue({ people: [] });
    // localStorage is used for the legacy-import path; keep it empty.
    window.localStorage.clear();
  });

  it('opens the tab named in the URL (?tab=focus)', async () => {
    renderAt('/tribe?tab=focus');
    // FocusPanel is the only tab that renders the "Energy Mix" panel.
    expect(await screen.findByText('Energy Mix')).toBeTruthy();
  });

  it('falls back to the default Care Queue tab for an unknown tab value', async () => {
    api.getTribePeople.mockResolvedValue({ people: PEOPLE });
    renderAt('/tribe?tab=bogus');
    // The Care Queue leads with the care filter bar and Touch buttons; the
    // Circle tab's search field is not on the first screen.
    expect(await screen.findByRole('group', { name: 'Care filter' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Touch/ }).length).toBeGreaterThan(0);
    expect(screen.queryByPlaceholderText('Search relationships')).toBeNull();
  });

  it('writes the active tab to the URL when a tab is selected', async () => {
    renderAt('/tribe');
    await screen.findByRole('tab', { name: /Focus/i });
    fireEvent.click(screen.getByRole('tab', { name: /Focus/i }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/tribe?tab=focus')
    );
  });

  it('omits the default tab from the URL when returning to the Care Queue', async () => {
    renderAt('/tribe?tab=focus');
    await screen.findByText('Energy Mix');
    fireEvent.click(screen.getByRole('tab', { name: /Care Queue/i }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/tribe')
    );
  });

  it('preserves a non-default tab when the Add action fires a functional update', async () => {
    // "Add" calls startNewRelationship, which uses a functional setActiveTab
    // updater that keeps the current tab unless it is focus/map. On Circle it must
    // resolve against the fresh URL and stay on circle — not fall back to care.
    renderAt('/tribe?tab=circle');
    await screen.findByRole('button', { name: 'Add' });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/tribe?tab=circle')
    );
  });
});

describe('Tribe care filter', () => {
  beforeEach(() => {
    api.getTribePeople.mockClear();
    api.getTribePeople.mockResolvedValue({ people: PEOPLE });
    window.localStorage.clear();
  });

  it('filters the care queue to overdue people when the Needs Care tile is clicked', async () => {
    renderAt('/tribe');
    await screen.findByText('Example Person');
    fireEvent.click(screen.getByRole('button', { name: /^Needs Care \d/ }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/tribe?status=overdue')
    );
    expect(screen.getByText('Example Person')).toBeTruthy();
    expect(screen.queryByText('Placeholder Pal')).toBeNull();
    expect(screen.queryByText('Sample Neighbor')).toBeNull();
  });

  it('clears the filter when the active tile is clicked again', async () => {
    renderAt('/tribe?status=overdue');
    await screen.findByText('Example Person');
    fireEvent.click(screen.getByRole('button', { name: /^Needs Care \d/ }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/tribe')
    );
    expect(await screen.findByText('Placeholder Pal')).toBeTruthy();
  });

  it('routes the Coming Up tile into the care tab from another tab', async () => {
    renderAt('/tribe?tab=circle');
    await screen.findByPlaceholderText('Search relationships');
    fireEvent.click(screen.getByRole('button', { name: /^Coming Up \d/ }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/tribe?status=soon')
    );
    expect(await screen.findByText('Sample Neighbor')).toBeTruthy();
    expect(screen.queryByText('Example Person')).toBeNull();
  });

  it('applies a deep-linked status filter to the Circle roster', async () => {
    renderAt('/tribe?tab=circle&status=overdue');
    expect(await screen.findByText('Example Person')).toBeTruthy();
    expect(screen.queryByText('Placeholder Pal')).toBeNull();
  });

  it('records a manual touch on the local calendar date', async () => {
    vi.setSystemTime(new Date(2026, 0, 1, 20));
    api.createTribeTouchpoint.mockResolvedValue({ id: 'touch-1' });

    renderAt('/tribe');
    await screen.findByText('Example Person');
    fireEvent.click(screen.getAllByRole('button', { name: 'Touch' })[0]);

    await waitFor(() => expect(api.createTribeTouchpoint).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ localDate: '2026-01-01' }),
      { silent: true },
    ));
    expect(await screen.findByText('Last 2026-01-01')).toBeTruthy();
  });
});
