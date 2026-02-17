/**
 * JIRA API Routes
 */

import express from 'express';
import * as jiraService from '../services/jira.js';
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

export default router;
