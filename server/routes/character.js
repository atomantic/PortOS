/**
 * Character Sheet Routes
 *
 * `GET /` returns the persisted record plus the fields derived on read: the
 * age-based `level`/`ageYears` (#2673), the per-domain `skills` (#2674), and the
 * `metrics` grid (#2676). The XP/HP/damage/rest/event endpoints are retained for
 * backward-compat.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as characterService from '../services/character.js';

const router = Router();

// Zod schemas for request validation
const updateCharacterSchema = z.object({
  // Empty is allowed (not `.min(1)`): '' is the "unset" state the human-centered page renders
  // as the "Your name" / "Add a title" placeholder (#2677), so the user must be able to clear
  // a name/title back to blank, not just replace it.
  name: z.string().max(100).optional(),
  class: z.string().max(100).optional(),
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

// `?skills=0` / `?metrics=0` opt out of each derived registry's domain fan-out, for consumers
// that only read the persisted fields plus the age level — notably the CyberCity HUD, which
// polls this route every 15s and renders only `level`. Both default to ON, so an unaware
// caller still gets the full sheet.
//
// `metrics` defaults to whatever `skills` says rather than to ON. `?skills=0` predates the
// metrics grid (#2676) and has only ever meant one thing — "give me the cheap sheet, skip the
// domain fan-out" — so a caller that predates the flag (a browser holding a stale bundle
// across an update, or any external script) must not silently start paying a NEW fan-out it
// has no way to ask about. An explicit `?metrics=` always wins, so the two stay independently
// gateable: `?skills=0&metrics=1` gets the grid without the skill curve.
const flagEnum = z.enum(['0', '1', 'false', 'true']).optional();
const getCharacterQuerySchema = z.object({
  skills: flagEnum,
  metrics: flagEnum,
});

// A flag is on unless explicitly switched off. Absent ⇒ on (see the default-ON note above).
const isEnabled = (flag) => flag !== '0' && flag !== 'false';

// GET /api/character - Get character sheet
router.get('/', asyncHandler(async (req, res) => {
  const { skills, metrics } = validateRequest(getCharacterQuerySchema, req.query);
  res.json(await characterService.getCharacter({
    withSkills: isEnabled(skills),
    withMetrics: isEnabled(metrics ?? skills),
  }));
}));

// PUT /api/character - Update character name/class
router.put('/', asyncHandler(async (req, res) => {
  const data = validateRequest(updateCharacterSchema, req.body);
  res.json(await characterService.updateCharacterFields(data));
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
