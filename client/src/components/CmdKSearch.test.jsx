import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { RECENT_KEY } from '../utils/navWorkingSet.js';

const getPaletteManifest = vi.fn();
const getDashboardLayouts = vi.fn();

vi.mock('../services/api', () => ({
  search: vi.fn(() => Promise.resolve({ sources: [] })),
  getPaletteManifest: (...args) => getPaletteManifest(...args),
  runPaletteAction: vi.fn(() => Promise.resolve({ ok: true })),
  getDashboardLayouts: (...args) => getDashboardLayouts(...args),
  setActiveDashboardLayout: vi.fn(() => Promise.resolve()),
  listCatalogIngredients: vi.fn(() => Promise.resolve({ items: [] })),
}));

import CmdKSearch from './CmdKSearch.jsx';

const NAV = [
  { id: 'nav.dashboard', path: '/', label: 'Dashboard', section: 'Home', aliases: [], keywords: [] },
  { id: 'nav.apps', path: '/apps', label: 'Apps', section: 'System', aliases: [], keywords: [] },
  { id: 'nav.brain.inbox', path: '/brain/inbox', label: 'Brain Inbox', section: 'Brain', aliases: [], keywords: [] },
  { id: 'nav.goals', path: '/goals', label: 'Goals', section: 'Life', aliases: [], keywords: [] },
  { id: 'nav.current', path: '/current', label: 'Current Page', section: 'Test', aliases: [], keywords: [] },
];

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

beforeEach(() => {
  getPaletteManifest.mockResolvedValue({ nav: NAV, actions: [] });
  getDashboardLayouts.mockResolvedValue({ layouts: [] });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe('CmdKSearch recent destinations', () => {
  it('leads with shared nav history, resolves deep links, and fills with non-duplicate defaults', async () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([
      '/current',
      '/apps/example-app',
      '/brain/inbox',
      '/stale-route',
    ]));

    render(
      <MemoryRouter initialEntries={['/current']}>
        <CmdKSearch />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    await screen.findByText('Recent destinations');
    await act(async () => {});

    const options = screen.getAllByRole('option');
    expect(within(options[0]).getByText('Apps')).toBeInTheDocument();
    expect(within(options[0]).getByText(/\/apps\/example-app/)).toBeInTheDocument();
    expect(within(options[1]).getByText('Brain Inbox')).toBeInTheDocument();
    expect(screen.getAllByText('Brain Inbox')).toHaveLength(1);
    expect(screen.queryByText('Current Page')).not.toBeInTheDocument();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();

    fireEvent.click(options[0]);
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/apps/example-app'));
  });
});
