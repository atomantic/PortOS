import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddPeerForm } from './Instances.jsx';
import { DEFAULT_PEER_PORT, DEFAULT_TAILCAT_LOCAL_PORT } from '../lib/ports.js';
import { addPeer, addTailcatPeer } from '../services/api';

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
    fireEvent.click(screen.getByRole('button', { name: 'Tailcat address' }));
    const tc = 'tcEXAMPLE' + 'B'.repeat(40);
    fireEvent.change(screen.getByLabelText('Tailcat address'), { target: { value: tc } });
    fireEvent.click(screen.getByRole('button', { name: 'Add via tailcat' }));
    await waitFor(() => expect(addTailcatPeer).toHaveBeenCalledWith({ tcAddress: tc }));
    expect(addPeer).not.toHaveBeenCalled();
  });

  it('keeps classic host/port add working', async () => {
    render(<AddPeerForm onAdd={() => {}} />);
    fireEvent.change(screen.getByLabelText('Peer address'), { target: { value: '100.64.1.2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(addPeer).toHaveBeenCalledWith({
      address: '100.64.1.2',
      port: DEFAULT_PEER_PORT,
    }));
    expect(addTailcatPeer).not.toHaveBeenCalled();
  });

  it('documents the 15555 local forward standard in the tailcat hint', () => {
    render(<AddPeerForm onAdd={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tailcat address' }));
    expect(screen.getAllByText(new RegExp(String(DEFAULT_TAILCAT_LOCAL_PORT))).length).toBeGreaterThan(0);
  });
});
