import { Router } from 'express';
import { getRunningAgents, killProcess, getProcessInfo } from '../services/agents.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

const router = Router();

// GET /api/agents - Get all running AI agents
router.get('/', asyncHandler(async (req, res) => {
  const agents = await getRunningAgents();
  res.json(agents);
}));

// GET /api/agents/:pid - Get specific process info
router.get('/:pid', asyncHandler(async (req, res) => {
  const pid = parseInt(req.params.pid);
  const info = await getProcessInfo(pid);
  if (!info) {
    throw new ServerError('Process not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(info);
}));

// DELETE /api/agents/:pid - Kill a process
router.delete('/:pid', asyncHandler(async (req, res) => {
  const pid = parseInt(req.params.pid);
  await killProcess(pid);
  res.json({ success: true, pid });
}));

export default router;
