/**
 * Agent Personalities Routes
 *
 * CRUD operations for AI agent personalities.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validate, agentSchema, agentUpdateSchema } from '../lib/validation.js';
import * as agentPersonalities from '../services/agentPersonalities.js';
import { generateAgentPersonality } from '../services/agentPersonalityGenerator.js';
import { logAction } from '../services/history.js';

const router = Router();

// GET / - Get all agent personalities
router.get('/', asyncHandler(async (req, res) => {
  console.log('🤖 GET /api/agents/personalities');
  const { userId } = req.query;

  const agents = userId
    ? await agentPersonalities.getAgentsByUser(userId)
    : await agentPersonalities.getAllAgents();

  res.json(agents);
}));

// GET /:id - Get agent by ID
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  console.log(`🤖 GET /api/agents/personalities/${id}`);

  const agent = await agentPersonalities.getAgentById(id);
  if (!agent) {
    throw new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' });
  }

  res.json(agent);
}));

// POST / - Create new agent
router.post('/', asyncHandler(async (req, res) => {
  console.log('🤖 POST /api/agents/personalities');

  const { success, data, errors } = validate(agentSchema, req.body);
  if (!success) {
    return res.status(422).json({ errors });
  }

  const agent = await agentPersonalities.createAgent(data);
  await logAction('create', 'agent-personality', agent.id, { name: agent.name });

  res.status(201).json(agent);
}));

// PUT /:id - Update agent
router.put('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  console.log(`🤖 PUT /api/agents/personalities/${id}`);

  const { success, data, errors } = validate(agentUpdateSchema, req.body);
  if (!success) {
    return res.status(422).json({ errors });
  }

  const agent = await agentPersonalities.updateAgent(id, data);
  if (!agent) {
    throw new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' });
  }

  await logAction('update', 'agent-personality', id, { name: agent.name });
  res.json(agent);
}));

// DELETE /:id - Delete agent
router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  console.log(`🤖 DELETE /api/agents/personalities/${id}`);

  const deleted = await agentPersonalities.deleteAgent(id);
  if (!deleted) {
    throw new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' });
  }

  await logAction('delete', 'agent-personality', id, {});
  res.json({ success: true });
}));

// POST /generate - Generate agent personality using AI
router.post('/generate', asyncHandler(async (req, res) => {
  console.log('🎨 POST /api/agents/personalities/generate');

  const { seed = {}, providerId, model } = req.body;

  const generated = await generateAgentPersonality(seed, providerId, model);

  res.json(generated);
}));

// POST /:id/toggle - Toggle agent enabled status
router.post('/:id/toggle', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { enabled } = req.body;
  console.log(`🤖 POST /api/agents/personalities/${id}/toggle enabled=${enabled}`);

  const agent = await agentPersonalities.toggleAgent(id, enabled);
  if (!agent) {
    throw new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' });
  }

  await logAction('toggle', 'agent-personality', id, { enabled });
  res.json(agent);
}));

export default router;
