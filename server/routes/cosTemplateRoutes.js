/**
 * CoS Quick Task Templates Routes
 */

import { Router } from 'express';
import * as taskTemplates from '../services/taskTemplates.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, parsePagination } from '../lib/validation.js';
import {
  createTaskTemplateSchema,
  updateTaskTemplateSchema,
  taskTemplateFromTaskSchema
} from '../lib/cosValidation.js';

const router = Router();

// GET /api/cos/templates - Get all task templates
router.get('/templates', asyncHandler(async (req, res) => {
  const templates = await taskTemplates.getAllTemplates();
  res.json({ templates });
}));

// GET /api/cos/templates/popular - Get popular templates
router.get('/templates/popular', asyncHandler(async (req, res) => {
  const { limit } = parsePagination(req.query, { defaultLimit: 5, maxLimit: 500 });
  const templates = await taskTemplates.getPopularTemplates(limit);
  res.json({ templates });
}));

// GET /api/cos/templates/categories - Get template categories
router.get('/templates/categories', asyncHandler(async (req, res) => {
  const categories = await taskTemplates.getCategories();
  res.json({ categories });
}));

// POST /api/cos/templates - Create a new template
router.post('/templates', asyncHandler(async (req, res) => {
  const template = await taskTemplates.createTemplate(validateRequest(createTaskTemplateSchema, req.body));
  res.json({ success: true, template });
}));

// POST /api/cos/templates/from-task - Create template from task
router.post('/templates/from-task', asyncHandler(async (req, res) => {
  const { task, templateName } = validateRequest(taskTemplateFromTaskSchema, req.body);
  const template = await taskTemplates.createTemplateFromTask(task, templateName);
  res.json({ success: true, template });
}));

// POST /api/cos/templates/:id/use - Record template usage
router.post('/templates/:id/use', asyncHandler(async (req, res) => {
  const useCount = await taskTemplates.recordTemplateUsage(req.params.id);
  res.json({ success: true, useCount });
}));

// PUT /api/cos/templates/:id - Update a template
router.put('/templates/:id', asyncHandler(async (req, res) => {
  // Only forward keys the caller actually sent — an absent field must leave the
  // stored value alone rather than overwrite it with undefined.
  const parsed = validateRequest(updateTaskTemplateSchema, req.body);
  const updates = Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined));
  const result = await taskTemplates.updateTemplate(req.params.id, updates);
  if (result.error) {
    throw new ServerError(result.error, { status: 400, code: 'BAD_REQUEST' });
  }
  res.json({ success: true, template: result });
}));

// DELETE /api/cos/templates/:id - Delete a template
router.delete('/templates/:id', asyncHandler(async (req, res) => {
  const result = await taskTemplates.deleteTemplate(req.params.id);
  if (result.error) {
    throw new ServerError(result.error, { status: 400, code: 'BAD_REQUEST' });
  }
  res.json(result);
}));

export default router;
