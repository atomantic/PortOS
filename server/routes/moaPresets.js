/**
 * Mixture of Agents preset routes (`/api/moa-presets`): list with live member
 * eligibility and the fixed prompt additions, create, update, delete.
 *
 * Executing a preset has no route of its own: a caller selects provider id
 * `moa:<id>` wherever it already selects a provider (lib/moaConfig.js).
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { MOA_ADVISOR_INSTRUCTION, MOA_AGGREGATOR_INSTRUCTION, moaProviderId } from '../lib/moaConfig.js';
import { MAX_MOA_REFERENCE_MODELS, moaPresetCreateSchema, moaPresetIdSchema, moaPresetUpdateSchema } from '../lib/moaValidation.js';
import { createMoaPreset, deleteMoaPreset, listMoaPresets, moaPresetRefusals, updateMoaPreset } from '../services/moaPresets.js';

const router = Router();

const present = async (preset) => (preset.invalid
  ? { ...preset, refusals: [] }
  : { ...preset, providerId: moaProviderId(preset.id), refusals: await moaPresetRefusals(preset) });

router.get('/', asyncHandler(async (req, res) => {
  const presets = await listMoaPresets();
  res.json({
    presets: await Promise.all(presets.map(present)),
    maxReferenceModels: MAX_MOA_REFERENCE_MODELS,
    instructions: { advisor: MOA_ADVISOR_INSTRUCTION, aggregator: MOA_AGGREGATOR_INSTRUCTION },
  });
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = validateRequest(moaPresetCreateSchema, req.body ?? {});
  res.status(201).json(await present(await createMoaPreset(body)));
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const id = validateRequest(moaPresetIdSchema, String(req.params.id));
  const body = validateRequest(moaPresetUpdateSchema, req.body ?? {});
  res.json(await present(await updateMoaPreset(id, body)));
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const id = validateRequest(moaPresetIdSchema, String(req.params.id));
  res.json(await deleteMoaPreset(id));
}));

export default router;
