import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PeerSyncSecretEditor from './PeerSyncSecretEditor';
import { updatePeer } from '../../services/api';
vi.mock('../../services/api', () => ({ updatePeer: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn() } }));

describe('peer record push pairing', () => {
  beforeEach(() => vi.clearAllMocks());
  it('keeps a failed secret edit available, then clears it only after a successful save', async () => {
    const onRefresh = vi.fn();
    updatePeer.mockRejectedValueOnce(new Error('Save failed')).mockResolvedValueOnce({ hasSyncSecret: true });
    render(<PeerSyncSecretEditor peer={{ id: 'peer-a', hasSyncSecret: false }} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Set sync secret' }));
    const input = screen.getByLabelText('Shared sync secret');
    fireEvent.change(input, { target: { value: 'synthetic-pair-secret-32-characters-long' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save secret' }).disabled).toBe(false));
    expect(input.value).toBe('synthetic-pair-secret-32-characters-long');
    expect(onRefresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(updatePeer).toHaveBeenLastCalledWith('peer-a', { syncSecret: 'synthetic-pair-secret-32-characters-long' });
    expect(screen.queryByLabelText('Shared sync secret')).toBeNull();
  });
});
