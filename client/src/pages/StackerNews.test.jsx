import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { clearSettled, retypeSettled, typeSettled } from '../test/settledInput';

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
  { id: 'a1', label: 'Art steward', username: 'art_steward', enabled: true, monitoringEnabled: true, monitoringIntervalMinutes: 15, analysisEnabled: true, textModel: 'example-text', visionModel: '', rules: { guidance: 'Curate visual work' }, apiKeyConfigured: true, readTransport: 'api' },
  { id: 'a2', label: 'Personal', username: 'personal_stacker', enabled: true, monitoringEnabled: false, monitoringIntervalMinutes: 60, analysisEnabled: false, textModel: '', visionModel: '', rules: { guidance: 'Personal rules' }, apiKeyConfigured: false, readTransport: 'browser' },
];

// Surfaces the URL so tests can assert the deep-linkable bits — the selected
// account/tab path and the drawer's `snAccount` / `snAccountTab` search params.
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderPage(path) {
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/stacker-news" element={<StackerNews />} /><Route path="/stacker-news/:accountId/:tab" element={<StackerNews />} /></Routes><LocationProbe /></MemoryRouter>);
}

const currentUrl = () => screen.getByTestId('location').textContent;
const accountSwitcher = () => screen.getByLabelText('Stacker News account in scope');
const drawerTab = (name) => screen.getByRole('tab', { name });
const intervalField = (prefix = 'edit') => screen.getByLabelText('Monitoring interval (minutes)', { selector: `#${prefix}-account-interval` });

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
    const user = userEvent.setup();
    renderPage('/stacker-news/a1/accounts');
    expect(await screen.findByText('@art_steward · every 15m')).toBeInTheDocument();
    expect(screen.getByText('@personal_stacker · monitoring off')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit account settings' }));
    await user.click(drawerTab('Monitoring & models'));
    // The drawer remounts its panel per tab (`key={currentTab}`), so the field
    // is briefly present with no value before the account's stored one lands.
    // Assert on the settled value, as the retired-vision-model case below does.
    await waitFor(() => expect(intervalField()).toHaveValue(15));
    await user.click(drawerTab('Stewardship'));
    expect(screen.getByDisplayValue('Curate visual work')).toBeInTheDocument();
  });

  it('opens account setup on the bare route so a first-time install is usable', async () => {
    const user = userEvent.setup();
    renderPage('/stacker-news');
    await user.click(await screen.findByRole('button', { name: 'Add account' }));
    expect(await screen.findByRole('dialog', { name: 'Add account' })).toBeInTheDocument();
    expect(currentUrl()).toContain('snAccount=new');
  });

  it('saves only the selected account configuration', async () => {
    const user = userEvent.setup();
    api.updateStackerNewsAccount.mockResolvedValue({ ...accounts[0], monitoringIntervalMinutes: 20 });
    renderPage('/stacker-news/a1/accounts?snAccount=edit&snAccountTab=monitoring');
    const interval = await screen.findByLabelText('Monitoring interval (minutes)', { selector: '#edit-account-interval' });
    await retypeSettled(user, interval, '20');
    await user.click(screen.getByRole('button', { name: 'Save account' }));
    await waitFor(() => expect(api.updateStackerNewsAccount).toHaveBeenCalledWith('a1', expect.objectContaining({ monitoringIntervalMinutes: 20 }), { silent: true }));
    // A successful save closes the drawer and clears its search params.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(currentUrl()).not.toContain('snAccount');
  });

  it('switches the account in scope from a non-account tab without leaving it', async () => {
    const user = userEvent.setup();
    renderPage('/stacker-news/a1/territory');
    expect(await screen.findByRole('heading', { name: 'Communities for @art_steward' })).toBeInTheDocument();
    await user.selectOptions(accountSwitcher(), 'a2');
    expect(await screen.findByRole('heading', { name: 'Communities for @personal_stacker' })).toBeInTheDocument();
    expect(currentUrl()).toBe('/stacker-news/a2/territory');
    expect(screen.getByRole('tab', { name: 'Territory' })).toHaveAttribute('aria-selected', 'true');
  });

  it('names the account in scope on every scoped section', async () => {
    const user = userEvent.setup();
    renderPage('/stacker-news/a1/review');
    expect(await screen.findByRole('heading', { name: 'Approval queue for @art_steward' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Monitored content for @art_steward' })).toBeInTheDocument();
    expect(screen.getByText(/No actions are waiting for @art_steward/)).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Territory' }));
    expect(await screen.findByRole('heading', { name: 'Add community to @art_steward' })).toBeInTheDocument();
    expect(screen.getByText(/Add communities @art_steward monitors or owns/)).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(await screen.findByRole('heading', { name: 'Action ledger for @art_steward' })).toBeInTheDocument();
  });

  it('keeps entered account values across drawer tab switches and deep-links the open tab', async () => {
    const user = userEvent.setup();
    renderPage('/stacker-news/a1/accounts?snAccount=edit&snAccountTab=stewardship');
    const tone = await screen.findByLabelText('Tone', { selector: '#edit-account-tone' });
    await typeSettled(user, tone, 'measured');
    await user.click(drawerTab('Budgets'));
    expect(currentUrl()).toContain('snAccountTab=budgets');
    expect(screen.getByLabelText('Max/hour', { selector: '#edit-account-hour-budget' })).toBeInTheDocument();
    await user.click(drawerTab('Stewardship'));
    expect(screen.getByLabelText('Tone', { selector: '#edit-account-tone' })).toHaveValue('measured');
  });

  it('reports an invalid field from an unmounted drawer tab and switches to it', async () => {
    const user = userEvent.setup();
    renderPage('/stacker-news/a1/accounts?snAccount=edit&snAccountTab=monitoring');
    const interval = await screen.findByLabelText('Monitoring interval (minutes)', { selector: '#edit-account-interval' });
    await clearSettled(user, interval);
    await user.click(drawerTab('Budgets'));
    await user.click(screen.getByRole('button', { name: 'Save account' }));
    expect(await screen.findByText(/Monitoring interval \(minutes\) must be a whole number from 5 to 1440/)).toBeInTheDocument();
    expect(intervalField()).toBeInTheDocument();
    expect(api.updateStackerNewsAccount).not.toHaveBeenCalled();
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
    renderPage('/stacker-news/a1/accounts?snAccount=edit&snAccountTab=monitoring');
    const interval = await screen.findByLabelText('Monitoring interval (minutes)', { selector: '#edit-account-interval' });
    await retypeSettled(user, interval, '20');
    expect(screen.getByText(/Unsaved changes to @art_steward/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check API identity' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Check browser identity' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save account' }));
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled();
    await act(async () => save.resolve({ ...accounts[0], monitoringIntervalMinutes: 20 }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sync now' })).toBeEnabled());
  });

  it('discards an unsaved account draft left behind by closing the drawer', async () => {
    const user = userEvent.setup();
    renderPage('/stacker-news/a1/accounts?snAccount=edit&snAccountTab=monitoring');
    const interval = await screen.findByLabelText('Monitoring interval (minutes)', { selector: '#edit-account-interval' });
    await retypeSettled(user, interval, '20');
    // Closing keeps the draft (a 19-field edit should survive a detour), so the
    // dependent actions stay disabled until the draft is saved or discarded.
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.queryByText(/Unsaved changes to @art_steward/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Edit account settings' }));
    await user.click(drawerTab('Monitoring & models'));
    await waitFor(() => expect(intervalField()).toHaveValue(15));
  });

  // Stacker News grants API keys on request only, so a keyless account is the
  // normal case: the browser-backed actions stay usable and only the API check
  // is disabled — with a reason, not a bare failure.
  it('disables only the API identity check when no key is stored, and explains why', async () => {
    renderPage('/stacker-news/a2/accounts');
    const apiCheck = await screen.findByRole('button', { name: 'Check API identity' });
    expect(apiCheck).toBeDisabled();
    expect(apiCheck).toHaveAttribute('title', expect.stringContaining('pinned browser'));
    expect(screen.getByRole('button', { name: 'Check browser identity' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeEnabled();
    expect(screen.getByText(/reads via pinned browser/)).toBeInTheDocument();
  });

  it('forces the API transport from the API identity check', async () => {
    const user = userEvent.setup();
    api.verifyStackerNewsAccount.mockResolvedValue({ configured: true, connected: true, transport: 'api', username: 'art_steward', matchesConfigured: true });
    renderPage('/stacker-news/a1/accounts');
    await user.click(await screen.findByRole('button', { name: 'Check API identity' }));
    await waitFor(() => expect(api.verifyStackerNewsAccount).toHaveBeenCalledWith('a1', 'api', { silent: true }));
  });

  it('saves the chosen read transport with the account', async () => {
    const user = userEvent.setup();
    api.updateStackerNewsAccount.mockResolvedValue({ ...accounts[0], readTransport: 'browser' });
    renderPage('/stacker-news/a1/accounts?snAccount=edit');
    await user.selectOptions(await screen.findByLabelText('Read transport', { selector: '#edit-account-read-transport' }), 'browser');
    await user.click(screen.getByRole('button', { name: 'Save account' }));
    await waitFor(() => expect(api.updateStackerNewsAccount).toHaveBeenCalledWith('a1', expect.objectContaining({ readTransport: 'browser' }), { silent: true }));
  });

  it('can explicitly remove a stored API key', async () => {
    const user = userEvent.setup();
    api.updateStackerNewsAccount.mockResolvedValue({ ...accounts[0], apiKeyConfigured: false });
    renderPage('/stacker-news/a1/accounts?snAccount=edit');
    await user.click(await screen.findByRole('checkbox', { name: 'Remove stored API key when saving' }));
    await user.click(screen.getByRole('button', { name: 'Save account' }));
    await waitFor(() => expect(api.updateStackerNewsAccount).toHaveBeenCalledWith('a1', expect.objectContaining({ apiKey: '' }), { silent: true }));
  });

  it('ignores an old account save completion after navigation', async () => {
    const user = userEvent.setup();
    const save = deferred();
    api.updateStackerNewsAccount.mockReturnValue(save.promise);
    renderPage('/stacker-news/a1/accounts?snAccount=edit&snAccountTab=monitoring');
    const interval = await screen.findByLabelText('Monitoring interval (minutes)', { selector: '#edit-account-interval' });
    await retypeSettled(user, interval, '20');
    await user.click(screen.getByRole('button', { name: 'Save account' }));
    // Selecting another account navigates by path, which drops the drawer params.
    await user.click(screen.getByRole('button', { name: /Personal/ }));
    expect(await screen.findByRole('heading', { name: 'Settings and safety for @personal_stacker' })).toBeInTheDocument();
    await act(async () => save.resolve({ ...accounts[0], monitoringIntervalMinutes: 20 }));
    expect(screen.getByRole('heading', { name: 'Settings and safety for @personal_stacker' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit account settings' }));
    await user.click(drawerTab('Monitoring & models'));
    await waitFor(() => expect(intervalField()).toHaveValue(60));
  });

  it('offers only vision-capable models for the vision stage and every model for text', async () => {
    renderPage('/stacker-news?snAccount=new&snAccountTab=monitoring');
    await screen.findByRole('dialog', { name: 'Add account' });
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
    renderPage('/stacker-news?snAccount=new&snAccountTab=monitoring');
    await screen.findByRole('dialog', { name: 'Add account' });
    // Without the server map only the regex-recognizable id survives.
    expect(optionsOf(modelSelects().vision)).toEqual(['Disabled', 'example-vision']);
  });

  it('keeps a stored vision model that is no longer offered and saves it unchanged', async () => {
    const user = userEvent.setup();
    const retired = { ...accounts[0], visionModel: 'retired-multimodal:7b' };
    api.getStackerNewsAccounts.mockResolvedValue({ accounts: [retired, accounts[1]] });
    api.updateStackerNewsAccount.mockResolvedValue(retired);
    renderPage('/stacker-news/a1/accounts?snAccount=edit&snAccountTab=monitoring');
    const vision = await screen.findByLabelText('Ollama vision model', { selector: '#edit-account-vision-model' });
    await waitFor(() => expect(vision).toHaveValue('retired-multimodal:7b'));
    expect(optionsOf(vision)).toContain('retired-multimodal:7b (configured)');
    await user.click(screen.getByRole('button', { name: 'Save account' }));
    await waitFor(() => expect(api.updateStackerNewsAccount).toHaveBeenCalledWith('a1', expect.objectContaining({ visionModel: 'retired-multimodal:7b' }), { silent: true }));
  });

  it('does not claim there is no vision model while the capability fetch is in flight', async () => {
    local.models = { ollama: ['example-text'], loading: false };
    local.vision = { idsByProvider: null, loaded: false };
    renderPage('/stacker-news?snAccount=new&snAccountTab=monitoring');
    await screen.findByRole('dialog', { name: 'Add account' });
    expect(screen.getByText(/Checking which installed Ollama models can read an image/)).toBeInTheDocument();
    expect(screen.queryByText(/No vision-capable Ollama model installed/)).not.toBeInTheDocument();
  });

  it('says so explicitly once the capability fetch settles with no vision model installed', async () => {
    local.models = { ollama: ['example-text'], loading: false };
    local.vision = { idsByProvider: { ollama: new Set() }, loaded: true };
    renderPage('/stacker-news?snAccount=new&snAccountTab=monitoring');
    await screen.findByRole('dialog', { name: 'Add account' });
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
