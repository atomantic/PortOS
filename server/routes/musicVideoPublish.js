/**
 * Publish routes of the Music Video surface: the publish kit, cover art and thumbnails, platform posts and cross-links (#16097).
 * Mounted from musicVideo.js at the position of its first route so match order
 * against the remaining routes is unchanged.
 */

import { unlink } from 'fs/promises';
import { Router } from 'express';
import { assertCancelResult } from '../lib/cancelResponse.js';
import { requireProductionReviewer } from '../services/musicVideo/productionReviewService.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { musicVideoPublishKitBuildSchema, musicVideoPublishCopyPatchSchema, musicVideoPublishCopyDraftSchema, musicVideoPromotionPlanSchema, musicVideoPublishFrameSchema, musicVideoCoverArtComposeSchema, musicVideoYoutubeThumbnailComposeSchema, musicVideoYoutubeThumbnailPaintSchema, musicVideoYoutubeThumbnailPaintPreviewSchema, musicVideoCoverArtGenerateSchema, musicVideoCoverDesignSaveSchema, musicVideoArtistStyleSaveSchema, musicVideoArtistStyleDeleteSchema, musicVideoCoverArtDesignSchema, musicVideoPublishTargetSchema, musicVideoPublishPrepareSchema, musicVideoPublishPlatformsPatchSchema, musicVideoPublishPostSchema, musicVideoPublishCrossLinksSchema, musicVideoCrossLinkTargetSchema, musicVideoCrossLinkEditSchema } from '../lib/musicVideo/musicVideoRouteValidation.js';
import { uploadSingle } from '../lib/multipart.js';
import { requireProject } from '../services/musicVideo/requireProject.js';
import { startPublishKitBuild, getPublishKitCropPreview, attachPublishKitSseClient, cancelPublishKitBuild, draftPublishKitCopy, updatePublishKitCopy, finalRenderFile, capturePublishKitFrame } from '../services/musicVideo/publishKit.js';
import { preparePublishDraft, previewPublishPost, discardPublishDraft, listPublishDrafts, recordPublishPost, removePublishPost, prepareCrossLinkEdit, setPublishCrossLinks } from '../services/musicVideo/publish/index.js';
import { getPublishPlatforms, updatePublishPlatforms, publishHistory } from '../services/musicVideo/publish/platforms.js';
import { listArtistStyles, saveArtistStyle, removeArtistStyle } from '../services/musicVideo/publish/artistStyles.js';
import { addCoverFont, coverFontPath, listCoverFonts, MAX_COVER_FONT_BYTES, removeCoverFont } from '../services/musicVideo/coverFonts.js';

const router = Router();

// --- Publishing kit (#9281) ---
// Platform encodes, thumbnails, captions and chapters from the final render
// (an SSE job), plus per-platform copy: one user-triggered draft, then edits.
router.get('/:id/publish-kit/video', asyncHandler(async (req, res) => {
  const { path } = await finalRenderFile(await requireProject(req.params.id));
  res.sendFile(path);
}));

router.get('/:id/publish-kit/crop-preview', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await getPublishKitCropPreview(req.params.id));
}));

router.post('/:id/publish-kit/frame', asyncHandler(async (req, res) => {
  const { atSec } = validateRequest(musicVideoPublishFrameSchema, req.body ?? {});
  const { project } = await capturePublishKitFrame(req.params.id, atSec);
  res.json({ project });
}));

router.post('/:id/publish-kit/build', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoPublishKitBuildSchema, req.body ?? {});
  res.json(await startPublishKitBuild(req.params.id, input));
}));

router.get('/publish-kit/:jobId/events', (req, res) => {
  const ok = attachPublishKitSseClient(req.params.jobId, res);
  if (!ok) throw new ServerError('Publishing kit job not found or expired', { status: 404, code: 'NOT_FOUND' });
});

router.post('/publish-kit/:jobId/cancel', (req, res) => {
  res.json(assertCancelResult(cancelPublishKitBuild(req.params.jobId), { notFoundMessage: 'Publish kit job not found' }));
});

router.post('/:id/publish-kit/copy', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoPublishCopyDraftSchema, req.body || {});
  const { project } = await draftPublishKitCopy(req.params.id, input);
  res.json({ project });
}));

// The release's scheduled promotion steps (open ones), soonest first.
router.get('/:id/publish/promotion-plan', asyncHandler(async (req, res) => {
  const { promotionPlanSteps } = await import('../services/musicVideo/promotionPlan.js');
  res.json(await promotionPlanSteps(req.params.id));
}));

// Turn the release into dated steps only the artist can take, with reminders.
router.post('/:id/publish/promotion-plan', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoPromotionPlanSchema, req.body || {});
  const { planMusicVideoPromotion } = await import('../services/musicVideo/promotionPlan.js');
  res.status(201).json(await planMusicVideoPromotion(req.params.id, input));
}));

router.patch('/:id/publish-kit/copy', asyncHandler(async (req, res) => {
  const patch = validateRequest(musicVideoPublishCopyPatchSchema, req.body || {});
  const { project } = await updatePublishKitCopy(req.params.id, patch);
  res.json({ project });
}));

// The YouTube thumbnail: a source cropped 16:9 with the title set in the
// cover's lettering. DELETE goes back to the picked video frame.
router.post('/:id/publish-kit/youtube-thumbnail', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoYoutubeThumbnailComposeSchema, req.body ?? {});
  const { composeProjectYoutubeThumbnail } = await import('../services/musicVideo/youtubeThumbnail.js');
  const { project } = await composeProjectYoutubeThumbnail(req.params.id, input);
  res.json({ project });
}));

router.delete('/:id/publish-kit/youtube-thumbnail', asyncHandler(async (req, res) => {
  const { clearProjectYoutubeThumbnail } = await import('../services/musicVideo/youtubeThumbnail.js');
  const { project } = await clearProjectYoutubeThumbnail(req.params.id);
  res.json({ project });
}));

// "Paint the title": what the image model would receive, then the queued job
// (its completion hook makes the result the thumbnail).
router.post('/:id/publish-kit/youtube-thumbnail/paint/preview', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoYoutubeThumbnailPaintPreviewSchema, req.body ?? {});
  const { buildThumbnailPaintPrompt } = await import('../services/musicVideo/youtubeThumbnail.js');
  res.json(buildThumbnailPaintPrompt(input));
}));

router.post('/:id/publish-kit/youtube-thumbnail/paint', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoYoutubeThumbnailPaintSchema, req.body ?? {});
  const { paintYoutubeThumbnail } = await import('../services/musicVideo/youtubeThumbnail.js');
  const { project } = await paintYoutubeThumbnail(req.params.id, input);
  res.json({ project });
}));

// Variants kept for YouTube's Test & Compare (up to three): add the made thumbnail, or drop one.
router.post('/:id/publish-kit/youtube-thumbnail/tests', asyncHandler(async (req, res) => {
  const { addYoutubeThumbnailTest } = await import('../services/musicVideo/youtubeThumbnail.js');
  const { project } = await addYoutubeThumbnailTest(req.params.id);
  res.json({ project });
}));

router.delete('/:id/publish-kit/youtube-thumbnail/tests/:filename', asyncHandler(async (req, res) => {
  const { removeYoutubeThumbnailTest } = await import('../services/musicVideo/youtubeThumbnail.js');
  const { project } = await removeYoutubeThumbnailTest(req.params.id, req.params.filename);
  res.json({ project });
}));

// Release cover art: the song's own design (drafted, or adjusted from the
// director's direction), compose from a chosen image, or queue a fresh cover
// photo whose completion hook composes the cover.
router.post('/:id/publish-kit/cover-art', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoCoverArtComposeSchema, req.body || {});
  const { composeProjectCoverArt } = await import('../services/musicVideo/coverArt.js');
  const { project } = await composeProjectCoverArt(req.params.id, input);
  res.json({ project });
}));

router.post('/:id/publish-kit/cover-art/design', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoCoverArtDesignSchema, req.body || {});
  const { designCoverArt } = await import('../services/musicVideo/coverArt.js');
  const { project } = await designCoverArt(req.params.id, input);
  res.json({ project });
}));

// #10345: the Lettering controls set the design directly, with no AI call.
router.put('/:id/publish-kit/cover-art/design', asyncHandler(async (req, res) => {
  const { design } = validateRequest(musicVideoCoverDesignSaveSchema, req.body ?? {});
  const { saveCoverDesign } = await import('../services/musicVideo/coverArt.js');
  const { project } = await saveCoverDesign(req.params.id, design);
  res.json({ project });
}));

router.post('/:id/publish-kit/cover-art/generate', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoCoverArtGenerateSchema, req.body || {});
  const { generateCoverArtSource } = await import('../services/musicVideo/coverArt.js');
  const { project } = await generateCoverArtSource(req.params.id, input);
  res.json({ project });
}));

// --- Posting (#9282) ---
// Fill a platform's post in the PortOS Browser and return a screenshot; post
// only on a second, explicit request naming that live draft.
// #9287: where the director posts (opt-in, optional account per platform),
// with every platform's post history and ratings across projects.
router.get('/publish/platforms', asyncHandler(async (req, res) => {
  const [platforms, history] = await Promise.all([getPublishPlatforms(), publishHistory()]);
  res.json({ platforms, history });
}));

router.put('/publish/platforms', asyncHandler(async (req, res) => {
  const patch = validateRequest(musicVideoPublishPlatformsPatchSchema, req.body || {});
  res.json({ platforms: await updatePublishPlatforms(patch) });
}));

// #10345: one saved cover design per artist, and the typefaces the director uploaded.
router.get('/publish/artist-styles', asyncHandler(async (req, res) => {
  res.json({ styles: await listArtistStyles() });
}));

router.put('/publish/artist-styles', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoArtistStyleSaveSchema, req.body ?? {});
  res.json({ style: await saveArtistStyle(input) });
}));

router.delete('/publish/artist-styles', asyncHandler(async (req, res) => {
  const { name } = validateRequest(musicVideoArtistStyleDeleteSchema, req.query);
  await removeArtistStyle(name);
  res.json({ ok: true });
}));

const COVER_FONT_MIME = { ttf: 'font/ttf', otf: 'font/otf', woff2: 'font/woff2' };

const coverFontUpload = uploadSingle('font', { limits: { fileSize: MAX_COVER_FONT_BYTES } });

router.get('/publish/cover-fonts', asyncHandler(async (req, res) => {
  res.json({ fonts: await listCoverFonts() });
}));

router.post('/publish/cover-fonts', coverFontUpload, asyncHandler(async (req, res) => {
  if (!req.file) throw new ServerError('No font file uploaded (multipart field "font")', { status: 400, code: 'VALIDATION_ERROR' });
  const font = await addCoverFont({ tempPath: req.file.path, originalName: req.file.originalname }).finally(() => unlink(req.file.path).catch(() => {}));
  res.status(201).json({ font, fonts: await listCoverFonts() });
}));

router.get('/publish/cover-fonts/:fontId/file', asyncHandler(async (req, res) => {
  const found = await coverFontPath(req.params.fontId);
  if (!found) throw new ServerError('Font not found', { status: 404, code: 'NOT_FOUND' });
  res.type(COVER_FONT_MIME[found.font.ext]).sendFile(found.path);
}));

router.delete('/publish/cover-fonts/:fontId', asyncHandler(async (req, res) => {
  await removeCoverFont(req.params.fontId);
  res.json({ fonts: await listCoverFonts() });
}));

// Record a post made by hand, or rate one: its link, reception and notes.
router.put('/:id/publish/posts/:target', asyncHandler(async (req, res) => {
  const target = validateRequest(musicVideoPublishTargetSchema, req.params.target);
  const input = validateRequest(musicVideoPublishPostSchema, req.body || {});
  res.json(await recordPublishPost(req.params.id, target, input));
}));

// Undo a platform's "done" (the post record only; nothing on the platform changes).
router.delete('/:id/publish/posts/:target', asyncHandler(async (req, res) => {
  const target = validateRequest(musicVideoPublishTargetSchema, req.params.target);
  res.json(await removePublishPost(req.params.id, target));
}));

// What Fill draft would post, read-only: the rows of text and files, or what is still missing.
router.post('/:id/publish/:target/preview', asyncHandler(async (req, res) => {
  const target = validateRequest(musicVideoPublishTargetSchema, req.params.target);
  const options = validateRequest(musicVideoPublishPrepareSchema, req.body || {});
  res.json(await previewPublishPost(req.params.id, target, options));
}));

// Whether new drafts list the release's other posts (cross-links).
router.put('/:id/publish/cross-links', asyncHandler(async (req, res) => {
  const { enabled } = validateRequest(musicVideoPublishCrossLinksSchema, req.body || {});
  res.json(await setPublishCrossLinks(req.params.id, enabled));
}));

// Fill a posted platform's edit form (or a reply under it) with the links it lacks; the director saves it.
router.post('/:id/publish/:target/cross-links', asyncHandler(async (req, res) => {
  const target = validateRequest(musicVideoCrossLinkTargetSchema, req.params.target);
  await requireProductionReviewer(req);
  const { password: _password, ...body } = req.body || {};
  validateRequest(musicVideoCrossLinkEditSchema, body);
  res.json(await prepareCrossLinkEdit(req.params.id, target));
}));

router.post('/:id/publish/:target/prepare', asyncHandler(async (req, res) => {
  const target = validateRequest(musicVideoPublishTargetSchema, req.params.target);
  await requireProductionReviewer(req);
  const { password: _password, ...body } = req.body || {};
  const options = validateRequest(musicVideoPublishPrepareSchema, body);
  res.json(await preparePublishDraft(req.params.id, target, options));
}));

router.get('/:id/publish/drafts', asyncHandler(async (req, res) => {
  res.json({ drafts: await listPublishDrafts(req.params.id) });
}));

router.delete('/:id/publish/drafts/:draftId', asyncHandler(async (req, res) => {
  res.json({ ok: await discardPublishDraft(req.params.id, req.params.draftId) });
}));

export default router;
