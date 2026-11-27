import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SyncCategoriesPanel from './SyncCategoriesPanel';
import { reciprocatePeer, getPeerFullSyncCoverage, updatePeer } from '../../services/apiSystem.js';
import toast from '../ui/Toast';

vi.mock('../../services/apiSystem.js', () => ({
  updatePeer: vi.fn(),
  reciprocatePeer: vi.fn(),
  getPeerFullSyncCoverage: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

describe('SyncCategoriesPanel reciprocation errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPeerFullSyncCoverage.mockResolvedValue({ fullyMirrored: true, total: 0, confirmed: 0, pending: 0 });
    updatePeer.mockResolvedValue({});
  });

  it('shows the server error message when reciprocation fails', async () => {
    reciprocatePeer.mockResolvedValue({ error: 'Peer is not ready to reciprocate sync categories' });
    render(<SyncCategoriesPanel peer={{ id: 'peer-1', name: 'Example peer', instanceId: 'remote-id' }} onRefresh={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Sync Categories/ }));
    fireEvent.click(screen.getByRole('button', { name: /Make mutual|sync back|mutual/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Peer is not ready to reciprocate sync categories'));
  });
});
