import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PeerSyncSecretEditor from './PeerSyncSecretEditor';
import { pairPeerSyncSecret } from '../../services/api';
vi.mock('../../services/api', () => ({ pairPeerSyncSecret: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn() } }));

describe('peer record push pairing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('generates and sends a secret without exposing it in the browser', async () => {
    const onRefresh = vi.fn();
    pairPeerSyncSecret.mockResolvedValueOnce({ hasSyncSecret: true });
    render(<PeerSyncSecretEditor
      peer={{ id: 'peer-a', auth: { hasPassword: true }, hasSyncSecret: false }}
      onRefresh={onRefresh}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'Generate & pair' }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(pairPeerSyncSecret).toHaveBeenCalledWith('peer-a');
    expect(screen.queryByLabelText('Shared sync secret')).toBeNull();
  });

  it('reuses the local secret to retry an unconfirmed pairing', async () => {
    pairPeerSyncSecret.mockResolvedValueOnce({ hasSyncSecret: true });
    render(<PeerSyncSecretEditor
      peer={{ id: 'peer-a', auth: { hasPassword: true }, hasSyncSecret: true, peerAuthAccepted: false }}
      onRefresh={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'Retry pairing' }));
    await waitFor(() => expect(pairPeerSyncSecret).toHaveBeenCalledWith('peer-a'));
    expect(screen.getByText(/confirmation is still pending/)).toBeTruthy();
  });

  it('requires a saved peer password before automatic setup and confirms success', () => {
    const peer = { id: 'peer-a', auth: { username: '', hasPassword: true }, hasSyncSecret: true };
    const { rerender } = render(<PeerSyncSecretEditor peer={peer} onRefresh={vi.fn()} />);
    expect(screen.getByText(/instance password stays in use/)).toBeTruthy();
    rerender(<PeerSyncSecretEditor peer={{ ...peer, peerAuthAccepted: true }} onRefresh={vi.fn()} />);
    expect(screen.getByText(/accepts the pair credential/)).toBeTruthy();
    rerender(<PeerSyncSecretEditor peer={{ ...peer, auth: null, peerAuthAccepted: false }} onRefresh={vi.fn()} />);
    expect(screen.getByText(/Save this peer’s instance password here/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry pairing' }).disabled).toBe(true);
    rerender(<PeerSyncSecretEditor peer={{ ...peer, auth: null, peerAuthAccepted: true }} onRefresh={vi.fn()} />);
    expect(screen.queryByText(/Save this peer’s instance password here/)).toBeNull();
  });
});
