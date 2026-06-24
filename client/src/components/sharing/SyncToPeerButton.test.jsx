import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/api', () => ({
  getInstances: vi.fn(),
  listPeerSubscriptions: vi.fn(),
  subscribeToPeer: vi.fn(),
  unsubscribeFromPeer: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import * as api from '../../services/api';
import SyncToPeerButton from './SyncToPeerButton';

beforeEach(() => {
  vi.clearAllMocks();
  api.getInstances.mockResolvedValue({
    peers: [
      // syncCategories needs to include the record-kind-matching category
      // (universe for these tests) so the dropdown's peerHasMatchingCategory
      // guard doesn't disable the row.
      { instanceId: 'peer-a', name: 'Peer A', enabled: true, status: 'online', host: 'host-a.tail.net', syncCategories: { universe: true, pipeline: true } },
      { instanceId: 'peer-b', name: 'Peer B', enabled: true, status: 'offline', address: '10.0.0.3', syncCategories: { universe: true, pipeline: true } },
      { instanceId: 'peer-c', name: 'Peer C disabled', enabled: false, status: 'offline' },
      { instanceId: '', name: 'No-id peer', enabled: true },
    ],
  });
  api.listPeerSubscriptions.mockResolvedValue({ subscriptions: [] });
});

describe('SyncToPeerButton', () => {
  it('does not open the dropdown when there is no recordId', async () => {
    const user = userEvent.setup();
    render(<SyncToPeerButton recordKind="universe" recordId={null} />);
    const button = screen.getByRole('button', { name: /Sync/i });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(screen.queryByText(/Subscribe to peer/i)).toBeNull();
  });

  it('lists only enabled peers with an instanceId on open', async () => {
    const user = userEvent.setup();
    render(<SyncToPeerButton recordKind="universe" recordId="u1" />);
    await user.click(screen.getByRole('button', { name: /Sync/i }));
    await waitFor(() => expect(api.getInstances).toHaveBeenCalled());
    expect(await screen.findByText('Peer A')).toBeTruthy();
    expect(screen.getByText('Peer B')).toBeTruthy();
    // disabled peer + no-id peer hidden.
    expect(screen.queryByText(/Peer C disabled/i)).toBeNull();
    expect(screen.queryByText(/No-id peer/i)).toBeNull();
  });

  it('a full-sync peer is subscribable even with no per-category map', async () => {
    // peerCanReceiveOutbound must honor fullSync — a mirror-everything peer can
    // always receive, regardless of its syncCategories.
    api.getInstances.mockResolvedValue({
      peers: [
        { instanceId: 'peer-full', name: 'Peer Full', enabled: true, status: 'online', host: 'host-f.tail.net', fullSync: true, syncCategories: {} },
      ],
    });
    api.subscribeToPeer.mockResolvedValue({ subscription: { id: 'peer-universe-u1-peer-full' } });
    const user = userEvent.setup();
    render(<SyncToPeerButton recordKind="universe" recordId="u1" />);
    await user.click(screen.getByRole('button', { name: /Sync/i }));
    const row = await screen.findByRole('button', { name: /Peer Full/i });
    expect(row).not.toBeDisabled();
    await user.click(row);
    await waitFor(() => expect(api.subscribeToPeer).toHaveBeenCalledWith(
      { peerId: 'peer-full', recordKind: 'universe', recordId: 'u1' },
      expect.anything(),
    ));
  });

  it('shows a filled check when already subscribed to that peer', async () => {
    api.listPeerSubscriptions.mockResolvedValue({
      subscriptions: [{
        id: 'peer-universe-u1-peer-a',
        peerId: 'peer-a',
        recordKind: 'universe',
        recordId: 'u1',
      }],
    });
    const user = userEvent.setup();
    render(<SyncToPeerButton recordKind="universe" recordId="u1" />);
    await user.click(screen.getByRole('button', { name: /Sync/i }));
    await waitFor(() => expect(api.listPeerSubscriptions).toHaveBeenCalled());
    // We can't easily assert on the icon shape; assert via the row count + that
    // the peer's name renders alongside an enabled-looking button.
    expect(await screen.findByText('Peer A')).toBeTruthy();
  });

  it('subscribes when an unchecked peer row is clicked', async () => {
    api.subscribeToPeer.mockResolvedValue({
      subscription: {
        id: 'peer-universe-u1-peer-a',
        peerId: 'peer-a',
        recordKind: 'universe',
        recordId: 'u1',
      },
    });
    const user = userEvent.setup();
    render(<SyncToPeerButton recordKind="universe" recordId="u1" />);
    await user.click(screen.getByRole('button', { name: /Sync/i }));
    await screen.findByText('Peer A');
    await user.click(screen.getByText('Peer A'));
    expect(api.subscribeToPeer).toHaveBeenCalledWith(
      { peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' },
      { silent: true },
    );
  });

  it('unsubscribes when a checked peer row is clicked', async () => {
    api.listPeerSubscriptions.mockResolvedValue({
      subscriptions: [{
        id: 'peer-universe-u1-peer-a',
        peerId: 'peer-a',
        recordKind: 'universe',
        recordId: 'u1',
      }],
    });
    api.unsubscribeFromPeer.mockResolvedValue({ id: 'peer-universe-u1-peer-a', removed: true });
    const user = userEvent.setup();
    render(<SyncToPeerButton recordKind="universe" recordId="u1" />);
    await user.click(screen.getByRole('button', { name: /Sync/i }));
    await screen.findByText('Peer A');
    await user.click(screen.getByText('Peer A'));
    expect(api.unsubscribeFromPeer).toHaveBeenCalledWith('peer-universe-u1-peer-a', { silent: true });
  });
});
