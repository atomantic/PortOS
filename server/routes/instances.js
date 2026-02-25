/**
 * Instances API Routes
 *
 * Federation endpoints for managing PortOS peer instances.
 */

import { Router } from 'express';
import { z } from 'zod';
import * as instances from '../services/instances.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

const router = Router();

// Validation schemas
const addPeerSchema = z.object({
  address: z.string().regex(/^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/, 'Must be a valid IP address'),
  port: z.number().int().min(1).max(65535).default(5554),
  name: z.string().optional()
});

const updatePeerSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional()
});

const announceSchema = z.object({
  port: z.number().int().min(1).max(65535),
  instanceId: z.string().uuid(),
  name: z.string().optional()
});

const querySchema = z.object({
  path: z.string().startsWith('/api/', 'Path must start with /api/')
});

// GET /api/instances — list self + all peers
router.get('/', asyncHandler(async (req, res) => {
  const self = await instances.getSelf();
  const peers = await instances.getPeers();
  res.json({ self, peers });
}));

// GET /api/instances/self — get this instance's identity
router.get('/self', asyncHandler(async (req, res) => {
  const self = await instances.getSelf();
  res.json(self);
}));

// PUT /api/instances/self — update display name
router.put('/self', asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string') {
    throw new ServerError('Name is required', { status: 400 });
  }
  const updated = await instances.updateSelf(name.trim());
  if (!updated) throw new ServerError('Self identity not initialized', { status: 500 });
  res.json(updated);
}));

// POST /api/instances/peers/announce — receive announcement from remote peer
router.post('/peers/announce', asyncHandler(async (req, res) => {
  const data = announceSchema.parse(req.body);
  // Derive caller IP from req.ip, stripping ::ffff: prefix for IPv4-mapped addresses
  const address = req.ip?.replace(/^::ffff:/, '') ?? req.socket.remoteAddress?.replace(/^::ffff:/, '');
  if (!address) throw new ServerError('Could not determine caller IP', { status: 400 });

  const result = await instances.handleAnnounce({
    address,
    port: data.port,
    instanceId: data.instanceId,
    name: data.name
  });

  const self = await instances.getSelf();
  res.status(result.created ? 201 : 200).json({
    self: { instanceId: self?.instanceId, name: self?.name },
    peer: result.peer
  });
}));

// POST /api/instances/peers — add a peer
router.post('/peers', asyncHandler(async (req, res) => {
  const data = addPeerSchema.parse(req.body);
  const peer = await instances.addPeer(data);
  res.status(201).json(peer);
}));

// PUT /api/instances/peers/:id — update peer
router.put('/peers/:id', asyncHandler(async (req, res) => {
  const data = updatePeerSchema.parse(req.body);
  const peer = await instances.updatePeer(req.params.id, data);
  if (!peer) throw new ServerError('Peer not found', { status: 404 });
  res.json(peer);
}));

// DELETE /api/instances/peers/:id — remove peer
router.delete('/peers/:id', asyncHandler(async (req, res) => {
  const removed = await instances.removePeer(req.params.id);
  if (!removed) throw new ServerError('Peer not found', { status: 404 });
  res.json({ success: true });
}));

// POST /api/instances/peers/:id/probe — force immediate probe
router.post('/peers/:id/probe', asyncHandler(async (req, res) => {
  const peers = await instances.getPeers();
  const peer = peers.find(p => p.id === req.params.id);
  if (!peer) throw new ServerError('Peer not found', { status: 404 });
  const result = await instances.probePeer(peer);
  res.json(result);
}));

// GET /api/instances/peers/:id/query — proxy GET to peer
router.get('/peers/:id/query', asyncHandler(async (req, res) => {
  const { path } = querySchema.parse(req.query);
  const result = await instances.queryPeer(req.params.id, path);
  if (result.error) throw new ServerError(result.error, { status: 502 });
  res.json(result.data);
}));

export default router;
