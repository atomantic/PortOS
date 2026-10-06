import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import socket from '../../services/socket';
import * as storage from '../../lib/safeStorage';
import { safeRemoveStorage, safeRemoveSession } from '../../lib/safeStorage';
import PeerAdministrationPanel from './PeerAdministrationPanel';
import { getPeerAdminSetup, savePeerAdminGrant, previewPeerAdministration, savePeerExecutionGrant, previewPeerExecution, dispatchPeerExecution, getPeerExecutionStatus, getPeerCatalogReviews } from '../../services/api';
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../../services/api', () => ({
  getPeerAdminSetup: vi.fn(), savePeerAdminGrant: vi.fn(), previewPeerAdministration: vi.fn(),
  savePeerExecutionGrant: vi.fn(), previewPeerExecution: vi.fn(), dispatchPeerExecution: vi.fn(), getPeerExecutionStatus: vi.fn(), getPeerCatalogReviews: vi.fn(),
}));
const peer = { id: 'peer-example', instanceId: '11111111-1111-4111-8111-111111111111', enabled: true, hasSyncSecret: true };
const setup = {
  hostInstanceId: '22222222-2222-4222-8222-222222222222', peerInstanceId: peer.instanceId,
  paired: true, executionSupported: false,
  actions: ['portos.update', 'portos.restart', 'catalog.install'].map(action => ({ action, active: false, grant: null })),
};
beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  safeRemoveStorage(`peer-execution:${setup.hostInstanceId}:${peer.id}:${setup.peerInstanceId}`);
  getPeerAdminSetup.mockResolvedValue(setup);
});

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


describe('separate peer execution controls', () => {
  const executionSetup = { ...setup, execution: { scope: 'execution-v1', actions: setup.actions } };
  const envelope = { signature: 'signed-fixture', payload: {
    requestId: '33333333-3333-4333-8333-333333333333', intent: { action: 'portos.restart' },
    targetInstanceId: peer.instanceId, version: '1.0.0', expiresAt: Date.now() + 60_000,
  } };
  const open = async () => {
    getPeerAdminSetup.mockResolvedValue(executionSetup);
    const view = render(<PeerAdministrationPanel peer={peer} />);
    fireEvent.click(screen.getByRole('button', { name: /Peer administration/ }));
    await screen.findByText('Allow this peer to execute on this host');
    return view;
  };

  it('requires a distinct execution confirmation bound to both identities and the selected action', async () => {
    savePeerExecutionGrant.mockResolvedValue(executionSetup);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Review execution grant for PortOS restart' }));
    expect(savePeerExecutionGrant).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Allow execution for one hour' }));
    await waitFor(() => expect(savePeerExecutionGrant).toHaveBeenCalledWith({
      peerId: peer.id, action: 'portos.restart', confirmedHostInstanceId: setup.hostInstanceId,
      confirmedPeerInstanceId: peer.instanceId, previousGrantId: null, expiresInMinutes: 60,
      allowExecution: true, confirmation: 'execution-v1',
    }, { silent: true }));
    expect(dispatchPeerExecution).not.toHaveBeenCalled();
    expect(savePeerAdminGrant).not.toHaveBeenCalled();
  });

  it('passes a selected catalog intent into signed preview and retains the exact selection for dispatch', async () => {
    const intent = { action: 'catalog.install', backend: 'lmstudio', catalogKey: 'example-model' };
    const preview = { ...envelope, payload: { ...envelope.payload, intent } };
    getPeerCatalogReviews.mockResolvedValue({ candidates: [{ backend: 'lmstudio', catalogKey: 'example-model', name: 'Example model' }], reviews: [] });
    previewPeerExecution.mockResolvedValue(preview);
    dispatchPeerExecution.mockResolvedValue({ requestId: preview.payload.requestId, state: 'draining', revision: 1 });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Choose a catalog model' }));
    fireEvent.change(await screen.findByLabelText('Catalog model (LM Studio)'), { target: { value: 'example-model' } });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare catalog installation on remote peer' }));
    await screen.findByText('Catalog entry: example-model · lmstudio');
    expect(previewPeerExecution).toHaveBeenCalledWith({ peerId: peer.id, intent }, { silent: true });
    expect(dispatchPeerExecution).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Submit execution' }));
    await screen.findByText('Execution status: draining');
    expect(dispatchPeerExecution).toHaveBeenCalledWith({ peerId: peer.id, preflight: preview }, { silent: true });
  });

  it.each(['unavailable', 'mismatched'])('refuses dispatch when recovery storage readback is %s', async failure => {
    previewPeerExecution.mockResolvedValue(envelope);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare PortOS restart execution' }));
    await screen.findByRole('button', { name: 'Submit execution' });
    vi.spyOn(storage, 'safeWriteJsonStorage').mockImplementationOnce(key => {
      if (failure === 'mismatched') storage.safeWriteStorage(key, JSON.stringify({ requestId: envelope.payload.requestId, state: 'failed' }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit execution' }));
    await screen.findByText(/Execution was not submitted because this browser could not save its recovery record/);
    expect(dispatchPeerExecution).not.toHaveBeenCalled();
    expect(screen.queryByText('Execution status: uncertain')).toBeNull();
  });

  it('retains an uncertain launch across tab closure and recovers with status without a second dispatch', async () => {
    previewPeerExecution.mockResolvedValue(envelope);
    dispatchPeerExecution.mockRejectedValue(new Error('Response timed out'));
    getPeerExecutionStatus.mockResolvedValue({ requestId: envelope.payload.requestId, state: 'succeeded', revision: 3, code: null });
    const view = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare PortOS restart execution' }));
    await screen.findByRole('button', { name: 'Submit execution' });
    expect(dispatchPeerExecution).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Submit execution' }));
    await screen.findByText('Response timed out');
    expect(screen.getByText('Execution status: uncertain')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit execution' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Prepare PortOS restart execution' }).disabled).toBe(true);
    view.unmount();
    safeRemoveSession(`peer-execution:${setup.hostInstanceId}:${peer.id}:${setup.peerInstanceId}`);
    await open();
    expect(screen.getByText('Execution status: uncertain')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check execution status' }));
    await screen.findByText('Execution status: succeeded');
    expect(dispatchPeerExecution).toHaveBeenCalledTimes(1);
    expect(dispatchPeerExecution).toHaveBeenCalledWith({ peerId: peer.id, preflight: envelope }, { silent: true });
    expect(getPeerExecutionStatus).toHaveBeenCalledWith({ peerId: peer.id, requestId: envelope.payload.requestId }, { silent: true });
  });
});


it('refreshes local execution grants on change and reconnect, retaining the reviewed grant identity', async () => {
  const execution = { scope: 'execution-v1', actions: setup.actions };
  getPeerAdminSetup.mockResolvedValue({ ...setup, execution });
  savePeerExecutionGrant.mockRejectedValue(new Error('Refresh the changed grant'));
  const view = render(<PeerAdministrationPanel peer={peer} />);
  fireEvent.click(screen.getByRole('button', { name: /Peer administration/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Review execution grant for PortOS restart' }));
  const refresh = socket.on.mock.calls.find(([event]) => event === 'peer-execution:changed')[1];
  getPeerAdminSetup.mockResolvedValue({ ...setup, execution: { ...execution, actions: execution.actions.map(row => ({
    ...row, active: true, grant: { id: 'new-grant', allowed: true, expiresAt: Date.now() + 60_000 },
  })) } });
  await act(async () => { refresh(); });
  await screen.findByRole('button', { name: 'Review execution renewal for PortOS restart' });
  fireEvent.click(screen.getByRole('button', { name: 'Allow execution for one hour' }));
  await screen.findByText('Refresh the changed grant');
  expect(savePeerExecutionGrant.mock.calls[0][0].previousGrantId).toBeNull();
  expect(socket.on).toHaveBeenCalledWith('connect', refresh);
  view.unmount();
  expect(socket.off).toHaveBeenCalledWith('peer-execution:changed', refresh);
  expect(socket.off).toHaveBeenCalledWith('connect', refresh);
});
