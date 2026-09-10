import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const api = vi.hoisted(() => ({
  evaluateMessages: vi.fn(),
  executeMessageAction: vi.fn(),
  fetchFullContent: vi.fn(),
  generateMessageDraft: vi.fn(),
  getMessageDetail: vi.fn(),
  getMessageInbox: vi.fn(),
  getMessageThread: vi.fn(),
  getSettings: vi.fn(),
  syncMessageAccount: vi.fn(),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), {
  error: vi.fn(),
  success: vi.fn(),
}));
const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn() }));

vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: toast }));
vi.mock('../../services/socket', () => ({ default: socket }));

const InboxTab = (await import('./InboxTab')).default;
const { latestSyncAt } = await import('./InboxTab');

const HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000).toISOString();

const neverSyncedAccount = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Personal',
  type: 'gmail',
  email: 'alice@example.com',
  enabled: true,
  lastSyncAt: null,
};
const syncedAccount = { ...neverSyncedAccount, lastSyncAt: HOUR_AGO };

function renderInbox(accounts, { route = '/messages/inbox' } = {}) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/messages/inbox" element={<InboxTab accounts={accounts} />} />
        <Route path="/messages/config" element={<div>CONFIG SCREEN</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function renderInboxWithLocation(accounts, { route = '/messages/inbox' } = {}) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <LocationProbe />
      <Routes>
        <Route path="/messages/inbox" element={<InboxTab accounts={accounts} />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getMessageInbox.mockResolvedValue({ messages: [], total: 0 });
  api.getMessageDetail.mockResolvedValue(null);
  api.getMessageThread.mockResolvedValue({ messages: [] });
  api.getSettings.mockResolvedValue({});
  api.syncMessageAccount.mockResolvedValue({ newMessages: 0, pruned: 0 });
});

describe('latestSyncAt', () => {
  it('returns null when no account has ever synced', () => {
    expect(latestSyncAt([neverSyncedAccount, { ...neverSyncedAccount, id: 'b' }])).toBeNull();
  });

  it('returns null for a missing list rather than throwing', () => {
    expect(latestSyncAt(null)).toBeNull();
  });

  it('skips an unparseable timestamp instead of reporting it as the newest sync', () => {
    expect(latestSyncAt([{ id: 'a', lastSyncAt: 'not-a-date' }])).toBeNull();
  });

  it('compares parsed dates, not raw strings, so an offset stamp sorts correctly', () => {
    // 2026-01-31T20:00-05:00 is 2026-02-01T01:00Z — later than the Z stamp, even
    // though it sorts earlier lexicographically.
    const zStamp = '2026-02-01T00:00:00.000Z';
    const offsetStamp = '2026-01-31T20:00:00.000-05:00';
    expect(latestSyncAt([{ id: 'a', lastSyncAt: zStamp }, { id: 'b', lastSyncAt: offsetStamp }]))
      .toBe(offsetStamp);
  });

  it('picks the newest timestamp and ignores accounts that never synced', () => {
    const older = '2026-01-01T00:00:00.000Z';
    const newer = '2026-02-01T00:00:00.000Z';
    const accounts = [
      { id: 'a', lastSyncAt: older },
      neverSyncedAccount,
      { id: 'c', lastSyncAt: newer },
    ];
    expect(latestSyncAt(accounts)).toBe(newer);
  });
});

describe('InboxTab empty state', () => {
  it('tells a user with zero accounts to add one, and routes them to Config', async () => {
    renderInbox([]);

    expect(await screen.findByText('No messages yet')).toBeInTheDocument();
    expect(screen.getByText('Add an account and sync to get started')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /add an account/i }));
    expect(await screen.findByText('CONFIG SCREEN')).toBeInTheDocument();
  });

  it('offers a sync when an account exists but has never synced', async () => {
    renderInbox([neverSyncedAccount]);

    expect(await screen.findByText('Nothing synced yet')).toBeInTheDocument();
    expect(screen.getByText('Pull your latest mail to fill the inbox')).toBeInTheDocument();
    // The stale "add an account" advice must be gone once one is configured.
    expect(screen.queryByText('Add an account and sync to get started')).not.toBeInTheDocument();

    const emptyStateSync = screen.getAllByRole('button', { name: /sync unread/i }).at(-1);
    fireEvent.click(emptyStateSync);

    await waitFor(() => expect(api.syncMessageAccount).toHaveBeenCalledTimes(1));
    expect(api.syncMessageAccount).toHaveBeenCalledWith(neverSyncedAccount.id, 'unread', { silent: true });
  });

  it('keeps the never-synced copy when every account sync fails', async () => {
    api.syncMessageAccount.mockRejectedValue(new Error('imap unreachable'));
    renderInbox([neverSyncedAccount]);

    await screen.findByText('Nothing synced yet');
    fireEvent.click(screen.getAllByRole('button', { name: /sync unread/i }).at(-1));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByText('Nothing synced yet')).toBeInTheDocument();
  });

  it('reports an empty result with the last sync time once a sync has run', async () => {
    renderInbox([syncedAccount]);

    expect(await screen.findByText('Your inbox is empty')).toBeInTheDocument();
    expect(screen.getByText(/last synced 1h ago/i)).toBeInTheDocument();
  });

  it('offers to clear filters when a triage filter is hiding everything', async () => {
    renderInbox([syncedAccount], { route: '/messages/inbox?triage=reply' });

    expect(await screen.findByText('No messages match this view')).toBeInTheDocument();
    expect(screen.getByText(/last synced 1h ago/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /clear filters/i }));

    expect(await screen.findByText('Your inbox is empty')).toBeInTheDocument();
  });

  it('scopes the sync question to the filtered account, not the whole list', async () => {
    const otherNeverSynced = { ...neverSyncedAccount, id: '22222222-2222-2222-2222-222222222222', name: 'Work' };
    renderInbox([syncedAccount, otherNeverSynced]);

    // Unfiltered, one account has synced — so the list is genuinely empty.
    expect(await screen.findByText('Your inbox is empty')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: otherNeverSynced.id } });

    // Filtered to the account that has never synced, the other account's
    // timestamp says nothing useful — offer the sync instead.
    expect(await screen.findByText('Nothing synced yet')).toBeInTheDocument();
  });

  it('does not claim there are no accounts when the account list failed to load', async () => {
    renderInbox(null);

    expect(await screen.findByText('Could not load your mail accounts')).toBeInTheDocument();
    expect(screen.queryByText('No messages yet')).not.toBeInTheDocument();
    expect(screen.queryByText('Nothing synced yet')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /open config/i }));
    expect(await screen.findByText('CONFIG SCREEN')).toBeInTheDocument();
  });
});

describe('InboxTab message selection URL', () => {
  const message = {
    id: 'message-1',
    accountId: neverSyncedAccount.id,
    subject: 'A message to inspect',
    bodyText: 'Message body',
    from: { name: 'Example Sender' },
    date: '2026-08-16T00:00:00.000Z',
    source: 'gmail',
    evaluation: { action: 'reply', priority: 'medium' },
  };

  it('opens a selected message while preserving triage in the URL and removes selection on back', async () => {
    api.getMessageInbox.mockResolvedValue({ messages: [message], total: 1 });
    renderInboxWithLocation([neverSyncedAccount], { route: '/messages/inbox?triage=reply' });

    fireEvent.click(await screen.findByRole('button', { name: /a message to inspect/i }));
    expect(await screen.findByText('Message body')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(
      `/messages/inbox?triage=reply&message=${message.id}&account=${message.accountId}`,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/messages/inbox?triage=reply'));
  });

  it('fetches a URL-selected message when it is missing from the current list', async () => {
    api.getMessageDetail.mockResolvedValue(message);
    renderInboxWithLocation([neverSyncedAccount], {
      route: `/messages/inbox?triage=review&message=${message.id}&account=${message.accountId}`,
    });

    expect(await screen.findByText('Message body')).toBeInTheDocument();
    expect(api.getMessageDetail).toHaveBeenCalledWith(neverSyncedAccount.id, message.id);
    expect(screen.getByTestId('location')).toHaveTextContent(
      `/messages/inbox?triage=review&message=${message.id}&account=${message.accountId}`,
    );
  });

  it('keeps sender text in the row and wraps the toolbar instead of a single overflowing flex', async () => {
    api.getMessageInbox.mockResolvedValue({ messages: [message], total: 1 });
    const { container } = renderInbox([neverSyncedAccount]);

    expect(await screen.findByText('Example Sender')).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'Triage filters' })).toHaveClass('overflow-x-auto');
    const row = screen.getByText('Example Sender').closest('.group');
    expect(row.className).toMatch(/flex-col/);
    expect(row.className).toMatch(/sm:flex-row/);
    const toolbar = container.querySelector('input[aria-label="Search messages"]').closest('.flex.flex-col');
    expect(toolbar).toBeTruthy();
    expect(toolbar.className).toMatch(/sm:flex-row/);
  });
});
