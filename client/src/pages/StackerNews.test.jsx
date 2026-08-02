import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const api = {
  getStackerNewsAccounts: vi.fn(),
  getStackerNewsTerritories: vi.fn(),
  getStackerNewsItems: vi.fn(),
  getStackerNewsActions: vi.fn(),
  updateStackerNewsAccount: vi.fn(),
  createStackerNewsAccount: vi.fn(),
  createStackerNewsTerritory: vi.fn(),
  updateStackerNewsTerritory: vi.fn(),
  deleteStackerNewsTerritory: vi.fn(),
  verifyStackerNewsAccount: vi.fn(),
  getStackerNewsBrowserIdentity: vi.fn(),
  syncStackerNewsAccount: vi.fn(),
  analyzeStackerNewsItem: vi.fn(),
  createStackerNewsAction: vi.fn(),
  reviewStackerNewsAction: vi.fn(),
  executeStackerNewsAction: vi.fn(),
};
vi.mock('../services/api', () => api);
// Mutable so a test can pose a still-loading capability fetch or a backend with
// no VLM installed. `futuremodel:9b` is deliberately unrecognizable to the
// `isVisionModel` id regex — only the server map can vouch for it.
const local = vi.hoisted(() => ({
  models: { ollama: ['example-text', 'example-embed', 'example-vision', 'futuremodel:9b'], loading: false },
  vision: { idsByProvider: { ollama: new Set(['futuremodel:9b']) }, loaded: true },
}));
vi.mock('../hooks/useLocalModels', () => ({ default: () => local.models }));
vi.mock('../hooks/useVisionModelIds', () => ({ default: () => local.vision }));
const { default: StackerNews } = await import('./StackerNews.jsx');

const optionsOf = (select) => within(select).getAllByRole('option').map((option) => option.textContent);
const modelSelects = () => ({
  text: screen.getByLabelText('Ollama text model', { selector: '#new-account-text-model' }),
  vision: screen.getByLabelText('Ollama vision model', { selector: '#new-account-vision-model' }),
});

const accounts = [
  { id: 'a1', label: 'Art steward', username: 'art_steward', enabled: true, monitoringEnabled: true, monitoringIntervalMinutes: 15, analysisEnabled: true, textModel: 'example-text', visionModel: '', rules: { guidance: 'Curate visual work' }, apiKeyConfigured: true },
  { id: 'a2', label: 'Personal', username: 'personal_stacker', enabled: true, monitoringEnabled: false, monitoringIntervalMinutes: 60, analysisEnabled: false, textModel: '', visionModel: '', rules: { guidance: 'Personal rules' }, apiKeyConfigured: false },
];

function renderPage(path) {
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/stacker-news" element={<StackerNews />} /><Route path="/stacker-news/:accountId/:tab" element={<StackerNews />} /></Routes></MemoryRouter>);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe('StackerNews', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    local.models = { ollama: ['example-text', 'example-embed', 'example-vision', 'futuremodel:9b'], loading: false };
    local.vision = { idsByProvider: { ollama: new Set(['futuremodel:9b']) }, loaded: true };
    api.getStackerNewsAccounts.mockResolvedValue({ accounts });
    api.getStackerNewsTerritories.mockResolvedValue({ territories: [] });
    api.getStackerNewsItems.mockResolvedValue({ items: [] });
    api.getStackerNewsActions.mockResolvedValue({ actions: [] });
  });

  it('deep-links to one account and shows its independent schedule and rules', async () => {
    renderPage('/stacker-news/a1/accounts');
    expect(await screen.findByText('@art_steward · every 15m')).toBeInTheDocument();
    expect(await screen.findByDisplayValue('Curate visual work')).toBeInTheDocument();
    expect(screen.getByDisplayValue('15')).toBeInTheDocument();
    expect(screen.getByText('@personal_stacker · monitoring off')).toBeInTheDocument();
  });

  it('opens account setup on the bare route so a first-time install is usable', async () => {
    renderPage('/stacker-news');
    expect(await screen.findByRole('heading', { name: 'Add account' })).toBeInTheDocument();
  });

  it('saves only the selected account configuration', async () => {
    const user = userEvent.setup();
    api.updateStackerNewsAccount.mockResolvedValue({ ...accounts[0], monitoringIntervalMinutes: 20 });
    renderPage('/stacker-news/a1/accounts');
    await screen.findByDisplayValue('Curate visual work');
    const interval = screen.getByLabelText('Monitoring interval (minutes)', { selector: '#edit-account-interval' });
    await user.clear(interval);
    await user.type(interval, '20');
    await user.click(screen.getByRole('button', { name: 'Save account' }));
    await waitFor(() => expect(api.updateStackerNewsAccount).toHaveBeenCalledWith('a1', expect.objectContaining({ monitoringIntervalMinutes: 20 }), { silent: true }));
  });

  it('renders a recovery path for a stale account URL', async () => {
    renderPage('/stacker-news/missing/review');
    expect(await screen.findByText(/account was not found/i)).toBeInTheDocument();
  });

  it('discards resource responses for an account that is no longer selected', async () => {
    const user = userEvent.setup();
    const oldTerritories = deferred();
    api.getStackerNewsTerritories.mockImplementation((id) => id === 'a1'
      ? oldTerritories.promise
      : Promise.resolve({ territories: [{ id: 't2', accountId: 'a2', slug: 'current-community', label: 'Current community', rules: {} }] }));
    renderPage('/stacker-news/a1/accounts');
    await screen.findByRole('button', { name: /Personal/ });
    await user.click(screen.getByRole('button', { name: /Personal/ }));
    await user.click(screen.getByRole('tab', { name: 'Territory' }));
    expect(await screen.findByText('Current community')).toBeInTheDocument();
    await act(async () => oldTerritories.resolve({ territories: [{ id: 't1', accountId: 'a1', slug: 'old-community', label: 'Old community', rules: {} }] }));
    expect(screen.queryByText('Old community')).not.toBeInTheDocument();
    expect(screen.getByText('Current community')).toBeInTheDocument();
  });

  it('hides executable actions immediately when account selection changes', async () => {
    const user = userEvent.setup();
    const nextActions = deferred();
    api.getStackerNewsActions.mockImplementation((id) => id === 'a1'
      ? Promise.resolve({ actions: [{ id: 'old-action', kind: 'publish_comment', state: 'approved', payload: { body: 'Old account action' }, reviewedTarget: { username: 'art_steward' }, policyVersion: 'v1' }] })
      : nextActions.promise);
    renderPage('/stacker-news/a1/review');
    expect(await screen.findByRole('button', { name: 'Execute reviewed action' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Accounts & Safety' }));
    await user.click(await screen.findByRole('button', { name: /Personal/ }));
    expect(screen.queryByRole('button', { name: 'Execute reviewed action' })).not.toBeInTheDocument();
    await act(async () => nextActions.resolve({ actions: [] }));
  });

  it('gates server-side account actions on saved settings and the in-flight save', async () => {
    const user = userEvent.setup();
    const save = deferred();
    api.updateStackerNewsAccount.mockReturnValue(save.promise);
    renderPage('/stacker-news/a1/accounts');
    const interval = await screen.findByLabelText('Monitoring interval (minutes)', { selector: '#edit-account-interval' });
    await user.clear(interval);
    await user.type(interval, '20');
    expect(screen.getByRole('button', { name: 'Check API identity' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Check browser identity' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save account' }));
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled();
    await act(async () => save.resolve({ ...accounts[0], monitoringIntervalMinutes: 20 }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sync now' })).toBeEnabled());
  });

  it('can explicitly remove a stored API key', async () => {
    const user = userEvent.setup();
    api.updateStackerNewsAccount.mockResolvedValue({ ...accounts[0], apiKeyConfigured: false });
    renderPage('/stacker-news/a1/accounts');
    await user.click(await screen.findByRole('checkbox', { name: 'Remove stored API key when saving' }));
    await user.click(screen.getByRole('button', { name: 'Save account' }));
    await waitFor(() => expect(api.updateStackerNewsAccount).toHaveBeenCalledWith('a1', expect.objectContaining({ apiKey: '' }), { silent: true }));
  });

  it('ignores an old account save completion after navigation', async () => {
    const user = userEvent.setup();
    const save = deferred();
    api.updateStackerNewsAccount.mockReturnValue(save.promise);
    renderPage('/stacker-news/a1/accounts');
    const interval = await screen.findByLabelText('Monitoring interval (minutes)', { selector: '#edit-account-interval' });
    await user.clear(interval);
    await user.type(interval, '20');
    await user.click(screen.getByRole('button', { name: 'Save account' }));
    await user.click(screen.getByRole('button', { name: /Personal/ }));
    expect(await screen.findByDisplayValue('personal_stacker')).toBeInTheDocument();
    await act(async () => save.resolve({ ...accounts[0], monitoringIntervalMinutes: 20 }));
    expect(screen.getByDisplayValue('personal_stacker')).toBeInTheDocument();
    expect(screen.getByLabelText('Monitoring interval (minutes)', { selector: '#edit-account-interval' })).toHaveValue(60);
  });

  it('offers only vision-capable models for the vision stage and every model for text', async () => {
    renderPage('/stacker-news');
    await screen.findByRole('heading', { name: 'Add account' });
    const { text, vision } = modelSelects();
    expect(optionsOf(text)).toEqual(['Disabled', 'example-text', 'example-embed', 'example-vision', 'futuremodel:9b']);
    // Subset of the text list, with the text-only and embedding ids dropped.
    expect(optionsOf(vision)).toEqual(['Disabled', 'example-vision', 'futuremodel:9b']);
    for (const option of optionsOf(vision)) expect(optionsOf(text)).toContain(option);
    expect(optionsOf(vision)).not.toContain('example-text');
    expect(optionsOf(vision)).not.toContain('example-embed');
  });

  it('offers a server-classified vision model the id regex does not recognize', async () => {
    local.vision = { idsByProvider: { ollama: new Set() }, loaded: true };
    renderPage('/stacker-news');
    await screen.findByRole('heading', { name: 'Add account' });
    // Without the server map only the regex-recognizable id survives.
    expect(optionsOf(modelSelects().vision)).toEqual(['Disabled', 'example-vision']);
  });

  it('keeps a stored vision model that is no longer offered and saves it unchanged', async () => {
    const user = userEvent.setup();
    const retired = { ...accounts[0], visionModel: 'retired-multimodal:7b' };
    api.getStackerNewsAccounts.mockResolvedValue({ accounts: [retired, accounts[1]] });
    api.updateStackerNewsAccount.mockResolvedValue(retired);
    renderPage('/stacker-news/a1/accounts');
    await screen.findByDisplayValue('Curate visual work');
    const vision = screen.getByLabelText('Ollama vision model', { selector: '#edit-account-vision-model' });
    expect(optionsOf(vision)).toContain('retired-multimodal:7b (configured)');
    expect(vision).toHaveValue('retired-multimodal:7b');
    await user.click(screen.getByRole('button', { name: 'Save account' }));
    await waitFor(() => expect(api.updateStackerNewsAccount).toHaveBeenCalledWith('a1', expect.objectContaining({ visionModel: 'retired-multimodal:7b' }), { silent: true }));
  });

  it('does not claim there is no vision model while the capability fetch is in flight', async () => {
    local.models = { ollama: ['example-text'], loading: false };
    local.vision = { idsByProvider: null, loaded: false };
    renderPage('/stacker-news');
    await screen.findByRole('heading', { name: 'Add account' });
    expect(screen.getByText(/Checking which installed Ollama models can read an image/)).toBeInTheDocument();
    expect(screen.queryByText(/No vision-capable Ollama model installed/)).not.toBeInTheDocument();
  });

  it('says so explicitly once the capability fetch settles with no vision model installed', async () => {
    local.models = { ollama: ['example-text'], loading: false };
    local.vision = { idsByProvider: { ollama: new Set() }, loaded: true };
    renderPage('/stacker-news');
    await screen.findByRole('heading', { name: 'Add account' });
    expect(screen.getByText(/No vision-capable Ollama model installed/)).toBeInTheDocument();
    expect(optionsOf(modelSelects().vision)).toEqual(['Disabled']);
  });

  it('edits and deletes configured communities through inline controls', async () => {
    const user = userEvent.setup();
    const territory = { id: 't1', accountId: 'a1', slug: 'art', label: 'Art', isOwned: false, monitoringEnabled: null, inheritAccountRules: true, rules: {} };
    api.getStackerNewsTerritories.mockResolvedValue({ territories: [territory] });
    api.updateStackerNewsTerritory.mockResolvedValue({ ...territory, isOwned: true });
    api.deleteStackerNewsTerritory.mockResolvedValue(null);
    renderPage('/stacker-news/a1/territory');
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const editForm = screen.getByRole('heading', { name: 'Edit Art' }).closest('form');
    await user.click(within(editForm).getByRole('checkbox', { name: 'This account owns this community' }));
    await user.click(within(editForm).getByRole('button', { name: 'Save community' }));
    await waitFor(() => expect(api.updateStackerNewsTerritory).toHaveBeenCalledWith('t1', expect.objectContaining({ isOwned: true }), { silent: true }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(api.deleteStackerNewsTerritory).toHaveBeenCalledWith('t1', { silent: true }));
    expect(screen.queryByText('Art')).not.toBeInTheDocument();
  });
});
