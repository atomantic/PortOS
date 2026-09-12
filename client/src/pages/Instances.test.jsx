import { MemoryRouter } from 'react-router';
import * as api from '../services/api';
import socket from '../services/socket';
import { TailcatServeProvider } from '../components/instances/TailcatServeProvider';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as renderUI, screen, within, fireEvent, waitFor, act } from '@testing-library/react';
import TailcatServePanel from '../components/instances/TailcatServePanel';
import Instances, { AddPeerForm, PeerCard } from './Instances.jsx';
import { DEFAULT_TAILCAT_REMOTE_PORT } from '../lib/ports.js';
import { DEFAULT_PEER_PORT, DEFAULT_TAILCAT_LOCAL_PORT } from '../lib/ports.js';
import { addPeer, addTailcatPeer, startTailcatServe, getTailcatServe, stopTailcatServe, removePeer, listPeerSubscriptions, getPeerFullSyncCoverage, syncPeer } from '../services/api';

vi.mock('../services/api', () => ({
  getInstances: vi.fn(),
  getSettings: vi.fn().mockResolvedValue({}),
  updateSettings: vi.fn(),
  getCosJob: vi.fn().mockResolvedValue(null),
  updateSelfInstance: vi.fn(),
  addPeer: vi.fn(),
  addTailcatPeer: vi.fn(),
  updatePeer: vi.fn(),
  removePeer: vi.fn(),
  connectPeer: vi.fn(),
  reciprocatePeer: vi.fn(),
  probePeer: vi.fn(),
  syncPeer: vi.fn(),
  getTailnetInfo: vi.fn(),
  getNetworkExposure: vi.fn(),
  listPeerSubscriptions: vi.fn(),
  getPeerFullSyncCoverage: vi.fn(),
  getBrainParityReports: vi.fn(),
  getTailcatForwards: vi.fn().mockResolvedValue({ forwards: [] }),
  retryTailcatForward: vi.fn(),
  forgetTailcatForward: vi.fn(),
  getTailcatServe: vi.fn().mockResolvedValue({
    enabled: false, status: 'stopped', live: false, localPort: 5555,
    keyName: 'portos-api', tcAddress: null, tcAddressRedacted: null, hasAddress: false,
  }),
  startTailcatServe: vi.fn(),
  retryTailcatServe: vi.fn(),
  stopTailcatServe: vi.fn(),
}));

vi.mock('../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } }));

describe('AddPeerForm port default', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addPeer.mockResolvedValue({ id: 'peer-1' });
  });

  // Regression: the placeholder advertised :5554 (the Vite dev port) while the
  // field defaulted to the API port, so clearing the field suggested a port
  // PortOS never serves the API on.
  it('advertises the same port in the placeholder as it defaults to', async () => {
    render(<AddPeerForm onAdd={() => {}} />);
    await act(async () => {});
    const portInput = screen.getByLabelText('Peer port');
    expect(portInput).toHaveValue(DEFAULT_PEER_PORT);
    expect(portInput.getAttribute('placeholder')).toBe(String(DEFAULT_PEER_PORT));
  });

  it('falls back to the default port when the field is cleared', async () => {
    render(<AddPeerForm onAdd={() => {}} />);
    fireEvent.change(screen.getByLabelText('Peer address'), { target: { value: '192.0.2.10' } });
    fireEvent.change(screen.getByLabelText('Peer port'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(addPeer).toHaveBeenCalledWith({
      address: '192.0.2.10',
      port: DEFAULT_PEER_PORT,
    }));
  });
});

describe('AddPeerForm tailcat path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addPeer.mockResolvedValue({ id: 'peer-1' });
    addTailcatPeer.mockResolvedValue({ id: 'peer-tc', port: DEFAULT_TAILCAT_LOCAL_PORT, transport: 'tailcat' });
  });

  it('submits a pasted tc address through addTailcatPeer (not classic addPeer)', async () => {
    render(<AddPeerForm onAdd={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tailcat' }));
    const tc = 'tcEXAMPLE' + 'B'.repeat(40);
    fireEvent.change(screen.getByLabelText('Tailcat address'), { target: { value: tc } });
    fireEvent.click(screen.getByRole('button', { name: 'Add via tailcat' }));
    await waitFor(() => expect(addTailcatPeer).toHaveBeenCalledWith({ tcAddress: tc, remotePort: DEFAULT_TAILCAT_REMOTE_PORT }));
    expect(addPeer).not.toHaveBeenCalled();
  });

  it('sends HTTPS selection for a remote TLS install', async () => {
    render(<AddPeerForm onAdd={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tailcat' }));
    const tc = 'tcEXAMPLE' + 'B'.repeat(40);
    fireEvent.change(screen.getByLabelText('Tailcat address'), { target: { value: tc } });
    fireEvent.click(screen.getByLabelText('Remote PortOS uses HTTPS'));
    fireEvent.click(screen.getByRole('button', { name: 'Add via tailcat' }));
    await waitFor(() => expect(addTailcatPeer).toHaveBeenCalledWith({ tcAddress: tc, protocol: 'https', remotePort: DEFAULT_TAILCAT_REMOTE_PORT }));
  });

  it('keeps classic host/port add working' , async () => {
    render(<AddPeerForm onAdd={() => {}} />);
    fireEvent.change(screen.getByLabelText('Peer address'), { target: { value: '192.0.2.10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(addPeer).toHaveBeenCalledWith({
      address: '192.0.2.10',
      port: DEFAULT_PEER_PORT,
    }));
    expect(addTailcatPeer).not.toHaveBeenCalled();
  });

  it('documents the 15555 local forward standard in the tailcat hint', async () => {
    render(<AddPeerForm onAdd={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tailcat' }));
    // Settling the silent getTailcatServe from switching into Tailcat mode.
    await waitFor(() => expect(getTailcatServe).toHaveBeenCalled());
    expect(screen.getAllByText(new RegExp(String(DEFAULT_TAILCAT_LOCAL_PORT))).length).toBeGreaterThan(0);
  });
});

describe('AddPeerForm dial direction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addTailcatPeer.mockResolvedValue({ id: 'peer-tc', port: DEFAULT_TAILCAT_LOCAL_PORT, transport: 'tailcat' });
    getTailcatServe.mockResolvedValue({
      enabled: false, status: 'stopped', live: false, localPort: 5555,
      keyName: 'portos-api', tcAddress: null, tcAddressRedacted: null, hasAddress: false,
    });
    startTailcatServe.mockResolvedValue({
      enabled: true, status: 'active', live: true, localPort: 5555,
      keyName: 'portos-api',
      tcAddress: 'tcEXAMPLE' + 'D'.repeat(40),
      tcAddressRedacted: 'tcEX…DDDD',
      hasAddress: true,
    });
  });

  it('defaults to Dial them and still submits a pasted address', async () => {
    render(<AddPeerForm onAdd={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tailcat' }));
    expect(screen.getByRole('button', { name: 'Dial them' })).toHaveAttribute('aria-pressed', 'true');
    const tc = 'tcEXAMPLE' + 'B'.repeat(40);
    fireEvent.change(screen.getByLabelText('Tailcat address'), { target: { value: tc } });
    fireEvent.click(screen.getByRole('button', { name: 'Add via tailcat' }));
    await waitFor(() => expect(addTailcatPeer).toHaveBeenCalledWith({ tcAddress: tc, remotePort: DEFAULT_TAILCAT_REMOTE_PORT }));
  });

  it('switches to They dial us and starts serve instead of pasting', async () => {
    render(<AddPeerForm onAdd={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tailcat' }));
    fireEvent.click(screen.getByRole('button', { name: 'They dial us' }));
    expect(screen.queryByLabelText('Tailcat address')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start serve' }));
    await waitFor(() => expect(startTailcatServe).toHaveBeenCalled());
    expect(addTailcatPeer).not.toHaveBeenCalled();
  });
});

function render(ui) { return renderUI(<TailcatServeProvider>{ui}</TailcatServeProvider>); }

it('shares start and stop receipts between both serve controls', async () => {
  getTailcatServe.mockResolvedValue({ live: false, enabled: false, status: 'stopped' });
  startTailcatServe.mockResolvedValue({ live: true, enabled: true, status: 'active' });
  stopTailcatServe.mockResolvedValue({ live: false, enabled: false, status: 'stopped' });
  render(<><AddPeerForm onAdd={() => {}} /><TailcatServePanel /></>);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Tailcat' }));
  fireEvent.click(screen.getByRole('button', { name: 'They dial us' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Start serve' })[0]);
  expect(await screen.findByRole('button', { name: 'Serve running' })).toBeDisabled();
  fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Start serve' })).toHaveLength(2));
  expect(screen.queryByRole('button', { name: 'Serve running' })).not.toBeInTheDocument();
});

describe('PeerCard removal confirmation', () => {
  it('uses explicit, peer-specific confirmation actions', async () => {
    const onRefresh = vi.fn();
    removePeer.mockResolvedValue({ ok: true });
    listPeerSubscriptions.mockResolvedValue({ subscriptions: [] });

    render(
      <PeerCard
        peer={{
          id: 'peer-1',
          name: 'Living Room',
          address: '192.0.2.10',
          port: 5555,
          status: 'offline',
          enabled: true,
          directions: [],
          lastSeen: new Date().toISOString(),
          consecutiveFailures: 0,
        }}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove peer' }));

    expect(screen.queryByRole('button', { name: 'Yes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'No' })).not.toBeInTheDocument();
    expect(screen.getByText('Remove peer "Living Room"?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm removing peer Living Room' })).toHaveClass('text-port-error');
    expect(screen.getByRole('button', { name: 'Cancel removing peer Living Room' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm removing peer Living Room' }));
    await waitFor(() => expect(removePeer).toHaveBeenCalledWith('peer-1'));
  });
});

describe('PeerCard snapshot progress', () => {
  const peer = {
    id: 'peer-snapshot', instanceId: 'remote-snapshot', name: 'Snapshot peer',
    address: '192.0.2.20', port: 5555, status: 'online', enabled: true,
    directions: ['outbound'], syncCategories: { universe: true, pipeline: true },
    remoteSyncSeqs: { checksums: { universe: 'new', pipeline: 'same' } },
  };
  const syncStatus = {
    cursors: { 'remote-snapshot': { checksums: { universe: 'old', pipeline: 'same' } } },
  };
  const subscriptions = [
    { recordKind: 'universe', recordId: 'universe-1', peerId: peer.instanceId },
    { recordKind: 'series', recordId: 'series-1', peerId: peer.instanceId },
  ];
  const badge = label => within(screen.getByText(label + ':').parentElement);

  beforeEach(() => {
    listPeerSubscriptions.mockResolvedValue({ subscriptions });
    getPeerFullSyncCoverage.mockResolvedValue({ fullyMirrored: true, total: 2 });
  });

  // Outbound delivery coverage must never replace inbound snapshot progress.
  it('uses checksums with loaded subscriptions and independent full-sync coverage', async () => {
    const props = { peer: { ...peer, fullSync: true }, syncStatus, onRefresh: vi.fn() };
    const view = renderUI(<PeerCard {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /sync categories/i }));
    expect(await screen.findByText('Fully mirrored · 2 records')).toBeInTheDocument();
    await act(async () => {});
    expect(badge('Universe').getByText('behind')).toBeInTheDocument();
    expect(badge('Pipeline').getByText('synced')).toBeInTheDocument();
    expect(screen.queryByText('live-push')).not.toBeInTheDocument();

    view.rerender(<PeerCard {...props} syncStatus={{
      cursors: { [peer.instanceId]: { checksums: { universe: 'new', pipeline: 'old' } } },
    }} />);
    expect(badge('Universe').getByText('synced')).toBeInTheDocument();
    expect(badge('Pipeline').getByText('behind')).toBeInTheDocument();

    view.rerender(<PeerCard {...props}
      peer={{ ...props.peer, remoteSyncSeqs: { checksums: { universe: 'new' } } }}
      syncStatus={{ cursors: { [peer.instanceId]: { checksums: { pipeline: 'same' } } } }}
    />);
    expect(badge('Universe').getByText('pending')).toBeInTheDocument();
    expect(badge('Pipeline').getByText('pending')).toBeInTheDocument();
  });

  it('shows unavailable for degraded coverage, request failure, and recovers on refresh', async () => {
    getPeerFullSyncCoverage.mockResolvedValue({
      available: false, partial: true, fullyMirrored: false, total: 2, confirmed: 2, pending: 0,
    });
    const props = { peer: { ...peer, fullSync: true, lastSeen: 'first' }, syncStatus, onRefresh: vi.fn() };
    const view = renderUI(<PeerCard {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /sync categories/i }));
    expect(await screen.findByText('Coverage unavailable')).toHaveClass('text-port-warning');
    expect(screen.queryByText(/Fully mirrored/)).not.toBeInTheDocument();
    expect(screen.getByText('Coverage unavailable')).toHaveAttribute('title', expect.stringContaining('partial'));

    getPeerFullSyncCoverage.mockRejectedValue(new Error('Request failed'));
    view.rerender(<PeerCard {...props} peer={{ ...props.peer, lastSeen: 'second' }} />);
    await waitFor(() => expect(getPeerFullSyncCoverage).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Coverage unavailable')).toBeInTheDocument();
    expect(screen.queryByText('checking coverage…')).not.toBeInTheDocument();

    getPeerFullSyncCoverage.mockResolvedValue({ fullyMirrored: false, total: 3, confirmed: 2, pending: 1 });
    view.rerender(<PeerCard {...props} peer={{ ...props.peer, lastSeen: 'third' }} />);
    expect(await screen.findByText('1 pending · 2/3 mirrored')).toBeInTheDocument();
    expect(screen.queryByText('Coverage unavailable')).not.toBeInTheDocument();
  });

  // A slow or failed subscription endpoint must not hide a known mismatch.
  it('shows known status while subscriptions are unresolved and after they fail', async () => {
    let rejectSubscriptions;
    listPeerSubscriptions.mockReturnValue(new Promise((_, reject) => { rejectSubscriptions = reject; }));
    renderUI(<PeerCard peer={peer} syncStatus={syncStatus} onRefresh={vi.fn()} />);
    expect(badge('Universe').getByText('behind')).toBeInTheDocument();
    expect(badge('Pipeline').getByText('synced')).toBeInTheDocument();
    await act(async () => { rejectSubscriptions(new Error('Subscriptions unavailable')); });
    expect(badge('Universe').getByText('behind')).toBeInTheDocument();
    expect(badge('Pipeline').getByText('synced')).toBeInTheDocument();
  });

  // Active sync takes precedence until the user-triggered request completes.
  it('shows syncing ahead of checksum status and restores status on completion', async () => {
    let resolveSync;
    syncPeer.mockReturnValue(new Promise(resolve => { resolveSync = resolve; }));
    renderUI(<PeerCard peer={peer} syncStatus={syncStatus} onRefresh={vi.fn()} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));
    expect(badge('Universe').getByText('syncing…')).toBeInTheDocument();
    expect(badge('Pipeline').getByText('syncing…')).toBeInTheDocument();
    await act(async () => { resolveSync({}); });
    expect(badge('Universe').getByText('behind')).toBeInTheDocument();
    expect(badge('Pipeline').getByText('synced')).toBeInTheDocument();
  });
});


describe('Instances page connection drawers', () => {
  const peer = { id: 'page-peer', name: 'Office', status: 'online', enabled: true, address: '192.0.2.10', port: 5555 };
  beforeEach(() => {
    api.getInstances.mockResolvedValue({ self: { name: 'Home' }, peers: [peer] });
    api.getTailnetInfo.mockResolvedValue({ suffix: 'example', self: 'home' });
    api.getNetworkExposure.mockResolvedValue({ setup: { complete: true } });
    api.getBrainParityReports.mockResolvedValue({ reports: {} });
    api.getSettings.mockResolvedValue({});
    api.getTailcatForwards.mockResolvedValue({ forwards: [] });
    api.getTailcatServe.mockResolvedValue({ status: 'stopped', live: false });
    api.listPeerSubscriptions.mockResolvedValue({ subscriptions: [] });
  });

  // Regression: the full setup stack displaced peer actions, and moving it to
  // remounting drawers could discard drafts or accidentally start networking.
  it('prioritizes peers and retains drafts across drawer sections and failed adds', async () => {
    renderUI(<MemoryRouter><Instances /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: 'Sync now' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Probe now' })).toBeEnabled();
    expect(screen.queryByLabelText('Peer address')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add peer' }));
    expect(screen.getByLabelText('Peer address')).toHaveFocus();
    fireEvent.change(screen.getByLabelText('Peer address'), { target: { value: '192.0.2.30' } });
    api.addPeer.mockRejectedValueOnce(new Error('Unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Add', exact: true }));
    await waitFor(() => expect(api.addPeer).toHaveBeenCalled());
    expect(screen.getByLabelText('Peer address')).toHaveValue('192.0.2.30');
    fireEvent.click(screen.getByRole('button', { name: 'Tailcat', exact: true }));
    fireEvent.change(screen.getByLabelText('Tailcat address'), { target: { value: 'tcEXAMPLE' } });
    fireEvent.click(screen.getByRole('button', { name: 'They dial us' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close add peer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connection settings', exact: true }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit', exact: true }));
    fireEvent.change(screen.getByLabelText('Instance name'), { target: { value: 'Draft name' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Connection settings sections' }), { target: { value: 'relay' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Connection settings sections' }), { target: { value: 'instance' } });
    expect(screen.getByLabelText('Instance name')).toHaveValue('Draft name');
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add peer' }));
    expect(screen.getByRole('button', { name: 'They dial us' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Dial them' }));
    expect(screen.getByLabelText('Tailcat address')).toHaveValue('tcEXAMPLE');
    fireEvent.click(screen.getByRole('button', { name: 'Host / port' }));
    expect(screen.getByLabelText('Peer address')).toHaveValue('192.0.2.30');
    expect(api.startTailcatServe).not.toHaveBeenCalled();
    expect(api.syncPeer).not.toHaveBeenCalled();
    expect(api.probePeer).not.toHaveBeenCalled();
    expect(api.updateSettings).not.toHaveBeenCalled();
  });

  // Regression: removing the last peer must not hide orphan/serve recovery or
  // the saved route that would keep unattended rendering pointed at that peer.
  it('keeps actionable recovery and the add CTA after the last peer disappears', async () => {
    api.getTailcatForwards.mockResolvedValue({ forwards: [{ id: 'orphan', peerId: peer.id, name: 'Saved forward', status: 'failed', remotePort: 5558 }] });
    api.getTailcatServe.mockResolvedValue({ status: 'failed', live: false });
    api.getSettings.mockResolvedValue({ federation: { mediaRouting: { image: { peerId: peer.id, engine: 'comfy', modelId: 'old-model' } } } });
    renderUI(<MemoryRouter><Instances /></MemoryRouter>);
    await screen.findByRole('button', { name: 'Sync now' });
    const updatePeers = socket.on.mock.calls.find(([event]) => event === 'instances:peers:updated')[1];
    act(() => updatePeers([]));
    fireEvent.click(await screen.findByRole('button', { name: /Tailcat needs attention/ }));
    expect(await screen.findByText('Saved forward')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Retry', exact: true })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    fireEvent.click(screen.getByRole('button', { name: /render routing needs attention/ }));
    const select = screen.getByLabelText('Image');
    expect(select).toBeEnabled();
    api.updateSettings.mockImplementation(async (patch) => patch);
    api.getSettings.mockResolvedValue({ federation: { mediaRouting: { image: { peerId: peer.id, engine: 'comfy', modelId: 'old-model' } } } });
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ federation: { mediaRouting: { image: null } } }, { silent: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(screen.queryByRole('button', { name: /render routing needs attention/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add your first peer' }));
    expect(screen.getByRole('dialog', { name: 'Add peer' })).toBeInTheDocument();
    expect(screen.getByLabelText('Peer address')).toHaveFocus();
  });
});
