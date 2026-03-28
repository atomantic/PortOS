/**
 * JIRA API Routes
 */

import express from 'express';
import * as jiraService from '../services/jira.js';
import * as jiraReports from '../services/jiraReports.js';
import { getAppById } from '../services/apps.js';
import { ServerError } from '../lib/errorHandler.js';

const router = express.Router();

/**
 * GET /api/jira/instances
 * Get all JIRA instances
 */
router.get('/instances', async (req, res, next) => {
  try {
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
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/jira/instances
 * Create or update JIRA instance
 */
router.post('/instances', async (req, res, next) => {
  try {
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
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/jira/instances/:id
 * Delete JIRA instance
 */
router.delete('/instances/:id', async (req, res, next) => {
  try {
    await jiraService.deleteInstance(req.params.id);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/jira/instances/:id/test
 * Test JIRA instance connection
 */
router.post('/instances/:id/test', async (req, res, next) => {
  try {
    const result = await jiraService.testConnection(req.params.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/jira/instances/:id/projects
 * Get projects for JIRA instance
 */
router.get('/instances/:id/projects', async (req, res, next) => {
  try {
    const projects = await jiraService.getProjects(req.params.id);
    res.json(projects);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/jira/instances/:id/tickets
 * Create JIRA ticket
 */
router.post('/instances/:id/tickets', async (req, res, next) => {
  try {
    const result = await jiraService.createTicket(req.params.id, req.body);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/jira/instances/:instanceId/tickets/:ticketId
 * Update JIRA ticket
 */
router.put('/instances/:instanceId/tickets/:ticketId', async (req, res, next) => {
  try {
    const result = await jiraService.updateTicket(
      req.params.instanceId,
      req.params.ticketId,
      req.body
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/jira/instances/:instanceId/tickets/:ticketId/comments
 * Add comment to JIRA ticket
 */
router.post('/instances/:instanceId/tickets/:ticketId/comments', async (req, res, next) => {
  try {
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
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/jira/instances/:instanceId/tickets/:ticketId/transitions
 * Get available transitions for a ticket
 */
router.get('/instances/:instanceId/tickets/:ticketId/transitions', async (req, res, next) => {
  try {
    const transitions = await jiraService.getTransitions(
      req.params.instanceId,
      req.params.ticketId
    );
    res.json(transitions);
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/jira/instances/:instanceId/tickets/:ticketId
 * Delete a JIRA ticket
 */
router.delete('/instances/:instanceId/tickets/:ticketId', async (req, res, next) => {
  try {
    const result = await jiraService.deleteTicket(
      req.params.instanceId,
      req.params.ticketId
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/jira/instances/:instanceId/tickets/:ticketId/transition
 * Transition JIRA ticket status
 */
router.post('/instances/:instanceId/tickets/:ticketId/transition', async (req, res, next) => {
  try {
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
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/jira/instances/:instanceId/my-sprint-tickets/:projectKey
 * Get tickets assigned to current user in active sprint for a project
 */
router.get('/instances/:instanceId/my-sprint-tickets/:projectKey', async (req, res, next) => {
  try {
    const tickets = await jiraService.getMyCurrentSprintTickets(
      req.params.instanceId,
      req.params.projectKey
    );
    res.json(tickets);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/jira/instances/:instanceId/boards/:boardId/sprints
 * Get active sprints for a board
 */
router.get('/instances/:instanceId/boards/:boardId/sprints', async (req, res, next) => {
  try {
    const sprints = await jiraService.getActiveSprints(
      req.params.instanceId,
      req.params.boardId
    );
    res.json(sprints);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/jira/instances/:instanceId/projects/:projectKey/epics?q=search
 * Search for epics by name in a project
 */
router.get('/instances/:instanceId/projects/:projectKey/epics', async (req, res, next) => {
  try {
    const epics = await jiraService.searchEpics(
      req.params.instanceId,
      req.params.projectKey,
      req.query.q || ''
    );
    res.json(epics);
  } catch (error) {
    next(error);
  }
});

// ============================================================
// JIRA Status Reports
// ============================================================

/**
 * GET /api/jira/reports
 * List all JIRA status reports, optionally filtered by appId
 */
router.get('/reports', async (req, res, next) => {
  try {
    const reports = await jiraReports.listReports(req.query.appId || null);
    res.json(reports);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/jira/reports/generate
 * Generate status report for a specific app or all JIRA-enabled apps
 */
router.post('/reports/generate', async (req, res, next) => {
  try {
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
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/jira/reports/:appId/latest
 * Get the latest report for an app
 */
router.get('/reports/:appId/latest', async (req, res, next) => {
  try {
    const report = await jiraReports.getLatestReport(req.params.appId);
    if (!report) {
      throw new ServerError('No reports found for this app', { status: 404, code: 'NOT_FOUND' });
    }
    res.json(report);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/jira/reports/:appId/:date
 * Get a specific report by app and date
 */
router.get('/reports/:appId/:date', async (req, res, next) => {
  try {
    const report = await jiraReports.getReport(req.params.appId, req.params.date);
    if (!report) {
      throw new ServerError('Report not found', { status: 404, code: 'NOT_FOUND' });
    }
    res.json(report);
  } catch (error) {
    next(error);
  }
});

export default router;
