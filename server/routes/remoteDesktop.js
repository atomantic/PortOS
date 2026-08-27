import express from 'express';
import { asyncHandler, createServiceErrorMapper, ServerError } from '../lib/errorHandler.js';
import { remoteDesktopBroker } from '../services/remoteDesktop.js';

const router = express.Router();
const mapServiceError = createServiceErrorMapper({ VNC_NOT_CONFIGURED: 409 });

router.get('/status', asyncHandler(async (req, res) => {
  const brokerStatus = await remoteDesktopBroker.status();
  const authEnabled = req.portosAuthContext?.enabled === true;
  res.json({
    ...brokerStatus,
    available: brokerStatus.configured && authEnabled,
    requiresPortOSAuth: !authEnabled,
    setupCommand: 'npm run setup:remote-desktop',
  });
}));

router.post('/sessions', asyncHandler(async (req, res) => {
  if (req.portosAuthContext?.enabled !== true || req.portosAuthContext?.authenticated !== true) {
    throw new ServerError('Set an instance password in PortOS before enabling remote desktop sessions.', {
      status: 409,
      code: 'REMOTE_DESKTOP_REQUIRES_AUTH',
      severity: 'warning',
    });
  }
  const session = await remoteDesktopBroker.createSession()
    .catch((err) => { throw mapServiceError(err); });
  res.status(201).json(session);
}));

export default router;
