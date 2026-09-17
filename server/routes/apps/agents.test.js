import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import agentRoutes from './agents.js';

vi.mock('../../services/apps.js', () => ({
  getAppById: vi.fn(),
}));
vi.mock('../../services/cos.js', () => ({
  getAgents: vi.fn(),
  getAgentDates: vi.fn(),
  getAgentsByDate: vi.fn(),
}));

import * as appsService from '../../services/apps.js';
import * as cos from '../../services/cos.js';

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
    cos.getAgents.mockResolvedValue([]);
    cos.getAgentDates.mockResolvedValue([]);
    cos.getAgentsByDate.mockResolvedValue([]);
  });

  // This response carries up to 500 records; shipping each one's transcript and
  // whole pasted-prompt description is the same payload problem the CoS Agents
  // tab had. The table here renders the description as a clamped link label and
  // never reuses the text, so the bounded copy is all it needs.
  it('projects the combined list: no transcripts, bounded descriptions', async () => {
    const long = 'Refactor the queue. '.repeat(5000);
    cos.getAgents.mockResolvedValue([agentFor('agent-running', { status: 'running' })]);
    cos.getAgentDates.mockResolvedValue([{ date: '2026-07-13', count: 1 }]);
    cos.getAgentsByDate.mockResolvedValue([
      agentFor('agent-done', { metadata: { taskApp: APP.id, taskDescription: long } }),
    ]);

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
});
