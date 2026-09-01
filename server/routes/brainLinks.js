/**
 * Brain Links & Buckets Routes
 *
 * Bookmark links (with repository clone/pull/scan/study affordances for the
 * hosts in `lib/repoUrl.js`) and the buckets that group them.
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
  linkStudyInputSchema,
  bucketInputSchema,
  bucketUpdateInputSchema,
  bucketReorderSchema
} from '../lib/brainValidation.js';
import * as repoCloner from '../services/repoCloner.js';
import { deriveRepoLinkFields } from '../lib/repoLinkFields.js';
import { queueMalwareScan, restudyRepoLink } from '../services/repoIntake.js';
import { getScanReport } from '../services/malwareScanReports.js';

const router = Router();

/**
 * Resolve a link that has a readable clone, or throw the right 404/400. Every
 * clone-reading action (open-folder aside, which only needs a path) shares these
 * preconditions, so they are stated once rather than re-spelled per route.
 */
async function requireClonedRepoLink(id) {
  const link = await brainService.getLinkById(id);
  if (!link) {
    throw new ServerError('Link not found', { status: 404, code: 'NOT_FOUND' });
  }
  if (!link.isRepo || link.cloneStatus !== 'cloned' || !link.localPath) {
    throw new ServerError('Link is not a cloned repository', { status: 400, code: 'NOT_CLONED' });
  }
  return link;
}

/**
 * How a `{ queued: false, reason }` from services/repoIntake.js is reported. A
 * lookup rather than a ternary chain so a reason added there surfaces as itself
 * instead of falling through to whichever branch happened to be last.
 */
const QUEUE_REASON_ERRORS = {
  duplicate: (what) => new ServerError(`A ${what} for this repo is already pending or in progress`, { status: 409, code: 'DUPLICATE_TASK' }),
  'app-not-found': () => new ServerError('The app to file study issues against no longer exists', { status: 400, code: 'APP_NOT_FOUND' }),
};
const queueFailure = (reason, what) => (QUEUE_REASON_ERRORS[reason] ?? (() =>
  new ServerError('Local clone folder does not exist', { status: 400, code: 'PATH_NOT_FOUND' })))(what);

// =============================================================================
// LINKS CRUD
// =============================================================================

/**
 * GET /api/brain/links
 * Get all links with optional filters
 */
router.get('/links', asyncHandler(async (req, res) => {
  const { linkType, isRepo, isGitHubRepo, limit, offset } = validateRequest(linksQuerySchema, req.query);
  const repoFilter = isRepo ?? isGitHubRepo;
  // Filtering, newest-first ordering, and the total count are answered from
  // brainStorage's cached link-summary index, so only THIS page's records are
  // read and parsed from disk (issue #3509) — not the whole collection.
  const { links, total } = await brainService.getLinksPage({ linkType, isRepo: repoFilter, limit, offset });
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

  // Title derivation, repository metadata, and the background clone all live in the
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

  // When the URL changes, re-derive the repository fields so the link type /
  // repo metadata stay consistent with the new target.
  if (data.url && data.url !== existing.url) {
    const duplicate = await brainService.getLinkByUrl(data.url);
    if (duplicate && duplicate.id !== existing.id) {
      throw new ServerError('Link with this URL already exists', {
        status: 409,
        code: 'DUPLICATE_URL',
        context: { existingId: duplicate.id }
      });
    }

    Object.assign(data, deriveRepoLinkFields(data.url));

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
 * Manually trigger clone for a repository link
 */
router.post('/links/:id/clone', asyncHandler(async (req, res) => {
  const link = await brainService.getLinkById(req.params.id);
  if (!link) {
    throw new ServerError('Link not found', { status: 404, code: 'NOT_FOUND' });
  }

  if (!link.isRepo) {
    throw new ServerError('Link is not a repository', {
      status: 400,
      code: 'NOT_A_REPO'
    });
  }

  if (link.cloneStatus === 'cloning') {
    throw new ServerError('Clone already in progress', {
      status: 409,
      code: 'CLONE_IN_PROGRESS'
    });
  }

  // Start clone in background. Deliberately not awaited, so it needs its own
  // catch: the setup steps before the clone's own handlers are armed (identity
  // resolve, the `cloning` stamp) run outside the request lifecycle, and an
  // unhandled rejection there would crash the process instead of logging.
  brainService.cloneRepoInBackground(link.id, link.url).catch(err => {
    console.error(`❌ Background clone setup failed for ${link.id}: ${err.message}`);
  });

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

  if (!link.isRepo || !link.localPath) {
    throw new ServerError('Link is not a cloned repository', {
      status: 400,
      code: 'NOT_CLONED'
    });
  }

  const result = await repoCloner.pullRepo(link.localPath);
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
  const link = await requireClonedRepoLink(req.params.id);

  // `not-cloned` here means the recorded localPath is gone from disk — the
  // service re-checks existence so the background capture path can't queue a
  // scan against a directory that was deleted after the clone.
  const result = await queueMalwareScan(link);
  if (!result.queued) throw queueFailure(result.reason, 'scan');
  // Record the pending scan the same way the capture-time path does, so a
  // reload shows the "Scan queued" chip instead of re-arming the button (whose
  // second click would 409 as a duplicate).
  await brainService.updateLink(link.id, result.linkPatch);

  res.json({ message: 'Scan queued', taskId: result.taskId, linkId: link.id, scanPath: link.localPath });
}));

/**
 * POST /api/brain/links/:id/study
 * Refresh the clone (unless `pull: false`) and queue a fresh `repo-study` run
 * against it, with the brief the user just wrote. The dispatch shape lives in
 * services/repoIntake.js so this button and the capture-time "study for app
 * ideas" checkbox queue exactly the same run.
 */
router.post('/links/:id/study', asyncHandler(async (req, res) => {
  const body = validateRequest(linkStudyInputSchema, req.body);
  const link = await requireClonedRepoLink(req.params.id);

  const result = await restudyRepoLink(link, body);
  if (!result.queued) throw queueFailure(result.reason, 'study');
  // Record the pending study the same way the capture-time path does, so a
  // reload shows the queued chip and the brief the run was given.
  const updated = await brainService.updateLink(link.id, result.linkPatch);

  res.json({
    message: 'Study queued',
    taskId: result.taskId,
    linkId: link.id,
    pulled: result.pulled,
    link: updated
  });
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
