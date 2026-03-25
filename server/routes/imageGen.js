/**
 * Image Generation Routes
 *
 * Endpoints for generating images via Stable Diffusion API.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as imageGen from '../services/imageGen.js';

const router = Router();

const generateSchema = z.object({
  prompt: z.string().min(1).max(2000),
  negativePrompt: z.string().max(2000).optional(),
  width: z.number().int().min(64).max(2048).optional(),
  height: z.number().int().min(64).max(2048).optional(),
  steps: z.number().int().min(1).max(150).optional(),
  cfgScale: z.number().min(0).max(30).optional(),
  seed: z.number().int().min(0).optional()
});

const avatarSchema = z.object({
  name: z.string().max(100).optional(),
  characterClass: z.string().max(100).optional(),
  prompt: z.string().max(2000).optional()
});

// GET /api/image-gen/status - Check SD API connection
router.get('/status', asyncHandler(async (req, res) => {
  const status = await imageGen.checkConnection();
  res.json(status);
}));

// POST /api/image-gen/generate - Generate an image
router.post('/generate', asyncHandler(async (req, res) => {
  const data = validateRequest(generateSchema, req.body);
  const result = await imageGen.generateImage(data);
  res.json(result);
}));

// POST /api/image-gen/avatar - Generate a character avatar
router.post('/avatar', asyncHandler(async (req, res) => {
  const data = validateRequest(avatarSchema, req.body);
  const result = await imageGen.generateAvatar(data);
  res.json(result);
}));

export default router;
