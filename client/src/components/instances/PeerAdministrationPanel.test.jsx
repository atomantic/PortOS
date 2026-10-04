import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PeerAdministrationPanel from './PeerAdministrationPanel';
import { getPeerAdminSetup, savePeerAdminGrant, previewPeerAdministration } from '../../services/api';
vi.mock('../../services/api', () => ({
  getPeerAdminSetup: vi.fn(), savePeerAdminGrant: vi.fn(), previewPeerAdministration: vi.fn(),
}));
const peer = { id: 'peer-example', instanceId: '11111111-1111-4111-8111-111111111111', enabled: true, hasSyncSecret: true };
const setup = {
  hostInstanceId: '22222222-2222-4222-8222-222222222222', peerInstanceId: peer.instanceId,
  paired: true, executionSupported: false,
  actions: ['portos.update', 'portos.restart', 'catalog.install'].map(action => ({ action, active: false, grant: null })),
};
beforeEach(() => { vi.clearAllMocks(); getPeerAdminSetup.mockResolvedValue(setup); });

describe('planning-only peer administration', () => {
  it('requires review and explicit confirmation and binds the save to both displayed identities', async () => {
    savePeerAdminGrant.mockResolvedValue(setup);
    render(<PeerAdministrationPanel peer={peer} />);
    expect(getPeerAdminSetup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Peer administration/ }));
    await screen.findByText(setup.hostInstanceId);
    fireEvent.click(screen.getAllByRole('button', { name: 'Review grant' })[0]);
    expect(savePeerAdminGrant).not.toHaveBeenCalled();
    expect(screen.getByText(/does not authorize execution/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Allow planning for one hour' }));
    await waitFor(() => expect(savePeerAdminGrant).toHaveBeenCalledWith({
      peerId: peer.id, action: 'portos.update', confirmedHostInstanceId: setup.hostInstanceId,
      confirmedPeerInstanceId: peer.instanceId, previousGrantId: null, expiresInMinutes: 60, allowPlanning: true,
    }, { silent: true }));
  });

  it('shows a preview as planned without offering execution', async () => {
    previewPeerAdministration.mockResolvedValue({ preflight: { version: '1.0.0' }, plan: { requestId: 'example-request' } });
    render(<PeerAdministrationPanel peer={peer} />);
    fireEvent.click(screen.getByRole('button', { name: /Peer administration/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Preview PortOS restart' }));
    expect(await screen.findByText('Planned only · not queued · not in flight')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Restart|^Execute|^Install/ })).toBeNull();
    expect(savePeerAdminGrant).not.toHaveBeenCalled();
  });

  it('does not allow a grant save while reopening refreshes an older setup snapshot', async () => {
    let resolveRefresh;
    getPeerAdminSetup.mockResolvedValueOnce(setup).mockReturnValueOnce(new Promise(resolve => { resolveRefresh = resolve; }));
    render(<PeerAdministrationPanel peer={peer} />);
    const toggle = screen.getByRole('button', { name: /Peer administration/ });
    fireEvent.click(toggle);
    await screen.findByText(setup.hostInstanceId);
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(screen.queryByRole('button', { name: 'Review grant' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Allow planning for one hour' })).toBeNull();
    resolveRefresh(setup);
    await screen.findByText(setup.hostInstanceId);
    expect(savePeerAdminGrant).not.toHaveBeenCalled();
  });

  it('drops an old identity response and confirmation when the peer changes', async () => {
    let resolveOld;
    getPeerAdminSetup.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
    const view = render(<PeerAdministrationPanel peer={peer} />);
    fireEvent.click(screen.getByRole('button', { name: /Peer administration/ }));
    view.rerender(<PeerAdministrationPanel peer={{ ...peer, instanceId: '33333333-3333-4333-8333-333333333333' }} />);
    resolveOld(setup);
    await waitFor(() => expect(screen.queryByText(setup.hostInstanceId)).toBeNull());
    expect(savePeerAdminGrant).not.toHaveBeenCalled();
  });
});
