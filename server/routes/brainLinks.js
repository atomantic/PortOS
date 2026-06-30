/**
 * Brain Links & Buckets Routes
 *
 * Bookmark links (with GitHub clone/pull/scan affordances) and the buckets
 * that group them.
 */

import { Router } from 'express';
import { existsSync } from 'fs';
import * as brainService from '../services/brain.js';
import { openFolderInSystemExplorer } from '../lib/openFolder.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  linkInputSchema,
  linkUpdateInputSchema,
  linkReorderSchema,
  linksQuerySchema,
  bucketInputSchema,
  bucketUpdateInputSchema,
  bucketReorderSchema
} from '../lib/brainValidation.js';
import * as githubCloner from '../services/githubCloner.js';
import { loadSlashdoCommand } from '../services/subAgentSpawner.js';
import * as cos from '../services/cos.js';

const router = Router();

/**
 * Extract a clean hostname from a URL (strip a leading www.), or null if unparseable.
 */
function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

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
 * POST /api/brain/links/reorder
 * Apply a batch of { id, bucketId, bucketOrder } updates for one drag gesture
 * in a single atomic write — N concurrent single-link PUTs against the shared
 * links store can lose-update each other. Mirrors POST /buckets/reorder.
 * (Registered before /links/:id so "reorder" isn't captured as an :id.)
 */
router.post('/links/reorder', asyncHandler(async (req, res) => {
  const { updates } = validateRequest(linkReorderSchema, req.body);
  // All-or-nothing: reject before any write if a batch references a link that
  // no longer exists, so the response can't report success after a partial
  // apply (mirrors the single-link PUT's 404 on an unknown id).
  const known = new Set((await brainService.getLinks()).map(l => l.id));
  const missing = updates.filter(u => !known.has(u.id)).map(u => u.id);
  if (missing.length) {
    throw new ServerError('Unknown link id in reorder batch', {
      status: 404,
      code: 'NOT_FOUND',
      context: { missing }
    });
  }
  const links = await brainService.reorderLinks(updates);
  res.json({ links });
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
  const { url, title, description, linkType, tags, bucketId, bucketOrder, autoClone } = validateRequest(linkInputSchema, req.body);

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

  // Derive a readable default title: repo slug for GitHub, hostname for plain
  // URLs (so quick-added bucket chips read "example.com" instead of the full URL).
  const defaultTitle = parsed
    ? `${parsed.owner}/${parsed.repo}`
    : (hostnameFromUrl(url) || url);

  // Create initial link record
  const linkData = {
    url,
    title: title || defaultTitle,
    description: description || '',
    linkType: linkType || (isGitHubRepo ? 'github' : 'other'),
    tags: tags || [],
    isGitHubRepo,
    gitHubOwner: parsed?.owner,
    gitHubRepo: parsed?.repo,
    localPath: null,
    cloneStatus: isGitHubRepo && autoClone !== false ? 'pending' : 'none',
    cloneError: null,
    ...(bucketId !== undefined ? { bucketId } : {}),
    ...(bucketOrder !== undefined ? { bucketOrder } : {})
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
 * PUT /api/brain/links/:id
 * Update a link
 */
router.put('/links/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(linkUpdateInputSchema, req.body);

  const existing = await brainService.getLinkById(req.params.id);
  if (!existing) {
    throw new ServerError('Link not found', { status: 404, code: 'NOT_FOUND' });
  }

  // When the URL changes, re-derive the GitHub-specific fields so the link
  // type / repo metadata stay consistent with the new target.
  if (data.url && data.url !== existing.url) {
    const duplicate = await brainService.getLinkByUrl(data.url);
    if (duplicate && duplicate.id !== existing.id) {
      throw new ServerError('Link with this URL already exists', {
        status: 409,
        code: 'DUPLICATE_URL',
        context: { existingId: duplicate.id }
      });
    }

    const parsed = githubCloner.parseGitHubUrl(data.url);
    data.isGitHubRepo = !!parsed;
    data.gitHubOwner = parsed?.owner || null;
    data.gitHubRepo = parsed?.repo || null;

    // The previous clone (if any) belongs to the old URL — reset clone state so
    // it doesn't point at the wrong repo. The user can re-clone the new target.
    data.localPath = null;
    data.cloneStatus = 'none';
    data.cloneError = null;
  }

  const link = await brainService.updateLink(req.params.id, data);
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

  openFolderInSystemExplorer(link.localPath);
  res.json({ message: 'Folder opened', path: link.localPath });
}));

/**
 * POST /api/brain/links/:id/scan
 * Queue a read-only malware/risk scan (do:scan) against the cloned repo.
 * Creates a CoS user task whose context inlines the do:scan command body
 * with the repo's localPath baked in as SCAN_DIR. The agent writes its
 * markdown report to ~/.claude/scans/.
 */
router.post('/links/:id/scan', asyncHandler(async (req, res) => {
  const link = await brainService.getLinkById(req.params.id);
  if (!link) {
    throw new ServerError('Link not found', { status: 404, code: 'NOT_FOUND' });
  }
  if (!link.isGitHubRepo || link.cloneStatus !== 'cloned' || !link.localPath) {
    throw new ServerError('Link is not a cloned GitHub repository', {
      status: 400,
      code: 'NOT_CLONED'
    });
  }
  if (!existsSync(link.localPath)) {
    throw new ServerError('Local clone folder does not exist', {
      status: 400,
      code: 'PATH_NOT_FOUND'
    });
  }

  const scanCommand = await loadSlashdoCommand('scan');
  if (!scanCommand) {
    throw new ServerError('Failed to load do:scan command', {
      status: 500,
      code: 'COMMAND_LOAD_FAILED'
    });
  }

  const repoLabel = link.title || link.url;
  const description = `Malware scan: ${repoLabel} (do:scan)`;
  const context = `Run the /do:scan workflow against the cloned repository at: \`${link.localPath}\`

Use that path as SCAN_DIR. Adhere to every Operational Invariant in the command body — this is a hostile-until-proven-safe audit. The full markdown report will be written to ~/.claude/scans/. When complete, summarize the verdict (CLEAN / CAUTION / DANGEROUS) and the top findings in your final response so the report can be surfaced in the UI.

---

${scanCommand}`;

  const result = await cos.addTask(
    { description, context, useWorktree: false, openPR: false, simplify: false, reviewLoop: false },
    'user'
  );
  if (result?.duplicate) {
    throw new ServerError('A scan for this repo is already pending or in progress', {
      status: 409,
      code: 'DUPLICATE_TASK'
    });
  }

  console.log(`🛡️ Queued malware scan: link=${link.id} path=${link.localPath} task=${result.id}`);
  res.json({ message: 'Scan queued', taskId: result.id, linkId: link.id, scanPath: link.localPath });
}));

// =============================================================================
// BUCKETS (bookmark groups for links)
// =============================================================================

/**
 * GET /api/brain/buckets
 * List buckets sorted by their display order.
 */
router.get('/buckets', asyncHandler(async (req, res) => {
  const buckets = await brainService.getBuckets();
  buckets.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  res.json({ buckets });
}));

/**
 * POST /api/brain/buckets
 * Create a bucket. New buckets are appended after the existing ones.
 */
router.post('/buckets', asyncHandler(async (req, res) => {
  const { name, color, icon } = validateRequest(bucketInputSchema, req.body);
  const bucket = await brainService.createBucketAppended({ name, color, icon });
  console.log(`🗂️ Created bucket: ${bucket.id} (${bucket.name})`);
  res.status(201).json(bucket);
}));

/**
 * POST /api/brain/buckets/reorder
 * Persist a new display order for buckets in a single call.
 * (Registered before /buckets/:id so "reorder" isn't captured as an :id.)
 */
router.post('/buckets/reorder', asyncHandler(async (req, res) => {
  const { ids } = validateRequest(bucketReorderSchema, req.body);
  for (let i = 0; i < ids.length; i++) {
    await brainService.updateBucket(ids[i], { order: i });
  }
  const buckets = await brainService.getBuckets();
  buckets.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  res.json({ buckets });
}));

/**
 * PUT /api/brain/buckets/:id
 * Update a bucket's name / color / icon / order.
 */
router.put('/buckets/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(bucketUpdateInputSchema, req.body);
  const existing = await brainService.getBucketById(req.params.id);
  if (!existing) {
    throw new ServerError('Bucket not found', { status: 404, code: 'NOT_FOUND' });
  }
  const bucket = await brainService.updateBucket(req.params.id, data);
  res.json(bucket);
}));

/**
 * DELETE /api/brain/buckets/:id
 * Delete a bucket. Its links survive — they're unassigned (bucketId -> null)
 * so they fall back to the ungrouped list rather than being orphaned.
 */
router.delete('/buckets/:id', asyncHandler(async (req, res) => {
  const existing = await brainService.getBucketById(req.params.id);
  if (!existing) {
    throw new ServerError('Bucket not found', { status: 404, code: 'NOT_FOUND' });
  }

  const result = await brainService.deleteBucketAndUnlinkChildren(req.params.id);
  console.log(`🗂️ Deleted bucket: ${req.params.id} (unassigned ${result.unassigned} links)`);
  res.json(result);
}));

export default router;
