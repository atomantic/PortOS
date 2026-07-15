/**
 * Digital Twin personas (M34 P7) — CRUD plus the active-persona pointer.
 *
 * Route ordering matters here: `/personas/active` is registered before
 * `/personas/:id` so "active" isn't matched as an id. All of these routes live
 * in this one file, so that ordering is preserved regardless of sub-router mount
 * order in index.js.
 */

import { Router } from 'express';
import * as digitalTwinService from '../../services/digital-twin.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import {
  createPersonaInputSchema,
  updatePersonaInputSchema,
  setActivePersonaInputSchema,
} from '../../lib/digitalTwinValidation.js';
import { UUID_RE } from '../../lib/fileUtils.js';

const router = Router();

/**
 * GET /api/digital-twin/personas
 * List all twin personas
 */
router.get('/personas', asyncHandler(async (req, res) => {
  res.json(await digitalTwinService.getPersonas());
}));

/**
 * POST /api/digital-twin/personas
 * Create a new persona
 */
router.post('/personas', asyncHandler(async (req, res) => {
  const data = validateRequest(createPersonaInputSchema, req.body);
  const persona = await digitalTwinService.createPersona(data);
  res.status(201).json(persona);
}));

/**
 * GET /api/digital-twin/personas/active
 * Get the currently active persona (null when none is set)
 * (Registered before /personas/:id so "active" isn't matched as an id.)
 */
router.get('/personas/active', asyncHandler(async (req, res) => {
  res.json(await digitalTwinService.getActivePersona());
}));

/**
 * PUT /api/digital-twin/personas/active
 * Set (or clear, with personaId: null) the active persona
 */
router.put('/personas/active', asyncHandler(async (req, res) => {
  const { personaId } = validateRequest(setActivePersonaInputSchema, req.body);
  if (personaId && !(await digitalTwinService.getPersonaById(personaId))) {
    throw new ServerError('Persona not found', { status: 404, code: 'NOT_FOUND' });
  }
  const settings = await digitalTwinService.setActivePersona(personaId);
  res.json(settings);
}));

/**
 * PUT /api/digital-twin/personas/:id
 * Update a persona
 */
router.put('/personas/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    throw new ServerError('Invalid persona id', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const data = validateRequest(updatePersonaInputSchema, req.body);
  if (!(await digitalTwinService.getPersonaById(id))) {
    throw new ServerError('Persona not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(await digitalTwinService.updatePersona(id, data));
}));

/**
 * DELETE /api/digital-twin/personas/:id
 * Delete a persona (clears the active pointer if it was active)
 */
router.delete('/personas/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    throw new ServerError('Invalid persona id', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const { deleted } = await digitalTwinService.deletePersona(id);
  if (!deleted) {
    throw new ServerError('Persona not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json({ success: true });
}));

export default router;
