import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddPeerForm } from './Instances.jsx';
import { DEFAULT_PEER_PORT } from '../lib/ports.js';
import { addPeer } from '../services/api';

vi.mock('../services/api', () => ({
  getInstances: vi.fn(),
  updateSelfInstance: vi.fn(),
  addPeer: vi.fn(),
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
