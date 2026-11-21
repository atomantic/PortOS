import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import agentRoutes from './agents.js';

vi.mock('../../services/apps.js', () => ({
  getAppById: vi.fn(),
}));
vi.mock('../../services/cos/cosAgentLifecycle.js', () => ({
  getAgents: vi.fn(),
}));
vi.mock('../../services/cos/cosAgentIndex.js', () => ({
  getAgentDates: vi.fn(),
  selectArchivedCompletions: vi.fn(),
  readArchivedAgentMetadata: vi.fn(),
}));

import * as appsService from '../../services/apps.js';
import { getAgentDates, readArchivedAgentMetadata, selectArchivedCompletions } from '../../services/cos/cosAgentIndex.js';
import { getAgents } from '../../services/cos/cosAgentLifecycle.js';

const APP = { id: 'app-001', name: 'Widget' };

const agentFor = (id, overrides = {}) => ({
  id,
  status: 'completed',
  output: [{ line: 'a transcript line' }],
  metadata: { taskApp: APP.id, taskDescription: 'Fix the widget' },
  ...overrides,
});

describe('GET /api/apps/:id/agents', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use('/api/apps', agentRoutes);
    vi.clearAllMocks();
    appsService.getAppById.mockResolvedValue(APP);
    getAgents.mockResolvedValue([]);
    getAgentDates.mockResolvedValue([]);
    selectArchivedCompletions.mockResolvedValue([]);
    readArchivedAgentMetadata.mockImplementation(async () => null);
  });

  // Archived fixture: the projection selects ids, metadata is read per returned row only.
  const archive = (...agentList) => {
    selectArchivedCompletions.mockResolvedValue(agentList.map(a => ({ id: a.id, day: '2026-07-13', projection: {} })));
    readArchivedAgentMetadata.mockImplementation(async (_day, id) => agentList.find(a => a.id === id) || null);
  };

  // This response carries up to 500 records; shipping each one's transcript and
  // whole pasted-prompt description is the same payload problem the CoS Agents
  // tab had. The table here renders the description as a clamped link label and
  // never reuses the text, so the bounded copy is all it needs.
  it('projects the combined list: no transcripts, bounded descriptions', async () => {
    const long = 'Refactor the queue. '.repeat(5000);
    getAgents.mockResolvedValue([agentFor('agent-running', { status: 'running' })]);
    getAgentDates.mockResolvedValue([{ date: '2026-07-13', count: 1 }]);
    archive(agentFor('agent-done', { metadata: { taskApp: APP.id, taskDescription: long } }));

    const response = await request(app).get('/api/apps/app-001/agents');

    expect(response.status).toBe(200);
    expect(response.body.agents).toHaveLength(2);
    expect(response.body.agents.every(a => !('output' in a))).toBe(true);
    const archived = response.body.agents.find(a => a.id === 'agent-done');
    expect(archived.metadata.taskDescription.length).toBeLessThan(long.length);
    expect(archived.metadata.taskDescriptionTruncated).toBe(true);
    // The summary counts still read the real statuses, not the projection.
    expect(response.body.summary).toMatchObject({ total: 2, running: 1, succeeded: 1 });
  });

  it('reads metadata only for the rows needed to fill the limit, selecting by this app', async () => {
    const many = Array.from({ length: 6 }, (_, n) => agentFor(`agent-${n}`));
    getAgentDates.mockResolvedValue([{ date: '2026-07-13', count: 6 }]);
    archive(...many);

    const response = await request(app).get('/api/apps/app-001/agents?limit=2');

    expect(response.body.agents.map(a => a.id)).toEqual(['agent-0', 'agent-1']);
    expect(selectArchivedCompletions).toHaveBeenCalledWith(expect.objectContaining({ app: APP.id }));
    expect(readArchivedAgentMetadata).toHaveBeenCalledTimes(2);
  });
});
