import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddPeerForm } from './Instances.jsx';
import { DEFAULT_TAILCAT_REMOTE_PORT } from '../lib/ports.js';
import { DEFAULT_PEER_PORT, DEFAULT_TAILCAT_LOCAL_PORT } from '../lib/ports.js';
import { addPeer, addTailcatPeer, startTailcatServe, getTailcatServe } from '../services/api';

vi.mock('../services/api', () => ({
  getInstances: vi.fn(),
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
  it('advertises the same port in the placeholder as it defaults to', () => {
    render(<AddPeerForm onAdd={() => {}} />);
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
