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
  getEpicChildren: vi.fn(),
  addIssuesToSprint: vi.fn(),
  addLabels: vi.fn(),
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
import * as jiraReports from '../services/jiraReports.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import jiraRoutes from './jira.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/jira', jiraRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('GET /reports/:appId/:date', () => {
  it('rejects unsafe path parameters before reading a report', async () => {
    const response = await request(makeApp()).get('/api/jira/reports/bad@app/2026-01-01');

    expect(response.status).toBe(400);
    expect(jiraReports.getReport).not.toHaveBeenCalled();
  });

  it('rejects invalid dates before reading a report', async () => {
    const response = await request(makeApp()).get('/api/jira/reports/example-app/not-a-date');

    expect(response.status).toBe(400);
    expect(jiraReports.getReport).not.toHaveBeenCalled();
  });
});

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

// #5042 — the endpoints the JIRA claim flow's epic decomposition needs. Before
// this, the flow's prompt told the agent to GET `/tickets/<KEY>`, a route that
// did not exist, and there was no way at all to stamp a label, list an epic's
// children, or move a filed child into the sprint.
describe('epic-decomposition endpoints (#5042)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /instances/:instanceId/tickets/:ticketId reads one ticket', async () => {
    jiraService.getIssue.mockResolvedValue({ key: 'PROJ-1', labels: ['decomposed'], description: 'body', epicKey: null });
    const response = await request(makeApp()).get('/api/jira/instances/inst-1/tickets/PROJ-1');
    expect(response.status).toBe(200);
    expect(response.body.labels).toEqual(['decomposed']);
    expect(jiraService.getIssue).toHaveBeenCalledWith('inst-1', 'PROJ-1');
  });

  it('POST /instances/:instanceId/tickets/:ticketId/labels adds labels additively', async () => {
    jiraService.addLabels.mockResolvedValue({ success: true, ticketId: 'PROJ-1' });
    const response = await request(makeApp())
      .post('/api/jira/instances/inst-1/tickets/PROJ-1/labels')
      .send({ labels: ['decomposed'] });
    expect(response.status).toBe(200);
    expect(jiraService.addLabels).toHaveBeenCalledWith('inst-1', 'PROJ-1', ['decomposed']);
  });

  it('rejects a labels request with no labels rather than issuing a no-op write', async () => {
    const response = await request(makeApp())
      .post('/api/jira/instances/inst-1/tickets/PROJ-1/labels')
      .send({ labels: [] });
    expect(response.status).toBe(400);
    expect(jiraService.addLabels).not.toHaveBeenCalled();
  });

  it('GET /instances/:instanceId/epics/:epicKey/children lists an epic\'s children', async () => {
    jiraService.getEpicChildren.mockResolvedValue([{ key: 'PROJ-2', status: 'To Do' }]);
    const response = await request(makeApp()).get('/api/jira/instances/inst-1/epics/PROJ-1/children');
    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ key: 'PROJ-2', status: 'To Do' }]);
    expect(jiraService.getEpicChildren).toHaveBeenCalledWith('inst-1', 'PROJ-1');
  });

  it('POST /instances/:instanceId/sprints/:sprintId/issues moves issues into a sprint', async () => {
    jiraService.addIssuesToSprint.mockResolvedValue({ success: true, sprintId: '42', issueKeys: ['PROJ-2'] });
    const response = await request(makeApp())
      .post('/api/jira/instances/inst-1/sprints/42/issues')
      .send({ issueKeys: ['PROJ-2'] });
    expect(response.status).toBe(200);
    expect(jiraService.addIssuesToSprint).toHaveBeenCalledWith('inst-1', '42', ['PROJ-2']);
  });

  it('rejects a sprint move with no issue keys', async () => {
    const response = await request(makeApp())
      .post('/api/jira/instances/inst-1/sprints/42/issues')
      .send({ issueKeys: [] });
    expect(response.status).toBe(400);
    expect(jiraService.addIssuesToSprint).not.toHaveBeenCalled();
  });
});
