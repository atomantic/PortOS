/**
 * Tools Registry Routes
 *
 * CRUD endpoints for managing onboard tools available to CoS agents.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as toolsService from '../services/tools.js';

const router = Router();

const toolIdSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, 'Tool ID must contain only alphanumeric characters, hyphens, and underscores');

const registerToolSchema = z.object({
  id: toolIdSchema.optional(),
  name: z.string().min(1).max(100),
  category: z.string().min(1).max(50),
  description: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
  promptHints: z.string().max(1000).optional()
});

const updateToolSchema = registerToolSchema.omit({ id: true }).partial();

// GET /api/tools - List all tools
router.get('/', asyncHandler(async (req, res) => {
  const tools = await toolsService.getTools();
  res.json(tools);
}));

// GET /api/tools/enabled - List enabled tools
router.get('/enabled', asyncHandler(async (req, res) => {
  const tools = await toolsService.getEnabledTools();
  res.json(tools);
}));

// GET /api/tools/summary - Get prompt-ready summary for agents
router.get('/summary', asyncHandler(async (req, res) => {
  const summary = await toolsService.getToolsSummaryForPrompt();
  res.json({ summary });
}));

// GET /api/tools/:id - Get single tool
router.get('/:id', asyncHandler(async (req, res) => {
  const id = validateRequest(toolIdSchema, req.params.id);
  const tool = await toolsService.getTool(id);
  if (!tool) return res.status(404).json({ error: 'Tool not found' });
  res.json(tool);
}));

// POST /api/tools - Register a new tool
router.post('/', asyncHandler(async (req, res) => {
  const data = validateRequest(registerToolSchema, req.body);
  const tool = await toolsService.registerTool(data);
  res.status(201).json(tool);
}));

// PUT /api/tools/:id - Update a tool
router.put('/:id', asyncHandler(async (req, res) => {
  const id = validateRequest(toolIdSchema, req.params.id);
  const data = validateRequest(updateToolSchema, req.body);
  const tool = await toolsService.updateTool(id, data);
  if (!tool) return res.status(404).json({ error: 'Tool not found' });
  res.json(tool);
}));

// DELETE /api/tools/:id - Delete a tool
router.delete('/:id', asyncHandler(async (req, res) => {
  const id = validateRequest(toolIdSchema, req.params.id);
  await toolsService.deleteTool(id);
  res.status(204).end();
}));

export default router;
