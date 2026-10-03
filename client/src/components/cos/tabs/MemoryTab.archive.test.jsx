import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/api', () => ({
  getCosConfig: vi.fn(),
  getMemories: vi.fn(),
  getMemoryStats: vi.fn(),
  getEmbeddingStatus: vi.fn(),
  getMemoryBackendStatus: vi.fn(),
  deleteMemory: vi.fn(),
}));

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

const memory = {
  id: 'synthetic-memory-1',
  content: 'A synthetic test memory',
  type: 'fact',
  status: 'active',
  createdAt: '2026-10-01T12:00:00.000Z',
};

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/cos/memory']}>
      <MemoryTab apps={[]} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosConfig.mockResolvedValue({});
  api.getMemories.mockResolvedValue({ memories: [memory] });
  api.getMemoryStats.mockResolvedValue({ active: 1, pendingApproval: 0 });
  api.getEmbeddingStatus.mockResolvedValue({ available: false });
  api.getMemoryBackendStatus.mockResolvedValue({ backend: 'postgres' });
  api.deleteMemory.mockResolvedValue({ success: true });
});

describe('MemoryTab archive confirmation', () => {
  it('explains retained content, lets Cancel avoid mutation, and archives through the existing API intent', async () => {
    const user = userEvent.setup();
    renderTab();

    await screen.findAllByText('A synthetic test memory');
    await user.click(screen.getByRole('button', { name: 'Archive memory' }));

    expect(screen.getByText('Archive this memory? It will be hidden from active memory and search. Its contents remain stored.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.deleteMemory).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Archive memory' }));
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    // The wrapper's default hard=false keeps this existing archive request soft.
    await waitFor(() => expect(api.deleteMemory).toHaveBeenCalledWith(memory.id));
  });
});
