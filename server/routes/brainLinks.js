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
import { queueMalwareScan } from '../services/repoIntake.js';
import { getScanReport } from '../services/malwareScanReports.js';

const router = Router();

// =============================================================================
// LINKS CRUD
// =============================================================================

/**
 * GET /api/brain/links
 * Get all links with optional filters
 */
router.get('/links', asyncHandler(async (req, res) => {
  const { linkType, isGitHubRepo, limit, offset } = validateRequest(linksQuerySchema, req.query);
  // Filtering, newest-first ordering, and the total count are answered from
  // brainStorage's cached link-summary index, so only THIS page's records are
  // read and parsed from disk (issue #3509) — not the whole collection.
  const { links, total } = await brainService.getLinksPage({ linkType, isGitHubRepo, limit, offset });
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
  // Membership only — `listLinkIds` answers it from the summary index instead
  // of parsing every link body (issue #3509).
  const known = new Set(await brainService.listLinkIds());
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
  const { url, ...options } = validateRequest(linkInputSchema, req.body);

  // Check if URL already exists
  const existing = await brainService.getLinkByUrl(url);
  if (existing) {
    throw new ServerError('Link with this URL already exists', {
      status: 409,
      code: 'DUPLICATE_URL',
      context: { existingId: existing.id }
    });
  }

  // Title derivation, GitHub metadata, and the background clone all live in the
  // service so a URL captured in the Brain inbox lands identically (see
  // captureUrlAsLink in services/brain.js).
  const link = await brainService.createLinkFromUrl(url, options);
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
  brainService.cloneRepoInBackground(link.id, link.url);

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
 * The task shape lives in services/repoIntake.js so this button and the
 * capture-time "scan for malware" checkbox queue exactly the same run.
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

  // `not-cloned` here means the recorded localPath is gone from disk — the
  // service re-checks existence so the background capture path can't queue a
  // scan against a directory that was deleted after the clone.
  const result = await queueMalwareScan(link);
  if (!result.queued) {
    throw result.reason === 'duplicate'
      ? new ServerError('A scan for this repo is already pending or in progress', { status: 409, code: 'DUPLICATE_TASK' })
      : new ServerError('Local clone folder does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }
  // Record the pending scan the same way the capture-time path does, so a
  // reload shows the "Scan queued" chip instead of re-arming the button (whose
  // second click would 409 as a duplicate).
  await brainService.updateLink(link.id, result.linkPatch);

  res.json({ message: 'Scan queued', taskId: result.taskId, linkId: link.id, scanPath: link.localPath });
}));

router.get('/links/:id/scan-report', asyncHandler(async (req, res) => {
  const link = await brainService.getLinkById(req.params.id);
  if (!link?.malwareScan?.reportId) {
    throw new ServerError('No malware scan report is available for this link', { status: 404, code: 'REPORT_NOT_FOUND' });
  }
  const report = await getScanReport(link.malwareScan.reportId);
  if (report === null) {
    throw new ServerError('Malware scan report file is unavailable', { status: 404, code: 'REPORT_NOT_FOUND' });
  }
  res.type('text/markdown').send(report);
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
  await brainService.reorderBuckets(ids.map((id, order) => ({ id, order })));
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
