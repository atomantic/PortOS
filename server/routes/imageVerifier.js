/**
 * imageVerifier.js — HTTP endpoints for Image Verifier configuration, profiles,
 * on-demand evaluation, and operator overrides.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import {
  getVerifierSettings,
  updateVerifierSettings,
  getVerificationProfiles,
  getVerificationProfile,
  saveCustomProfile,
  deleteCustomProfile,
  verifyImage,
  overrideVerification,
} from '../services/imageVerifier.js';
import { verificationProfileSchema, VERIFIER_REVIEWER_MODELS } from '../lib/imageVerification.js';

const router = Router();

const updateSettingsSchema = z.object({
  enabledForGeneration: z.boolean().optional(),
  enabledForImport: z.boolean().optional(),
  defaultProfileId: z.string().optional(),
  maxRerolls: z.number().int().min(0).max(5).optional(),
  reviewer: z.object({
    providerId: z.string().optional(),
    model: z.string().optional(),
  }).nullable().optional(),
});

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

// GET models
router.get('/models', asyncHandler(async (_req, res) => {
  res.json({ models: VERIFIER_REVIEWER_MODELS });
}));

// GET settings
router.get('/settings', asyncHandler(async (_req, res) => {
  res.json(await getVerifierSettings());
}));

// PUT settings
router.put('/settings', asyncHandler(async (req, res) => {
  const data = validateRequest(updateSettingsSchema, req.body);
  res.json(await updateVerifierSettings(data));
}));

// GET profiles
router.get('/profiles', asyncHandler(async (_req, res) => {
  res.json(await getVerificationProfiles());
}));

// GET single profile
router.get('/profiles/:id', asyncHandler(async (req, res) => {
  res.json(await getVerificationProfile(req.params.id));
}));

// POST/PUT custom profile
router.post('/profiles', asyncHandler(async (req, res) => {
  const data = validateRequest(verificationProfileSchema, req.body);
  res.json(await saveCustomProfile(data));
}));

// DELETE custom profile
router.delete('/profiles/:id', asyncHandler(async (req, res) => {
  res.json(await deleteCustomProfile(req.params.id));
}));

// POST on-demand verification
router.post('/verify', asyncHandler(async (req, res) => {
  const data = validateRequest(verifyRequestSchema, req.body);
  const reviewer = data.reviewer || (data.reviewerModel && data.reviewerModel !== 'auto' ? { model: data.reviewerModel } : null);
  const result = await verifyImage({
    ...data,
    reviewer,
  });
  res.json(result);
}));

// POST manual operator override
router.post('/override', asyncHandler(async (req, res) => {
  const data = validateRequest(overrideRequestSchema, req.body);
  const result = await overrideVerification(data);
  res.json(result);
}));

export default router;
