import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

vi.mock('../services/api', () => ({
  getNotesVaults: vi.fn(),
  scanNotesVault: vi.fn(),
}));

// Stub the tab bodies — this suite only exercises vault selection + URL wiring.
vi.mock('../components/wiki/tabs/OverviewTab', () => ({
  default: ({ vaultId }) => <div data-testid="overview">overview:{vaultId || 'none'}</div>,
}));
vi.mock('../components/wiki/tabs/BrowseTab', () => ({ default: () => <div>browse</div> }));
vi.mock('../components/wiki/tabs/SearchTab', () => ({ default: () => <div>search</div> }));
vi.mock('../components/wiki/tabs/GraphTab', () => ({ default: () => <div>graph</div> }));
vi.mock('../components/wiki/tabs/LogTab', () => ({ default: () => <div>log</div> }));

import Wiki from './Wiki';
import { getNotesVaults, scanNotesVault } from '../services/api';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

const renderWiki = (initialEntry) =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <Routes>
        <Route path="/wiki/:tab" element={<Wiki />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  getNotesVaults.mockResolvedValue([
    { id: 'vault-a', name: 'Vault A' },
    { id: 'vault-b', name: 'Vault B' },
  ]);
  scanNotesVault.mockResolvedValue({ notes: [] });
});

describe('Wiki vault URL wiring', () => {
  it('defaults to the first vault when no ?vault= param is present', async () => {
    renderWiki('/wiki/overview');
    await waitFor(() => expect(screen.getByTestId('overview')).toHaveTextContent('overview:vault-a'));
    expect(scanNotesVault).toHaveBeenCalledWith('vault-a', { limit: 1000 });
  });

  it('restores the selected vault from the ?vault= param', async () => {
    renderWiki('/wiki/overview?vault=vault-b');
    await waitFor(() => expect(screen.getByTestId('overview')).toHaveTextContent('overview:vault-b'));
    expect(scanNotesVault).toHaveBeenCalledWith('vault-b', { limit: 1000 });
  });

  it('writes the chosen vault to the URL when selecting from the dropdown', async () => {
    renderWiki('/wiki/overview');
    await waitFor(() => expect(screen.getByTestId('overview')).toHaveTextContent('overview:vault-a'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'vault-b' } });
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/wiki/overview?vault=vault-b'),
    );
    await waitFor(() => expect(screen.getByTestId('overview')).toHaveTextContent('overview:vault-b'));
  });

  it('renders a not-found fallback for a stale/deleted vault id', async () => {
    renderWiki('/wiki/overview?vault=deleted');
    await waitFor(() => expect(screen.getByText('Vault not found')).toBeInTheDocument());
    expect(screen.queryByTestId('overview')).not.toBeInTheDocument();
    // Clearing the param recovers the default vault.
    fireEvent.click(screen.getByRole('button', { name: /show default vault/i }));
    await waitFor(() => expect(screen.getByTestId('overview')).toHaveTextContent('overview:vault-a'));
  });
});
