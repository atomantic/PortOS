import { Router } from 'express';
import { getRunningAgents, killProcess, getProcessInfo } from '../services/agents.js';

const router = Router();

// GET /api/agents - Get all running AI agents
router.get('/', async (req, res) => {
  const agents = await getRunningAgents();
  res.json(agents);
});

// GET /api/agents/:pid - Get specific process info
router.get('/:pid', async (req, res) => {
  const pid = parseInt(req.params.pid);
  const info = await getProcessInfo(pid);
  if (!info) {
    return res.status(404).json({ error: 'Process not found' });
  }
  res.json(info);
});

// DELETE /api/agents/:pid - Kill a process
router.delete('/:pid', async (req, res) => {
  const pid = parseInt(req.params.pid);
  await killProcess(pid);
  res.json({ success: true, pid });
});

export default router;
