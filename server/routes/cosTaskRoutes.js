/**
 * CoS Task CRUD, Enhancement, and Evaluation Routes
 */

import { Router } from 'express';
import * as cos from '../services/cos.js';
import * as taskWatcher from '../services/taskWatcher.js';
import { enhanceTaskPrompt } from '../services/taskEnhancer.js';
import { loadSlashdoCommand } from '../services/subAgentSpawner.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

const SLASHDO_COMMANDS = {
  push:           { label: 'Push', description: 'Commit and push all work with changelog' },
  review:         { label: 'Review', description: 'Deep code review of changed files' },
  replan:         { label: 'Replan', description: 'Audit PLAN.md, archive completed items, prune stale work' },
  release:        { label: 'Release', description: 'Create a release PR' },
  better:         { label: 'Better', description: 'Unified DevSecOps audit and remediation' },
  'better-swift': { label: 'Better Swift', description: 'SwiftUI DevSecOps audit and remediation' }
};

const router = Router();

// GET /api/cos/tasks - Get all tasks
router.get('/tasks', asyncHandler(async (req, res) => {
  const tasks = await cos.getAllTasks();
  res.json(tasks);
}));

// GET /api/cos/tasks/user - Get user tasks
router.get('/tasks/user', asyncHandler(async (req, res) => {
  const tasks = await cos.getUserTasks();
  res.json(tasks);
}));

// GET /api/cos/tasks/internal - Get CoS internal tasks
router.get('/tasks/internal', asyncHandler(async (req, res) => {
  const tasks = await cos.getCosTasks();
  res.json(tasks);
}));

// POST /api/cos/tasks/refresh - Force refresh tasks
router.post('/tasks/refresh', asyncHandler(async (req, res) => {
  const tasks = await taskWatcher.refreshTasks();
  res.json(tasks);
}));

// POST /api/cos/tasks/reorder - Reorder tasks
router.post('/tasks/reorder', asyncHandler(async (req, res) => {
  const { taskIds } = req.body;

  if (!taskIds || !Array.isArray(taskIds)) {
    throw new ServerError('taskIds array is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const result = await cos.reorderTasks(taskIds);
  res.json(result);
}));

// POST /api/cos/tasks/enhance - Enhance a task prompt with AI
router.post('/tasks/enhance', asyncHandler(async (req, res) => {
  const { description, context } = req.body;

  if (!description) {
    throw new ServerError('Description is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const result = await enhanceTaskPrompt(description, context);
  res.json(result);
}));

// POST /api/cos/tasks/slashdo - Create a task from a slashdo command
router.post('/tasks/slashdo', asyncHandler(async (req, res) => {
  const { command, app } = req.body;

  if (!command || !SLASHDO_COMMANDS[command]) {
    throw new ServerError(`Invalid slashdo command. Allowed: ${Object.keys(SLASHDO_COMMANDS).join(', ')}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (!app) {
    throw new ServerError('App ID is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const content = await loadSlashdoCommand(command);
  if (!content) {
    throw new ServerError(`Failed to load slashdo command: ${command}`, { status: 500, code: 'COMMAND_LOAD_FAILED' });
  }

  const meta = SLASHDO_COMMANDS[command];
  const description = `Run /do:${command} for ${app} — ${meta.description}`;
  const taskData = { description, app, context: content, useWorktree: false, openPR: false, simplify: false, reviewLoop: false };
  const result = await cos.addTask(taskData, 'user');

  if (result?.duplicate) {
    throw new ServerError(`A task with this description is already ${result.status}`, { status: 409, code: 'DUPLICATE_TASK' });
  }

  res.json(result);
}));

// POST /api/cos/tasks - Add a new task
router.post('/tasks', asyncHandler(async (req, res) => {
  const { description, priority, context, model, provider, app, type = 'user', approvalRequired, screenshots, attachments, position = 'bottom', createJiraTicket, jiraTicketId, jiraTicketUrl, useWorktree, openPR, simplify, reviewLoop } = req.body;

  if (!description) {
    throw new ServerError('Description is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  // Coerce boolean flags — values from req.body may arrive as strings like 'false' (truthy in JS)
  const toBool = (v) => v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined;
  const taskData = { description, priority, context, model, provider, app, approvalRequired, screenshots, attachments, position, createJiraTicket: toBool(createJiraTicket), jiraTicketId, jiraTicketUrl, useWorktree: toBool(useWorktree), openPR: toBool(openPR), simplify: toBool(simplify), reviewLoop: toBool(reviewLoop) };
  const result = await cos.addTask(taskData, type);

  if (result?.duplicate) {
    throw new ServerError(`A task with this description is already ${result.status}`, { status: 409, code: 'DUPLICATE_TASK' });
  }

  res.json(result);
}));

// PUT /api/cos/tasks/:id - Update a task
router.put('/tasks/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { description, priority, status, context, model, provider, app, blockedReason, type = 'user' } = req.body;

  const updates = {};
  if (description !== undefined) updates.description = description;
  if (priority !== undefined) updates.priority = priority;
  if (status !== undefined) updates.status = status;
  if (context !== undefined) updates.context = context;
  if (model !== undefined) updates.model = model;
  if (provider !== undefined) updates.provider = provider;
  if (app !== undefined) updates.app = app;

  // Set blocker metadata when marking as blocked
  if (status === 'blocked' && blockedReason) {
    updates.metadata = { blocker: blockedReason };
  }

  const result = await cos.updateTask(id, updates, type);
  if (result?.error) {
    throw new ServerError(result.error, { status: 404, code: 'NOT_FOUND' });
  }
  res.json(result);
}));

// DELETE /api/cos/tasks/:id - Delete a task
router.delete('/tasks/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { type = 'user' } = req.query;

  const result = await cos.deleteTask(id, type);
  if (result?.error) {
    throw new ServerError(result.error, { status: 404, code: 'NOT_FOUND' });
  }
  res.json(result);
}));

// POST /api/cos/tasks/:id/approve - Approve a task
router.post('/tasks/:id/approve', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const result = await cos.approveTask(id);
  if (result?.error) {
    throw new ServerError(result.error, { status: 400, code: 'BAD_REQUEST' });
  }
  res.json(result);
}));

// POST /api/cos/evaluate - Force task evaluation
router.post('/evaluate', asyncHandler(async (req, res) => {
  await cos.evaluateTasks();
  res.json({ success: true, message: 'Evaluation triggered' });
}));

// POST /api/cos/tasks/:id/spawn - Force-spawn a pending task
router.post('/tasks/:id/spawn', asyncHandler(async (req, res) => {
  const result = await cos.forceSpawnTask(req.params.id);
  if (result.error) {
    const message = String(result.error);
    let status = 400;
    let code = 'SPAWN_FAILED';
    if (/not found/i.test(message)) {
      status = 404;
      code = 'NOT_FOUND';
    } else if (/not pending/i.test(message)) {
      status = 409;
      code = 'TASK_NOT_PENDING';
    } else if (/no available agent slots/i.test(message)) {
      status = 429;
      code = 'NO_CAPACITY';
    }
    throw new ServerError(result.error, { status, code });
  }
  res.json(result);
}));

export default router;
