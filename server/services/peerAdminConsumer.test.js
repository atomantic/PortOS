import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { peerExecutionRemoteDispatchSchema } from '../lib/peerAdminValidation.js';
import { peerFetch, readPeerBody } from '../lib/peerHttpClient.js';
import { peerAdminIdentity, signPeerAdmin } from './peerAdministration.js';
import { dispatchPeerExecution, getPeerExecutionStatus, preparePeerExecution } from './peerAdminConsumer.js';

vi.mock('../lib/peerHttpClient.js', async importOriginal => ({
  ...await importOriginal(), peerFetch: vi.fn(), readPeerBody: vi.fn(),
}));
vi.mock('./peerAdministration.js', async importOriginal => ({
  ...await importOriginal(), peerAdminIdentity: vi.fn(),
}));
const peer = { id: 'peer-example', instanceId: randomUUID(), address: '192.0.2.10', port: 5555, syncSecret: 'fixture-only-pair-secret-with-32-characters', auth: 'never-forward' };
const self = { instanceId: randomUUID() };
const intent = { action: 'portos.restart' };
const snapshot = requestId => ({
  protocolVersion: 1, scope: 'execution-v1', requestId, grantId: randomUUID(), grantGeneration: 1,
  senderInstanceId: self.instanceId, targetInstanceId: peer.instanceId, version: '1.0.0', intent,
  evidenceDigest: 'a'.repeat(64), executionEpoch: randomUUID(), expiresAt: Date.now() + 59_000,
});
const signed = (payload, purpose = 'execution-preflight') => ({ payload, signature: signPeerAdmin(peer, purpose, payload) });
const receipt = requestId => ({ protocolVersion: 1, scope: 'execution-v1', requestId,
  senderInstanceId: self.instanceId, targetInstanceId: peer.instanceId, operationId: randomUUID(),
  state: 'draining', revision: 1, code: null,
});
beforeEach(() => {
  vi.clearAllMocks();
  peerAdminIdentity.mockResolvedValue({ peer, self });
  peerFetch.mockResolvedValue({ ok: true });
});

describe('peer execution sender boundary', () => {
  it('prepares a signed preview then sends exactly its bound dispatch and verifies the receipt', async () => {
    readPeerBody.mockImplementationOnce(async () => signed(snapshot(JSON.parse(peerFetch.mock.calls[0][1].body).requestId)));
    const preflight = await preparePeerExecution({ peerId: peer.id, intent });
    const result = receipt(preflight.payload.requestId);
    readPeerBody.mockResolvedValueOnce(signed(result, 'execution-receipt'));
    // Route validation reorders keys: the signature must survive this round trip.
    const input = peerExecutionRemoteDispatchSchema.parse({ peerId: peer.id, preflight });
    await expect(dispatchPeerExecution(input)).resolves.toEqual(result);
    expect(peerFetch).toHaveBeenCalledTimes(2);
    const [url, options, credential] = peerFetch.mock.calls[1];
    expect(url).toMatch(/execution\/dispatch$/);
    expect(JSON.parse(options.body)).toEqual({ protocolVersion: 1, requestId: preflight.payload.requestId,
      grantId: preflight.payload.grantId, grantGeneration: 1, intent,
      evidenceDigest: preflight.payload.evidenceDigest, executionEpoch: preflight.payload.executionEpoch, version: '1.0.0' });
    expect(credential.auth).toBeNull();
    expect(credential.peerAuthAccepted).toBe(true);
  });

  it('proves only local preview rejection was never sent, binding the result to its request', async () => {
    const preflight = signed(snapshot(randomUUID()));
    preflight.payload.intent = { action: 'portos.update' };
    await expect(dispatchPeerExecution({ peerId: peer.id, preflight })).rejects.toMatchObject({ code: 'PEER_EXECUTION_NOT_SENT', context: { requestId: preflight.payload.requestId } });
    const expired = signed({ ...snapshot(randomUUID()), expiresAt: Date.now() - 1 });
    await expect(dispatchPeerExecution({ peerId: peer.id, preflight: expired }))
      .rejects.toMatchObject({ code: 'PEER_EXECUTION_NOT_SENT', context: { requestId: expired.payload.requestId } });
    expect(peerFetch).not.toHaveBeenCalled();
    peerFetch.mockResolvedValueOnce({ ok: false });
    await expect(dispatchPeerExecution({ peerId: peer.id, preflight: signed(snapshot(randomUUID())) }))
      .rejects.toMatchObject({ code: 'PEER_ADMIN_REMOTE_REFUSED' });
    expect(peerFetch).toHaveBeenCalledOnce();
  });

  it('rejects signed responses with another intent or a pair changed while preparing', async () => {
    readPeerBody.mockImplementationOnce(async () => signed({ ...snapshot(JSON.parse(peerFetch.mock.calls[0][1].body).requestId), intent: { action: 'portos.update' } }));
    await expect(preparePeerExecution({ peerId: peer.id, intent })).rejects.toMatchObject({ code: 'PEER_EXECUTION_UNVERIFIED_RESPONSE' });
    readPeerBody.mockImplementationOnce(async () => signed(snapshot(JSON.parse(peerFetch.mock.calls[1][1].body).requestId)));
    peerAdminIdentity.mockResolvedValueOnce({ peer, self }).mockResolvedValueOnce({ peer: { ...peer, syncSecret: 'replacement-secret' }, self });
    await expect(preparePeerExecution({ peerId: peer.id, intent })).rejects.toMatchObject({ code: 'PEER_EXECUTION_UNVERIFIED_RESPONSE' });
    expect(peerFetch.mock.calls.every(([url]) => url.endsWith('/preflight'))).toBe(true);
  });

  it('does not retry after a lost dispatch response and permits read-only recovery by request ID', async () => {
    const preflight = signed(snapshot(randomUUID()));
    peerFetch.mockRejectedValueOnce(new Error('connection lost'));
    await expect(dispatchPeerExecution({ peerId: peer.id, preflight })).rejects.toMatchObject({ code: 'PEER_EXECUTION_UNAVAILABLE' });
    expect(peerFetch).toHaveBeenCalledTimes(1);
    const completed = { ...receipt(preflight.payload.requestId), state: 'succeeded', revision: 4 };
    readPeerBody.mockResolvedValueOnce(signed(completed, 'execution-receipt'));
    await expect(getPeerExecutionStatus({ peerId: peer.id, requestId: preflight.payload.requestId, preflight })).resolves.toEqual(completed);
    expect(peerFetch.mock.calls[1][0]).toMatch(/execution\/status$/);
    expect(JSON.parse(peerFetch.mock.calls[1][1].body)).toEqual({ requestId: preflight.payload.requestId, preflight });
  });

  it('rejects a valid signature for an unrelated receipt or incorrect signature purpose', async () => {
    const requestId = randomUUID();
    readPeerBody.mockResolvedValueOnce(signed(receipt(randomUUID()), 'execution-receipt'));
    await expect(getPeerExecutionStatus({ peerId: peer.id, requestId })).rejects.toMatchObject({ code: 'PEER_EXECUTION_UNVERIFIED_RESPONSE' });
    readPeerBody.mockResolvedValueOnce(signed(receipt(requestId), 'execution-preflight'));
    await expect(getPeerExecutionStatus({ peerId: peer.id, requestId })).rejects.toMatchObject({ code: 'PEER_EXECUTION_UNVERIFIED_RESPONSE' });
  });
});
