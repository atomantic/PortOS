/**
 * JIRA API Routes
 */

import express from 'express';
import * as jiraService from '../services/jira.js';
import * as jiraReports from '../services/jiraReports.js';
import { getAppById } from '../services/apps.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

const router = express.Router();

/**
 * GET /api/jira/instances
 * Get all JIRA instances
 */
router.get('/instances', asyncHandler(async (req, res) => {
  const config = await jiraService.getInstances();

  // Don't send API tokens to client
  const sanitized = {
    instances: Object.fromEntries(
      Object.entries(config.instances).map(([id, instance]) => [
        id,
        {
          id: instance.id,
          name: instance.name,
          baseUrl: instance.baseUrl,
          email: instance.email,
          hasApiToken: !!instance.apiToken,
          tokenUpdatedAt: instance.tokenUpdatedAt,
          createdAt: instance.createdAt,
          updatedAt: instance.updatedAt
        }
      ])
    )
  };

  res.json(sanitized);
}));

/**
 * POST /api/jira/instances
 * Create or update JIRA instance
 */
router.post('/instances', asyncHandler(async (req, res) => {
  const { id, name, baseUrl, email, apiToken } = req.body;

  if (!id || !name || !baseUrl || !email || !apiToken) {
    throw new ServerError('Missing required fields', {
      status: 400,
      code: 'INVALID_INPUT'
    });
  }

  const instance = await jiraService.upsertInstance(id, {
    name,
    baseUrl,
    email,
    apiToken
  });

  // Don't send API token back
  const sanitized = {
    id: instance.id,
    name: instance.name,
    baseUrl: instance.baseUrl,
    email: instance.email,
    hasApiToken: true,
    tokenUpdatedAt: instance.tokenUpdatedAt,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt
  };

  res.json(sanitized);
}));

/**
 * DELETE /api/jira/instances/:id
 * Delete JIRA instance
 */
router.delete('/instances/:id', asyncHandler(async (req, res) => {
  await jiraService.deleteInstance(req.params.id);
  res.json({ success: true });
}));

/**
 * POST /api/jira/instances/:id/test
 * Test JIRA instance connection
 */
router.post('/instances/:id/test', asyncHandler(async (req, res) => {
  const result = await jiraService.testConnection(req.params.id);
  res.json(result);
}));

/**
 * GET /api/jira/instances/:id/projects
 * Get projects for JIRA instance
 */
router.get('/instances/:id/projects', asyncHandler(async (req, res) => {
  const projects = await jiraService.getProjects(req.params.id);
  res.json(projects);
}));

/**
 * POST /api/jira/instances/:id/tickets
 * Create JIRA ticket
 */
router.post('/instances/:id/tickets', asyncHandler(async (req, res) => {
  const result = await jiraService.createTicket(req.params.id, req.body);
  res.json(result);
}));

/**
 * PUT /api/jira/instances/:instanceId/tickets/:ticketId
 * Update JIRA ticket
 */
router.put('/instances/:instanceId/tickets/:ticketId', asyncHandler(async (req, res) => {
  const result = await jiraService.updateTicket(
    req.params.instanceId,
    req.params.ticketId,
    req.body
  );
  res.json(result);
}));

/**
 * POST /api/jira/instances/:instanceId/tickets/:ticketId/comments
 * Add comment to JIRA ticket
 */
router.post('/instances/:instanceId/tickets/:ticketId/comments', asyncHandler(async (req, res) => {
  const { comment } = req.body;

  if (!comment) {
    throw new ServerError('Comment is required', {
      status: 400,
      code: 'INVALID_INPUT'
    });
  }

  const result = await jiraService.addComment(
    req.params.instanceId,
    req.params.ticketId,
    comment
  );

  res.json(result);
}));

/**
 * GET /api/jira/instances/:instanceId/tickets/:ticketId/transitions
 * Get available transitions for a ticket
 */
router.get('/instances/:instanceId/tickets/:ticketId/transitions', asyncHandler(async (req, res) => {
  const transitions = await jiraService.getTransitions(
    req.params.instanceId,
    req.params.ticketId
  );
  res.json(transitions);
}));

/**
 * DELETE /api/jira/instances/:instanceId/tickets/:ticketId
 * Delete a JIRA ticket
 */
router.delete('/instances/:instanceId/tickets/:ticketId', asyncHandler(async (req, res) => {
  const result = await jiraService.deleteTicket(
    req.params.instanceId,
    req.params.ticketId
  );
  res.json(result);
}));

/**
 * POST /api/jira/instances/:instanceId/tickets/:ticketId/transition
 * Transition JIRA ticket status
 */
router.post('/instances/:instanceId/tickets/:ticketId/transition', asyncHandler(async (req, res) => {
  const { transitionId } = req.body;

  if (!transitionId) {
    throw new ServerError('Transition ID is required', {
      status: 400,
      code: 'INVALID_INPUT'
    });
  }

  const result = await jiraService.transitionTicket(
    req.params.instanceId,
    req.params.ticketId,
    transitionId
  );

  res.json(result);
}));

/**
 * GET /api/jira/instances/:instanceId/my-sprint-tickets/:projectKey
 * Get tickets assigned to current user in active sprint for a project
 */
router.get('/instances/:instanceId/my-sprint-tickets/:projectKey', asyncHandler(async (req, res) => {
  const tickets = await jiraService.getMyCurrentSprintTickets(
    req.params.instanceId,
    req.params.projectKey
  );
  res.json(tickets);
}));

/**
 * GET /api/jira/instances/:instanceId/boards/:boardId/sprints
 * Get active sprints for a board
 */
router.get('/instances/:instanceId/boards/:boardId/sprints', asyncHandler(async (req, res) => {
  const sprints = await jiraService.getActiveSprints(
    req.params.instanceId,
    req.params.boardId
  );
  res.json(sprints);
}));

/**
 * GET /api/jira/instances/:instanceId/projects/:projectKey/epics?q=search
 * Search for epics by name in a project
 */
router.get('/instances/:instanceId/projects/:projectKey/epics', asyncHandler(async (req, res) => {
  const epics = await jiraService.searchEpics(
    req.params.instanceId,
    req.params.projectKey,
    req.query.q || ''
  );
  res.json(epics);
}));

// ============================================================
// JIRA Status Reports
// ============================================================

/**
 * GET /api/jira/reports
 * List all JIRA status reports, optionally filtered by appId
 */
router.get('/reports', asyncHandler(async (req, res) => {
  const reports = await jiraReports.listReports(req.query.appId || null);
  res.json(reports);
}));

/**
 * POST /api/jira/reports/generate
 * Generate status report for a specific app or all JIRA-enabled apps
 */
router.post('/reports/generate', asyncHandler(async (req, res) => {
  const { appId } = req.body;

  if (appId) {
    const app = await getAppById(appId);
    if (!app) {
      throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
    }
    if (!app.jira?.enabled) {
      throw new ServerError('JIRA is not enabled for this app', { status: 400, code: 'JIRA_NOT_ENABLED' });
    }
    const report = await jiraReports.generateReport(appId, app);
    res.json(report);
  } else {
    const reports = await jiraReports.generateAllReports();
    res.json(reports);
  }
}));

/**
 * GET /api/jira/reports/:appId/latest
 * Get the latest report for an app
 */
router.get('/reports/:appId/latest', asyncHandler(async (req, res) => {
  const report = await jiraReports.getLatestReport(req.params.appId);
  if (!report) {
    throw new ServerError('No reports found for this app', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(report);
}));

/**
 * GET /api/jira/reports/:appId/:date
 * Get a specific report by app and date
 */
router.get('/reports/:appId/:date', asyncHandler(async (req, res) => {
  const report = await jiraReports.getReport(req.params.appId, req.params.date);
  if (!report) {
    throw new ServerError('Report not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(report);
}));

export default router;
