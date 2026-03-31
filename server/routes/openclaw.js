import express from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  getRuntimeStatus,
  listSessions,
  getSessionMessages,
  sendSessionMessage
} from '../integrations/openclaw/api.js';

const router = express.Router();

const sendMessageSchema = z.object({
  message: z.string().trim().min(1),
  context: z.unknown().optional()
});

router.get('/status', asyncHandler(async (req, res) => {
  const status = await getRuntimeStatus();
  res.json(status);
}));

router.get('/sessions', asyncHandler(async (req, res) => {
  const status = await getRuntimeStatus();
  if (!status.configured) {
    return res.json({
      configured: false,
      reachable: false,
      sessions: [],
      defaultSession: status.defaultSession || null,
      label: status.label
    });
  }

  const result = await listSessions();
  res.json(result);
}));

router.get('/sessions/:id/messages', asyncHandler(async (req, res) => {
  const sessionId = req.params.id?.trim();
  if (!sessionId) {
    throw new ServerError('Session ID is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  let limit = req.query.limit !== undefined ? Number.parseInt(String(req.query.limit), 10) : 50;
  if (Number.isNaN(limit) || limit <= 0) limit = 50;
  if (limit > 200) limit = 200;

  const status = await getRuntimeStatus();
  if (!status.configured) {
    return res.json({
      configured: false,
      reachable: false,
      sessionId,
      messages: []
    });
  }

  const result = await getSessionMessages(sessionId, { limit });
  res.json(result);
}));

router.post('/sessions/:id/messages', asyncHandler(async (req, res) => {
  const sessionId = req.params.id?.trim();
  if (!sessionId) {
    throw new ServerError('Session ID is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const payload = validateRequest(sendMessageSchema, req.body);
  const status = await getRuntimeStatus();
  if (!status.configured) {
    throw new ServerError('OpenClaw is not configured for this PortOS instance', {
      status: 503,
      code: 'OPENCLAW_UNCONFIGURED'
    });
  }

  const result = await sendSessionMessage(sessionId, payload);
  res.json(result);
}));

export default router;
