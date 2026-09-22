import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const mockSocketListeners = vi.hoisted(() => new Map());
const mockSocket = vi.hoisted(() => ({
  on: vi.fn((event, handler) => {
    if (!mockSocketListeners.has(event)) mockSocketListeners.set(event, []);
    mockSocketListeners.get(event).push(handler);
  }),
  off: vi.fn((event, handler) => {
    const list = mockSocketListeners.get(event) || [];
    const idx = list.indexOf(handler);
    if (idx !== -1) list.splice(idx, 1);
  }),
  emitEvent: (event, data) => {
    const list = mockSocketListeners.get(event) || [];
    for (const fn of list) fn(data);
  }
}));

const api = vi.hoisted(() => ({
  getBrainInbox: vi.fn(),
  captureBrainThought: vi.fn(),
  resolveBrainReview: vi.fn(),
  fixBrainClassification: vi.fn(),
  retryBrainClassification: vi.fn(),
  updateBrainInboxEntry: vi.fn(),
  deleteBrainInboxEntry: vi.fn(),
  markBrainInboxDone: vi.fn(),
  markBrainInboxSentToCatalog: vi.fn(),
  getBrainMemories: vi.fn(),
  getBrainMemory: vi.fn(),
  createBrainMemory: vi.fn(),
  updateBrainMemory: vi.fn(),
  deleteBrainMemory: vi.fn(),
  getMemoryBackendStatus: vi.fn().mockResolvedValue({ backend: 'postgres' }),
  getChatgptArchive: vi.fn(),
}));

vi.mock('../../../services/api', () => api);
vi.mock('../../../services/apiBrain', () => api);
vi.mock('../../../services/socket', () => ({ default: mockSocket }));

vi.mock('../../../hooks', () => ({
  useLocalStorageBool: () => [false, vi.fn()],
  useRepoIntake: () => ({
    repo: null,
    options: { malwareScan: false, learn: false },
    managedApps: [],
    targetAppId: 'portos-default',
    setTargetAppId: vi.fn(),
    studyContext: '',
    setStudyContext: vi.fn(),
    providerOverride: { providerId: '', model: '', effort: '' },
    providers: [],
    activeProviderId: '',
    setProviderOverride: vi.fn(),
    toggle: vi.fn(),
    intakeFor: vi.fn(() => undefined),
  }),
}));

vi.mock('../../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

vi.mock('../VoiceCapture', () => ({ default: () => null }));
vi.mock('../RepoIntakeOptions', () => ({ default: () => null }));

import InboxTab from './InboxTab';
import MemoryTab from './MemoryTab';

function mountInbox() {
  return render(
    <MemoryRouter initialEntries={['/brain/inbox']}>
      <InboxTab />
    </MemoryRouter>
  );
}

function mountMemory(path = '/brain/memory') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/brain/:tab/:recordType?/:recordId?" element={<MemoryTab />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('Brain collection pagination & UI bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSocketListeners.clear();
  });

  describe('InboxTab bounded collection and pagination', () => {
    it('renders bounded page of 50 items and server counts from thousands-record collection', async () => {
      // 1,200 synthetic inbox items
      const thousandItems = Array.from({ length: 50 }, (_, i) => ({
        id: `inbox-item-${i}`,
        capturedText: `Thought entry #${i}`,
        status: 'needs_review',
        capturedAt: new Date(Date.now() - i * 60000).toISOString()
      }));

      api.getBrainInbox.mockResolvedValueOnce({
        items: thousandItems,
        total: 1200,
        nextCursor: 'cursor_page_2',
        counts: {
          total: 1200,
          needs_review: 600,
          filed: 400,
          done: 200,
          classifying: 0
        }
      });

      mountInbox();

      // Ensure initial load bounds
      await waitFor(() => {
        expect(screen.getByText('Thought entry #0')).toBeTruthy();
        expect(screen.getByText('Thought entry #49')).toBeTruthy();
      });

      // Bounded rendered rows: exactly 50 items
      const items = screen.getAllByText(/Thought entry #/);
      expect(items).toHaveLength(50);

      // Verify server counts are displayed
      expect(screen.getByText(/Needs Review \(600\)/)).toBeTruthy();

      // Verify InfiniteScrollFooter rendered with manual Load more button
      const loadMoreBtn = screen.getByRole('button', { name: 'Load more' });
      expect(loadMoreBtn).toBeTruthy();

      // Test keyboard interaction: clicking Load more
      const page2Items = Array.from({ length: 50 }, (_, i) => ({
        id: `inbox-item-${i + 50}`,
        capturedText: `Thought entry #${i + 50}`,
        status: 'needs_review',
        capturedAt: new Date(Date.now() - (i + 50) * 60000).toISOString()
      }));

      api.getBrainInbox.mockResolvedValueOnce({
        items: page2Items,
        total: 1200,
        nextCursor: null, // End of collection
      });

      fireEvent.click(loadMoreBtn);

      await waitFor(() => {
        expect(screen.getByText('Thought entry #99')).toBeTruthy();
      });

      // Total rendered rows now 100
      expect(screen.getAllByText(/Thought entry #/)).toHaveLength(100);

      // End of collection message
      await waitFor(() => {
        expect(screen.getByText('All results loaded')).toBeTruthy();
      });
    });

    it('preserves optimistic captures across refresh and guards deleted entries against stale resurrection', async () => {
      api.getBrainInbox.mockResolvedValue({
        items: [
          { id: 'inbox-1', capturedText: 'Existing item 1', status: 'filed', capturedAt: new Date().toISOString() },
          { id: 'inbox-2', capturedText: 'Existing item 2', status: 'filed', capturedAt: new Date().toISOString() }
        ],
        total: 2,
        nextCursor: null
      });

      api.captureBrainThought.mockResolvedValue({
        inboxLog: { id: 'inbox-server-3', capturedText: 'My fresh optimistic thought', status: 'classifying' },
        message: 'Saved'
      });

      mountInbox();

      await screen.findByText('Existing item 1');

      // Submit a thought
      const input = screen.getByLabelText('New inbox thought');
      fireEvent.change(input, { target: { value: 'My fresh optimistic thought' } });
      fireEvent.submit(input.closest('form'));

      // Optimistic thought immediately appears
      await screen.findByText('My fresh optimistic thought');

      // Wait for capture submission fetch to settle
      await waitFor(() => {
        expect(api.getBrainInbox).toHaveBeenCalledTimes(2);
      });

      // Reconnect event triggers refreshFirst()
      await act(async () => {
        mockSocket.emitEvent('connect');
      });

      await waitFor(() => {
        expect(api.getBrainInbox).toHaveBeenCalledTimes(3);
      });

      // Optimistic entry survives refresh
      expect(screen.getByText('My fresh optimistic thought')).toBeTruthy();

      // Delete item 1
      api.deleteBrainInboxEntry.mockResolvedValue({});
      fireEvent.click(screen.getAllByRole('button', { name: 'Delete entry' })[0]);
      const confirm = screen.getByTitle('Confirm delete');
      await act(async () => {
        fireEvent.click(confirm);
      });

      await waitFor(() => {
        expect(screen.queryByText('Existing item 1')).toBeNull();
      });

      // Stale response from server tries to return inbox-1
      api.getBrainInbox.mockResolvedValueOnce({
        items: [
          { id: 'inbox-1', capturedText: 'Existing item 1', status: 'filed', capturedAt: new Date().toISOString() },
          { id: 'inbox-2', capturedText: 'Existing item 2', status: 'filed', capturedAt: new Date().toISOString() }
        ],
        total: 2,
        nextCursor: null
      });

      await act(async () => {
        mockSocket.emitEvent('connect');
      });

      // Ensure deleted item is NOT resurrected
      await waitFor(() => {
        expect(screen.queryByText('Existing item 1')).toBeNull();
        expect(screen.getByText('Existing item 2')).toBeTruthy();
      });
    });
  });

  describe('MemoryTab bounded collection, search, and deep-link hydration', () => {
    it('renders bounded page of memories and executes query-wide debounced search', async () => {
      const pagedMemories = Array.from({ length: 25 }, (_, i) => ({
        id: `mem-${i}`,
        title: `Memory Title ${i}`,
        content: `Short teaser content for memory ${i}`,
        contentTruncated: true
      }));

      api.getBrainMemories.mockResolvedValueOnce({
        items: pagedMemories,
        total: 1500,
        nextCursor: 'mem_cursor_2'
      });

      mountMemory();

      await screen.findByText('Memory Title 0');
      expect(screen.getAllByText(/Memory Title/)).toHaveLength(25);

      // Search queries the server with debounced input
      api.getBrainMemories.mockResolvedValueOnce({
        items: [{ id: 'mem-999', title: 'Needle Search Result', content: 'Search match teaser', contentTruncated: true }],
        total: 1,
        nextCursor: null
      });

      const searchInput = screen.getByPlaceholderText(/Search/);
      fireEvent.change(searchInput, { target: { value: 'Needle' } });

      await waitFor(() => {
        expect(api.getBrainMemories).toHaveBeenCalledWith(expect.objectContaining({ search: 'Needle' }));
      });

      await screen.findByText('Needle Search Result');
      expect(screen.getAllByText(/Search Result/)).toHaveLength(1);
    });

    it('hydrates full record details on demand for deep-linked memory route', async () => {
      api.getBrainMemories.mockResolvedValue({
        items: [
          { id: 'mem-deeplink', title: 'Deep Memory', content: 'Truncated summary...', contentTruncated: true }
        ],
        total: 1,
        nextCursor: null
      });

      api.getBrainMemory.mockResolvedValue({
        id: 'mem-deeplink',
        title: 'Deep Memory',
        content: '# Full Un-truncated Content\n\nDetailed reflection that was loaded on demand.',
        contentTruncated: false
      });

      mountMemory('/brain/memory/memories/mem-deeplink');

      await screen.findByRole('complementary', { name: 'Preview: Deep Memory' });

      // Ensure detail endpoint was called on demand
      await waitFor(() => {
        expect(api.getBrainMemory).toHaveBeenCalledWith('mem-deeplink');
      });

      // Full content rendered in reader pane
      expect(screen.getByText(/Detailed reflection that was loaded on demand/)).toBeTruthy();
    });
  });
});
