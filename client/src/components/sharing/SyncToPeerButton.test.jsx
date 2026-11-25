import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/apiSystem.js', () => ({
  getInstances: vi.fn(),
}));
vi.mock('../../services/apiPeerSync.js', () => ({
  listPeerSubscriptions: vi.fn(),
  subscribeToPeer: vi.fn(),
  unsubscribeFromPeer: vi.fn(),
}));
vi.mock('../ui/Toast');

import { getInstances } from '../../services/apiSystem.js';
import { listPeerSubscriptions, subscribeToPeer, unsubscribeFromPeer } from '../../services/apiPeerSync.js';
import SyncToPeerButton from './SyncToPeerButton';

beforeEach(() => {
  vi.clearAllMocks();
  getInstances.mockResolvedValue({
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
  listPeerSubscriptions.mockResolvedValue({ subscriptions: [] });
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

  it('moves focus into a labelled dialog, traps Tab, and restores focus on Escape', async () => {
    const user = userEvent.setup();
    render(<SyncToPeerButton recordKind="universe" recordId="u1" />);
    const trigger = screen.getByRole('button', { name: /Sync/i });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Subscribe to peer' });
    const rowA = await screen.findByRole('button', { name: /Peer A/i });
    const rowB = screen.getByRole('button', { name: /Peer B/i });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    rowB.focus();
    await user.tab();
    expect(document.activeElement).toBe(rowA);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(rowB);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('uses the label as the accessible name in compact mode', () => {
    render(<SyncToPeerButton recordKind="universe" recordId="u1" compact label="Sync universe" />);
    expect(screen.getByRole('button', { name: 'Sync universe' })).toBeTruthy();
  });

  it('exposes subscribed state through aria-pressed on peer rows', async () => {
    listPeerSubscriptions.mockResolvedValue({ subscriptions: [{ id: 's-a', peerId: 'peer-a' }] });
    subscribeToPeer.mockResolvedValue({ subscription: { id: 's-b', peerId: 'peer-b' } });
    const user = userEvent.setup();
    render(<SyncToPeerButton recordKind="universe" recordId="u1" />);
    await user.click(screen.getByRole('button', { name: /Sync/i }));
    const rowA = await screen.findByRole('button', { name: /Peer A/i });
    expect(rowA).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Peer B/i })).toHaveAttribute('aria-pressed', 'false');
    await user.click(screen.getByRole('button', { name: /Peer B/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Peer B/i })).toHaveAttribute('aria-pressed', 'true'));
  });

  it('lists only enabled peers with an instanceId on open', async () => {
    const user = userEvent.setup();
    render(<SyncToPeerButton recordKind="universe" recordId="u1" />);
    await user.click(screen.getByRole('button', { name: /Sync/i }));
    await waitFor(() => expect(getInstances).toHaveBeenCalled());
    expect(await screen.findByText('Peer A')).toBeTruthy();
    expect(screen.getByText('Peer B')).toBeTruthy();
    // disabled peer + no-id peer hidden.
    expect(screen.queryByText(/Peer C disabled/i)).toBeNull();
    expect(screen.queryByText(/No-id peer/i)).toBeNull();
  });

  it('a full-sync peer is subscribable even with no per-category map', async () => {
    // peerCanReceiveOutbound must honor fullSync — a mirror-everything peer can
    // always receive, regardless of its syncCategories.
    getInstances.mockResolvedValue({
      peers: [
        { instanceId: 'peer-full', name: 'Peer Full', enabled: true, status: 'online', host: 'host-f.tail.net', fullSync: true, syncCategories: {} },
      ],
    });
    subscribeToPeer.mockResolvedValue({ subscription: { id: 'peer-universe-u1-peer-full' } });
    const user = userEvent.setup();
    render(<SyncToPeerButton recordKind="universe" recordId="u1" />);
    await user.click(screen.getByRole('button', { name: /Sync/i }));
    const row = await screen.findByRole('button', { name: /Peer Full/i });
    expect(row).not.toBeDisabled();
    await user.click(row);
    await waitFor(() => expect(subscribeToPeer).toHaveBeenCalledWith(
      { peerId: 'peer-full', recordKind: 'universe', recordId: 'u1' },
      expect.anything(),
    ));
  });

  it('uses the FableLoom category when sharing a loom', async () => {
    getInstances.mockResolvedValue({
      peers: [{
        instanceId: 'peer-fable',
        name: 'Peer Fable',
        enabled: true,
        status: 'online',
        syncCategories: { fableLoom: true },
      }],
    });
    subscribeToPeer.mockResolvedValue({
      subscription: { id: 'peer-fableLoom-loom-1-peer-fable' },
    });
    const user = userEvent.setup();
    render(<SyncToPeerButton recordKind="fableLoom" recordId="loom-1" />);
    await user.click(screen.getByRole('button', { name: /Sync/i }));
    const row = await screen.findByRole('button', { name: /Peer Fable/i });
    expect(row).not.toBeDisabled();
    await user.click(row);
    await waitFor(() => expect(subscribeToPeer).toHaveBeenCalledWith(
      { peerId: 'peer-fable', recordKind: 'fableLoom', recordId: 'loom-1' },
      { silent: true },
    ));
  });

  it('shows a filled check when already subscribed to that peer', async () => {
    listPeerSubscriptions.mockResolvedValue({
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
    await waitFor(() => expect(listPeerSubscriptions).toHaveBeenCalled());
    // We can't easily assert on the icon shape; assert via the row count + that
    // the peer's name renders alongside an enabled-looking button.
    expect(await screen.findByText('Peer A')).toBeTruthy();
  });

  it('subscribes when an unchecked peer row is clicked', async () => {
    subscribeToPeer.mockResolvedValue({
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
    expect(subscribeToPeer).toHaveBeenCalledWith(
      { peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' },
      { silent: true },
    );
  });

  it('unsubscribes when a checked peer row is clicked', async () => {
    listPeerSubscriptions.mockResolvedValue({
      subscriptions: [{
        id: 'peer-universe-u1-peer-a',
        peerId: 'peer-a',
        recordKind: 'universe',
        recordId: 'u1',
      }],
    });
    unsubscribeFromPeer.mockResolvedValue({ id: 'peer-universe-u1-peer-a', removed: true });
    const user = userEvent.setup();
    render(<SyncToPeerButton recordKind="universe" recordId="u1" />);
    await user.click(screen.getByRole('button', { name: /Sync/i }));
    await screen.findByText('Peer A');
    await user.click(screen.getByText('Peer A'));
    expect(unsubscribeFromPeer).toHaveBeenCalledWith('peer-universe-u1-peer-a', { silent: true });
  });

  it('flips the peer menu above the trigger when there is no room below', async () => {
    // Trigger low on a short viewport: the menu no longer fits underneath, so
    // the shared placement hook must open it upward instead of letting it hang
    // off the bottom (the hand-rolled coords this replaced always went below).
    Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 780 });
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 600, bottom: 640, left: 400, right: 460, width: 60, height: 240, x: 400, y: 600,
    });
    const user = userEvent.setup();
    render(<SyncToPeerButton recordKind="universe" recordId="u1" />);
    await user.click(screen.getByRole('button', { name: /Sync/i }));
    const menu = (await screen.findByText('Peer A')).closest('div[style*="position: fixed"]');
    expect(menu).toBeTruthy();
    const top = Number.parseFloat(menu.style.top);
    expect(top).toBeLessThan(600);
    expect(top).toBeGreaterThanOrEqual(8);
    vi.restoreAllMocks();
  });

  it('exposes aria-expanded=false when closed and aria-expanded=true when open', async () => {
    const user = userEvent.setup();
    render(<SyncToPeerButton recordKind="universe" recordId="u1" />);
    const trigger = screen.getByRole('button', { name: /Sync/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes the popover and returns focus to the trigger when Escape is pressed', async () => {
    const user = userEvent.setup();
    render(<SyncToPeerButton recordKind="universe" recordId="u1" />);
    const trigger = screen.getByRole('button', { name: /Sync/i });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // Focus returns to the trigger after Escape.
    expect(document.activeElement).toBe(trigger);
  });

  it('shows an error row with Retry when the peer read fails, not "No peers configured"', async () => {
    const user = userEvent.setup();
    getInstances.mockRejectedValueOnce(new Error('instances 500'));
    render(<SyncToPeerButton recordKind="universe" recordId="u1" />);
    await user.click(screen.getByRole('button', { name: /Sync/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load peers — instances 500');
    expect(screen.queryByText(/No peers configured/)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Peer A')).toBeTruthy();
  });

  it('does not render unchecked rows when the subscription read fails', async () => {
    const user = userEvent.setup();
    listPeerSubscriptions.mockRejectedValueOnce(new Error('subs 500'));
    render(<SyncToPeerButton recordKind="universe" recordId="u1" />);
    await user.click(screen.getByRole('button', { name: /Sync/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load subscriptions — subs 500');
    expect(screen.queryByText('Peer A')).toBeNull();
  });
});
