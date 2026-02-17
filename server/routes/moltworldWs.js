/**
 * Moltworld WebSocket Control Routes
 *
 * HTTP endpoints for managing the server-side WebSocket relay to Moltworld.
 * Mounted at /api/agents/tools/moltworld/ws/
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  validate,
  moltworldWsConnectSchema,
  moltworldWsMoveSchema,
  moltworldWsThinkSchema,
  moltworldWsNearbySchema,
  moltworldWsInteractSchema
} from '../lib/validation.js';
import * as moltworldWs from '../services/moltworldWs.js';

const router = Router();

// POST /connect — Connect the WebSocket relay
router.post('/connect', asyncHandler(async (req, res) => {
  const { success, data, errors } = validate(moltworldWsConnectSchema, req.body);
  if (!success) {
    throw new ServerError('Validation failed', { status: 400, code: 'VALIDATION_ERROR', context: { errors } });
  }

  console.log(`🌐 POST /api/agents/tools/moltworld/ws/connect account=${data.accountId}`);
  await moltworldWs.connect(data.accountId);
  res.json(moltworldWs.getStatus());
}));

// POST /disconnect — Disconnect the WebSocket relay
router.post('/disconnect', asyncHandler(async (req, res) => {
  console.log(`🌐 POST /api/agents/tools/moltworld/ws/disconnect`);
  moltworldWs.disconnect();
  res.json(moltworldWs.getStatus());
}));

// GET /status — Return connection state
router.get('/status', asyncHandler(async (req, res) => {
  res.json(moltworldWs.getStatus());
}));

// POST /move — Send move via WebSocket
router.post('/move', asyncHandler(async (req, res) => {
  const { success, data, errors } = validate(moltworldWsMoveSchema, req.body);
  if (!success) {
    throw new ServerError('Validation failed', { status: 400, code: 'VALIDATION_ERROR', context: { errors } });
  }

  console.log(`🌐 POST /api/agents/tools/moltworld/ws/move (${data.x}, ${data.y})`);
  moltworldWs.sendMove(data.x, data.y, data.thought);
  res.json({ sent: true });
}));

// POST /think — Send think via WebSocket
router.post('/think', asyncHandler(async (req, res) => {
  const { success, data, errors } = validate(moltworldWsThinkSchema, req.body);
  if (!success) {
    throw new ServerError('Validation failed', { status: 400, code: 'VALIDATION_ERROR', context: { errors } });
  }

  console.log(`🌐 POST /api/agents/tools/moltworld/ws/think`);
  moltworldWs.sendThink(data.thought);
  res.json({ sent: true });
}));

// POST /nearby — Request nearby agents via WebSocket
router.post('/nearby', asyncHandler(async (req, res) => {
  const { success, data, errors } = validate(moltworldWsNearbySchema, req.body);
  if (!success) {
    throw new ServerError('Validation failed', { status: 400, code: 'VALIDATION_ERROR', context: { errors } });
  }

  console.log(`🌐 POST /api/agents/tools/moltworld/ws/nearby`);
  moltworldWs.sendNearby(data.radius);
  res.json({ sent: true });
}));

// POST /interact — Send interaction via WebSocket
router.post('/interact', asyncHandler(async (req, res) => {
  const { success, data, errors } = validate(moltworldWsInteractSchema, req.body);
  if (!success) {
    throw new ServerError('Validation failed', { status: 400, code: 'VALIDATION_ERROR', context: { errors } });
  }

  console.log(`🌐 POST /api/agents/tools/moltworld/ws/interact to=${data.to}`);
  moltworldWs.sendInteract(data.to, data.payload);
  res.json({ sent: true });
}));

export default router;
