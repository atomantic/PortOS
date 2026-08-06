import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
vi.mock('../services/api', () => api);

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
});
