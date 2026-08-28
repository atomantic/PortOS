import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { RECENT_KEY } from '../utils/navWorkingSet.js';

const getPaletteManifest = vi.fn();
const getInstanceFeatures = vi.fn();
const getDashboardLayouts = vi.fn();
const search = vi.fn(() => Promise.resolve({ sources: [] }));

vi.mock('../services/api', () => ({
  search: (...args) => search(...args),
  getPaletteManifest: (...args) => getPaletteManifest(...args),
  getInstanceFeatures: (...args) => getInstanceFeatures(...args),
  runPaletteAction: vi.fn(() => Promise.resolve({ ok: true })),
  getDashboardLayouts: (...args) => getDashboardLayouts(...args),
  setActiveDashboardLayout: vi.fn(() => Promise.resolve()),
  listCatalogIngredients: vi.fn(() => Promise.resolve({ items: [] })),
}));

import { __resetInstanceFeatureCache } from '../hooks/useInstanceFeatures.js';
import CmdKSearch from './CmdKSearch.jsx';

const NAV = [
  { id: 'nav.dashboard', path: '/', label: 'Dashboard', section: 'Home', aliases: [], keywords: [] },
  { id: 'nav.apps', path: '/apps', label: 'Apps', section: 'System', aliases: [], keywords: [] },
  { id: 'nav.brain.inbox', path: '/brain/inbox', label: 'Brain Inbox', section: 'Brain', aliases: [], keywords: [] },
  { id: 'nav.goals', path: '/goals', label: 'Goals', section: 'Life', aliases: [], keywords: [] },
  { id: 'nav.current', path: '/current', label: 'Current Page', section: 'Test', aliases: [], keywords: [] },
  // Gated on an optional instance feature — present in the manifest, hidden by
  // the palette whenever that feature is off.
  { id: 'nav.devtools.jira', path: '/devtools/jira', label: 'JIRA', section: 'Dev Tools', feature: 'jira', aliases: ['jira'], keywords: [] },
];

const FEATURES_ON = [{ id: 'jira', label: 'JIRA', enabled: true }];
const FEATURES_OFF = [{ id: 'jira', label: 'JIRA', enabled: false }];

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

beforeEach(() => {
  // The feature list is cached at module scope and shared with the sidebar.
  __resetInstanceFeatureCache();
  getInstanceFeatures.mockResolvedValue({ features: FEATURES_ON });
  getPaletteManifest.mockResolvedValue({ nav: NAV, actions: [] });
  getDashboardLayouts.mockResolvedValue({ layouts: [] });
  search.mockReset();
  search.mockResolvedValue({ sources: [] });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe('CmdKSearch dialog accessibility', () => {
  it('traps focus inside the modal and restores it to the opener on close', async () => {
    render(
      <MemoryRouter>
        <button type="button">Open palette shortcut</button>
        <CmdKSearch />
      </MemoryRouter>,
    );

    const opener = screen.getByRole('button', { name: 'Open palette shortcut' });
    opener.focus();
    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    const dialog = await screen.findByRole('dialog', { name: 'Command palette' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    const input = within(dialog).getByRole('textbox', { name: 'Command palette' });
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });
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

// The manifest ships gated entries tagged rather than filtered, so the palette
// has to apply the gate itself — filtering server-side would leave ⌘K offering
// hidden pages until a reload, because it fetches the manifest once per session.
describe('CmdKSearch instance feature gating', () => {
  const openAndSearch = async (query) => {
    render(
      <MemoryRouter initialEntries={['/current']}>
        <CmdKSearch />
        <LocationProbe />
      </MemoryRouter>,
    );
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    const input = await screen.findByRole('textbox', { name: 'Command palette' });
    fireEvent.change(input, { target: { value: query } });
    await act(async () => {});
  };

  it('offers a gated page while its feature is on', async () => {
    await openAndSearch('jira');
    expect(screen.getByText('JIRA')).toBeInTheDocument();
  });

  it('hides a gated page when its feature is off', async () => {
    getInstanceFeatures.mockResolvedValue({ features: FEATURES_OFF });

    await openAndSearch('jira');
    expect(screen.queryByText('JIRA')).not.toBeInTheDocument();
  });

  it('shows gated pages when the feature list cannot be read', async () => {
    getInstanceFeatures.mockRejectedValue(new Error('offline'));

    await openAndSearch('jira');
    expect(screen.getByText('JIRA')).toBeInTheDocument();
  });
});

describe('CmdKSearch global search staleness', () => {
  it('does not let a slow older-query response overwrite the newer query results', async () => {
    vi.useFakeTimers();

    // First (stale) query resolves late; second (current) query resolves fast.
    let resolveStale;
    const stalePromise = new Promise((res) => { resolveStale = res; });
    search
      .mockImplementationOnce(() => stalePromise)
      .mockImplementationOnce(() => Promise.resolve({
        sources: [{ id: 'brain', label: 'Brain', icon: 'Brain', results: [{ title: 'Fresh result', snippet: 'new', url: '/brain/x' }] }],
      }));

    render(
      <MemoryRouter initialEntries={['/current']}>
        <CmdKSearch />
      </MemoryRouter>,
    );

    await act(async () => {
      fireEvent.keyDown(document, { key: 'k', metaKey: true });
    });

    const input = screen.getByPlaceholderText(/Go to page/);

    // Type first query and let its debounce elapse so the stale request fires.
    await act(async () => { fireEvent.change(input, { target: { value: 'aa' } }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(search).toHaveBeenNthCalledWith(1, 'aa');

    // Type second query; its cleanup marks the first effect cancelled.
    await act(async () => { fireEvent.change(input, { target: { value: 'bb' } }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(search).toHaveBeenNthCalledWith(2, 'bb');

    // Now the stale response finally arrives — it must be ignored.
    await act(async () => {
      resolveStale({ sources: [{ id: 'brain', label: 'Brain', icon: 'Brain', results: [{ title: 'Stale result', snippet: 'old', url: '/brain/y' }] }] });
      await Promise.resolve();
    });

    expect(screen.getByText('Fresh result')).toBeInTheDocument();
    expect(screen.queryByText('Stale result')).not.toBeInTheDocument();

    vi.useRealTimers();
  });
});
