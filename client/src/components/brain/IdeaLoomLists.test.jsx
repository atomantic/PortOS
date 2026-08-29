import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';

vi.mock('../../services/api', () => ({
  getIdeaLoomLists: vi.fn(), getIdeaLoomSettings: vi.fn(),
  createIdeaLoomList: vi.fn(), updateIdeaLoomList: vi.fn(), deleteIdeaLoomList: vi.fn(),
  importIdeaLoomFromObsidian: vi.fn(), syncIdeaLoomToObsidian: vi.fn(),
  updateIdeaLoomSettings: vi.fn(), getNotesVaults: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

import * as api from '../../services/api';
import toast from '../ui/Toast';
import IdeaLoomLists from './IdeaLoomLists';

function Location() {
  return <output data-testid="location">{useLocation().search}</output>;
}

function renderPanel(entry = '/brain/ideas') {
  return render(<MemoryRouter initialEntries={[entry]}><IdeaLoomLists /><Location /></MemoryRouter>);
}

// A stored list carries record metadata the strict list API refuses on the way
// back in — every test that saves asserts the payload stayed schema-shaped.
const storedList = (overrides = {}) => ({
  id: 'list-1',
  schemaVersion: 1,
  title: 'Launch ideas',
  prompt: 'What should we launch?',
  category: 'product',
  help: '',
  status: 'draft',
  ideas: ['First', 'Second'],
  sync: { noteHash: 'abc' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.getIdeaLoomLists.mockResolvedValue([]);
  api.getIdeaLoomSettings.mockResolvedValue({ enabled: false, obsidianVaultId: null, autoSync: false });
  api.getNotesVaults.mockResolvedValue({ vaults: [{ id: 'vault-1', name: 'Example Vault' }] });
});

describe('IdeaLoomLists', () => {
  it('opts into vault sync and automatic export one explicit step at a time', async () => {
    api.updateIdeaLoomSettings
      .mockResolvedValueOnce({ enabled: true, obsidianVaultId: null, autoSync: false })
      .mockResolvedValueOnce({ enabled: true, obsidianVaultId: 'vault-1', autoSync: false })
      .mockResolvedValueOnce({ enabled: true, obsidianVaultId: 'vault-1', autoSync: true });
    renderPanel();

    // The auto-sync toggle stays out of reach until sync is on AND a vault is
    // chosen, so it can never be enabled against an unconfigured integration.
    fireEvent.click(await screen.findByLabelText('Sync with an Obsidian vault'));
    await waitFor(() => expect(screen.queryByLabelText('Vault')).toBeTruthy());
    expect(screen.queryByLabelText(/Export automatically/)).toBeNull();

    fireEvent.change(screen.getByLabelText('Vault'), { target: { value: 'vault-1' } });
    const autoSync = await screen.findByLabelText(/Export automatically/);
    fireEvent.click(autoSync);

    await waitFor(() => expect(api.updateIdeaLoomSettings).toHaveBeenLastCalledWith({ autoSync: true }, expect.anything()));
  });

  it('offers explicit recovery only after an exchange reports a deleted note', async () => {
    api.getIdeaLoomSettings.mockResolvedValue({ enabled: true, obsidianVaultId: 'vault-1', autoSync: false });
    api.syncIdeaLoomToObsidian
      .mockResolvedValueOnce({ counts: { exported: 0, missing: 1 } })
      .mockResolvedValueOnce({ counts: { exported: 1, missing: 0 } });
    renderPanel();

    expect(screen.queryByText(/Recreate/)).toBeNull();
    fireEvent.click(await screen.findByText('Export to Obsidian'));

    const recover = await screen.findByText('Recreate 1 deleted note');
    fireEvent.click(recover);

    await waitFor(() => expect(api.syncIdeaLoomToObsidian)
      .toHaveBeenLastCalledWith(null, expect.objectContaining({ recreateMissing: true })));
    // The first, automatic-shaped export must NOT have asked for a recreate.
    expect(api.syncIdeaLoomToObsidian.mock.calls[0][1]).not.toHaveProperty('recreateMissing');
    await waitFor(() => expect(screen.queryByText(/Recreate/)).toBeNull());
  });

  it('keeps local list editing available while vault sync is disabled', async () => {
    api.createIdeaLoomList.mockResolvedValue({ id: 'list-1', title: 'Launch ideas', prompt: 'Why?', category: 'product', status: 'draft', ideas: ['One'] });
    renderPanel();

    expect(await screen.findByText('Vault sync is disabled. Local lists remain available.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Create IdeaLoom list'));
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Launch ideas' } });
    fireEvent.change(screen.getByLabelText(/Prompt/), { target: { value: 'Why?' } });
    fireEvent.change(screen.getByLabelText(/Category/), { target: { value: 'product' } });
    fireEvent.change(screen.getByLabelText('New idea'), { target: { value: 'One' } });
    fireEvent.click(screen.getByLabelText('Add idea'));
    fireEvent.click(screen.getByText('Save list'));

    await waitFor(() => expect(api.createIdeaLoomList).toHaveBeenCalledWith(
      { title: 'Launch ideas', prompt: 'Why?', category: 'product', status: 'draft', help: '', ideas: ['One'] },
      { silent: true },
    ));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('?list=list-1'));
  });

  it('tells the user the integration is on but unbound when no vault is selected', async () => {
    api.getIdeaLoomSettings.mockResolvedValue({ enabled: true, obsidianVaultId: null, autoSync: false });
    api.getIdeaLoomLists.mockResolvedValue([storedList()]);
    renderPanel();

    expect(await screen.findByText('No Obsidian vault is selected. Local lists remain available.')).toBeTruthy();
    // The notice is advisory: the list is still selectable and editable.
    fireEvent.click(screen.getByText('Launch ideas'));
    expect(await screen.findByLabelText('Idea 1')).toBeTruthy();
  });

  it('offers explicit exchange controls only for a configured vault', async () => {
    api.getIdeaLoomSettings.mockResolvedValue({ enabled: true, obsidianVaultId: 'vault-1', autoSync: false });
    api.getIdeaLoomLists.mockResolvedValue([storedList()]);
    api.syncIdeaLoomToObsidian.mockResolvedValue({ counts: { exported: 1, skipped: 0 } });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Export to Obsidian' }));
    await waitFor(() => expect(api.syncIdeaLoomToObsidian).toHaveBeenCalledWith(null, { silent: true }));
    expect(await screen.findByText(/Last exchange: 0 imported · 1 exported/)).toBeTruthy();
  });

  it('reports exchange problems instead of showing a successful completion', async () => {
    api.getIdeaLoomSettings.mockResolvedValue({ enabled: true, obsidianVaultId: 'vault-1', autoSync: false });
    api.syncIdeaLoomToObsidian.mockResolvedValue({ counts: { failed: 1 } });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Export to Obsidian' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('IdeaLoom export complete with 1 issue'));
    expect(toast.success).not.toHaveBeenCalledWith('IdeaLoom export complete');
  });

  it('does not report an unread settings fetch as a disabled integration', async () => {
    api.getIdeaLoomSettings.mockRejectedValue(new Error('Server unreachable'));
    renderPanel();

    expect(await screen.findByText('Could not load IdeaLoom settings. Local lists remain available.')).toBeTruthy();
    expect(screen.queryByText('Vault sync is disabled. Local lists remain available.')).toBeNull();
  });

  it('reorders a selected list locally and saves only the schema fields', async () => {
    api.getIdeaLoomLists.mockResolvedValue([storedList()]);
    api.updateIdeaLoomList.mockResolvedValue(storedList({ ideas: ['Second', 'First'] }));
    renderPanel();

    fireEvent.click(await screen.findByText('Launch ideas'));
    await screen.findByLabelText('Move idea 2 up');
    fireEvent.click(screen.getByLabelText('Move idea 2 up'));
    fireEvent.click(screen.getByText('Save list'));

    await waitFor(() => expect(api.updateIdeaLoomList).toHaveBeenCalledWith(
      'list-1',
      { title: 'Launch ideas', prompt: 'What should we launch?', category: 'product', status: 'draft', help: '', ideas: ['Second', 'First'] },
      { silent: true },
    ));
    // Record metadata must never ride back to the strict API.
    const [, body] = api.updateIdeaLoomList.mock.calls[0];
    expect(Object.keys(body).sort()).toEqual(['category', 'help', 'ideas', 'prompt', 'status', 'title']);
    expect(screen.getByTestId('location').textContent).toBe('?list=list-1');
  });

  it('completes a list in one click without discarding unsaved edits', async () => {
    api.getIdeaLoomLists.mockResolvedValue([storedList()]);
    api.updateIdeaLoomList.mockResolvedValue(storedList({ status: 'completed', ideas: ['Renamed', 'Second'] }));
    renderPanel('/brain/ideas?list=list-1');

    fireEvent.change(await screen.findByLabelText('Idea 1'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByLabelText('Mark list completed'));

    await waitFor(() => expect(api.updateIdeaLoomList).toHaveBeenCalledWith(
      'list-1',
      expect.objectContaining({ status: 'completed', ideas: ['Renamed', 'Second'] }),
      { silent: true },
    ));
    expect(await screen.findByLabelText('Mark list draft')).toBeTruthy();
  });

  it('names the missing required field instead of posting an invalid list', async () => {
    renderPanel();

    fireEvent.click(await screen.findByLabelText('Create IdeaLoom list'));
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Launch ideas' } });
    fireEvent.click(screen.getByText('Save list'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A list prompt is required'));
    expect(api.createIdeaLoomList).not.toHaveBeenCalled();
  });

  it('deletes a list behind an inline confirmation and drops it from the URL', async () => {
    api.getIdeaLoomLists.mockResolvedValue([storedList()]);
    api.deleteIdeaLoomList.mockResolvedValue(null);
    renderPanel('/brain/ideas?list=list-1');

    fireEvent.click(await screen.findByLabelText('Delete list'));
    fireEvent.click(screen.getByTitle('Delete list'));

    await waitFor(() => expect(api.deleteIdeaLoomList).toHaveBeenCalledWith('list-1', { silent: true }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(''));
    expect(await screen.findByText('No IdeaLoom lists yet.')).toBeTruthy();
  });
});
