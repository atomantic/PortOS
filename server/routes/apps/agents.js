/**
 * Recent CoS agent history for an app (running + last-14-days history, deduped).
 *
 *   GET /:id/agents → { agents, summary }
 */

import { Router } from 'express';
import * as cos from '../../services/cos.js';
import { asyncHandler } from '../../lib/errorHandler.js';
import { loadApp } from './shared.js';

const router = Router();

// GET /api/apps/:id/agents - Recent CoS agents for this app
router.get('/:id/agents', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const limit = parseInt(req.query.limit, 10) || 50;

  // Get running agents filtered by this app
  const runningAgents = await cos.getAgents().catch(() => []);
  const appRunning = runningAgents.filter(a =>
    a.metadata?.app === app.id || a.metadata?.taskApp === app.id
  );

  // Scan last 14 days of agent history for this app
  const dates = await cos.getAgentDates().catch(() => []);
  const recentDates = dates.slice(0, 14);
  const historyAgents = [];

  for (const { date } of recentDates) {
    if (historyAgents.length >= limit) break;
    const dayAgents = await cos.getAgentsByDate(date).catch(() => []);
    const appAgents = dayAgents.filter(a =>
      a.metadata?.app === app.id || a.metadata?.taskApp === app.id
    );
    historyAgents.push(...appAgents);
  }

  // Combine running + history, deduplicate by id, limit
  const seenIds = new Set();
  const combined = [];
  for (const agent of [...appRunning, ...historyAgents]) {
    if (seenIds.has(agent.id)) continue;
    seenIds.add(agent.id);
    combined.push(agent);
    if (combined.length >= limit) break;
  }

  const running = combined.filter(a => a.status === 'running' || a.status === 'spawning').length;
  const succeeded = combined.filter(a => a.status === 'completed').length;
  const failed = combined.filter(a => a.status === 'failed' || a.status === 'error').length;

  res.json({
    agents: combined,
    summary: { total: combined.length, running, succeeded, failed }
  });
}));

export default router;
