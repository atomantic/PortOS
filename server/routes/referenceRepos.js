/**
 * Reference Repos routes.
 *
 * Per-app management of upstream repos we borrow code from. The
 * `reference-watch` scheduled task uses `checkReferenceRepo` to find
 * commits since each ref's `lastReviewedSha`, then dispatches a CoS
 * sub-agent to write REFERENCE_REVIEW.md to the app's repo.
 *
 * Mounted at /api/apps/:appId/reference-repos so it sits next to the
 * existing apps API surface.
 */

import { Router } from 'express';
import { asyncHandler, failValidation } from '../lib/errorHandler.js';
import { referenceRepoCreateSchema, referenceRepoUpdateSchema } from '../lib/validation.js';
import {
  listReferenceRepos,
  addReferenceRepo,
  updateReferenceRepo,
  deleteReferenceRepo,
  checkReferenceRepo,
  markReferenceRepoReviewed,
  triggerReferenceAnalysis,
} from '../services/referenceRepos.js';

const router = Router({ mergeParams: true });

router.get('/', asyncHandler(async (req, res) => {
  const refs = await listReferenceRepos(req.params.appId);
  res.json({ referenceRepos: refs });
}));

router.post('/', asyncHandler(async (req, res) => {
  const parsed = referenceRepoCreateSchema.safeParse(req.body || {});
  if (!parsed.success) failValidation(parsed);
  const ref = await addReferenceRepo(req.params.appId, parsed.data);
  res.status(201).json(ref);
}));

router.patch('/:refId', asyncHandler(async (req, res) => {
  const parsed = referenceRepoUpdateSchema.safeParse(req.body || {});
  if (!parsed.success) failValidation(parsed);
  const ref = await updateReferenceRepo(req.params.appId, req.params.refId, parsed.data);
  res.json(ref);
}));

router.delete('/:refId', asyncHandler(async (req, res) => {
  await deleteReferenceRepo(req.params.appId, req.params.refId);
  res.json({ ok: true });
}));

// Run a check now — fetches the upstream repo, returns the commit list since
// lastReviewedSha, and queues a CoS analysis task when new commits exist.
// Does NOT advance lastReviewedSha; that happens via the explicit /reviewed
// endpoint after the user / agent has actually processed the changes.
router.post('/:refId/check', asyncHandler(async (req, res) => {
  const { appId } = req.params;
  const snapshot = await checkReferenceRepo(appId, req.params.refId);
  let analysis = { queued: false, reason: 'no-new-commits' };
  if (snapshot.commitCount > 0) {
    const refs = (await listReferenceRepos(appId)) || [];
    const ref = refs.find((r) => r.id === req.params.refId);
    if (ref) {
      analysis = await triggerReferenceAnalysis(appId, ref, snapshot)
        .catch((err) => ({ queued: false, reason: err.message }));
    }
  }
  res.json({ ...snapshot, analysis });
}));

router.post('/:refId/reviewed', asyncHandler(async (req, res) => {
  const sha = (req.body?.sha || '').trim();
  const ref = await markReferenceRepoReviewed(req.params.appId, req.params.refId, sha);
  res.json(ref);
}));

export default router;
