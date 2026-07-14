import { Router } from 'express';
import * as portsService from '../services/ports.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest, portsCheckSchema, portsAllocateSchema } from '../lib/validation.js';

const router = Router();

// GET /api/ports/scan - Scan for used ports
router.get('/scan', asyncHandler(async (req, res) => {
  const scan = await portsService.scanPorts();
  res.json(scan);
}));

// POST /api/ports/check - Check if specific ports are available
router.post('/check', asyncHandler(async (req, res) => {
  const { ports } = validateRequest(portsCheckSchema, req.body);
  const results = await portsService.checkPortsAvailable(ports);
  res.json(results);
}));

// POST /api/ports/allocate - Allocate available ports
router.post('/allocate', asyncHandler(async (req, res) => {
  const { count } = validateRequest(portsAllocateSchema, req.body);
  const ports = await portsService.allocatePorts(count);
  res.json({ allocated: ports });
}));

export default router;
