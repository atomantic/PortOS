/**
 * Brain API Routes
 *
 * Handles all HTTP endpoints for the Brain feature:
 * - Capture and classify thoughts
 * - CRUD for People, Projects, Ideas, Admin
 * - Daily digest and weekly review
 * - Settings management
 */

import { Router } from 'express';
import * as brainService from '../services/brain.js';
import { getProviderById } from '../services/providers.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validate } from '../lib/validation.js';
import {
  captureInputSchema,
  resolveReviewInputSchema,
  fixInputSchema,
  updateInboxInputSchema,
  inboxQuerySchema,
  peopleInputSchema,
  projectInputSchema,
  ideaInputSchema,
  adminInputSchema,
  settingsUpdateInputSchema
} from '../lib/brainValidation.js';

const router = Router();

// =============================================================================
// CAPTURE & INBOX
// =============================================================================

/**
 * POST /api/brain/capture
 * Capture a thought, classify it, and store it
 */
router.post('/capture', asyncHandler(async (req, res) => {
  const validation = validate(captureInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const { text, providerOverride, modelOverride } = validation.data;
  const result = await brainService.captureThought(text, providerOverride, modelOverride);
  res.json(result);
}));

/**
 * GET /api/brain/inbox
 * Get inbox log entries with optional filters
 */
router.get('/inbox', asyncHandler(async (req, res) => {
  const validation = validate(inboxQuerySchema, req.query);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const entries = await brainService.getInboxLog(validation.data);
  const counts = await brainService.getInboxLogCounts();
  res.json({ entries, counts });
}));

/**
 * GET /api/brain/inbox/:id
 * Get a single inbox log entry
 */
router.get('/inbox/:id', asyncHandler(async (req, res) => {
  const entry = await brainService.getInboxLogById(req.params.id);
  if (!entry) {
    throw new ServerError('Inbox entry not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(entry);
}));

/**
 * POST /api/brain/review/resolve
 * Resolve a needs_review inbox item
 */
router.post('/review/resolve', asyncHandler(async (req, res) => {
  const validation = validate(resolveReviewInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const { inboxLogId, destination, editedExtracted } = validation.data;
  const result = await brainService.resolveReview(inboxLogId, destination, editedExtracted);
  res.json(result);
}));

/**
 * POST /api/brain/fix
 * Fix/correct a filed inbox item
 */
router.post('/fix', asyncHandler(async (req, res) => {
  const validation = validate(fixInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const { inboxLogId, newDestination, updatedFields, note } = validation.data;
  const result = await brainService.fixClassification(inboxLogId, newDestination, updatedFields, note);
  res.json(result);
}));

/**
 * POST /api/brain/inbox/:id/retry
 * Retry AI classification for a needs_review item
 */
router.post('/inbox/:id/retry', asyncHandler(async (req, res) => {
  const { providerOverride, modelOverride } = req.body;
  const result = await brainService.retryClassification(req.params.id, providerOverride, modelOverride);
  res.json(result);
}));

/**
 * PUT /api/brain/inbox/:id
 * Update an inbox entry (edit captured text)
 */
router.put('/inbox/:id', asyncHandler(async (req, res) => {
  const validation = validate(updateInboxInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  const result = await brainService.updateInboxEntry(req.params.id, validation.data);
  if (!result) {
    throw new ServerError('Inbox entry not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(result);
}));

/**
 * DELETE /api/brain/inbox/:id
 * Delete an inbox entry
 */
router.delete('/inbox/:id', asyncHandler(async (req, res) => {
  const deleted = await brainService.deleteInboxEntry(req.params.id);
  if (!deleted) {
    throw new ServerError('Inbox entry not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(204).send();
}));

// =============================================================================
// PEOPLE CRUD
// =============================================================================

router.get('/people', asyncHandler(async (req, res) => {
  const people = await brainService.getPeople();
  res.json(people);
}));

router.get('/people/:id', asyncHandler(async (req, res) => {
  const person = await brainService.getPersonById(req.params.id);
  if (!person) {
    throw new ServerError('Person not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(person);
}));

router.post('/people', asyncHandler(async (req, res) => {
  const validation = validate(peopleInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }
  const person = await brainService.createPerson(validation.data);
  res.status(201).json(person);
}));

router.put('/people/:id', asyncHandler(async (req, res) => {
  const validation = validate(peopleInputSchema.partial(), req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }
  const person = await brainService.updatePerson(req.params.id, validation.data);
  if (!person) {
    throw new ServerError('Person not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(person);
}));

router.delete('/people/:id', asyncHandler(async (req, res) => {
  const deleted = await brainService.deletePerson(req.params.id);
  if (!deleted) {
    throw new ServerError('Person not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(204).send();
}));

// =============================================================================
// PROJECTS CRUD
// =============================================================================

router.get('/projects', asyncHandler(async (req, res) => {
  const { status } = req.query;
  const filters = status ? { status } : undefined;
  const projects = await brainService.getProjects(filters);
  res.json(projects);
}));

router.get('/projects/:id', asyncHandler(async (req, res) => {
  const project = await brainService.getProjectById(req.params.id);
  if (!project) {
    throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(project);
}));

router.post('/projects', asyncHandler(async (req, res) => {
  const validation = validate(projectInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }
  const project = await brainService.createProject(validation.data);
  res.status(201).json(project);
}));

router.put('/projects/:id', asyncHandler(async (req, res) => {
  const validation = validate(projectInputSchema.partial(), req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }
  const project = await brainService.updateProject(req.params.id, validation.data);
  if (!project) {
    throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(project);
}));

router.delete('/projects/:id', asyncHandler(async (req, res) => {
  const deleted = await brainService.deleteProject(req.params.id);
  if (!deleted) {
    throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(204).send();
}));

// =============================================================================
// IDEAS CRUD
// =============================================================================

router.get('/ideas', asyncHandler(async (req, res) => {
  const ideas = await brainService.getIdeas();
  res.json(ideas);
}));

router.get('/ideas/:id', asyncHandler(async (req, res) => {
  const idea = await brainService.getIdeaById(req.params.id);
  if (!idea) {
    throw new ServerError('Idea not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(idea);
}));

router.post('/ideas', asyncHandler(async (req, res) => {
  const validation = validate(ideaInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }
  const idea = await brainService.createIdea(validation.data);
  res.status(201).json(idea);
}));

router.put('/ideas/:id', asyncHandler(async (req, res) => {
  const validation = validate(ideaInputSchema.partial(), req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }
  const idea = await brainService.updateIdea(req.params.id, validation.data);
  if (!idea) {
    throw new ServerError('Idea not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(idea);
}));

router.delete('/ideas/:id', asyncHandler(async (req, res) => {
  const deleted = await brainService.deleteIdea(req.params.id);
  if (!deleted) {
    throw new ServerError('Idea not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(204).send();
}));

// =============================================================================
// ADMIN CRUD
// =============================================================================

router.get('/admin', asyncHandler(async (req, res) => {
  const { status } = req.query;
  const filters = status ? { status } : undefined;
  const adminItems = await brainService.getAdminItems(filters);
  res.json(adminItems);
}));

router.get('/admin/:id', asyncHandler(async (req, res) => {
  const item = await brainService.getAdminById(req.params.id);
  if (!item) {
    throw new ServerError('Admin item not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(item);
}));

router.post('/admin', asyncHandler(async (req, res) => {
  const validation = validate(adminInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }
  const item = await brainService.createAdminItem(validation.data);
  res.status(201).json(item);
}));

router.put('/admin/:id', asyncHandler(async (req, res) => {
  const validation = validate(adminInputSchema.partial(), req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }
  const item = await brainService.updateAdminItem(req.params.id, validation.data);
  if (!item) {
    throw new ServerError('Admin item not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(item);
}));

router.delete('/admin/:id', asyncHandler(async (req, res) => {
  const deleted = await brainService.deleteAdminItem(req.params.id);
  if (!deleted) {
    throw new ServerError('Admin item not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(204).send();
}));

// =============================================================================
// DIGEST & REVIEW
// =============================================================================

/**
 * GET /api/brain/digest/latest
 * Get the most recent daily digest
 */
router.get('/digest/latest', asyncHandler(async (req, res) => {
  const digest = await brainService.getLatestDigest();
  res.json(digest);
}));

/**
 * GET /api/brain/digests
 * Get digest history
 */
router.get('/digests', asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const digests = await brainService.getDigests(limit);
  res.json(digests);
}));

/**
 * POST /api/brain/digest/run
 * Manually trigger daily digest generation
 */
router.post('/digest/run', asyncHandler(async (req, res) => {
  const { providerOverride, modelOverride } = req.body;
  const digest = await brainService.runDailyDigest(providerOverride, modelOverride);
  res.json(digest);
}));

/**
 * GET /api/brain/review/latest
 * Get the most recent weekly review
 */
router.get('/review/latest', asyncHandler(async (req, res) => {
  const review = await brainService.getLatestReview();
  res.json(review);
}));

/**
 * GET /api/brain/reviews
 * Get review history
 */
router.get('/reviews', asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const reviews = await brainService.getReviews(limit);
  res.json(reviews);
}));

/**
 * POST /api/brain/review/run
 * Manually trigger weekly review generation
 */
router.post('/review/run', asyncHandler(async (req, res) => {
  const { providerOverride, modelOverride } = req.body;
  const review = await brainService.runWeeklyReview(providerOverride, modelOverride);
  res.json(review);
}));

// =============================================================================
// SETTINGS & SUMMARY
// =============================================================================

/**
 * GET /api/brain/settings
 * Get brain settings
 */
router.get('/settings', asyncHandler(async (req, res) => {
  const settings = await brainService.loadMeta();
  res.json(settings);
}));

/**
 * PUT /api/brain/settings
 * Update brain settings
 */
router.put('/settings', asyncHandler(async (req, res) => {
  const validation = validate(settingsUpdateInputSchema, req.body);
  if (!validation.success) {
    throw new ServerError('Validation failed', {
      status: 400,
      code: 'VALIDATION_ERROR',
      context: { details: validation.errors }
    });
  }

  // Validate provider and model if provided
  if (validation.data.defaultProvider || validation.data.defaultModel) {
    const providerId = validation.data.defaultProvider;
    const modelId = validation.data.defaultModel;

    // Get current settings to use existing provider if only model is being updated
    const currentSettings = await brainService.loadMeta();
    const effectiveProviderId = providerId || currentSettings.defaultProvider;

    // Validate provider exists
    const provider = await getProviderById(effectiveProviderId);
    if (!provider) {
      throw new ServerError(`Provider "${effectiveProviderId}" not found`, {
        status: 400,
        code: 'INVALID_PROVIDER'
      });
    }

    // Validate model exists in provider's models
    if (modelId) {
      if (!provider.models || provider.models.length === 0) {
        throw new ServerError(`Provider "${effectiveProviderId}" has no models configured`, {
          status: 400,
          code: 'NO_MODELS'
        });
      }
      if (!provider.models.includes(modelId)) {
        throw new ServerError(`Model "${modelId}" not found in provider "${effectiveProviderId}"`, {
          status: 400,
          code: 'INVALID_MODEL',
          context: { availableModels: provider.models }
        });
      }
    }
  }

  const settings = await brainService.updateMeta(validation.data);
  res.json(settings);
}));

/**
 * GET /api/brain/summary
 * Get brain data summary for dashboard
 */
router.get('/summary', asyncHandler(async (req, res) => {
  const summary = await brainService.getSummary();
  res.json(summary);
}));

export default router;
