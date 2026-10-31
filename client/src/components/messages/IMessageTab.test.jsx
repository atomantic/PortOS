import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const api = vi.hoisted(() => ({
  checkImessageSetup: vi.fn(),
  getImessageBlocklist: vi.fn(),
  getImessageConversationEvents: vi.fn(),
  getImessageConversations: vi.fn(),
  getImessageStats: vi.fn(),
  getImessageStatus: vi.fn(),
  getSettings: vi.fn(),
  syncImessage: vi.fn(),
  updateSettings: vi.fn(),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));

vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: toast }));

const IMessageTab = (await import('./IMessageTab')).default;

function LocationProbe() {
  const { search } = useLocation();
  return <div data-testid="search">{search}</div>;
}

function renderTab(route = '/messages/imessage') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/messages/imessage" element={<><IMessageTab /><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getImessageBlocklist.mockResolvedValue({ handles: [] });
  api.getImessageStats.mockResolvedValue({ eventCount: 2, conversationCount: 1, blockedCount: 0 });
  api.getImessageConversations.mockResolvedValue({ conversations: [] });
  api.getImessageConversationEvents.mockResolvedValue({ events: [], identity: null });
  api.getSettings.mockResolvedValue({ imessage: { enabled: false, intervalMinutes: 30 } });
  api.getImessageStatus.mockResolvedValue({ state: {} });
  api.syncImessage.mockResolvedValue({ ok: true, recorded: 1, touchpointsCreated: 0 });
});

// The ingestion config used to be its own /settings/imessage page; it is now a
// right-side drawer over this page, deep-linked via ?settings=1 so ⌘K and voice
// ("open iMessage settings") can still land on it.
describe('IMessageTab — settings drawer', () => {
  it('stays closed until the Settings button is pressed, then sets ?settings=1', async () => {
    renderTab();
    await screen.findByRole('button', { name: 'Settings' });
    expect(screen.queryByText('iMessage ingestion')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(await screen.findByText('iMessage ingestion')).toBeTruthy();
    expect(screen.getByTestId('search').textContent).toBe('?settings=1');
  });

  it('opens straight from a ?settings=1 deep link', async () => {
    renderTab('/messages/imessage?settings=1');
    expect(await screen.findByText('iMessage ingestion')).toBeTruthy();
  });

  it('closing the drawer drops the param without leaving the page', async () => {
    renderTab('/messages/imessage?settings=1');
    await screen.findByText('iMessage ingestion');

    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));

    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe(''));
    expect(screen.queryByText('iMessage ingestion')).toBeNull();
  });

  it('refreshes the conversation list after a sync run inside the drawer', async () => {
    renderTab('/messages/imessage?settings=1');
    await screen.findByText('iMessage ingestion');
    const listCalls = api.getImessageConversations.mock.calls.length;

    const drawer = screen.getByRole('dialog', { name: 'iMessage Settings' });
    fireEvent.click(within(drawer).getByRole('button', { name: /Sync now/ }));

    await waitFor(() => {
      expect(api.getImessageConversations.mock.calls.length).toBeGreaterThan(listCalls);
    });
  });
});

describe('IMessageTab — blocked handles read', () => {
  it('shows an error with Retry when the blocklist read fails, then the handles after Retry', async () => {
    api.getImessageStats.mockResolvedValue({ eventCount: 2, conversationCount: 1, blockedCount: 1 });
    api.getImessageBlocklist.mockRejectedValueOnce(new Error('blocklist down'));
    renderTab();

    expect(await screen.findByText(/Could not load blocked handles — blocklist down/)).toBeTruthy();

    api.getImessageBlocklist.mockResolvedValueOnce({ handles: ['+15550100'] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('button', { name: 'Unblock +15550100' })).toBeTruthy();
    expect(screen.queryByText(/Could not load blocked handles/)).toBeNull();
  });
});

describe('IMessageTab — failed list reads', () => {
  it('shows a retryable error instead of "No conversations yet" and zero counts', async () => {
    api.getImessageStats.mockRejectedValueOnce(new Error('Synthetic stats failure'));
    api.getImessageConversations.mockRejectedValueOnce(new Error('Synthetic list failure'));
    renderTab();

    expect(await screen.findByText(/Could not load conversations/)).toBeTruthy();
    expect(screen.getByText(/Could not load iMessage stats/)).toBeTruthy();
    expect(screen.queryByText('No conversations yet.')).toBeNull();
    expect(screen.queryByText(/\b0 events\b/)).toBeNull();

    api.getImessageConversations.mockResolvedValueOnce({
      conversations: [{ chatKey: 'chat-1', title: 'Example Chat', eventCount: 1 }],
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]);
    expect(await screen.findByText('Example Chat')).toBeTruthy();
    expect(screen.queryByText(/Could not load conversations/)).toBeNull();
    expect(screen.getByText(/2 events/)).toBeTruthy();
  });
});

describe('IMessageTab — failed stats refresh', () => {
  it('replaces earlier counts with the error instead of showing them as current', async () => {
    api.getImessageStats.mockResolvedValueOnce({ eventCount: 2, conversationCount: 1, blockedCount: 0 });
    renderTab();
    expect(await screen.findByText(/2 events/)).toBeTruthy();

    api.getImessageStats.mockRejectedValueOnce(new Error('Synthetic stats refresh failure'));
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    expect(await screen.findByText(/Could not load iMessage stats/)).toBeTruthy();
    expect(screen.queryByText(/2 events/)).toBeNull();
  });
});
