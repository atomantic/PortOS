/**
 * Tools Registry Routes
 *
 * CRUD endpoints for managing onboard tools available to CoS agents.
 */

import { toolIdSchema, registerToolSchema, updateToolSchema } from '../lib/toolsValidation.js';
import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import * as toolsService from '../services/tools.js';

const router = Router();

// GET /api/tools - List all tools
router.get('/', asyncHandler(async (req, res) => {
  const tools = await toolsService.getTools();
  res.json(tools);
}));

// GET /api/tools/:id - Get single tool
router.get('/:id', asyncHandler(async (req, res) => {
  const id = validateRequest(toolIdSchema, req.params.id);
  const tool = await toolsService.getTool(id);
  if (!tool) throw new ServerError('Tool not found', { status: 404 });
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
  if (!tool) throw new ServerError('Tool not found', { status: 404 });
  res.json(tool);
}));

// DELETE /api/tools/:id - Delete a tool
router.delete('/:id', asyncHandler(async (req, res) => {
  const id = validateRequest(toolIdSchema, req.params.id);
  await toolsService.deleteTool(id);
  res.status(204).end();
}));

export default router;
