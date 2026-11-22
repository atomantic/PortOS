import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const api = {
  getXAccounts: vi.fn(),
  getXPosts: vi.fn(),
  getXDrafts: vi.fn(),
  createXAccount: vi.fn(),
  updateXAccount: vi.fn(),
  deleteXAccount: vi.fn(),
  syncXAccount: vi.fn(),
  openXAccountDestination: vi.fn(),
  createXDraft: vi.fn(),
  reviewXDraft: vi.fn(),
  openXDraft: vi.fn(),
};
vi.mock('../services/apiX.js', () => ({
  getXAccounts: api.getXAccounts,
  getXPosts: api.getXPosts,
  getXDrafts: api.getXDrafts,
  createXAccount: api.createXAccount,
  updateXAccount: api.updateXAccount,
  deleteXAccount: api.deleteXAccount,
  syncXAccount: api.syncXAccount,
  openXAccountDestination: api.openXAccountDestination,
  createXDraft: api.createXDraft,
  reviewXDraft: api.reviewXDraft,
  openXDraft: api.openXDraft,
}));

const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn() }));
vi.mock('../services/socket', () => ({ default: socket }));

const { default: XPage } = await import('./X.jsx');

const account = {
  id: '00000000-0000-4000-8000-000000000001',
  label: 'Personal X',
  username: 'example_user',
  enabled: true,
  notes: '',
  profileSnapshot: {
    profile: { followers: 1296, following: 1777, postCount: 7473 },
    diagnostics: {
      profilePublic: true,
      appearsInPeopleSearch: true,
      recentPostsInLatestSearch: true,
      latestSearchPostCount: 2,
    },
  },
  lastSyncAt: '2026-08-05T12:00:00.000Z',
  lastError: '',
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderPage(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/x" element={<XPage />} />
        <Route path="/x/:accountId/:tab" element={<XPage />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('X page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getXAccounts.mockResolvedValue({ accounts: [account] });
    api.getXPosts.mockResolvedValue({ posts: [] });
    api.getXDrafts.mockResolvedValue({ drafts: [] });
  });

  it('deep-links to an account and reports verified reach checks without claiming recommendation status', async () => {
    renderPage(`/x/${account.id}/health`);
    expect(await screen.findByRole('heading', { name: 'Reach diagnostics for @example_user' })).toBeInTheDocument();
    expect(screen.getByText('Public profile reachable')).toBeInTheDocument();
    expect(screen.getByText('Exact account search')).toBeInTheDocument();
    expect(screen.getByText('Recommendation eligibility')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(`/x/${account.id}/health`);
  });

  it('renders a failed profile read as Unknown rather than a negative verdict', async () => {
    api.getXAccounts.mockResolvedValue({ accounts: [{
      ...account,
      profileSnapshot: {
        profile: {},
        diagnostics: {
          profilePublic: null,
          appearsInPeopleSearch: null,
          recentPostsInLatestSearch: null,
          latestSearchPostCount: null,
        },
      },
      lastError: 'Could not read the X profile page, account search, Latest search — those checks are unknown, not negative. Retry the diagnostic.',
    }] });
    renderPage(`/x/${account.id}/health`);
    await screen.findByRole('heading', { name: 'Reach diagnostics for @example_user' });
    expect(screen.getAllByText('Unknown')).toHaveLength(4);
    expect(screen.queryByText('Not observed')).not.toBeInTheDocument();
    expect(screen.getByText(/Could not read the X profile page/)).toBeInTheDocument();
  });

  it('explains each unknown check by its own page rather than blaming the profile read', async () => {
    api.getXAccounts.mockResolvedValue({ accounts: [{
      ...account,
      profileSnapshot: {
        profile: { followers: 1 },
        diagnostics: { profilePublic: true, appearsInPeopleSearch: null, recentPostsInLatestSearch: null, latestSearchPostCount: null },
      },
    }] });
    renderPage(`/x/${account.id}/health`);
    await screen.findByRole('heading', { name: 'Reach diagnostics for @example_user' });
    expect(screen.getByText('The profile page returned the configured handle.')).toBeInTheDocument();
    expect(screen.getByText(/The account search did not render/)).toBeInTheDocument();
    expect(screen.getByText(/The Latest search did not render/)).toBeInTheDocument();
  });

  it('runs a manual diagnostic and keeps publishing out of the page workflow', async () => {
    const user = userEvent.setup();
    api.syncXAccount.mockResolvedValue({ account: { ...account, lastSyncAt: '2026-08-05T13:00:00.000Z' }, posts: [], ingested: 2 });
    renderPage(`/x/${account.id}/health`);
    await screen.findByRole('heading', { name: 'Reach diagnostics for @example_user' });
    await user.click(screen.getByRole('button', { name: 'Run diagnostic' }));
    await waitFor(() => expect(api.syncXAccount).toHaveBeenCalledWith(account.id, { silent: true }));
    expect(screen.queryByRole('button', { name: /publish/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Diagnostic complete/)).toBeInTheDocument();
  });

  it('opens the account editor from the accounts index with an id-backed URL', async () => {
    const user = userEvent.setup();
    renderPage('/x');
    await screen.findByRole('heading', { name: 'X accounts' });
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('heading', { name: 'Edit X account' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(`/x/${account.id}/accounts?xAccount=edit`);
  });

  it('offers one Add account control when no accounts exist and the header switcher once they do', async () => {
    api.getXAccounts.mockResolvedValueOnce({ accounts: [] });
    const first = renderPage('/x');
    await screen.findByRole('heading', { name: 'X accounts' });
    expect(screen.getAllByRole('button', { name: 'Add account' })).toHaveLength(1);
    expect(screen.queryByLabelText('X account in scope')).not.toBeInTheDocument();
    first.unmount();

    renderPage('/x');
    await screen.findByRole('heading', { name: 'X accounts' });
    expect(screen.getAllByRole('button', { name: 'Add account' })).toHaveLength(2);
    expect(screen.getByLabelText('X account in scope')).toBeInTheDocument();
  });

  it('renders a not-found fallback for stale account URLs', async () => {
    renderPage('/x/00000000-0000-4000-8000-000000000099/health');
    expect(await screen.findByText(/This X account was not found/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Return to accounts.' })).toBeInTheDocument();
  });

  it('offers re-submit instead of compose for an approval older than 24h, and compose for a fresh one', async () => {
    const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
    const base = { accountId: account.id, updatedAt: hoursAgo(1), state: 'approved' };
    api.getXDrafts.mockResolvedValue({ drafts: [
      { ...base, id: 'stale', body: 'stale body', approvedAt: hoursAgo(25) },
      { ...base, id: 'fresh', body: 'fresh body', approvedAt: hoursAgo(1) },
    ] });
    api.reviewXDraft.mockResolvedValue({ draft: { ...base, id: 'stale', body: 'stale body', state: 'pending_review', approvedAt: null } });

    renderPage(`/x/${account.id}/drafts`);
    await screen.findByText('stale body');

    expect(screen.getAllByRole('button', { name: /Open compose in X/ })).toHaveLength(1);
    expect(screen.getByText('Approval expired')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Re-submit for review' }));
    expect(api.reviewXDraft).toHaveBeenCalledWith('stale', { state: 'pending_review' }, { silent: true });
  });

  it('displays a loading spinner in the draft queue while drafts are loading', async () => {
    let resolveDrafts;
    const draftsPromise = new Promise((resolve) => {
      resolveDrafts = resolve;
    });
    api.getXDrafts.mockReturnValueOnce(draftsPromise);

    renderPage(`/x/${account.id}/drafts`);
    await screen.findByRole('heading', { name: 'Draft queue' });

    expect(screen.getByLabelText('Loading drafts…')).toBeInTheDocument();
    expect(screen.queryByText(`No drafts for @${account.username}.`)).not.toBeInTheDocument();

    await act(async () => { resolveDrafts({ drafts: [] }); });

    expect(await screen.findByText(`No drafts for @${account.username}.`)).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading drafts…')).not.toBeInTheDocument();
  });
  it('retries account reads without showing an empty or missing account', async () => {
    const user = userEvent.setup();
    api.getXAccounts.mockRejectedValueOnce(new Error('Accounts unavailable'));
    renderPage(`/x/${account.id}/health`);
    expect(await screen.findByRole('alert')).toHaveTextContent('Accounts unavailable');
    expect(screen.queryByText(/This X account was not found/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Add an X account to begin/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry accounts' }));
    expect(await screen.findByRole('heading', { name: 'Reach diagnostics for @example_user' })).toBeInTheDocument();
  });

  it('keeps failed posts distinct from zero and retries only posts after an unrelated action', async () => {
    const user = userEvent.setup();
    api.getXPosts.mockRejectedValueOnce(new Error('Posts unavailable')).mockResolvedValue({ posts: [{ id: 'post-one', body: 'Recovered captured post' }] });
    api.openXAccountDestination.mockResolvedValue({});
    renderPage(`/x/${account.id}/health`);
    await screen.findByRole('heading', { name: 'Reach diagnostics for @example_user' });
    await waitFor(() => expect(api.getXPosts).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Captured posts').parentElement).toHaveTextContent('—');
    await user.click(screen.getByRole('tab', { name: 'Posts' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Posts unavailable');
    expect(screen.queryByText(/No captured posts yet/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Reach & health' }));
    await user.click(screen.getByRole('button', { name: 'Open profile' }));
    await screen.findByText(/Opened the requested X page/);
    await user.click(screen.getByRole('tab', { name: 'Posts' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Posts unavailable');
    await user.click(screen.getByRole('button', { name: 'Retry posts' }));
    expect(await screen.findByText('Recovered captured post')).toBeInTheDocument();
    expect(api.getXDrafts).toHaveBeenCalledTimes(1);
    expect(api.syncXAccount).not.toHaveBeenCalled();
  });

  it('reloads accounts always and the selected drafts only for a matching or omitted x:changed accountId', async () => {
    const { unmount } = renderPage(`/x/${account.id}/drafts`);
    expect(await screen.findByText(/No drafts for/)).toBeInTheDocument();
    const [, onChanged] = socket.on.mock.calls.find(([name]) => name === 'x:changed');
    api.getXDrafts.mockResolvedValue({ drafts: [{ id: 'submitted', body: 'Submitted from another tab', state: 'pending_review' }] });

    await act(async () => onChanged({ accountId: 'some-other-account' }));
    expect(api.getXAccounts).toHaveBeenCalledTimes(2);
    expect(api.getXDrafts).toHaveBeenCalledTimes(1);

    await act(async () => onChanged({ accountId: account.id }));
    expect(await screen.findByText('Submitted from another tab')).toBeInTheDocument();
    expect(api.getXDrafts).toHaveBeenCalledTimes(2);
    expect(api.getXDrafts).toHaveBeenLastCalledWith(account.id, { silent: true });

    api.getXDrafts.mockResolvedValue({ drafts: [] });
    await act(async () => onChanged());
    await waitFor(() => expect(screen.queryByText('Submitted from another tab')).not.toBeInTheDocument());
    expect(api.getXDrafts).toHaveBeenCalledTimes(3);

    unmount();
    expect(socket.off).toHaveBeenCalledWith('x:changed', onChanged);
  });

  it('drops a pending x:changed drafts reload that resolves after the account was switched', async () => {
    const user = userEvent.setup();
    const secondAccount = { ...account, id: 'second-account', username: 'second_user' };
    let resolveStale;
    api.getXAccounts.mockResolvedValue({ accounts: [account, secondAccount] });
    renderPage(`/x/${account.id}/drafts`);
    await screen.findByText(/No drafts for/);
    const [, onChanged] = socket.on.mock.calls.find(([name]) => name === 'x:changed');
    api.getXDrafts.mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve; }))
      .mockResolvedValueOnce({ drafts: [{ id: 'second-draft', body: 'Second account draft', state: 'draft' }] });
    await act(async () => onChanged({ accountId: account.id }));
    await user.selectOptions(screen.getByLabelText('X account in scope'), secondAccount.id);
    expect(await screen.findByText('Second account draft')).toBeInTheDocument();
    await act(async () => { resolveStale({ drafts: [{ id: 'stale-draft', body: 'Stale first account draft', state: 'draft' }] }); });
    await waitFor(() => expect(screen.queryByText('Stale first account draft')).not.toBeInTheDocument());
    expect(screen.getByText('Second account draft')).toBeInTheDocument();
  });

  it('retries failed drafts independently and drops a retry superseded by an account switch', async () => {
    const user = userEvent.setup();
    const secondAccount = { ...account, id: 'second-account', username: 'second_user' };
    let resolveRetry;
    api.getXAccounts.mockResolvedValue({ accounts: [account, secondAccount] });
    api.getXDrafts.mockRejectedValueOnce(new Error('Drafts unavailable'))
      .mockResolvedValueOnce({ drafts: [{ id: 'draft-one', body: 'Recovered draft', state: 'draft' }] });
    renderPage(`/x/${account.id}/drafts`);
    expect(await screen.findByRole('alert')).toHaveTextContent('Drafts unavailable');
    expect(screen.queryByText(/No drafts for/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry drafts' }));
    expect(await screen.findByText('Recovered draft')).toBeInTheDocument();
    expect(api.getXPosts).toHaveBeenCalledTimes(1);
    // A fresh failed read on another account can be retried while navigating away.
    api.getXDrafts.mockRejectedValueOnce(new Error('Second drafts unavailable'));
    await user.selectOptions(screen.getByLabelText('X account in scope'), secondAccount.id);
    await screen.findByText('Second drafts unavailable');
    api.getXDrafts.mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }))
      .mockResolvedValueOnce({ drafts: [{ id: 'current-draft', body: 'Current account draft', state: 'draft' }] });
    await user.click(screen.getByRole('button', { name: 'Retry drafts' }));
    await user.selectOptions(screen.getByLabelText('X account in scope'), account.id);
    expect(await screen.findByText('Current account draft')).toBeInTheDocument();
    await act(async () => { resolveRetry({ drafts: [{ id: 'stale-draft', body: 'Stale other account draft', state: 'draft' }] }); });
    await waitFor(() => expect(screen.queryByText('Stale other account draft')).not.toBeInTheDocument());
    expect(screen.getByText('Current account draft')).toBeInTheDocument();
  });

  it('keeps a completed diagnostic authoritative over an older pending posts retry', async () => {
    const user = userEvent.setup();
    let rejectRetry;
    api.getXPosts.mockRejectedValueOnce(new Error('Posts unavailable'))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRetry = reject; }));
    api.syncXAccount.mockResolvedValue({ account, posts: [{ id: 'new-post', body: 'New diagnostic post' }], ingested: 1 });
    renderPage(`/x/${account.id}/posts`);
    await screen.findByText('Posts unavailable');
    await user.click(screen.getByRole('button', { name: 'Retry posts' }));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('New diagnostic post')).toBeInTheDocument();
    await act(async () => { rejectRetry(new Error('Older read failed')); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('New diagnostic post')).toBeInTheDocument();
  });

});
