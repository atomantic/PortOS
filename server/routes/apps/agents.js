/**
 * Recent CoS agent history for an app (running + last-14-days history, deduped).
 *
 *   GET /:id/agents → { agents, summary }
 */

import { Router } from 'express';
import { getAgentDates, readArchivedAgentMetadata, selectArchivedCompletions } from '../../services/cos/cosAgentIndex.js';
import { getAgents } from '../../services/cos/cosAgentLifecycle.js';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validateRequest.js';
import { limitQuerySchema, parsePagination } from '../../lib/queryValidation.js';
import { toAgentListItems } from '../../lib/cos/cosAgentListProjection.js';
import { loadApp } from './shared.js';

const router = Router();

// GET /api/apps/:id/agents - Recent CoS agents for this app
router.get('/:id/agents', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const { limit } = parsePagination(validateRequest(limitQuerySchema, req.query), { defaultLimit: 50, maxLimit: 500 });

  const runningAgents = await getAgents().catch(() => []);
  const appRunning = runningAgents.filter(a =>
    a.metadata?.app === app.id || a.metadata?.taskApp === app.id
  );

  // Last 14 archive days for this app: the matching ids come from the completion-order projection,
  // newest first, and metadata is read only until `limit` rows are filled (#17309).
  const dates = await getAgentDates().catch(() => []);
  const matches = await selectArchivedCompletions({
    dates: dates.slice(0, 14).map(({ date }) => date),
    app: app.id,
    includeIncomplete: true,
  }).catch(() => []);

  const seenIds = new Set();
  const combined = [];
  for (const agent of appRunning) {
    if (seenIds.has(agent.id) || combined.length >= limit) continue;
    seenIds.add(agent.id);
    combined.push(agent);
  }
  const pending = matches.filter(({ id }) => !seenIds.has(id));
  while (combined.length < limit && pending.length > 0) {
    const batch = pending.splice(0, limit - combined.length);
    const records = await Promise.all(batch.map(({ day, id }) =>
      readArchivedAgentMetadata(day, id, { repairSummaries: false }).catch(() => null)));
    for (const agent of records) {
      if (!agent || seenIds.has(agent.id)) continue;
      seenIds.add(agent.id);
      combined.push(agent);
    }
  }

  const running = combined.filter(a => a.status === 'running' || a.status === 'spawning').length;
  const succeeded = combined.filter(a => a.status === 'completed').length;
  const failed = combined.filter(a => a.status === 'failed' || a.status === 'error').length;

  // Same listing projection as `GET /api/cos/agents`: no transcripts, and a
  // bounded task description. This response can carry up to 500 records, and the
  // App page's table renders the description as a two-line clamped link label —
  // it never reuses the text, so nothing here needs hydration.
  res.json({
    agents: toAgentListItems(combined),
    summary: { total: combined.length, running, succeeded, failed }
  });
}));

export default router;
