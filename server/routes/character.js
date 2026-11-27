/**
 * Character Sheet Routes
 *
 * `GET /` returns the persisted record plus the fields derived on read: the
 * age-based `level`/`ageYears` (#2673), the per-domain `skills` (#2674), and the
 * `metrics` grid (#2676). The XP/HP/damage/rest/event endpoints are retained for
 * backward-compat.
 */

import { updateCharacterSchema, addXPSchema, takeDamageSchema, takeRestSchema, addEventSchema, getCharacterQuerySchema } from '../lib/characterValidation.js';
import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import * as characterService from '../services/character.js';

const router = Router();

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

export default router;
