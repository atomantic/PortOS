import { Router } from 'express';
import { getRunningAgents, killProcess, getProcessInfo } from '../services/agent/agents.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

const router = Router();

// GET /api/agents - Get all running AI agents
router.get('/', asyncHandler(async (req, res) => {
  const agents = await getRunningAgents();
  res.json(agents);
}));

function parsePositivePid(raw) {
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) {
    throw new ServerError('Invalid PID', { status: 400, code: 'INVALID_PARAM' });
  }
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid)) {
    throw new ServerError('Invalid PID', { status: 400, code: 'INVALID_PARAM' });
  }
  return pid;
}

// GET /api/agents/:pid - Get specific process info
router.get('/:pid', asyncHandler(async (req, res) => {
  const pid = parsePositivePid(req.params.pid);
  const info = await getProcessInfo(pid);
  if (!info) {
    throw new ServerError('Process not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(info);
}));

// DELETE /api/agents/:pid - Kill a process
router.delete('/:pid', asyncHandler(async (req, res) => {
  const pid = parsePositivePid(req.params.pid);
  await killProcess(pid);
  res.json({ success: true, pid });
}));

export default router;
