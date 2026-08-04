import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../services/jira.js', () => ({
  getInstances: vi.fn(),
  upsertInstance: vi.fn(),
  deleteInstance: vi.fn(),
  testConnection: vi.fn(),
  getProjects: vi.fn(),
  createTicket: vi.fn(),
  updateTicket: vi.fn(),
  addComment: vi.fn(),
  getTransitions: vi.fn(),
  deleteTicket: vi.fn(),
  transitionTicket: vi.fn(),
  getMyCurrentSprintTickets: vi.fn(),
  fetchMyCurrentSprintTickets: vi.fn(),
  getBoardColumns: vi.fn(),
  getActiveSprints: vi.fn(),
  getBoards: vi.fn(),
  getIssue: vi.fn(),
  searchEpics: vi.fn()
}));
vi.mock('../services/jiraReports.js', () => ({
  listReports: vi.fn(),
  generateReport: vi.fn(),
  generateAllReports: vi.fn(),
  getLatestReport: vi.fn(),
  getReport: vi.fn()
}));
vi.mock('../services/apps.js', () => ({ getAppById: vi.fn() }));

import * as jiraService from '../services/jira.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import jiraRoutes from './jira.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/jira', jiraRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('GET /instances/:instanceId/my-sprint-tickets/:projectKey', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
    vi.clearAllMocks();
  });

  it('returns the sprint tickets', async () => {
    jiraService.fetchMyCurrentSprintTickets.mockResolvedValue([{ key: 'EX-1', summary: 'Example ticket' }]);

    const r = await request(app).get('/api/jira/instances/jira-1/my-sprint-tickets/EX');

    expect(r.status).toBe(200);
    expect(r.body).toEqual([{ key: 'EX-1', summary: 'Example ticket' }]);
  });

  it('returns an empty sprint as an empty list, not an error', async () => {
    jiraService.fetchMyCurrentSprintTickets.mockResolvedValue([]);

    const r = await request(app).get('/api/jira/instances/jira-1/my-sprint-tickets/EX');

    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it('surfaces a fetch failure instead of answering 200 with an empty list (#3437)', async () => {
    // The swallow-to-[] wrapper made an unreachable instance indistinguishable
    // from an empty sprint, so the UI stated "No tickets assigned to you".
    jiraService.fetchMyCurrentSprintTickets.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const r = await request(app).get('/api/jira/instances/jira-1/my-sprint-tickets/EX');

    expect(r.status).toBe(502);
    expect(r.body.code).toBe('JIRA_FETCH_FAILED');
    expect(r.body.error).toContain('connect ECONNREFUSED');
    // The soft wrapper must not be what the UI route calls.
    expect(jiraService.getMyCurrentSprintTickets).not.toHaveBeenCalled();
  });
});
