import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/api', () => ({
  getCosConfig: vi.fn(),
  getMemories: vi.fn(),
  getMemoryStats: vi.fn(),
  getEmbeddingStatus: vi.fn(),
  getMemoryBackendStatus: vi.fn(),
  deleteMemory: vi.fn(),
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
vi.mock('./MemoryEditModal', () => ({ default: () => null }));
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

const pending = {
  id: 'synthetic-pending-1',
  content: 'A synthetic pending memory',
  type: 'fact',
  status: 'pending_approval',
  createdAt: '2026-10-01T12:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosConfig.mockResolvedValue({});
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
