import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

vi.mock('../../../services/api', () => ({
  getCosConfig: vi.fn(),
  getMemories: vi.fn(),
  getMemoryStats: vi.fn(),
  getEmbeddingStatus: vi.fn(),
  getMemoryBackendStatus: vi.fn(),
  deleteMemory: vi.fn(),
  updateMemory: vi.fn(),
  getMemory: vi.fn(),
  searchMemories: vi.fn(),
  getMemoryVersions: vi.fn(),
  getMemoryVersion: vi.fn(),
}));

const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn() }));
vi.mock('../../../services/socket', () => ({ default: socket }));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [], availableModels: [], setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(), selectedProviderId: '', selectedModel: '',
  }),
}));
vi.mock('./MemoryTimeline', () => ({ default: () => null }));
vi.mock('./MemoryRunsUsedBy', () => ({ default: () => null }));
vi.mock('./MemoryGraph', () => ({ default: () => <p>Graph view</p> }));
vi.mock('../../ui/InlineConfirmRow', () => ({
  default: ({ question, confirmText, onConfirm, onCancel }) => (
    <div>
      <p>{question}</p>
      <button type="button" onClick={onConfirm}>{confirmText}</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  ),
}));

import * as api from '../../../services/api';
import MemoryTab from './MemoryTab';

const handlers = new Map();
const dispatch = async (event, payload) => {
  await act(async () => { for (const handler of handlers.get(event) || []) handler(payload); });
};
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const activeMemory = { id: 'synthetic-active', content: 'Original body', summary: 'Original summary', type: 'fact', status: 'active' };
const renderTab = (entry = '/cos/memory') => render(<MemoryRouter initialEntries={[entry]}>
  <Routes><Route path="/cos/memory/:agentId?" element={<MemoryTab />} /></Routes>
</MemoryRouter>);

const pending = {
  id: 'synthetic-pending-1',
  content: 'A synthetic pending memory',
  type: 'fact',
  status: 'pending_approval',
  createdAt: '2026-10-01T12:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  socket.on.mockImplementation((event, handler) => {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(handler);
  });
  socket.off.mockImplementation((event, handler) => handlers.get(event)?.delete(handler));
  api.getMemories.mockReset();
  api.getCosConfig.mockResolvedValue({});
  api.getMemory.mockResolvedValue({ ...activeMemory, version: 1 });
  api.getMemoryVersions.mockResolvedValue({ versions: [] });
  api.getMemories.mockResolvedValue({ memories: [] });
  api.getMemoryStats.mockResolvedValue({ active: 0, pendingApproval: 0 });
  api.getEmbeddingStatus.mockResolvedValue({ available: false });
  api.getMemoryBackendStatus.mockResolvedValue({ backend: 'postgres' });
});

describe('MemoryTab live approvals', () => {
  it('shows a newly pending memory when cos:memory:approval-needed arrives, without navigation', async () => {
    render(
      <MemoryRouter initialEntries={['/cos/memory']}>
        <MemoryTab apps={[]} />
      </MemoryRouter>
    );
    await waitFor(() => expect(socket.on).toHaveBeenCalledWith('cos:memory:approval-needed', expect.any(Function)));
    expect(screen.queryByText('A synthetic pending memory')).toBeNull();

    api.getMemories.mockImplementation(async (params = {}) => ({ memories: params.status === 'pending_approval' ? [pending] : [] }));
    const handler = socket.on.mock.calls.find(([event]) => event === 'cos:memory:approval-needed')[1];
    await act(async () => { await handler({ memories: [{ id: pending.id }] }); });

    expect(await screen.findByText('A synthetic pending memory')).toBeTruthy();
    expect(screen.getByText('Pending Approval (1)')).toBeTruthy();
  });
});

describe('MemoryTab lifecycle reconciliation', () => {
  it('coalesces in-flight mutations and keeps rows/counts visible until the fresh result arrives', async () => {
    api.getMemories.mockImplementation(async params => ({ memories: params.status ? [] : [activeMemory] }));
    api.getMemoryStats.mockResolvedValue({ active: 1 });
    renderTab();
    await screen.findByText('Original summary');

    const read = deferred();
    let activeReads = 0;
    api.getMemories.mockImplementation(params => {
      if (params.status) return Promise.resolve({ memories: [] });
      activeReads += 1;
      return activeReads === 1 ? read.promise : Promise.resolve({ memories: [{ ...activeMemory, summary: 'Latest summary' }] });
    });
    api.getMemoryStats.mockResolvedValue({ active: 2 });
    await dispatch('cos:memory:updated', { id: activeMemory.id });
    expect(screen.getByText('Original summary')).toBeInTheDocument();
    expect(screen.queryByText('Loading')).not.toBeInTheDocument();
    await act(async () => {
      for (let i = 0; i < 30; i++) for (const handler of handlers.get('cos:memory:updated')) handler({ id: activeMemory.id });
    });
    expect(activeReads).toBe(1);
    await act(async () => { read.resolve({ memories: [{ ...activeMemory, summary: 'Intermediate summary' }] }); });
    expect(await screen.findByText('Latest summary')).toBeInTheDocument();
    expect(screen.getByText(/2 active memories/)).toBeInTheDocument();
    expect(activeReads).toBe(2);

    api.getMemories.mockImplementation(async () => ({ memories: [] }));
    api.getMemoryStats.mockResolvedValue({ active: 0 });
    await dispatch('cos:memory:deleted', { id: activeMemory.id });
    expect(screen.queryByText('Latest summary')).not.toBeInTheDocument();
    expect(screen.getByText(/0 active memories/)).toBeInTheDocument();
  });

  it('drops an old source response and aborts a pending read on unmount', async () => {
    const oldRead = deferred();
    let oldSignal;
    api.getMemories.mockImplementation((params, options) => {
      if (params.status) return Promise.resolve({ memories: [] });
      if (params.appId === 'brain') return Promise.resolve({ memories: [{ ...activeMemory, summary: 'Brain summary' }] });
      oldSignal = options.signal;
      return oldRead.promise;
    });
    const view = renderTab();
    await waitFor(() => expect(oldSignal).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Brain' }));
    expect(await screen.findByText('Brain summary')).toBeInTheDocument();
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { oldRead.resolve({ memories: [activeMemory] }); });
    expect(screen.queryByText('Original summary')).not.toBeInTheDocument();
    const lateRead = deferred();
    let lateSignal;
    api.getMemories.mockImplementation((params, options) => {
      if (params.status) return Promise.resolve({ memories: [] });
      lateSignal = options.signal;
      return lateRead.promise;
    });
    await dispatch('cos:memory:created', { id: 'synthetic-new' });
    view.unmount();
    expect(lateSignal.aborted).toBe(true);
    await act(async () => { lateRead.resolve({ memories: [activeMemory] }); });
    expect(handlers.get('cos:memory:updated').size).toBe(0);
  });

  it('recovers missed changes on reconnect and tab-show while suppressing hidden reads', async () => {
    api.getMemories.mockImplementation(async params => ({ memories: params.status ? [] : [activeMemory] }));
    renderTab();
    await screen.findByText('Original summary');
    api.getMemories.mockImplementation(async params => ({ memories: params.status ? [] : [{ ...activeMemory, summary: 'Reconnect summary' }] }));
    await dispatch('connect');
    expect(await screen.findByText('Reconnect summary')).toBeInTheDocument();
    const calls = api.getMemories.mock.calls.length;
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await dispatch('cos:memory:deleted', { id: activeMemory.id });
    await dispatch('connect');
    expect(api.getMemories).toHaveBeenCalledTimes(calls);
    api.getMemories.mockResolvedValue({ memories: [] });
    visibility.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(screen.queryByText('Reconnect summary')).not.toBeInTheDocument();
    visibility.mockRestore();
  });

  it('refreshes submitted search results and preserves an open dirty editor', async () => {
    api.getMemories.mockImplementation(async params => ({ memories: params.status ? [] : [activeMemory] }));
    renderTab();
    await screen.findByText('Original summary');
    fireEvent.click(screen.getByRole('button', { name: 'Edit memory' }));
    await screen.findByDisplayValue('Original body');
    fireEvent.change(screen.getByRole('textbox', { name: /Content/ }), { target: { value: 'Unsaved draft' } });
    api.getMemory.mockResolvedValue({ ...activeMemory, version: 2, content: 'Remote body', summary: 'Remote summary' });
    api.getMemories.mockImplementation(async params => ({ memories: params.status ? [] : [{ ...activeMemory, content: 'Remote body', summary: 'Remote summary' }] }));
    await dispatch('cos:memory:updated', { id: activeMemory.id });
    expect(screen.getByRole('textbox', { name: /Content/ })).toHaveValue('Unsaved draft');
    expect(screen.getByRole('textbox', { name: /Summary/ })).toHaveValue('Original summary');
    expect(screen.getByText(/A newer revision exists/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close edit memory' }));
    // Search remains a server-wide query and refreshes the submitted term,
    // even when the unsubmitted input has since changed.
    api.searchMemories.mockResolvedValue({ memories: [{ ...activeMemory, summary: 'Search summary' }] });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search memories' }), { target: { value: 'first query' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('Search summary');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search memories' }), { target: { value: 'unsubmitted query' } });
    api.searchMemories.mockResolvedValue({ memories: [] });
    await dispatch('cos:memory:deleted', { id: activeMemory.id });
    expect(api.searchMemories).toHaveBeenLastCalledWith('first query', expect.any(Object), expect.any(Object));
    expect(screen.queryByText('Search summary')).not.toBeInTheDocument();
  });

  it('does not read inactive list data in graph view and retains rows after refresh failure', async () => {
    renderTab('/cos/memory?view=graph');
    await screen.findByText('Graph view');
    expect(api.getMemories.mock.calls.every(([params]) => params.status === 'pending_approval')).toBe(true);
    api.getMemories.mockImplementation(async params => ({ memories: params.status ? [] : [activeMemory] }));
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    await screen.findByText('Original summary');
    api.getMemories.mockRejectedValue(new Error('Synthetic read failure'));
    await dispatch('cos:memory:updated', { id: activeMemory.id });
    expect(screen.getByText('Original summary')).toBeInTheDocument();
    expect(screen.getByText('Unable to refresh memories')).toBeInTheDocument();
  });
});

describe('independent approval/count availability', () => {
  it('keeps a usable approval queue when counts fail and retains counts when the queue fails', async () => {
    api.getMemories.mockImplementation(async params => ({ memories: params.status ? [pending] : [activeMemory] }));
    api.getMemoryStats.mockRejectedValue(new Error('Synthetic stats failure'));
    renderTab();
    expect(await screen.findByText('A synthetic pending memory')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve memory' })).toBeEnabled();
    api.getMemoryStats.mockResolvedValue({ active: 1, pendingApproval: 1 });
    await dispatch('connect');
    expect(screen.getByText(/1 active memories/)).toBeInTheDocument();
    api.getMemories.mockImplementation(params => params.status
      ? Promise.reject(new Error('Synthetic pending failure'))
      : Promise.resolve({ memories: [activeMemory] }));
    api.getMemoryStats.mockResolvedValue({ active: 2, pendingApproval: 1 });
    await dispatch('cos:memory:updated', { id: activeMemory.id });
    expect(screen.getByText(/2 active memories/)).toBeInTheDocument();
    expect(screen.getByText('A synthetic pending memory')).toBeInTheDocument();
  });
});
