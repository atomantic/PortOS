/**
 * Character Sheet Routes
 * D&D-style character sheet with XP, HP, damage, rests, and event tracking.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as characterService from '../services/character.js';

const router = Router();

// Zod schemas for request validation
const updateCharacterSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  class: z.string().min(1).max(100).optional(),
  avatarPath: z.string().max(500).regex(/^\/data\/images\/[A-Za-z0-9._-]+$/, 'Invalid avatar path').optional()
});

const addXPSchema = z.object({
  amount: z.number().int().min(1),
  source: z.string().min(1).max(200),
  description: z.string().max(500).optional()
});

const takeDamageSchema = z.object({
  diceNotation: z.string().regex(/^\d+d\d+([+-]\d+)?$/, 'Invalid dice notation (e.g. "1d8", "2d6+3")'),
  description: z.string().max(500).optional()
});

const takeRestSchema = z.object({
  type: z.enum(['short', 'long'])
});

const addEventSchema = z.object({
  description: z.string().min(1).max(500),
  xp: z.number().int().min(0).optional(),
  diceNotation: z.string().regex(/^\d+d\d+([+-]\d+)?$/).optional()
});

// GET /api/character - Get character sheet
router.get('/', asyncHandler(async (req, res) => {
  const character = await characterService.getCharacter();
  res.json(character);
}));

// PUT /api/character - Update character name/class
router.put('/', asyncHandler(async (req, res) => {
  const data = validateRequest(updateCharacterSchema, req.body);
  const character = await characterService.getCharacter();
  if (data.name) character.name = data.name;
  if (data.class) character.class = data.class;
  if (data.avatarPath) character.avatarPath = data.avatarPath;
  const updated = await characterService.saveCharacter(character);
  res.json(updated);
}));

// POST /api/character/xp - Add XP manually
router.post('/xp', asyncHandler(async (req, res) => {
  const { amount, source, description } = validateRequest(addXPSchema, req.body);
  const result = await characterService.addXP(amount, source, description);
  res.json(result);
}));

// POST /api/character/damage - Take damage
router.post('/damage', asyncHandler(async (req, res) => {
  const { diceNotation, description } = validateRequest(takeDamageSchema, req.body);
  const result = await characterService.takeDamage(diceNotation, description);
  res.json(result);
}));

// POST /api/character/rest - Take a rest
router.post('/rest', asyncHandler(async (req, res) => {
  const { type } = validateRequest(takeRestSchema, req.body);
  const result = await characterService.takeRest(type);
  res.json(result);
}));

// POST /api/character/event - Log custom event
router.post('/event', asyncHandler(async (req, res) => {
  const data = validateRequest(addEventSchema, req.body);
  const result = await characterService.addEvent(data);
  res.json(result);
}));

// POST /api/character/sync/jira - Sync JIRA tickets for XP
router.post('/sync/jira', asyncHandler(async (req, res) => {
  const result = await characterService.syncJiraXP();
  res.json(result);
}));

// POST /api/character/sync/tasks - Sync CoS tasks for XP
router.post('/sync/tasks', asyncHandler(async (req, res) => {
  const result = await characterService.syncTaskXP();
  res.json(result);
}));

// POST /api/character/reset - Reset character (fresh start)
router.post('/reset', asyncHandler(async (req, res) => {
  const character = await characterService.saveCharacter(characterService.createDefaultCharacter());
  res.json(character);
}));

export default router;
