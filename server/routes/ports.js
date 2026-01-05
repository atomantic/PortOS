import { Router } from 'express';
import * as portsService from '../services/ports.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

const router = Router();

// GET /api/ports/scan - Scan for used ports
router.get('/scan', asyncHandler(async (req, res) => {
  const scan = await portsService.scanPorts();
  res.json(scan);
}));

// POST /api/ports/check - Check if specific ports are available
router.post('/check', asyncHandler(async (req, res) => {
  const { ports } = req.body;

  if (!Array.isArray(ports) || ports.length === 0) {
    throw new ServerError('ports must be a non-empty array of numbers', {
      status: 400,
      code: 'VALIDATION_ERROR'
    });
  }

  const results = await portsService.checkPortsAvailable(ports);
  res.json(results);
}));

// POST /api/ports/allocate - Allocate available ports
router.post('/allocate', asyncHandler(async (req, res) => {
  const count = parseInt(req.body.count) || 1;

  if (count < 1 || count > 10) {
    throw new ServerError('count must be between 1 and 10', {
      status: 400,
      code: 'VALIDATION_ERROR'
    });
  }

  const ports = await portsService.allocatePorts(count);
  res.json({ allocated: ports });
}));

export default router;
