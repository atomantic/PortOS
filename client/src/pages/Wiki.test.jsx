import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Navigate, useLocation } from 'react-router';

vi.mock('../services/api', () => ({
  getNotesVaults: vi.fn(),
  scanNotesVault: vi.fn(),
  getNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
}));

// Keep Browse real: vault selection must be tested through its editor and
// mutation boundary, not only through the parent route's vaultId prop.
vi.mock('../components/wiki/tabs/OverviewTab', () => ({
  default: ({ vaultId }) => <div data-testid="overview">overview:{vaultId || 'none'}</div>,
}));
vi.mock('../components/wiki/tabs/SearchTab', () => ({ default: () => <div>search</div> }));
vi.mock('../components/wiki/tabs/GraphTab', () => ({ default: () => <div>graph</div> }));
vi.mock('../components/wiki/tabs/LogTab', () => ({ default: () => <div>log</div> }));

import Wiki, { TABS } from './Wiki';
import { getNotesVaults, scanNotesVault, getNote, updateNote, deleteNote } from '../services/api';
import { expectPageNavTabs } from '../test/pageNavTabAssertions.js';

describe('Wiki TABS ↔ nav manifest', () => {
  it('renders the wiki tabGroup in page order with a presentation entry each', () => {
    expectPageNavTabs(TABS, [
      'overview:Overview', 'browse:Browse', 'search:Search', 'graph:Graph', 'log:Log',
    ]);
  });
});

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

// Mirrors App.jsx's RedirectWithSearch so the base /wiki redirect keeps ?vault=.
function RedirectWithSearch({ to }) {
  const { search, hash } = useLocation();
  return <Navigate to={`${to}${search}${hash}`} replace />;
}

const renderWiki = (initialEntry) =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <Routes>
        <Route path="/wiki" element={<RedirectWithSearch to="/wiki/overview" />} />
        <Route path="/wiki/:tab" element={<Wiki />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.resetAllMocks();
  getNotesVaults.mockResolvedValue([
    { id: 'vault-a', name: 'Vault A' },
    { id: 'vault-b', name: 'Vault B' },
  ]);
  scanNotesVault.mockResolvedValue({ notes: [] });
});

const noteA = {
  path: 'wiki/index.md', name: 'Example A', folder: 'wiki', content: 'Example A body',
  size: 14, modifiedAt: '2026-01-01T00:00:00Z',
};
const noteB = { ...noteA, name: 'Example B', content: 'Example B body' };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

describe('Wiki vault editor isolation', () => {
  beforeEach(() => {
    scanNotesVault.mockImplementation(async id => ({ notes: [id === 'vault-a' ? noteA : noteB] }));
    getNote.mockImplementation(async id => id === 'vault-a' ? noteA : noteB);
    updateNote.mockImplementation(async (id, path, content) => ({ ...(id === 'vault-a' ? noteA : noteB), path, content }));
    deleteNote.mockResolvedValue(null);
  });

  const switchToB = () => fireEvent.change(screen.getByRole('combobox', { name: 'Vault' }), { target: { value: 'vault-b' } });
  const openA = () => renderWiki('/wiki/browse?vault=vault-a&note=wiki%2Findex.md');

  it('loads the destination note before editing or deleting a shared path in another vault', async () => {
    openA();
    await screen.findByText(noteA.content);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note content' }), { target: { value: 'Example A draft' } });

    switchToB();
    await screen.findByText(noteB.content);
    expect(screen.queryByRole('textbox', { name: 'Note content' })).not.toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/wiki/browse?vault=vault-b&note=wiki%2Findex.md');
    expect(getNote).toHaveBeenCalledWith('vault-b', noteB.path);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('textbox', { name: 'Note content' })).toHaveValue(noteB.content);
    fireEvent.change(screen.getByRole('textbox', { name: 'Note content' }), { target: { value: 'Example B edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Example B edited');
    expect(updateNote.mock.calls).toEqual([['vault-b', noteB.path, 'Example B edited', { force: false }]]);

    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteNote).toHaveBeenCalledWith('vault-b', noteB.path));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/wiki/browse?vault=vault-b'));
  });

  it('ignores a previous vault scan and note read that finish after the destination has loaded', async () => {
    const scanA = deferred();
    const readA = deferred();
    scanNotesVault.mockImplementation(id => id === 'vault-a' ? scanA.promise : Promise.resolve({ notes: [noteB] }));
    getNote.mockImplementation(id => id === 'vault-a' ? readA.promise : Promise.resolve(noteB));
    openA();
    await waitFor(() => expect(getNote).toHaveBeenCalledWith('vault-a', noteA.path));

    switchToB();
    await screen.findByText(noteB.content);
    await act(async () => {
      scanA.resolve({ notes: [noteA] });
      readA.resolve(noteA);
    });
    expect(screen.getByText(noteB.content)).toBeInTheDocument();
    expect(screen.queryByText(noteA.name)).not.toBeInTheDocument();
    expect(screen.queryByText(noteA.content)).not.toBeInTheDocument();
  });

  it('keeps a destination draft intact when a previous vault save completes', async () => {
    const saveA = deferred();
    updateNote.mockReturnValue(saveA.promise);
    openA();
    await screen.findByText(noteA.content);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateNote).toHaveBeenCalledWith('vault-a', noteA.path, noteA.content, { force: false }));

    switchToB();
    await screen.findByText(noteB.content);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note content' }), { target: { value: 'Example B draft' } });
    await act(async () => { saveA.resolve({ ...noteA, content: 'Example A saved' }); });
    expect(screen.getByRole('textbox', { name: 'Note content' })).toHaveValue('Example B draft');
    expect(scanNotesVault.mock.calls.filter(([id]) => id === 'vault-a')).toHaveLength(1);
    expect(screen.getByTestId('location')).toHaveTextContent('/wiki/browse?vault=vault-b&note=wiki%2Findex.md');
  });

  it('keeps the URL-selected page when an earlier note read in the same vault finishes late', async () => {
    const readA = deferred();
    const second = { ...noteA, path: 'wiki/second.md', name: 'Second page', content: 'Second page body' };
    scanNotesVault.mockResolvedValue({ notes: [noteA, second] });
    getNote.mockImplementation((_id, path) => path === noteA.path ? readA.promise : Promise.resolve(second));
    openA();
    fireEvent.click(await screen.findByRole('button', { name: second.name }));
    await screen.findByText(second.content);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Example second-note draft' } });
    await act(async () => { readA.resolve(noteA); });
    expect(screen.getByRole('textbox')).toHaveValue('Example second-note draft');
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.queryByText(noteA.content)).not.toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('note=wiki%2Fsecond.md');
  });

  it('shows an unavailable destination note without retaining the previous editor or repeatedly fetching', async () => {
    getNote.mockImplementation(id => id === 'vault-a' ? Promise.resolve(noteA) : Promise.reject(new Error('Note not found')));
    openA();
    await screen.findByText(noteA.content);
    switchToB();
    await screen.findByText('Page unavailable in this vault');
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete note' })).not.toBeInTheDocument();
    await act(async () => {});
    expect(getNote.mock.calls.filter(([id]) => id === 'vault-b')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Back to list' }));
    expect(screen.getByText('Select a page to view')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/wiki/browse?vault=vault-b');
  });
});

describe('Wiki vault URL wiring', () => {
  it('defaults to the first vault when no ?vault= param is present', async () => {
    renderWiki('/wiki/overview');
    await waitFor(() => expect(screen.getByTestId('overview')).toHaveTextContent('overview:vault-a'));
    // scanNotesVault is fired by a separate effect keyed on the selected vault id;
    // wait for that async side-effect rather than asserting it synchronously — the
    // passive effect can lag the committed overview render under full-suite load (#2643).
    await waitFor(() => expect(scanNotesVault).toHaveBeenCalledWith('vault-a', { limit: 1000 }));
  });

  it('restores the selected vault from the ?vault= param', async () => {
    renderWiki('/wiki/overview?vault=vault-b');
    await waitFor(() => expect(screen.getByTestId('overview')).toHaveTextContent('overview:vault-b'));
    await waitFor(() => expect(scanNotesVault).toHaveBeenCalledWith('vault-b', { limit: 1000 }));
  });

  it('preserves ?vault= through the base /wiki redirect', async () => {
    renderWiki('/wiki?vault=vault-b');
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/wiki/overview?vault=vault-b'),
    );
    await waitFor(() => expect(screen.getByTestId('overview')).toHaveTextContent('overview:vault-b'));
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
