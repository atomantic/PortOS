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
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import * as brainService from '../services/brain.js';
import { getProviderById } from '../services/providers.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
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
  settingsUpdateInputSchema,
  linkInputSchema,
  linkUpdateInputSchema,
  linksQuerySchema
} from '../lib/brainValidation.js';
import * as githubCloner from '../services/githubCloner.js';

const router = Router();

// =============================================================================
// CAPTURE & INBOX
// =============================================================================

/**
 * POST /api/brain/capture
 * Capture a thought, classify it, and store it
 */
router.post('/capture', asyncHandler(async (req, res) => {
  const { text, providerOverride, modelOverride } = validateRequest(captureInputSchema, req.body);
  const result = await brainService.captureThought(text, providerOverride, modelOverride);
  res.json(result);
}));

/**
 * GET /api/brain/inbox
 * Get inbox log entries with optional filters
 */
router.get('/inbox', asyncHandler(async (req, res) => {
  const data = validateRequest(inboxQuerySchema, req.query);
  const entries = await brainService.getInboxLog(data);
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
  const { inboxLogId, destination, editedExtracted } = validateRequest(resolveReviewInputSchema, req.body);
  const result = await brainService.resolveReview(inboxLogId, destination, editedExtracted);
  res.json(result);
}));

/**
 * POST /api/brain/fix
 * Fix/correct a filed inbox item
 */
router.post('/fix', asyncHandler(async (req, res) => {
  const { inboxLogId, newDestination, updatedFields, note } = validateRequest(fixInputSchema, req.body);
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
 * POST /api/brain/inbox/:id/done
 * Mark an inbox entry as done
 */
router.post('/inbox/:id/done', asyncHandler(async (req, res) => {
  const result = await brainService.markInboxDone(req.params.id);
  if (!result) {
    throw new ServerError('Inbox entry not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(result);
}));

/**
 * PUT /api/brain/inbox/:id
 * Update an inbox entry (edit captured text)
 */
router.put('/inbox/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(updateInboxInputSchema, req.body);
  const result = await brainService.updateInboxEntry(req.params.id, data);
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
  const data = validateRequest(peopleInputSchema, req.body);
  const person = await brainService.createPerson(data);
  res.status(201).json(person);
}));

router.put('/people/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(peopleInputSchema.partial(), req.body);
  const person = await brainService.updatePerson(req.params.id, data);
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
  const data = validateRequest(projectInputSchema, req.body);
  const project = await brainService.createProject(data);
  res.status(201).json(project);
}));

router.put('/projects/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(projectInputSchema.partial(), req.body);
  const project = await brainService.updateProject(req.params.id, data);
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
  const { status } = req.query;
  const filters = status ? { status } : undefined;
  const ideas = await brainService.getIdeas(filters);
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
  const data = validateRequest(ideaInputSchema, req.body);
  const idea = await brainService.createIdea(data);
  res.status(201).json(idea);
}));

router.put('/ideas/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(ideaInputSchema.partial(), req.body);
  const idea = await brainService.updateIdea(req.params.id, data);
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
  const data = validateRequest(adminInputSchema, req.body);
  const item = await brainService.createAdminItem(data);
  res.status(201).json(item);
}));

router.put('/admin/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(adminInputSchema.partial(), req.body);
  const item = await brainService.updateAdminItem(req.params.id, data);
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
  const limit = parseInt(req.query.limit, 10) || 10;
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
  const limit = parseInt(req.query.limit, 10) || 10;
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
  const data = validateRequest(settingsUpdateInputSchema, req.body);

  // Validate provider and model if provided
  if (data.defaultProvider || data.defaultModel) {
    const providerId = data.defaultProvider;
    const modelId = data.defaultModel;

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

  const settings = await brainService.updateMeta(data);
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

// =============================================================================
// LINKS CRUD
// =============================================================================

/**
 * GET /api/brain/links
 * Get all links with optional filters
 */
router.get('/links', asyncHandler(async (req, res) => {
  const { linkType, isGitHubRepo, limit, offset } = validateRequest(linksQuerySchema, req.query);
  let links = await brainService.getLinks();

  // Apply filters
  if (linkType) {
    links = links.filter(l => l.linkType === linkType);
  }
  if (isGitHubRepo !== undefined) {
    links = links.filter(l => l.isGitHubRepo === isGitHubRepo);
  }

  // Sort by createdAt descending
  links.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // Apply pagination
  const total = links.length;
  links = links.slice(offset, offset + limit);

  res.json({ links, total, limit, offset });
}));

/**
 * GET /api/brain/links/:id
 * Get a single link by ID
 */
router.get('/links/:id', asyncHandler(async (req, res) => {
  const link = await brainService.getLinkById(req.params.id);
  if (!link) {
    throw new ServerError('Link not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(link);
}));

/**
 * POST /api/brain/links
 * Create a new link (quick-add with URL)
 */
router.post('/links', asyncHandler(async (req, res) => {
  const { url, title, description, linkType, tags, autoClone } = validateRequest(linkInputSchema, req.body);

  // Check if URL already exists
  const existing = await brainService.getLinkByUrl(url);
  if (existing) {
    throw new ServerError('Link with this URL already exists', {
      status: 409,
      code: 'DUPLICATE_URL',
      context: { existingId: existing.id }
    });
  }

  // Parse GitHub URL if applicable
  const parsed = githubCloner.parseGitHubUrl(url);
  const isGitHubRepo = !!parsed;

  // Create initial link record
  const linkData = {
    url,
    title: title || (parsed ? `${parsed.owner}/${parsed.repo}` : url),
    description: description || '',
    linkType: linkType || (isGitHubRepo ? 'github' : 'other'),
    tags: tags || [],
    isGitHubRepo,
    gitHubOwner: parsed?.owner,
    gitHubRepo: parsed?.repo,
    localPath: null,
    cloneStatus: isGitHubRepo && autoClone !== false ? 'pending' : 'none',
    cloneError: null
  };

  const link = await brainService.createLink(linkData);
  console.log(`🔗 Created link: ${link.id} (${isGitHubRepo ? 'GitHub repo' : 'regular URL'})`);

  // If GitHub repo and auto-clone enabled, start clone in background
  if (isGitHubRepo && autoClone !== false) {
    cloneRepoInBackground(link.id, url).catch(err => {
      console.error(`❌ Background clone setup failed for ${link.id}: ${err.message}`);
    });
  }

  res.status(201).json(link);
}));

/**
 * Clone repo in background and update link record
 */
async function cloneRepoInBackground(linkId, url) {
  // Update status to cloning
  await brainService.updateLink(linkId, { cloneStatus: 'cloning' });

  githubCloner.cloneRepo(url)
    .then(async (result) => {
      await brainService.updateLink(linkId, {
        localPath: result.localPath,
        cloneStatus: 'cloned',
        cloneError: null
      });
      console.log(`✅ Background clone complete: ${linkId}`);
    })
    .catch(async (err) => {
      await brainService.updateLink(linkId, {
        cloneStatus: 'failed',
        cloneError: err.message
      });
      console.error(`❌ Background clone failed: ${linkId} - ${err.message}`);
    });
}

/**
 * PUT /api/brain/links/:id
 * Update a link
 */
router.put('/links/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(linkUpdateInputSchema, req.body);
  const link = await brainService.updateLink(req.params.id, data);
  if (!link) {
    throw new ServerError('Link not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(link);
}));

/**
 * DELETE /api/brain/links/:id
 * Delete a link
 */
router.delete('/links/:id', asyncHandler(async (req, res) => {
  const deleted = await brainService.deleteLink(req.params.id);
  if (!deleted) {
    throw new ServerError('Link not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(204).send();
}));

/**
 * POST /api/brain/links/:id/clone
 * Manually trigger clone for a GitHub repo link
 */
router.post('/links/:id/clone', asyncHandler(async (req, res) => {
  const link = await brainService.getLinkById(req.params.id);
  if (!link) {
    throw new ServerError('Link not found', { status: 404, code: 'NOT_FOUND' });
  }

  if (!link.isGitHubRepo) {
    throw new ServerError('Link is not a GitHub repository', {
      status: 400,
      code: 'NOT_GITHUB_REPO'
    });
  }

  if (link.cloneStatus === 'cloning') {
    throw new ServerError('Clone already in progress', {
      status: 409,
      code: 'CLONE_IN_PROGRESS'
    });
  }

  // Start clone in background
  cloneRepoInBackground(link.id, link.url);

  res.json({ message: 'Clone started', linkId: link.id });
}));

/**
 * POST /api/brain/links/:id/pull
 * Pull latest changes for a cloned repo
 */
router.post('/links/:id/pull', asyncHandler(async (req, res) => {
  const link = await brainService.getLinkById(req.params.id);
  if (!link) {
    throw new ServerError('Link not found', { status: 404, code: 'NOT_FOUND' });
  }

  if (!link.isGitHubRepo || !link.localPath) {
    throw new ServerError('Link is not a cloned GitHub repository', {
      status: 400,
      code: 'NOT_CLONED'
    });
  }

  const result = await githubCloner.pullRepo(link.localPath);
  res.json({ message: 'Pull complete', ...result });
}));

/**
 * POST /api/brain/links/:id/open-folder
 * Open the cloned repo folder in the system file manager
 */
router.post('/links/:id/open-folder', asyncHandler(async (req, res) => {
  const link = await brainService.getLinkById(req.params.id);
  if (!link) {
    throw new ServerError('Link not found', { status: 404, code: 'NOT_FOUND' });
  }

  if (!link.localPath) {
    throw new ServerError('Link has no local folder', {
      status: 400,
      code: 'NO_LOCAL_PATH'
    });
  }

  if (!existsSync(link.localPath)) {
    throw new ServerError('Local folder does not exist', {
      status: 400,
      code: 'PATH_NOT_FOUND'
    });
  }

  // Cross-platform folder open command
  const platform = process.platform;
  let cmd, args;

  if (platform === 'darwin') {
    cmd = 'open';
    args = [link.localPath];
  } else if (platform === 'win32') {
    cmd = 'explorer';
    args = [link.localPath];
  } else {
    cmd = 'xdg-open';
    args = [link.localPath];
  }

  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  console.log(`📂 Opened folder: ${link.localPath}`);

  res.json({ message: 'Folder opened', path: link.localPath });
}));

export default router;
