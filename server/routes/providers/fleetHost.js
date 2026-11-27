import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { freshQuerySchema } from '../../lib/queryValidation.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { requestHasHostControl } from '../../services/authGate.js';
import { onClientDisconnect, openSseStream } from '../../lib/sseDownload.js';
import { validateRequest } from '../../lib/validateRequest.js';
import { resetProviderReadinessCache } from '../../services/provider/providerReadiness.js';

export function createFleetHostRoutes(runtimeSetup) {
  const router = Router();

  router.get('/fleet-host', asyncHandler(async (req, res) => {
    const { readFleetHostStatus } = await import('../../services/fleetHostNotify.js');
    res.set('Cache-Control', 'no-store').json(await readFleetHostStatus({ refresh: validateRequest(freshQuerySchema, req.query).fresh === '1' }));
  }));
  // Who has been using this machine's GPU. Never cached: the point of the
  // report is what is happening right now.
  router.get('/fleet-host/usage', asyncHandler(async (req, res) => {
    const { getFleetLlmHostUsage } = await import('../../services/fleetLlmHost.js');
    res.set('Cache-Control', 'no-store').json(await getFleetLlmHostUsage());
  }));
  // The counterpart to `/fleet-host/setup`: close the queue, clear the
  // enable marker, drop the login task and remove the container.
  router.post('/fleet-host/stop', asyncHandler(async (req, res) => {
    const { disableFleetLlmHost, getFleetLlmHostStatus } = await import('../../services/fleetLlmHost.js');
    if (runtimeSetup.holder) throw new ServerError('Model host setup is running — wait for it to finish before stopping the host.', { status: 409, code: 'SETUP_BUSY', context: { holder: runtimeSetup.holder } });
    const log = [];
    const result = await disableFleetLlmHost({ emit: (message) => log.push(message) });
    resetProviderReadinessCache();
    res.set('Cache-Control', 'no-store').json({ ...result, log, status: await getFleetLlmHostStatus().catch(() => null) });
  }));
  router.get('/fleet-peer-hosts', asyncHandler(async (req, res) => {
    const { getFleetPeerHosts } = await import('../../services/fleetLlmHost.js');
    res.set('Cache-Control', 'no-store').json(await getFleetPeerHosts());
  }));
  router.post('/fleet-peer-hosts/:peerId/key', asyncHandler(async (req, res) => {
    const { revealFleetPeerHostKey } = await import('../../services/fleetLlmHost.js');
    res.set('Cache-Control', 'no-store').json(await revealFleetPeerHostKey(req.params.peerId));
  }));
  // The peer API surface bypasses the default host-control gate. Check the
  // verified caller here before reading the credential.
  router.post('/fleet-host/key', asyncHandler(async (req, res) => {
    const auth = req.portosAuthContext;
    const verifiedPeerCredential = auth?.authenticated === true
      && (auth.method === 'peer' || auth.method === 'basic');
    if (!verifiedPeerCredential && !requestHasHostControl(req)) {
      throw new ServerError('Fleet host key access requires a local connection, operator session or verified peer credential.', {
        status: 403, code: 'FLEET_HOST_KEY_FORBIDDEN',
      });
    }
    const { revealFleetLlmKey } = await import('../../services/fleetLlmHost.js');
    res.set('Cache-Control', 'no-store').json({ apiKey: await revealFleetLlmKey() });
  }));
  router.post('/fleet-host/setup', asyncHandler(async (req, res) => {
    const { configureFleetLlmHost, getFleetLlmHostStatus } = await import('../../services/fleetLlmHost.js');
    if (runtimeSetup.holder) throw new ServerError('Another model setup is running.', { status: 409, code: 'SETUP_BUSY', context: { holder: runtimeSetup.holder } });
    runtimeSetup.holder = { runId: randomUUID(), kind: 'fleet-host' };
    const { send, safeEnd } = openSseStream(res);
    let clientGone = false;
    onClientDisconnect(req, res, () => { clientGone = true; });
    const result = await configureFleetLlmHost({
      emit: (message) => send({ type: 'log', message }),
      isCancelled: () => clientGone,
    }).catch((err) => ({ success: false, error: err.message }))
      .finally(() => { runtimeSetup.holder = null; resetProviderReadinessCache(); });
    const status = await getFleetLlmHostStatus().catch(() => null);
    send(result.success ? { type: 'complete', message: 'Host configured. Check model readiness below.', status } : { type: 'error', message: result.error });
    safeEnd();
  }));

  return router;
}
