/**
 * imageVerifier.js — HTTP endpoints for on-demand image evaluation and operator overrides.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { onClientDisconnect } from '../lib/sseDownload.js';
import { validateRequest } from '../lib/validateRequest.js';
import { verifyImage, overrideVerification } from '../services/imageVerifier.js';

const router = Router();

const verifyRequestSchema = z.object({
  filename: z.string().min(1),
  profileId: z.string().optional(),
  prompt: z.string().optional(),
  isImport: z.boolean().optional(),
  reviewerModel: z.string().optional(),
  reviewer: z.object({
    providerId: z.string().optional(),
    model: z.string().optional(),
  }).optional(),
});

const overrideRequestSchema = z.object({
  filename: z.string().min(1),
  verdict: z.enum(['pass', 'fail', 'unreviewed']),
  notes: z.string().max(1000).optional(),
});

// POST on-demand verification
router.post('/verify', asyncHandler(async (req, res) => {
  const data = validateRequest(verifyRequestSchema, req.body);
  const reviewer = data.reviewer || (data.reviewerModel && data.reviewerModel !== 'auto' ? { model: data.reviewerModel } : null);
  const controller = new AbortController();
  const { signal } = controller;
  onClientDisconnect(req, res, () => controller.abort());
  const result = await verifyImage({
    ...data,
    reviewer,
    signal,
  }).catch((err) => {
    if (!signal.aborted) throw err;
  });
  if (!signal.aborted) res.json(result);
}));

// POST manual operator override
router.post('/override', asyncHandler(async (req, res) => {
  const data = validateRequest(overrideRequestSchema, req.body);
  const result = await overrideVerification(data);
  res.json(result);
}));

export default router;
